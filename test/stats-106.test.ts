import "./_localstorage";
import { beforeEach, describe, expect, it } from "vitest";
import * as c from "../src/core";
import { local } from "../src/ext/platform";
import * as stats from "../src/ext/stats";

const at = (iso: string) => Date.parse(iso);

describe("Counting wallets: what a signal holds (1.0.6)", () => {
  it("names the UTC day, ISO week and month", () => {
    expect(c.statsPeriods(at("2026-11-16T17:00:00Z"))).toEqual({ day: "2026-11-16", week: "2026-W47", month: "2026-11" });
    // A week belongs to the year of its Thursday.
    expect(c.statsPeriods(at("2027-01-01T00:00:00Z")).week).toBe("2026-W53");
    expect(c.statsPeriods(at("2024-12-30T12:00:00Z")).week).toBe("2025-W01");
    // UTC, whatever the clock of the computer says.
    expect(c.statsPeriods(at("2026-11-16T23:59:59Z")).day).toBe("2026-11-16");
  });
  it("one signal a day, marked first of the week and month only once, and first ever only once", () => {
    let st: c.StatsState = { wallets: 2, created: 1 };
    const mon = at("2026-11-16T09:00:00Z");
    const s1 = c.nextSignal(st, mon, "1.0.6", "chrome")!;
    expect(s1).toEqual({ s: 1, v: "1.0.6", b: "chrome", d: 1, w: 1, m: 1, n: 1, wallets: 2, created: 1, restored: 0 });
    st = c.afterSignal(st, s1, mon);
    expect(c.nextSignal(st, at("2026-11-16T22:00:00Z"), "1.0.6", "chrome")).toBeNull();
    const s2 = c.nextSignal(st, at("2026-11-17T09:00:00Z"), "1.0.6", "chrome")!;
    expect([s2.d, s2.w, s2.m, s2.n, s2.created]).toEqual([1, 0, 0, 0, 0]);
    st = c.afterSignal(st, s2, at("2026-11-17T09:00:00Z"));
    const s3 = c.nextSignal(st, at("2026-12-01T09:00:00Z"), "1.0.6", "chrome")!;
    expect([s3.w, s3.m, s3.n]).toEqual([1, 1, 0]);
  });
  it("holds nothing but the listed fields, and bounds every number", () => {
    const s = c.nextSignal({ wallets: 9999, created: -3, restored: 1e9 }, at("2026-11-16T09:00:00Z"), "<script>", "chrome")!;
    expect(Object.keys(s).sort()).toEqual(["b", "created", "d", "m", "n", "restored", "s", "v", "w", "wallets"]);
    expect([s.v, s.wallets, s.created, s.restored]).toEqual(["0.0.0", 50, 0, 20]);
    // No address, key, name or time can be in it: only short words and small numbers.
    expect(JSON.stringify(s).length).toBeLessThan(120);
  });
  it("a wallet created while a signal is on its way is still counted the next day", () => {
    const now = at("2026-11-16T09:00:00Z");
    const sent = c.nextSignal({ created: 1 }, now, "1.0.6", "chrome")!;
    expect(c.afterSignal({ created: 2 }, sent, now).created).toBe(1);
  });
});

describe("Counting wallets: only with the user's tick (1.0.6)", () => {
  let calls: { url: string; init: RequestInit }[];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  beforeEach(async () => {
    calls = [];
    await local.remove("terms");
    await local.remove("stats");
  });

  it("terms not accepted, or accepted without the tick: nothing is counted and nothing is sent", async () => {
    expect(stats.termsAccepted(await stats.getTerms())).toBe(false);
    await stats.noteWallet("created");
    expect(await stats.sendSignal(ok)).toBe(false);
    await stats.acceptTerms(false);
    expect(stats.termsAccepted(await stats.getTerms())).toBe(true);
    await stats.noteWallet("created");
    await stats.noteWalletCount(3);
    expect(await stats.sendSignal(ok)).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await local.get("stats")).toBeUndefined();
  });
  it("with the tick: one signal a day, to Keshi's counter only, without cookies or referrer", async () => {
    await stats.acceptTerms(true);
    await stats.noteWallet("created");
    await stats.noteWallet("restored");
    await stats.noteWalletCount(2);
    const day1 = at("2026-11-16T09:00:00Z");
    expect(await stats.sendSignal(ok, day1)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://stats.keshiwallet.com/v1/signal");
    expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ s: 1, v: "0.0.0", b: "web", d: 1, w: 1, m: 1, n: 1, wallets: 2, created: 1, restored: 1 });
    // Same day: nothing more. Next day: one more, counters back to zero.
    expect(await stats.sendSignal(ok, day1 + 5 * 3_600_000)).toBe(false);
    expect(await stats.sendSignal(ok, day1 + 24 * 3_600_000)).toBe(true);
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ n: 0, w: 0, m: 0, created: 0, restored: 0, wallets: 2 });
  });
  it("a counter that does not answer is asked once an hour at most, and loses nothing", async () => {
    await stats.acceptTerms(true);
    await stats.noteWallet("created");
    const down = (async () => {
      calls.push({ url: "", init: {} });
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const t = at("2026-11-16T09:00:00Z");
    expect(await stats.sendSignal(down, t)).toBe(false);
    expect(await stats.sendSignal(down, t + 60_000)).toBe(false);
    expect(calls).toHaveLength(1);
    const refused = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await stats.sendSignal(refused, t + 3_700_000)).toBe(false);
    expect(await stats.sendSignal(ok, t + 7_400_000)).toBe(true);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toMatchObject({ created: 1, n: 1 });
  });
  it("turning it off in Settings forgets the numbers and stops the signals", async () => {
    await stats.acceptTerms(true);
    await stats.noteWallet("created");
    await stats.setCounting(false);
    expect(await local.get("stats")).toBeUndefined();
    expect(await stats.sendSignal(ok)).toBe(false);
    expect((await stats.getTerms())!.count).toBe(false);
    expect(stats.termsAccepted(await stats.getTerms())).toBe(true); // the terms stay accepted
    expect(calls).toHaveLength(0);
  });
});
