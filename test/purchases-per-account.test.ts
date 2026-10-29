import "./_localstorage";
import { beforeEach, describe, expect, it } from "vitest";
import * as store from "../src/ui/store";
import * as core from "../src/core";
import { setDataKey, newDataKey, local } from "../src/ext/platform";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const buy = (txHash: string, from: string): store.UsdtPurchase => ({ txHash, chain: "arbitrum", amount: 50_000000n, to: "wprl", expected: 22_00000000n, at: Date.now(), from });

beforeEach(async () => {
  setDataKey(newDataKey());
  await local.remove("lifi");
  await local.remove("crossings");
});

describe("history per account", () => {
  it("shows each account only its own USDT purchases and bridge crossings", async () => {
    await store.recordPurchase(buy("0xaa", A));
    await store.recordPurchase(buy("0xbb", B));
    expect((await store.usdtPurchases(A)).map((p) => p.txHash)).toEqual(["0xaa"]);
    expect((await store.usdtPurchases(B.toUpperCase().replace("0X", "0x"))).map((p) => p.txHash)).toEqual(["0xbb"]);
    await store.addCrossing({ txid: "c1", eth: A, amount: 1n, at: 1 });
    await store.addCrossing({ txid: "c2", eth: B, amount: 2n, at: 2 });
    expect((await store.crossings(A)).map((c) => c.txid)).toEqual(["c1"]);
    expect((await store.crossings(B)).map((c) => c.txid)).toEqual(["c2"]);
  });
  it("a busy account never pushes another account's records out", async () => {
    await store.recordPurchase(buy("0xb0", B));
    for (let i = 0; i < 40; i++) await store.recordPurchase(buy("0xa" + i, A));
    expect((await store.usdtPurchases(A)).length).toBe(30);
    expect((await store.usdtPurchases(B)).length).toBe(1);
  });
  it("keeps how a purchase ended: a failure or a refund never becomes a neutral 'done'", () => {
    expect(store.purchaseOutcome({ status: "DONE" })).toBe("arrived");
    expect(store.purchaseOutcome({ status: "DONE", substatus: "PARTIAL" })).toBe("partial");
    expect(store.purchaseOutcome({ status: "DONE", substatus: "REFUNDED" })).toBe("refunded");
    expect(store.purchaseOutcome({ status: "DONE", substatus: "COMPLETED" })).toBe("arrived");
    // A way of finishing Keshi does not know is never announced as "arrived".
    expect(store.purchaseOutcome({ status: "DONE", substatus: "SOMETHING_NEW" })).toBe("partial");
    expect(store.purchaseOutcome({ status: "FAILED" })).toBe("failed");
    expect(store.purchaseOutcome({ status: "PENDING", substatus: "REFUND_IN_PROGRESS" })).toBeUndefined();
  });
});

describe("second step of a USDT purchase", () => {
  const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  it("is refused twice, and for another account's purchase", async () => {
    const mine = { phrase: ABANDON } as unknown as core.Secrets;
    const me = core.ethAccountOf(mine).address;
    const p: store.UsdtPurchase = { txHash: "0xd1", chain: "arbitrum", amount: 50_000000n, to: "usdt", expected: 49_000000n, at: Date.now(), from: me, done: true, outcome: "arrived" };
    await store.recordPurchase({ ...p, swapped: "0x" + "ee".repeat(32) });
    await expect(store.finishUsdtPurchase(mine, p, () => {})).rejects.toThrow(/already swapped/);
    await expect(store.finishUsdtPurchase(mine, { ...p, txHash: "0xd2", from: A }, () => {})).rejects.toThrow(/another account|Unknown purchase/);
  });
});

describe("how much USDT the second step swaps", () => {
  const p = (over: Partial<store.UsdtPurchase> = {}): store.UsdtPurchase => ({ txHash: "0xe1", chain: "arbitrum", amount: 50_000000n, to: "usdt", expected: 49_000000n, at: 0, from: A, ...over });
  it("swaps what arrived, never more than the address holds", () => {
    expect(store.usdtToSwap(p({ received: 48_900000n }), 1_000_000000n)).toBe(48_900000n);
    expect(store.usdtToSwap(p({ received: 48_900000n }), 10_000000n)).toBe(10_000000n);
    expect(store.usdtToSwap(p(), 1_000_000000n)).toBe(49_000000n);
  });
  it("ignores a reported amount far above the quote, so the user's other USDT is never swapped", () => {
    expect(store.usdtToSwap(p({ received: 900_000000n }), 1_000_000000n)).toBe(49_000000n);
  });
});
