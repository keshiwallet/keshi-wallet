import { describe, expect, it } from "vitest";
import { balanceAt, valueSeries } from "../src/core/history";

const act = [
  { txid: "a", time: 1000, confirmations: 9, net: 500n, fee: 0n, kind: "received" as const },
  { txid: "b", time: 2000, confirmations: 9, net: -200n, fee: 10n, kind: "sent" as const },
  { txid: "c", time: 0, confirmations: 0, net: 100n, fee: 0n, kind: "received" as const },
];

describe("balance history", () => {
  it("walks the balance backwards through the wallet's own payments", () => {
    expect(balanceAt(400n, act, 2500)).toBe(300n); // pending 100 not yet there
    expect(balanceAt(400n, act, 1500)).toBe(500n); // before the send
    expect(balanceAt(400n, act, 500)).toBe(0n); // before anything
  });
  it("never goes negative when the history is cut short", () => {
    expect(balanceAt(100n, [{ txid: "x", time: 10, confirmations: 1, net: 1000n, fee: 0n, kind: "received" }], 5)).toBe(0n);
  });
  it("values each moment at that moment's price and ends now", () => {
    const big = act.map((a) => ({ ...a, net: a.net * 100000000n }));
    const pts = valueSeries(400_00000000n, big, [{ time: 1500, value: 2 }, { time: 2500, value: 4 }], 3000);
    expect(pts.map((p) => p.value)).toEqual([1000, 1200, 1600]);
    expect(pts[2]!.time).toBe(3000);
  });
  it("falls back to PRL, one point per day", () => {
    const pts = valueSeries(400_00000000n, act, null, 100_000, 7);
    expect(pts).toHaveLength(8);
    expect(pts[7]!.value).toBe(400);
  });
});
