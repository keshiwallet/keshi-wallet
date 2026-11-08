import { describe, expect, it } from "vitest";
import * as c from "../src/core";

// Peryn's documented API (docs.peryn.ai, "Pool API" v1), as it answered on 3 November 2026 (trimmed).
const POOL = {
  v: 1,
  name: "Peryn Pool",
  coin: "PEARL",
  algorithm: "pearlhash",
  network: "mainnet",
  unit: "MAC/s",
  fees: { pplns: { open: true, feePct: 1 }, fpps: { open: true, feePct: 1 }, founding: "Founding Miners Season 1: 0% on PPLNS until Pearl's FP8 upgrade and for 6 months after it; 0.5% on PPS+." },
  payouts: { minimumPrl: "1.00000000", schedule: "every 2 hours", coinbaseMaturityBlocks: 100 },
  stratum: [
    { region: "eu", label: "Europe", location: "Frankfurt", host: "pool.peryn.ai", tcpPort: 3333, tlsPort: 3443, status: "up" },
    { region: "us-east", label: "US East", location: "New York", host: "us-east.pool.peryn.ai", tcpPort: 3333, tlsPort: 3443, status: "up" },
    { region: "tokyo", label: "Japan", location: "Tokyo", host: "tokyo.pool.peryn.ai", tcpPort: 3333, tlsPort: 3443, status: "down" },
  ],
  pool: { hashrate10m: 382555399402978700, hashrate24h: 133649277268108140, miners: 734, workers: 755, blocksFound: 0, lastBlock: null },
  networkStats: { hashrate: 82159037307064500000, difficulty: 51933843.55147143, height: 137955 },
  updatedAt: "2026-11-03T21:33:55.209Z",
};
const ADDRESS = "prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp";
// An address the pool has never seen, exactly as answered.
const MINER_EMPTY = { v: 1, address: ADDRESS, network: "mainnet", unit: "MAC/s", hashrate1h: 0, hashrate24h: 0, workersOnline: 0, workersOffline: 0, workers: [], balance: { owedPrl: "0.00000000", pendingPrl: "0.00000000", paidPrl: "0.00000000" }, payouts: [], updatedAt: "2026-11-03T21:38:04.192Z" };
// A mining address, with the fields the documentation lists for workers.
const NOW = Date.parse("2026-11-03T21:40:00.000Z");
const MINER = {
  ...MINER_EMPTY,
  hashrate1h: 2_400_000_000_000,
  hashrate24h: 2_100_000_000_000,
  workersOnline: 1,
  workersOffline: 1,
  workers: [
    { name: "rig01", online: true, hashrate1h: 2_400_000_000_000, hashrate24h: 2_100_000_000_000, lastShare: "2026-11-03T21:39:10.000Z" },
    { name: "rig02", online: false, hashrate1h: 0, hashrate24h: 900_000_000_000, lastShare: "2026-11-03T18:02:00.000Z" },
  ],
  balance: { owedPrl: "12.34567891", pendingPrl: "0.50000000", paidPrl: "100.00000000" },
  payouts: [{ time: "2026-11-03T20:00:00.000Z", amountPrl: "20.00000000", status: "sent", txids: ["ab"] }],
};
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const route = (map: Record<string, unknown>) =>
  (async (url: string) => {
    const hit = Object.entries(map).find(([k]) => String(url).includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : { error: "not_found" }), { status: hit ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("Peryn pool (1.0.5)", () => {
  it("reads the pool page", () => {
    const s = c.parsePeryn(POOL);
    expect(s.live).toBe(true);
    expect(s.hashrate).toBe(382555399402978700);
    expect(s.miners).toBe(734);
    expect(s.workers).toBe(755);
    expect(s.blocksFound).toBe(0);
    expect(s.fee).toBe(0.01);
    expect(s.payout).toBe("paid every 2 hours, from 1 PRL");
    expect(s.regionsUp).toBe(2);
    expect(s.regions).toBe(3);
    expect(s.networkHashrate).toBe(82159037307064500000);
    expect(s.networkDifficulty).toBeCloseTo(51933843.55, 1);
    expect(s.founding).toBe("0% PPLNS, 0.5% PPS+");
    expect(s.servers).toEqual({ "pool.peryn.ai": true, "us-east.pool.peryn.ai": true, "tokyo.pool.peryn.ai": false });
    expect(c.parsePeryn({ ...POOL, fees: { ...POOL.fees, founding: undefined } }).founding).toBeUndefined();
  });
  it("shows a live pool with its figures and fee", async () => {
    const st = await c.poolStatus("peryn", answer(POOL));
    expect(st.state).toBe("live");
    expect(st.fee).toBe("1%");
    expect(st.servers!["tokyo.pool.peryn.ai"]).toBe(false);
    expect(st.detail).toBe("383 PH/s · 734 miners · paid every 2 hours, from 1 PRL · 2/3 regions up · Founding Miners 0% PPLNS, 0.5% PPS+");
    expect((await c.poolStatus("peryn", answer({ ...POOL, stratum: POOL.stratum.map((r) => ({ ...r, status: "up" })) }))).detail).toBe("383 PH/s · 734 miners · paid every 2 hours, from 1 PRL · Founding Miners 0% PPLNS, 0.5% PPS+");
  });
  it("is 'coming' while no region is up and nobody mines", async () => {
    const st = await c.poolStatus("peryn", answer({ ...POOL, stratum: POOL.stratum.map((r) => ({ ...r, status: "down" })), pool: { ...POOL.pool, miners: 0 } }));
    expect(st.state).toBe("coming");
  });
  it("is 'no answer' when the page fails, is not JSON, or is empty: never an error on screen", async () => {
    expect((await c.poolStatus("peryn", answer({ nope: 1 }, 503))).state).toBe("no-answer");
    expect((await c.poolStatus("peryn", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).state).toBe("no-answer");
    expect((await c.poolStatus("peryn", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).state).toBe("no-answer");
    expect(c.parsePeryn({}).live).toBe(false);
    expect(c.parsePeryn({ pool: { hashrate10m: "x", miners: -3 }, stratum: [null, 1, {}] }).miners).toBe(0);
  });
  it("follows a miner: workers, who is online as Peryn says, the balance owed", async () => {
    const s = await c.minerState("peryn", ADDRESS, route({ "/miner/": MINER, "/pool": POOL }), NOW);
    expect(s.pool).toBe("peryn");
    expect(s.hashrate).toBe(2_400_000_000_000);
    expect(s.workers.map((w) => [w.name, w.online, w.lastShare])).toEqual([
      ["rig01", true, Math.floor(Date.parse("2026-11-03T21:39:10.000Z") / 1000)],
      ["rig02", false, Math.floor(Date.parse("2026-11-03T18:02:00.000Z") / 1000)],
    ]);
    expect(s.unpaid).toBe(1_284_567_891n); // 12.34567891 owed + 0.5 pending, to the grain
    expect(s.paid).toBe(10_000_000_000n); // 100 PRL paid so far
    expect(s.hashrate24h).toBe(2_100_000_000_000);
    expect(s.fee).toBe(0.01);
    // The offline alert counts the stopped worker, as for the other pools.
    const chk = c.offlineCheck(s, { offline: [], known: [] }, 10, NOW / 1000);
    expect(chk.offline).toEqual(["rig02"]);
    expect(chk.fresh).toEqual(["rig02"]);
  });
  it("an address the pool has never seen: zero, no workers, no balance to show as unpaid", async () => {
    const s = await c.minerState("peryn", ADDRESS, route({ "/miner/": MINER_EMPTY, "/pool": POOL }), NOW);
    expect(s.hashrate).toBe(0);
    expect(s.workers).toEqual([]);
    expect(s.unpaid).toBe(0n);
    expect(s.paid).toBeUndefined();
    expect(s.hashrate24h).toBeUndefined();
  });
  it("still answers when the pool page is missing (no fee), and refuses a bad address or a refused request", async () => {
    const s = await c.minerState("peryn", ADDRESS, route({ "/miner/": MINER }), NOW);
    expect(s.fee).toBeUndefined();
    expect(s.workers.length).toBe(2);
    await expect(c.minerState("peryn", "bc1qnotpearl", route({}), NOW)).rejects.toThrow("not a Pearl address");
    await expect(c.minerState("peryn", ADDRESS, answer({ error: "invalid_address" }, 400), NOW)).rejects.toThrow();
  });
  it("Kryptex and HeroMiners answer with their fee, or no answer", async () => {
    expect(await c.poolStatus("kryptex", answer({ fee: 1, fee_type: "pps+" }))).toEqual({ kind: "kryptex", state: "live", fee: "1%", feeRate: 0.01 });
    // As Kryptex really answers (30 October 2026): a fraction.
    expect(await c.poolStatus("kryptex", answer({ fee: 0.03, fee_type: "pps+" }))).toEqual({ kind: "kryptex", state: "live", fee: "3%", feeRate: 0.03 });
    expect(await c.poolStatus("herominers", answer({ config: { fee: 0.9 }, pool: {} }))).toMatchObject({ kind: "herominers", state: "live", fee: "0.9%" });
    // 0% is a fee too (HeroMiners, November 2026); a missing fee is not.
    expect(await c.poolStatus("herominers", answer({ config: { fee: 0 }, pool: {} }))).toMatchObject({ fee: "0%", feeRate: 0 });
    expect((await c.poolStatus("herominers", answer({ config: {}, pool: {} }))).fee).toBeUndefined();
    expect((await c.poolStatus("herominers", answer({}, 404))).state).toBe("no-answer");
    // A fee that cannot be a fee is dropped; with nothing else readable, the page did not answer (second review, November 2026).
    expect(await c.poolStatus("kryptex", answer({ fee: 99 }))).toEqual({ kind: "kryptex", state: "no-answer" });
    expect(await c.poolStatus("kryptex", answer({ fee: 99, hashrate: 5e18, miners: 10 }))).toMatchObject({ state: "live", fee: undefined });
    expect(await c.poolStatus("luckypool", answer({}))).toEqual({ kind: "luckypool", state: "no-answer" });
    expect(await c.poolStatus("pearlfortune", answer({ data: {} }))).toEqual({ kind: "pearlfortune", state: "no-answer" });
  });
  it("the guide: the three pools with a public miner page can be followed and get the dot", () => {
    const by = Object.fromEntries(c.POOL_GUIDE.map((p) => [p.name, p]));
    expect(by.Kryptex!.id).toBe("kryptex");
    expect(by.HeroMiners!.id).toBe("herominers");
    expect(by.Peryn!.id).toBe("peryn");
    expect(by.Peryn!.status).toBe("peryn");
    expect(by.Peryn!.soon).toBeUndefined();
    
    expect(c.POOLS.map((p) => p.id)).toEqual(["kryptex", "herominers", "peryn", "pearlhash", "pearlfortune", "luckypool"]);
  });
});
