import "./_localstorage";
import { describe, expect, it } from "vitest";
import * as c from "../src/core";
import * as store from "../src/ui/store";

// Second independent review of 1.0.5 (6 November 2026): what it asked for, checked here.
const ME = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TX = "0x" + "ab".repeat(32);
const topic = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const log = (token: string, to: string, amount: bigint) => ({ address: token, topics: [c.TRANSFER_TOPIC, topic(OTHER), topic(to)], data: "0x" + amount.toString(16).padStart(64, "0") });
const rpcWith = (receipt: unknown) => new c.EthRpc((async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt }))) as unknown as typeof fetch, ["https://rpc.test"]);

describe("USDT arrival is the chain's word, not LI.FI's", () => {
  it("reads the USDT delivered to the buyer from the Transfer events of the delivering transaction", async () => {
    const receipt = { status: "0x1", logs: [log(c.ETH_USDT, OTHER, 5n), log(c.ETH_USDT, ME, 99_000_000n), log("0x" + "33".repeat(20), ME, 7n), log(c.ETH_USDT, ME, 1_000_000n)] };
    expect(await rpcWith(receipt).tokenDelivered(TX, c.ETH_USDT, ME)).toBe(100_000_000n);
    // Another address, another token, a failed transaction, or no receipt yet: nothing verified.
    expect(await rpcWith(receipt).tokenDelivered(TX, c.ETH_USDT, "0x" + "44".repeat(20))).toBeNull();
    expect(await rpcWith({ ...receipt, status: "0x0" }).tokenDelivered(TX, c.ETH_USDT, ME)).toBeNull();
    expect(await rpcWith(null).tokenDelivered(TX, c.ETH_USDT, ME)).toBeNull();
    expect(await rpcWith(receipt).tokenDelivered("not-a-hash", c.ETH_USDT, ME)).toBeNull();
    // Hostile log shapes do not count and do not throw.
    expect(await rpcWith({ status: "0x1", logs: [{ address: c.ETH_USDT, topics: [c.TRANSFER_TOPIC, topic(OTHER), topic(ME)], data: "0xzz" }, 5, null] }).tokenDelivered(TX, c.ETH_USDT, ME)).toBeNull();
  });
  it("records an arrival only when Ethereum confirms it; otherwise the swap stays capped at the quote and is labelled unverified", async () => {
    const said: c.LifiStatus = { status: "DONE", receivedAmount: 100_000_000n, receivedToken: c.ETH_USDT, receivedChain: 1n, receivingTx: TX };
    const ok = await store.verifiedArrival(said, ME, rpcWith({ status: "0x1", logs: [log(c.ETH_USDT, ME, 98_500_000n)] }));
    expect(ok).toEqual({ received: 98_500_000n, receivingTx: TX }); // the chain's figure, not the server's
    expect(await store.verifiedArrival(said, ME, rpcWith(null))).toBeUndefined();
    expect(await store.verifiedArrival({ ...said, receivingTx: undefined }, ME, rpcWith({ status: "0x1", logs: [log(c.ETH_USDT, ME, 1n)] }))).toBeUndefined();
    expect(await store.verifiedArrival({ ...said, receivedChain: 42161n }, ME, rpcWith({ status: "0x1", logs: [log(c.ETH_USDT, ME, 1n)] }))).toBeUndefined();
    expect(await store.verifiedArrival(said, ME, new c.EthRpc((async () => { throw new Error("down"); }) as unknown as typeof fetch, ["https://rpc.test"]))).toBeUndefined();
    const p: store.UsdtPurchase = { txHash: "0x01", chain: "arbitrum", amount: 100_000_000n, to: "usdt", expected: 99_000_000n, at: 0, from: ME };
    expect(store.usdtToSwap(p, 500_000_000n)).toBe(99_000_000n); // unverified: the quote caps it, whatever the address holds
    expect(store.usdtToSwap({ ...p, received: 98_500_000n }, 500_000_000n)).toBe(98_500_000n);
    expect(store.usdtToSwap({ ...p, received: 98_500_000n }, 50_000_000n)).toBe(50_000_000n);
  });
});

describe("mining alerts and pool answers (second review)", () => {
  const PF = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
  const route = (map: Record<string, unknown>) =>
    (async (url: string) => {
      const hit = Object.entries(map).find(([k]) => String(url).includes(k));
      if (!hit) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  const miner = { data: { hourly_shares: { rolling_hashrates: [{ hours: 1, hashrate: 1e12 }] } } };
  it("a failed worker-list request is 'unknown', never an empty list: no worker is reported stopped from it", async () => {
    const seen = await c.minerState("pearlfortune", PF, route({ "?hours=24": miner, "/connections": { data: { online: 1, workers: [{ worker_name: "rig01", hashrate: 1e12, online: true }] } } }), Date.now());
    expect(seen.workersKnown).toBe(true);
    const memory = c.offlineCheck(seen, { offline: [], known: [] }, 10, Date.now() / 1000);
    expect(memory.known).toEqual(["rig01"]);
    const blind = await c.minerState("pearlfortune", PF, route({ "?hours=24": miner }), Date.now());
    expect(blind.workersKnown).toBe(false);
    expect(blind.workers).toEqual([]);
    const later = c.offlineCheck(blind, memory, 10, Date.now() / 1000 + 3600);
    expect(later.fresh).toEqual([]);
    expect(later.offline).toEqual([]);
    expect(later.known).toEqual(["rig01"]);
    const rates = { rates: { rig01: { avg: 1e12, n: 6, last: 1e12 } }, low: ["rig01"], pending: [] };
    const d = c.dropCheck(blind, rates, Date.now() / 1000 + 3600);
    expect(d.fresh).toEqual([]);
    expect(d.rates).toEqual(rates.rates);
    expect(d.low).toEqual(["rig01"]);
  });
  it("a pool answer is cut off at 4 MB before it is parsed", async () => {
    const chunk = new TextEncoder().encode("[" + "1,".repeat(100_000));
    const endless = new ReadableStream<Uint8Array>({ pull(ctrl) { ctrl.enqueue(chunk); } });
    const t = Date.now();
    await expect(c.readJsonCapped(new Response(endless))).rejects.toThrow(/too large/);
    expect(Date.now() - t).toBeLessThan(5000);
    await expect(c.readJsonCapped(new Response("{}", { headers: { "content-length": String(10 * 1024 * 1024) } }))).rejects.toThrow(/too large/);
    expect(await c.readJsonCapped(new Response(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect((await c.poolStatus("luckypool", (async () => new Response(endless)) as unknown as typeof fetch)).state).toBe("no-answer");
  });
});

describe("the Ethereum server must serve the chain being signed for", () => {
  const ME = "0x1111111111111111111111111111111111111111";
  const rpc = (chainId: unknown) =>
    new c.EthRpc((async (_u: unknown, init: { body: string }) => {
      const m = JSON.parse(init.body).method;
      const table: Record<string, unknown> = { eth_chainId: chainId, eth_getCode: "0x", eth_getTransactionCount: "0x1", eth_estimateGas: "0x5208", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: table[m] }));
    }) as unknown as typeof fetch, ["https://rpc.test"]);
  it("refuses to prepare a transaction on a server that is on another chain, or will not say", async () => {
    expect((await rpc("0x1").prepare(ME, ME, new Uint8Array(0))).nonce).toBe(1n);
    expect((await rpc("0xa4b1").prepare(ME, ME, new Uint8Array(0), 0n, { chainId: 42161n })).nonce).toBe(1n);
    await expect(rpc("0xa4b1").prepare(ME, ME, new Uint8Array(0))).rejects.toThrow(/serves chain 42161, not 1/);
    await expect(rpc("0x1").prepare(ME, ME, new Uint8Array(0), 0n, { chainId: 42161n })).rejects.toThrow(/serves chain 1, not 42161/);
    await expect(rpc(undefined).prepare(ME, ME, new Uint8Array(0))).rejects.toThrow(/unreadable answer|did not say/);
    await expect(rpc("mainnet").prepare(ME, ME, new Uint8Array(0))).rejects.toThrow(/did not say/);
  });
  it("refuses to sign from an address that delegates to a contract (EIP-7702), on every Ethereum action", async () => {
    const delegated = new c.EthRpc((async (_u: unknown, init: { body: string }) => {
      const m = JSON.parse(init.body).method;
      const table: Record<string, unknown> = { eth_chainId: "0x1", eth_getTransactionCount: "0x1", eth_estimateGas: "0x5208", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_getCode: "0xef0100" + "ab".repeat(20) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: table[m] }));
    }) as unknown as typeof fetch, ["https://rpc.test"]);
    await expect(delegated.prepare(ME, ME, new Uint8Array(0))).rejects.toThrow(/delegates to a contract/);
  });
});

describe("news feeds are bounded", () => {
  it("a feed is cut off at 2 MB before it is parsed, and no more than 200 stories are read from one", async () => {
    const chunk = new TextEncoder().encode("<item><title>x</title><link>https://a.example/x</link></item>".repeat(1000));
    const endless = new ReadableStream<Uint8Array>({ pull(ctrl) { ctrl.enqueue(chunk); } });
    await expect(c.readTextCapped(new Response(endless))).rejects.toThrow(/too large/);
    const many = "<rss>" + Array.from({ length: 500 }, (_, i) => `<item><title>t${i}</title><link>https://a.example/${i}</link></item>`).join("") + "</rss>";
    expect(c.parseRss(many, "media", "A").length).toBe(200);
  });
});

describe("worker names", () => {
  it("two workers with the same name stay two", () => {
    const w = (name: string) => ({ name, hashrate: 1, lastShare: 0, online: true });
    expect(c.distinctNames([w("rig"), w("rig"), w("other"), w("rig")]).map((x) => x.name)).toEqual(["rig", "rig #2", "other", "rig #3"]);
  });
});
