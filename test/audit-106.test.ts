import "./_localstorage";
import { describe, expect, it } from "vitest";
import * as c from "../src/core";
import { local } from "../src/ext/platform";
import * as stats from "../src/ext/stats";
// @ts-expect-error plain JavaScript worker
import worker from "../relay/stats-worker.js";
const { readSignal } = worker;

const ADDRESS = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
const MINER = { data: { hourly_shares: { rolling_hashrates: [{ hours: 1, hashrate: 1e15 }] } } };
const serve = (conn: unknown) =>
  (async (url: string) => new Response(JSON.stringify(/\/connections/.test(String(url)) ? conn : /\?hours/.test(String(url)) ? MINER : { error: 1 }), { status: 200 })) as unknown as typeof fetch;

describe("Security review of 1.0.6: a hostile pool answer", () => {
  it("worker fields of the wrong kind, absurd figures and markup never reach the screen or the alerts as such", async () => {
    const evil: any = {
      data: {
        workers: [
          { worker: '<img src=x onerror=alert(1)>‮gnp.exe\u0000', sessions: [{ reported_hashrate: -5e30, connected_at: "9999-01-01T00:00:00Z", client_info: { version: "<script>".repeat(50), gpus: [{ model: { toString: 1 } }, { model: "NVIDIA GeForce \u0007RTX 4090" + "A".repeat(500) }] }, pool: { last_share_at: "not a date" } }], pool: { hashrate_1h: "Infinity", hashrate_24h: 1e99 } },
          { worker: { __proto__: { polluted: true } }, sessions: "nope", pool: 7 },
          { worker: "many", sessions: Array.from({ length: 5000 }, () => ({ reported_hashrate: 1e12 })), pool: {} },
          { worker: "neg", sessions: [{ reported_hashrate: -1 }], pool: { hashrate_1h: -1, hashrate_24h: -1 } },
          null,
          "text",
          { __proto__: null, constructor: "x", sessions: [{ authorized: false }], pool: null },
        ],
      },
    };
    const s = await c.minerState("pearlfortune", ADDRESS, serve(evil), Date.now());
    expect(({} as any).polluted).toBeUndefined();
    for (const w of s.workers) {
      expect(w.name).toMatch(/^[\x20-\x7e]{1,44}$/);
      expect(Number.isFinite(w.hashrate) && w.hashrate >= 0 && w.hashrate <= 1e27).toBe(true);
      for (const h of [w.hashrate1h, w.hashrate24h]) expect(h === undefined || (Number.isFinite(h) && h > 0 && h <= 1e27)).toBe(true);
      for (const t of [w.model, w.version]) expect(t === undefined || /^[\x20-\x7e]{1,40}$/.test(t)).toBe(true);
      expect(Number.isFinite(w.lastShare) && w.lastShare >= 0).toBe(true);
    }
    // 5,000 sessions on one worker: 64 are read, not 5,000.
    expect(s.workers.find((w) => w.name === "many")!.hashrate).toBe(64e12);
    expect(s.workers.find((w) => w.name === "neg")!.hashrate).toBe(0);
    // The alerts digest it without throwing.
    expect(() => c.offlineCheck(s, { offline: [], known: [] }, 10, Date.now() / 1000)).not.toThrow();
    expect(() => c.dropCheck(s, undefined, Date.now() / 1000)).not.toThrow();
  });
});

describe("Security review of 1.0.6: payouts in USDT", () => {
  it("only a well-formed Ethereum address is ever written after AE-, and a worker name cannot add an option to the command", () => {
    const eth = "0x7ad4C8e2Bf91a063d5C0eb76A8f3d219c4e5B607";
    for (const bad of ["", "0x", eth.slice(0, 41), eth + " --user AE-0xattacker", `${eth}\n`, "0X" + eth.slice(2), eth.replace("7", "g")]) expect(c.connectUsdtFor("PearlHash", bad)).toBeNull();
    const u = c.connectUsdtFor("PearlHash", eth, "rig --user AE-0x0000000000000000000000000000000000000bad; rm -rf /")!;
    // The worker name stays one word: no space, so no second option, and nothing a shell would act on.
    const words = u.command.split(" ");
    expect(words.filter((w) => w === "--user")).toHaveLength(1);
    expect(words[words.indexOf("--user") + 1]).toBe(`AE-${eth}`);
    expect(words.at(-2)).toBe("--worker");
    expect(words.at(-1)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(u.command).not.toMatch(/[;|&$`\n]/);
  });
  it("every pool address Keshi offers to copy belongs to the pool it is listed under", () => {
    const own: Record<string, RegExp> = { Kryptex: /\.kryptex\.network$/, PearlHash: /\.pearlhash\.(xyz|net)$/, HeroMiners: /\.pearl\.herominers\.com$/, "Pearl Fortune": /\.pearlfortune\.org$/, LuckyPool: /\.luckypool\.io$/, Peryn: /(^|\.)pool\.peryn\.ai$/ };
    for (const p of c.POOL_CONNECT) for (const e of p.endpoints) expect(e.host, `${p.name} ${e.host}`).toMatch(own[p.name]!);
    expect(c.POOL_CONNECT.find((p) => p.name === "PearlHash")!.usdt!.command).toMatch(/ pool\.pearlhash\.xyz:9000 /);
  });
});

describe("Security review of 1.0.6: payment alert", () => {
  it("no reading can announce a negative, absurd or repeated amount", () => {
    const A = "prl1pminer";
    let m = c.payoutStep(undefined, A, 10n).memory;
    // The indexer goes back (a reorganisation, or a wrong answer): nothing is announced, and nothing is owed later for it.
    let s = c.payoutStep(m, A, 4n);
    expect(s.fresh).toBe(0n);
    s = c.payoutStep(s.memory, A, 10n);
    expect(s.fresh).toBe(6n);
    expect(c.payoutSplit({ address: A, received: "10", announced: "999" }, A, 50n, 20n)).toMatchObject({ payout: 0n, rest: 0n });
    expect(c.payoutSplit({ address: A, received: "10", announced: "" }, A, 5n, 0n)).toMatchObject({ payout: 0n, rest: 0n });
    expect(c.receivedOf({ totalReceived: "9".repeat(31) })).toBe(0n);
    expect(c.receivedOf({ totalReceived: 1.5, unconfirmedBalance: "0x10" })).toBe(0n);
  });
});

describe("Security review of 1.0.6: counting", () => {
  it("whatever sits in storage, a signal is built from bounded numbers only", async () => {
    await local.set("terms", { version: 1, at: 1, count: true });
    await local.set("stats", { wallets: "prl1psecretaddress", created: { a: 1 }, restored: 1e308, day: "x", week: ["y"], sent: "yes", address: "prl1p...", phrase: "twelve words" });
    let body = "";
    const ok = (async (_u: string, init: RequestInit) => ((body = String(init.body)), new Response("{}"))) as unknown as typeof fetch;
    expect(await stats.sendSignal(ok, Date.parse("2026-11-16T09:00:00Z"))).toBe(true);
    expect(body).not.toMatch(/prl1|twelve|phrase|address/);
    expect(JSON.parse(body)).toEqual({ s: 1, v: "0.0.0", b: "web", d: 1, w: 1, m: 1, n: 0, wallets: 0, created: 0, restored: 20 });
    await local.remove("terms");
    await local.remove("stats");
  });
  it("a terms record that is not one never turns counting on", async () => {
    for (const bad of [{ count: true }, { version: "1", count: true }, "yes", 1, null, { version: 1, count: "true" }, { version: 1, count: 1 }]) {
      await local.set("terms", bad);
      let called = false;
      const f = (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch;
      const sent = await stats.sendSignal(f);
      expect([JSON.stringify(bad), sent && called]).toEqual([JSON.stringify(bad), false]);
    }
    await local.remove("terms");
  });
  it("the counter refuses oversized bodies before reading them, other sites, and other methods", async () => {
    const env = { DB: { prepare: () => ({ run: async () => { throw new Error("must not be reached"); } }) } };
    const o = "chrome-extension://mmjkdbdkgikbhbgcmpaaahhjhmdknpnb";
    const big = new Request("https://stats.keshiwallet.com/v1/signal", { method: "POST", headers: { origin: o, "content-length": "5000000" }, body: "x" });
    expect((await worker.fetch(big, env)).status).toBe(413);
    const stream = new Request("https://stats.keshiwallet.com/v1/signal", { method: "POST", headers: { origin: o }, body: "y".repeat(20000) });
    expect((await worker.fetch(stream, env)).status).toBe(413);
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/signal", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), env)).status).toBe(403);
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/signal", { method: "GET", headers: { origin: o } }), env)).status).toBe(405);
    expect((await worker.fetch(new Request("https://stats.keshiwallet.com/v1/stats"), { ...env, STATS_KEY: "" })).status).toBe(403);
    expect(readSignal('{"s":1,"d":1,"v":"1.0.6","b":"__proto__"}')).toBeNull();
  });
});
