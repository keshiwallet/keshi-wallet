import { describe, it, expect } from "vitest";
import { Exchange } from "../src/core/exchange";

/** A fake SafeTrade: `markets` is what /public/markets answers, and only those market ids answer tickers. */
function fakeSafeTrade(markets: any[] | null, log: string[] = []) {
  const fetcher = (async (input: any) => {
    const url = String(input);
    log.push(url);
    const ok = (body: any) => new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith("/public/markets")) return markets ? ok(markets) : new Response("down", { status: 503 });
    const m = url.match(/\/public\/markets\/([a-z]+)\/(tickers|depth|k-line)/);
    const ids = (markets ?? [{ id: "pearlusdt" }]).map((x) => x.id);
    if (!m || !ids.includes(m[1])) return new Response("not found", { status: 404 });
    if (m[2] === "tickers") return ok({ ticker: { last: "1.90", high: "2", low: "1.8", vol: "100", price_change_percent: "+1.0%" } });
    if (m[2] === "depth") return ok({ asks: [["1.91", "10"]], bids: [["1.89", "10"]] });
    return ok([[1, 0, 0, 0, 1.9, 0], [2, 0, 0, 0, 1.91, 0]]);
  }) as unknown as typeof fetch;
  return { fetcher, log };
}
const PEARL = [{ id: "pearlusdt", base_unit: "pearl", quote_unit: "usdt", state: "enabled" }, { id: "pearlusdc", base_unit: "pearl", quote_unit: "usdc", state: "enabled" }];
const PRL = [{ id: "prlusdt", base_unit: "prl", quote_unit: "usdt", state: "enabled" }];

describe("SafeTrade after the PRL -> PEARL ticker change", () => {
  it("finds the pair under its new name from the market list", async () => {
    (Exchange as any).known.clear();
    const { fetcher, log } = fakeSafeTrade(PEARL);
    const t = await new Exchange(fetcher, undefined, "usdt").ticker();
    expect(t.last).toBe(1.9);
    expect(log.some((u) => u.includes("/markets/pearlusdt/tickers"))).toBe(true);
    expect(log.some((u) => u.includes("/markets/prlusdt/"))).toBe(false);
  });
  it("still works with the old name, for an exchange that never renamed", async () => {
    (Exchange as any).known.clear();
    const { fetcher } = fakeSafeTrade(PRL);
    expect((await new Exchange(fetcher, undefined, "usdt").book(5)).asks[0]![0]).toBe(1.91);
  });
  it("tries both names when the market list is unavailable", async () => {
    (Exchange as any).known.clear();
    const { fetcher, log } = fakeSafeTrade(null);
    expect((await new Exchange(fetcher, undefined, "usdt").candles(60, 2)).length).toBe(2);
    expect(log.filter((u) => u.includes("/markets/pearlusdt/k-line")).length).toBe(1);
  });
  it("reads the market list once, not on every price refresh", async () => {
    (Exchange as any).known.clear();
    const { fetcher, log } = fakeSafeTrade(PEARL);
    const x = new Exchange(fetcher, undefined, "usdc");
    await x.ticker(); await x.ticker(); await x.book(3);
    expect(log.filter((u) => u.endsWith("/public/markets")).length).toBe(1);
    expect(log.filter((u) => u.includes("pearlusdc")).length).toBe(3);
  });
});

import { BigOne, forgetBigOnePair } from "../src/core/bigone";
function fakeBigOne(pairs: any[] | null, log: string[] = []) {
  const fetcher = (async (input: any) => {
    const url = String(input); log.push(url);
    const ok = (data: any) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
    if (url.endsWith("/asset_pairs")) return pairs ? ok(pairs) : new Response("down", { status: 503 });
    const m = url.match(/\/asset_pairs\/([A-Z]+-USDT)\/(ticker|depth|candles)/);
    const names = (pairs ?? [{ name: "PEARL-USDT" }]).map((x) => x.name);
    if (!m || !names.includes(m[1])) return new Response(JSON.stringify({ code: 10001, message: "not found" }), { status: 200 });
    if (m[2] === "ticker") return ok({ close: "1.9", open: "1.8", high: "2", low: "1.7", volume: "5", bid: { price: "1.89" }, ask: { price: "1.91" } });
    if (m[2] === "depth") return ok({ asks: [{ price: "1.91", quantity: "3" }], bids: [{ price: "1.89", quantity: "3" }] });
    return ok([{ time: "2026-10-18T00:00:00Z", close: "1.9" }]);
  }) as unknown as typeof fetch;
  return { fetcher, log };
}
describe("BigONE, should it rename PRL too", () => {
  const PRL = [{ name: "PRL-USDT", base_asset: { symbol: "PRL" }, quote_asset: { symbol: "USDT" } }];
  const PEARL = [{ name: "PEARL-USDT", base_asset: { symbol: "PEARL" }, quote_asset: { symbol: "USDT" } }];
  it("works today under PRL-USDT", async () => {
    forgetBigOnePair();
    const { fetcher, log } = fakeBigOne(PRL);
    expect((await new BigOne(fetcher).ticker()).last).toBe(1.9);
    expect(log.some((u) => u.includes("/asset_pairs/PRL-USDT/ticker"))).toBe(true);
  });
  it("follows a rename to PEARL-USDT from the pair list", async () => {
    forgetBigOnePair();
    const { fetcher, log } = fakeBigOne(PEARL);
    expect((await new BigOne(fetcher).book(2)).asks[0]![0]).toBe(1.91);
    expect(log.some((u) => u.includes("/asset_pairs/PEARL-USDT/depth"))).toBe(true);
    expect(log.some((u) => u.includes("/asset_pairs/PRL-USDT/"))).toBe(false);
  });
  it("without the list, tries both names and keeps the one that answers", async () => {
    forgetBigOnePair();
    const { fetcher, log } = fakeBigOne(null); // only PEARL-USDT answers
    expect((await new BigOne(fetcher).candles(60, 1)).length).toBe(1);
    expect(log.filter((u) => u.includes("/asset_pairs/PEARL-USDT/candles")).length).toBe(1);
  });
});
