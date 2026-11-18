import { describe, expect, it } from "vitest";
import * as c from "../src/core";
// @ts-expect-error plain JavaScript worker, no types
import worker from "../relay/stats-worker.js";
const { METRICS, mondayOf, readSignal } = worker;

/** A tiny stand-in for Cloudflare D1: enough for the worker's three statements. */
function fakeDb() {
  const counts = new Map<string, number>();
  const stmt = (sql: string, args: any[] = []) => ({
    bind: (...a: any[]) => stmt(sql, a),
    run: async () => {
      if (sql.startsWith("INSERT")) counts.set(`${args[0]}|${args[1]}`, (counts.get(`${args[0]}|${args[1]}`) ?? 0) + args[2]);
      return {};
    },
    all: async () => {
      const rows = [...counts].map(([k, n]) => ({ day: k.split("|")[0]!, metric: k.split("|")[1]!, n }));
      if (sql.includes("GROUP BY")) {
        const t: Record<string, number> = {};
        for (const r of rows) if (["new", "created", "restored"].includes(r.metric)) t[r.metric] = (t[r.metric] ?? 0) + r.n;
        return { results: Object.entries(t).map(([metric, n]) => ({ metric, n })) };
      }
      return { results: rows.filter((r) => r.day >= args[0]).sort((a, b) => a.day.localeCompare(b.day)) };
    },
  });
  return { counts, prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) };
}
const ORIGIN = "chrome-extension://mmjkdbdkgikbhbgcmpaaahhjhmdknpnb";
const post = (body: string, origin = ORIGIN) => new Request("https://stats.keshiwallet.com/v1/signal", { method: "POST", headers: { origin, "content-type": "text/plain" }, body });

describe("Keshi's counter (relay/stats-worker.js)", () => {
  it("accepts exactly what Keshi sends, and adds it to the day's totals", async () => {
    const env = { DB: fakeDb(), STATS_KEY: "s3cret-key" };
    const signal = c.nextSignal({ wallets: 2, created: 1 }, Date.now(), "1.0.6", "chrome")!;
    expect((await worker.fetch(post(JSON.stringify(signal)), env)).status).toBe(200);
    expect((await worker.fetch(post(JSON.stringify({ ...signal, n: 0, w: 0, m: 0, created: 0 })), env)).status).toBe(200);
    const day = new Date().toISOString().slice(0, 10);
    const got = Object.fromEntries([...env.DB.counts].map(([k, n]) => [k.replace(day + "|", ""), n]));
    expect(got).toEqual({ active: 2, week_first: 1, month_first: 1, new: 1, wallets: 4, created: 1, "version:1.0.6": 2, "browser:chrome": 2 });
    // The totals are read with the key only.
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats"), env)).status).toBe(403);
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats", { headers: { authorization: "Bearer wrong-key!" } }), env)).status).toBe(403);
    const r = await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats?days=7", { headers: { authorization: "Bearer s3cret-key" } }), env);
    expect(await r.json()).toMatchObject({ today: { active: 2, wallets: 4 }, activeThisWeek: 1, activeThisMonth: 1, installsCountedEver: 1, walletsCreatedEver: 1, walletsRestoredEver: 0 });
  });
  it("drops anything that is not a Keshi signal, and stores no free text", async () => {
    const env = { DB: fakeDb() };
    for (const bad of ["", "{}", "[]", '{"s":1,"d":1,"v":"1.0.6","b":"safari"}', '{"s":1,"d":1,"v":"<b>","b":"chrome"}', '{"s":2,"d":1,"v":"1.0.6","b":"chrome"}', "x".repeat(400)])
      expect((await worker.fetch(post(bad), env)).status).toBe(400);
    expect((await worker.fetch(post('{"s":1,"d":1,"v":"1.0.6","b":"chrome"}', "https://evil.example"), env)).status).toBe(403);
    expect(env.DB.counts.size).toBe(0);
    // Extra fields are ignored and numbers bounded: an address slipped into a signal would not be stored.
    const s = readSignal('{"s":1,"d":1,"v":"1.0.6","b":"chrome","address":"prl1p...","wallets":99999,"created":-4,"w":"yes"}');
    expect(s).toEqual({ v: "1.0.6", b: "chrome", w: 0, m: 0, n: 0, wallets: 50, created: 0, restored: 0 });
    expect(METRICS(s).map((m: [string, number]) => m[0])).toEqual(["active", "wallets", "version:1.0.6", "browser:chrome"]);
  });
  it("the totals can be read from an extension page with the key, and a website gets no permission to read them", async () => {
    const env = { DB: fakeDb(), STATS_KEY: "s3cret-key" };
    const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const pre = await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats", { method: "OPTIONS", headers: { origin: ext } }), env);
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toEqual([204, ext, "authorization"]);
    const ok = await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats", { headers: { origin: ext, authorization: "Bearer s3cret-key" } }), env);
    expect([ok.status, ok.headers.get("access-control-allow-origin")]).toEqual([200, ext]);
    const site = await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats", { headers: { origin: "https://evil.example", authorization: "Bearer s3cret-key" } }), env);
    expect(site.headers.get("access-control-allow-origin")).toBeNull();
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats", { headers: { origin: ext } }), env)).status).toBe(403);
  });
  it("a week starts on Monday", () => {
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
  });
});
