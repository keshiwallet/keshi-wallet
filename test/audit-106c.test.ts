import "./_localstorage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../src/ui/store";
import * as core from "../src/core";
import { local, newDataKey, setDataKey } from "../src/ext/platform";

// External audit of the 1.0.6 release candidate, second pass: the second step of a USDT purchase, and one
// Ethereum operation at a time with a lasting record. No network: every answer here is a stand-in.

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const mine = { phrase: ABANDON } as unknown as core.Secrets;
const me = core.ethAccountOf(mine).address;

beforeEach(async () => {
  setDataKey(newDataKey());
  await local.remove("lifi");
  await local.remove("ethJournal");
});
afterEach(() => vi.unstubAllGlobals());

describe("second step of a USDT purchase checks its own state", () => {
  const base: store.UsdtPurchase = { txHash: "0xe1", chain: "arbitrum", amount: 50_000000n, to: "usdt", expected: 49_000000n, at: Date.now(), from: me };
  it("is refused while the purchase is not recorded as arrived, whatever the screen shows", async () => {
    for (const outcome of [undefined, "failed", "refunded", "partial"] as const) {
      await store.recordPurchase({ ...base, outcome });
      await expect(store.finishUsdtPurchase(mine, { ...base, outcome: "arrived", received: 49_000000n }, () => {}, 1.6), String(outcome)).rejects.toThrow(/not recorded as arrived/);
    }
  });
  it("an arrival that was not matched on Ethereum is swapped only on the user's explicit word", async () => {
    await store.recordPurchase({ ...base, outcome: "arrived" });
    await expect(store.finishUsdtPurchase(mine, base, () => {}, 1.6)).rejects.toThrow(/could not match this purchase/);
    // With the user's word it goes on to the next check (the network, absent here), not back to this one.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "insufficient funds for gas" } })));
    await expect(store.finishUsdtPurchase(mine, base, () => {}, 1.6, true)).rejects.not.toThrow(/could not match|not recorded/);
  });
});

describe("one Ethereum operation at a time, and a lasting record", () => {
  it("a second operation from the same wallet is refused while the first is running, and allowed after it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      await gate;
      // A clear refusal from the node: the operation ends at once instead of trying its other servers.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "insufficient funds for gas" } }));
    });
    const first = store.unwrapWeth(mine, 1n).catch((e) => String(e));
    await new Promise((r) => setTimeout(r, 20));
    await expect(store.unwrapWeth(mine, 1n)).rejects.toThrow(/already sending an Ethereum transaction/);
    await expect(store.swap(mine, {} as core.Route, () => {})).rejects.toThrow(/already sending an Ethereum transaction/);
    release();
    expect(await first).not.toMatch(/already sending/);
    // The turn is given back even though the first one failed.
    await expect(store.unwrapWeth(mine, 1n)).rejects.not.toThrow(/already sending/);
    expect(asked).toBeGreaterThan(0);
  });
  it("every signed transaction is written down, with its purpose, before the network sees it", async () => {
    const order: string[] = [];
    const hash = "0x" + "ab".repeat(32);
    const rpc = new core.EthRpc((async () => {
      order.push("network");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hash }));
    }) as unknown as typeof fetch);
    // Outside an operation nothing is recorded (there is nothing to say about it), and the send still goes out.
    await rpc.send("0x02c0", hash);
    expect(await local.get("ethJournal")).toBeUndefined();
    // Inside one: recorded first, sent second.
    core.setSendJournal(async (h, n) => {
      order.push("record");
      await local.set("ethJournal", [{ hash: h, nonce: n, at: 1, what: "Swap", chain: "Ethereum", from: me }]);
    });
    order.length = 0;
    await rpc.send("0x02c0", hash);
    expect(order[0]).toBe("record");
    expect(order).toContain("network");
    const kept = await store.ethJournal(me, false);
    expect(kept.map((o) => [o.hash, o.what, o.outcome])).toEqual([[hash, "Swap", undefined]]);
    // Another wallet's record is not shown to this one, and the record is stored encrypted.
    expect(await store.ethJournal("0x" + "22".repeat(20), false)).toEqual([]);
    expect(globalThis.localStorage.getItem("keshi:ethJournal")).not.toContain(hash);
    // A record that cannot be saved does not stop the transaction.
    core.setSendJournal(async () => {
      throw new Error("storage full");
    });
    await expect(rpc.send("0x02c0", hash)).resolves.toBe(hash);
  });
});
