import { describe, expect, it } from "vitest";
import * as c from "../src/core";

const ADDRESS = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
const NET = { hashrate: 82e18, blockSeconds: 194 };
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const route = (map: Record<string, unknown>) =>
  (async (url: string) => {
    const hit = Object.entries(map).find(([k]) => String(url).includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : { error: "not_found" }), { status: hit ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("connecting a miner (1.0.5)", () => {
  it("every pool that can be followed has connection details, and the address and worker fill the placeholders", () => {
    for (const p of c.POOL_GUIDE.filter((x) => x.id)) {
      const r = c.connectFor(p.name, ADDRESS, "rig 07!");
      expect(r, p.name).not.toBeNull();
      expect(r!.connect.endpoints.length).toBeGreaterThan(0);
      expect(r!.user).toContain(ADDRESS);
      expect(r!.user).not.toContain("ADDRESS");
      expect(r!.command).toContain(ADDRESS);
      expect(r!.command).not.toMatch(/ADDRESS|WORKER/);
      if (r!.connect.user.includes("WORKER")) expect(r!.user).toMatch(new RegExp(`^${ADDRESS}[./]rig07$`));
      for (const e of r!.connect.endpoints) {
        expect(e.host).toMatch(/^[a-z0-9.-]+$/);
        expect(e.port).toBeGreaterThan(0);
      }
    }
    const lucky = c.connectFor("LuckyPool", ADDRESS, "rig1")!;
    expect(lucky.connect.endpoints.length).toBe(19);
    expect(lucky.user).toBe(`${ADDRESS}.rig1`);
    expect(lucky.command).toContain(`--wallet ${ADDRESS} --worker rig1`);
    expect(c.connectFor("Nowhere", ADDRESS)).toBeNull();
    expect(c.cleanWorker("")).toBe("rig01");
    expect(c.cleanWorker("my rig <1>")).toBe("myrig1");
  });
  it("Peryn and PearlHash offer TLS; the Kryptex solo prefix is documented", () => {
    const peryn = c.connectFor("Peryn", ADDRESS)!.connect;
    expect(peryn.endpoints.every((e) => e.tlsPort === 3443)).toBe(true);
    expect(peryn.options!.some((o) => /mode=pplns/.test(o))).toBe(true);
    expect(c.connectFor("PearlHash", ADDRESS)!.connect.endpoints.every((e) => e.tlsPort === 9443)).toBe(true);
    expect(c.connectFor("Kryptex", ADDRESS)!.connect.options!.some((o) => /solo:/.test(o))).toBe(true);
    expect(c.connectFor("Kryptex", ADDRESS, "7358")!.user).toBe(`${ADDRESS}/7358`); // wallet/worker, as pool.kryptex.com writes it
  });
});

describe("Kryptex as it really answers (1.0.5)", () => {
  // Three entries of a 3,445-worker farm's /prl/api/v3/miner/workers answer, 6 November 2026, as given.
  const NOW = 1793928720000;
  const RESULTS = [
    { miner: "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r", worker: "1867", scheme: "pps", status: "offline", opened_at: 1793928707700, coin: "prl", last_share: 1793901129991, last_active: 1793928707729, valid: 1816, stale: 3, invalid: 0, avg_hashrate_24h: "189630734309882.69", avg_hashrate_3h: "0", avg_hashrate_30m: "0", agent: "ForgeMiner/1.8.8", latest_agent: "ForgeMiner/1.9.1", country: "CN", legacy_port: false, ru_v1: false, server_geo: "hk-16" },
    { miner: "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r", worker: "7358", scheme: "pps", status: "online", opened_at: 1793928688258, coin: "prl", last_share: 1793928710017, last_active: 1793928710014, valid: 3389, stale: 3, invalid: 0, avg_hashrate_24h: "352156470862442.95", avg_hashrate_3h: "337769972052787.21", avg_hashrate_30m: "205163983024655.9288888888889", agent: "ForgeMiner/1.8.8", latest_agent: "ForgeMiner/1.9.1", country: "CN", legacy_port: false, ru_v1: false, server_geo: "hk-16" },
    { miner: "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r", worker: "10038", scheme: "pps", status: "online", opened_at: 1793928700000, coin: "prl", last_share: 1793928715000, last_active: 1793928715000, valid: 182, stale: 0, invalid: 0, avg_hashrate_24h: "18760000000000", avg_hashrate_3h: "25000000000000", avg_hashrate_30m: "25020000000000", agent: "ForgeMiner/1.8.8", latest_agent: "ForgeMiner/1.9.1", country: "CN", legacy_port: false, ru_v1: false, server_geo: "hk-16" },
  ];
  const f = route({ "/miner/workers/": { results: RESULTS }, "/miner/balance/": { total: 5757.01, unconfirmed: 5757.01, confirmed: 0 }, "/pool/info": { fee: 0.03, fee_type: "pps+" } });
  it("reads the 30-minute hashrate, the status, and the time of last share in milliseconds", async () => {
    const s = await c.minerState("kryptex", "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r", f, NOW);
    expect(s.workers.map((w) => [w.name, w.online, Math.round(w.hashrate / 1e12)])).toEqual([
      ["1867", false, 0],
      ["7358", true, 205],
      ["10038", true, 25],
    ]);
    expect(s.workers[0]!.lastShare).toBe(1793901129);
    expect(s.hashrate).toBeCloseTo(205163983024655.93 + 25020000000000, -6);
    expect(s.hashrate24h).toBeCloseTo(189630734309882.69 + 352156470862442.95 + 18760000000000, -6);
    expect(s.fee).toBe(0.03);
    expect(s.unpaid).toBe(575_701_000_000n);
    // The offline alert sees the stopped worker, and only it.
    expect(c.offlineCheck(s, { offline: [], known: [] }, 10, NOW / 1000).offline).toEqual(["1867"]);
  });
  it("keeps every worker of a big farm, so the totals and the alerts cover all of them, whatever the order", async () => {
    const many = Array.from({ length: 3445 }, (_, i) => ({ ...RESULTS[1], worker: String(i), avg_hashrate_30m: "1000000000000", avg_hashrate_24h: "1000000000000" }));
    const s = await c.minerState("kryptex", "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r", route({ "/miner/workers/": { results: many } }), NOW);
    expect(s.workers.length).toBe(3445);
    expect(s.hashrate).toBe(3445e12);
    expect(s.hashrate24h).toBe(3445e12);
    // The pool reorders its list between two checks: nobody is "gone".
    const memory = c.offlineCheck(s, { offline: [], known: [] }, 10, NOW / 1000);
    expect(memory.known.length).toBe(3445);
    const shuffled = { ...s, workers: [...s.workers].reverse() };
    expect(c.offlineCheck(shuffled, memory, 10, NOW / 1000 + 120).fresh).toEqual([]);
    expect(s.workers[1]!.since).toBe(Math.floor(1793928688258 / 1000));
  });
  it("a worker that leaves a connected-only list is announced after the chosen delay, not at once", async () => {
    const w = (name: string) => ({ name, hashrate: 1e12, lastShare: 0, online: true });
    const t0 = NOW / 1000;
    const m1 = c.offlineCheck({ workers: [w("a"), w("b")] }, { offline: [], known: [] }, 10, t0);
    // b reconnects and misses one check: nothing yet.
    const m2 = c.offlineCheck({ workers: [w("a")] }, m1, 10, t0 + 120);
    expect(m2.fresh).toEqual([]);
    expect(m2.offline).toEqual([]);
    // Still gone after the delay: announced once.
    const m3 = c.offlineCheck({ workers: [w("a")] }, m2, 10, t0 + 120 + 600);
    expect(m3.fresh).toEqual(["b"]);
    expect(c.offlineCheck({ workers: [w("a")] }, m3, 10, t0 + 1000).fresh).toEqual([]);
    // Back: cleared, and a later disappearance starts the delay again.
    const m4 = c.offlineCheck({ workers: [w("a"), w("b")] }, m3, 10, t0 + 1100);
    expect(m4.offline).toEqual([]);
    expect(c.offlineCheck({ workers: [w("a")] }, m4, 10, t0 + 1200).fresh).toEqual([]);
  });
});

describe("real cost (1.0.5)", () => {
  it("expected blocks follow the pool's share of the network", () => {
    // 1% of the network over 24 h, one block every 194 s: about 4.45 blocks.
    expect(c.expectedBlocks(0.82e18, NET, 24)).toBeCloseTo(4.453, 2);
    expect(c.expectedBlocks(0, NET, 24)).toBe(0);
    expect(c.expectedBlocks(1e18, { hashrate: 0, blockSeconds: 194 }, 24)).toBe(0);
  });
  it("PPS schemes cost the fee; PPLNS and PROP add the luck, only with enough blocks", () => {
    expect(c.realCost(0.01, "PPS+ / SOLO")).toEqual({ pct: 1 });
    expect(c.realCost(0.01, "PPS+ / PPLNS")).toEqual({ pct: 1 });
    expect(c.realCost(0.01, "PPLNS")).toBeNull();
    expect(c.realCost(0.01, "PPLNS", { found: 10, expected: 12, hours: 24 })).toBeNull(); // too few
    const r = c.realCost(0.02, "PPLNS / PPS", { found: 43, expected: 45, hours: 24 })!;
    expect(r.luckPct).toBeCloseTo(95.56, 1);
    expect(r.pct).toBeCloseTo(100 - 98 * (43 / 45), 2);
    // Lucky pool: the real cost can be under the fee, never under zero.
    expect(c.realCost(0.01, "PROP", { found: 60, expected: 50, hours: 168 })!.pct).toBeGreaterThanOrEqual(0);
    expect(c.realCost(0.01, "PROP", { found: 60, expected: 50, hours: 168 })!.pct).toBe(0);
  });
  it("Pearl Fortune's summary gives a 24-hour luck when the network is known", async () => {
    const SUMMARY = { data: { pool_stats: { rolling_stats: [{ hours: 1, hashrate: 8.6e18, block_count: 4 }, { hours: 24, hashrate: 8e18, block_count: 43 }], pool_fee_rate: 0.02 }, pool_detail: { block_count: 43 } } };
    const st = await c.poolStatus("pearlfortune", route({ "/summary": SUMMARY, "/pool-fee-rate": { data: { pool_fee_rate: 0.02, pps_fee_rate: 0.04 } } }), NET);
    expect(st.feeRate).toBe(0.02);
    expect(st.luck).toEqual({ found: 43, expected: c.expectedBlocks(8e18, NET, 24), hours: 24 });
    expect(st.luck!.expected).toBeCloseTo(43.44, 1);
    // When the weekly view answers, a week's luck is preferred.
    const WEEK = { data: { pool_stats: { rolling_stats: [{ hours: 168, hashrate: 7.9e18, block_count: 290 }] } } };
    const wk = await c.poolStatus("pearlfortune", route({ "hours=168": WEEK, "/summary": SUMMARY }), NET);
    expect(wk.luck).toEqual({ found: 290, expected: c.expectedBlocks(7.9e18, NET, 168), hours: 168 });
    // Without the network: no luck, everything else as before.
    expect((await c.poolStatus("pearlfortune", route({ "/summary": SUMMARY }))).luck).toBeUndefined();
  });
  it("Peryn pays per share: its real cost is its fee, and its blocks are not fetched", async () => {
    const now = Date.parse("2026-11-06T00:00:00Z");
    const POOL = { fees: { fpps: { open: true, feePct: 1 }, pplns: { open: true, feePct: 1 } }, stratum: [{ status: "up" }], pool: { hashrate10m: 4e17, hashrate24h: 3.8e17, miners: 700, workers: 720, blocksFound: 30 }, payouts: { minimumPrl: "1", schedule: "every 2 hours" } };
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(POOL), { status: 200 }); }) as unknown as typeof fetch;
    const st = await c.poolStatus("peryn", f, NET, now);
    expect(st.state).toBe("live");
    expect(st.feeRate).toBe(0.01);
    expect(st.luck).toBeUndefined();
    expect(urls).toEqual(["https://app.peryn.ai/api/v1/pool"]);
    expect(c.realCost(0.01, "PPS+ / PPLNS")).toEqual({ pct: 1 });
  });
  it("HeroMiners: its own weekly effort is the luck, its real hashrate the figure, as its stats page answers", async () => {
    // Trimmed from pearl.herominers.com/api/stats, 6 November 2026.
    const NOW = 1793930100000;
    const STATS = { config: { fee: 0, minPaymentThreshold: "100000000", paymentsInterval: 3600, rewardScheme: "prop" }, pool: { hashrate: 893470638, realHashrate: 3837427170146255000, miners: 3604, workers: 11206, totalBlocks: 5785, effort_1d: 1.1995730454234828, effort_7d: 1.0590667226743722, blocks: ["5eaa085a:1793918577:3483803834379:4294165345075:4293966063206:5eaa085a:pending:219255370533:prl1p85ve:eu-es:prop:", "138940"] } };
    const st = await c.poolStatus("herominers", answer(STATS), NET, NOW);
    expect(st.fee).toBe("0%");
    expect(st.feeRate).toBe(0);
    expect(st.detail).toBe("3.8 EH/s · 3,604 miners · paid every hour from 1 PRL");
    expect(st.luck).toEqual({ found: 100 / 1.0590667226743722, expected: 100, hours: 168 });
    const cost = c.realCost(0, "PROP", st.luck)!;
    expect(cost.luckPct).toBeCloseTo(94.4, 1);
    expect(cost.pct).toBeCloseTo(5.6, 1);
    // Without realHashrate, the scaled figure is read at 2^32 hashes a unit; without effort, no luck.
    const bare = await c.poolStatus("herominers", answer({ config: { fee: 0.9 }, pool: { hashrate: 893470638 } }), NET, NOW);
    expect(bare.detail).toBe("3.8 EH/s");
    expect(bare.luck).toBeUndefined();
    // The effort is shown only with enough blocks in all, one found in the last week, and a figure a week can give.
    const gate = async (pool: Record<string, unknown>) => (await c.poolStatus("herominers", answer({ config: { fee: 0 }, pool: { ...STATS.pool, ...pool } }), NET, NOW)).luck;
    expect(await gate({ totalBlocks: 19 })).toBeUndefined();
    expect(await gate({ blocks: ["5eaa085a:1793000000:1:1:1", "100"] })).toBeUndefined();
    expect(await gate({ blocks: [] })).toBeUndefined();
    expect(await gate({ effort_7d: 0.05 })).toBeUndefined();
    expect(await gate({ effort_7d: 11 })).toBeUndefined();
    expect(await gate({ effort_7d: 0.1 })).toEqual({ found: 1000, expected: 100, hours: 168 });
  });
  it("Kryptex: hashrate, miners and minimum payout from its pool page, as it answers", async () => {
    const INFO = { miners: 32775, workers: 113802, hashrate: 3.9415693259952185e19, net_hashrate: 97852475731497580000, fee_type: "PPS+", fee: 0.03, minpay: 1.0, commission: { "PPS+": 0.03, SOLO: 0.01 }, servers: [{ geo: "Global", urls: ["prl.kryptex.network:7048"], ssl_urls: ["prl.kryptex.network:8048"] }] };
    const st = await c.poolStatus("kryptex", answer(INFO), NET);
    expect(st).toMatchObject({ state: "live", fee: "3%", feeRate: 0.03, detail: "39.4 EH/s · 32,775 miners · paid from 1 PRL" });
    // Every server Keshi lists for Kryptex is one Kryptex lists.
    const hosts = new Set(["prl", "prl-eu", "prl-us", "prl-br", "prl-sg", "prl-hk", "prl-ru", "prl-ae"].map((h) => `${h}.kryptex.network`));
    for (const e of c.connectFor("Kryptex", "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3")!.connect.endpoints) expect(hosts.has(e.host), e.host).toBe(true);
  });
});

describe("hashrate drop alert (1.0.5)", () => {
  const w = (name: string, hashrate: number, online = true, since?: number) => ({ name, hashrate, lastShare: 0, online, since });
  const T = 1_800_000_000;
  const mem = (r: ReturnType<typeof c.dropCheck>): c.RateMemory => ({ rates: r.rates, low: r.low, pending: r.pending });
  it("learns each worker's usual hashrate, then announces a drop once, after two low checks in a row", () => {
    let m: c.RateMemory | undefined;
    for (let i = 0; i < 6; i++) {
      const r = c.dropCheck({ workers: [w("rig01", 400e12), w("rig02", 300e12)] }, m, T + i * 120);
      expect(r.fresh).toEqual([]);
      m = mem(r);
    }
    expect(m!.rates.rig01!.avg).toBeCloseTo(400e12, -9);
    // rig01 loses a card: 220 of 400. First check: noted, not announced.
    const d1 = c.dropCheck({ workers: [w("rig01", 220e12), w("rig02", 300e12)] }, m, T + 720);
    expect(d1.fresh).toEqual([]);
    expect(d1.pending).toEqual(["rig01"]);
    expect(d1.low).toEqual([]);
    // Still low: announced once.
    const d2 = c.dropCheck({ workers: [w("rig01", 220e12), w("rig02", 300e12)] }, mem(d1), T + 840);
    expect(d2.fresh).toEqual([{ name: "rig01", now: 220e12, usual: m!.rates.rig01!.avg }]);
    expect(d2.low).toEqual(["rig01"]);
    // Still low on the next: not announced again, the average not dragged down.
    const d3 = c.dropCheck({ workers: [w("rig01", 220e12), w("rig02", 300e12)] }, mem(d2), T + 960);
    expect(d3.fresh).toEqual([]);
    expect(d3.low).toEqual(["rig01"]);
    expect(d3.rates.rig01!.avg).toBeCloseTo(400e12, -9);
    // Back over 80% of usual: cleared (the climb itself teaches nothing), and learning resumes on the next steady reading.
    const d4 = c.dropCheck({ workers: [w("rig01", 390e12), w("rig02", 300e12)] }, mem(d3), T + 1080);
    expect(d4.low).toEqual([]);
    const d5 = c.dropCheck({ workers: [w("rig01", 390e12), w("rig02", 300e12)] }, mem(d4), T + 1200);
    expect(d5.rates.rig01!.avg).toBeLessThan(400e12);
  });
  it("a blip of one check, a small dip, an offline worker, or a worker just started never trigger it", () => {
    let m: c.RateMemory | undefined;
    for (let i = 0; i < 6; i++) m = mem(c.dropCheck({ workers: [w("rig01", 400e12)] }, m, T + i * 120));
    const blip = c.dropCheck({ workers: [w("rig01", 100e12)] }, m, T + 720);
    expect(blip.pending).toEqual(["rig01"]);
    expect(c.dropCheck({ workers: [w("rig01", 400e12)] }, mem(blip), T + 840).pending).toEqual([]);
    expect(c.dropCheck({ workers: [w("rig01", 300e12)] }, m, T + 720).pending).toEqual([]); // 75%, above the 60% line
    expect(c.dropCheck({ workers: [w("rig01", 0, false)] }, m, T + 720).fresh).toEqual([]); // the offline alert's business
    expect(c.dropCheck({ workers: [w("rig01", 0, false)] }, m, T + 720).rates.rig01).toEqual(m!.rates.rig01); // remembered for when it is back
    expect(c.dropCheck({ workers: [w("new", 10e12)] }, m, T + 720).fresh).toEqual([]);
    // Two readings are not a habit yet.
    const young = c.dropCheck({ workers: [w("rig02", 400e12)] }, mem(c.dropCheck({ workers: [w("rig02", 400e12)] }, undefined, T)), T + 120);
    expect(c.dropCheck({ workers: [w("rig02", 100e12)] }, mem(young), T + 240).pending).toEqual([]);
  });
  it("a restart ramps up from zero: not a drop while the worker is young or its reading climbs", () => {
    let m: c.RateMemory | undefined;
    for (let i = 0; i < 6; i++) m = mem(c.dropCheck({ workers: [w("rig01", 400e12)] }, m, T + i * 120));
    // Kryptex says when the worker connected: under 30 minutes, nothing is judged and the average is left alone.
    let r = c.dropCheck({ workers: [w("rig01", 40e12, true, T + 700)] }, m, T + 720);
    expect(r.pending).toEqual([]);
    expect(r.rates.rig01!.avg).toBeCloseTo(400e12, -9);
    // Without that time: a reading climbing more than 15% over the last one is a ramp, not a drop.
    r = c.dropCheck({ workers: [w("rig01", 40e12)] }, m, T + 720); // first low reading: pending
    expect(r.pending).toEqual(["rig01"]);
    r = c.dropCheck({ workers: [w("rig01", 90e12)] }, mem(r), T + 840); // climbing: not announced
    expect(r.fresh).toEqual([]);
    expect(r.pending).toEqual([]);
    r = c.dropCheck({ workers: [w("rig01", 180e12)] }, mem(r), T + 960);
    expect(r.fresh).toEqual([]);
    expect(r.rates.rig01!.avg).toBeCloseTo(400e12, -9); // ramp readings taught it nothing
  });
  it("a farm-wide throttle is one event: every worker in fresh, for the one notification", () => {
    const farm = (h: number) => ({ workers: Array.from({ length: 1000 }, (_, i) => w(`r${i}`, h)) });
    let m: c.RateMemory | undefined;
    for (let i = 0; i < 6; i++) m = mem(c.dropCheck(farm(400e12), m, T + i * 120));
    const a = c.dropCheck(farm(100e12), m, T + 720);
    expect(a.fresh.length).toBe(0);
    expect(a.pending.length).toBe(1000);
    const b = c.dropCheck(farm(100e12), mem(a), T + 840);
    expect(b.fresh.length).toBe(1000);
    expect(c.dropCheck(farm(100e12), mem(b), T + 960).fresh.length).toBe(0);
  });
});

describe("hostile pool answers (1.0.5 audit)", () => {
  const ADDR = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
  it("a 1 MB digit string as an amount or a founding note is dropped in milliseconds, not matched for minutes", async () => {
    const big = "9".repeat(1_000_000);
    const t = Date.now();
    const s = await c.minerState("peryn", ADDR, route({ "/miner/": { hashrate1h: 1, workers: [], balance: { owedPrl: big + "x", pendingPrl: big, paidPrl: "1.5" } }, "/pool": { fees: { fpps: { feePct: 1 } }, founding: big } }), Date.now());
    expect(s.unpaid).toBe(0n);
    expect(s.paid).toBe(150_000_000n);
    const st = c.parsePeryn({ fees: { fpps: { feePct: 1 }, founding: big }, stratum: [{ status: "up" }], pool: {} });
    expect(st.founding).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(500);
  });
  it("absurd numbers are not believed and never throw", async () => {
    const s = await c.minerState("kryptex", ADDR, route({ "/miner/workers/": { results: [] }, "/miner/balance/": { total: 1e305, paid: Infinity } }), Date.now());
    expect(s.unpaid).toBe(0n);
    expect(s.paid).toBeUndefined();
    const p = await c.minerState("peryn", ADDR, route({ "/miner/": { workers: [], balance: { owedPrl: 1e305 } } }), Date.now());
    expect(p.unpaid).toBe(0n);
  });
  it("second audit: no figure reaches Infinity, a huge balance string is not a balance, long numbers group in one pass", async () => {
    // HeroMiners multiplies by 2^32: a 1e305 hashrate must not become Infinity on its way to the screen.
    const h = await c.minerState("herominers", ADDR, answer({ stats: { hashrate: 1e305, hashrate_24h: "1e400", balance: 0, paid: 0, lastShare: 0 }, workers: {} }), Date.now());
    expect(Number.isFinite(h.hashrate)).toBe(true);
    expect(h.hashrate24h === undefined || Number.isFinite(h.hashrate24h)).toBe(true);
    expect(c.formatHashrate(Infinity)).toBe("0 H/s");
    expect(c.formatHashrate(NaN)).toBe("0 H/s");
    expect(c.parseHashrate("1e400")).toBeNull();
    expect(c.parseHashrate("999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999 EH/s")).toBeNull();
    expect(c.expectedPerDay(1e308, { hashrate: 1e-300, blockSeconds: 1e-300, subsidy: 10n ** 30n }, 0)).toBe(0n);
    expect(() => c.expectedBlocks(1e308, { hashrate: 1e-300, blockSeconds: 1e-300 }, 1e300)).not.toThrow();
    // Pearl Fortune's balance_atomic: more than 18 digits is not believed.
    const pf = (bal: string) => c.minerState("pearlfortune", ADDR, route({ "/ledger": { data: { balance_atomic: bal } }, "/connections": { data: { online: 0, workers: [] } }, "/address-mode": { data: {} }, "?hours=24": { data: { hourly_shares: [] } } }), Date.now());
    expect((await pf("123456789012345678")).unpaid).toBe(123456789012345678n);
    expect((await pf("1234567890123456789")).unpaid).toBeUndefined();
    const t = Date.now();
    expect((await pf("9".repeat(1_000_000))).unpaid).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(500);
    // Thousands grouping without the quadratic regex.
    expect(c.groupThousands("1")).toBe("1");
    expect(c.groupThousands("123")).toBe("123");
    expect(c.groupThousands("1234")).toBe("1,234");
    expect(c.groupThousands("1234567")).toBe("1,234,567");
    expect(c.formatPrl(123456789012345678n)).toBe("1,234,567,890.12345678");
    expect(c.formatPrl(-100000000n)).toBe("-1.00");
    const t2 = Date.now();
    expect(c.formatPrl(10n ** 200n).length).toBeGreaterThan(200);
    expect(Date.now() - t2).toBeLessThan(200);
  });
  it("second audit: a worker missing for a week is forgotten; one that goes off while low is still low when it comes back", () => {
    const w = (name: string, hashrate: number, online = true) => ({ name, hashrate, lastShare: 0, online });
    const t0 = 1_800_000_000;
    let m = c.offlineCheck({ workers: [w("a", 1), w("b", 1)] }, { offline: [], known: [] }, 10, t0);
    expect(m.known).toEqual(["a", "b"]);
    // b leaves the list: announced after the delay, then forgotten after a week.
    m = c.offlineCheck({ workers: [w("a", 1)] }, m, 10, t0 + 60);
    m = c.offlineCheck({ workers: [w("a", 1)] }, m, 10, t0 + 11 * 60);
    expect(m.offline).toEqual(["b"]);
    m = c.offlineCheck({ workers: [w("a", 1)] }, m, 10, t0 + 6 * 86400);
    expect(m.offline).toEqual(["b"]);
    expect(m.known).toEqual(["a", "b"]);
    m = c.offlineCheck({ workers: [w("a", 1)] }, m, 10, t0 + 60 + c.FORGET_SECONDS);
    expect(m.offline).toEqual([]);
    expect(m.known).toEqual(["a"]);
    expect(m.idleSince).toEqual({});
    expect(m.total).toBe(1);
    // Hashrate memory: a low worker that goes offline and comes back as low is not announced twice.
    let d = c.dropCheck({ workers: [w("a", 100)] }, undefined, t0);
    for (let i = 1; i < 6; i++) d = c.dropCheck({ workers: [w("a", 100)] }, { rates: d.rates, low: d.low, pending: d.pending }, t0 + i * 120);
    d = c.dropCheck({ workers: [w("a", 40)] }, { rates: d.rates, low: d.low, pending: d.pending }, t0 + 6 * 120);
    d = c.dropCheck({ workers: [w("a", 40)] }, { rates: d.rates, low: d.low, pending: d.pending }, t0 + 7 * 120);
    expect(d.fresh.map((x) => x.name)).toEqual(["a"]);
    d = c.dropCheck({ workers: [w("a", 0, false)] }, { rates: d.rates, low: d.low, pending: d.pending }, t0 + 8 * 120);
    expect(d.low).toEqual(["a"]);
    d = c.dropCheck({ workers: [w("a", 40)] }, { rates: d.rates, low: d.low, pending: d.pending }, t0 + 9 * 120);
    expect(d.low).toEqual(["a"]);
    expect(d.fresh).toEqual([]);
  });
  it("second audit: a LuckyPool candidate block (fewer fields, not orphaned) counts as found", async () => {
    const NOW = 1793961300000;
    const STATS = { config: { fee: 1 }, stats: { hashrate: 5e18, miners: 10 }, pool: { blocks: ["0xaaaa:1793955077:1:1", "139174", "0xbbbb:1793952814:1:1:0:219129544135:0", "139164", "0xcccc:1793950000:1:1:1:2:0", "139100"] } };
    const st = await c.poolStatus("luckypool", answer(STATS), { hashrate: 73e18, blockSeconds: 205 }, NOW);
    expect(st.luck!.found).toBe(2);
  });
});

describe("EIP-7702 delegation (1.0.5)", () => {
  it("recognises a delegation designator and nothing else", () => {
    expect(c.delegationOf("0xef0100" + "ab".repeat(20))).toBe("0x" + "ab".repeat(20));
    expect(c.delegationOf("0xEF0100" + "AB".repeat(20))).toBe("0x" + "ab".repeat(20));
    expect(c.delegationOf("0x")).toBeNull();
    expect(c.delegationOf("0x6080604052")).toBeNull(); // an ordinary contract
    expect(c.delegationOf("0xef0100" + "ab".repeat(19))).toBeNull(); // too short
    expect(c.delegationOf("")).toBeNull();
  });
  it("reads it from the address's code", async () => {
    const rpc = new c.EthRpc((async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xef0100" + "cd".repeat(20) }), { status: 200 })) as unknown as typeof fetch, ["https://rpc.example"]);
    expect(await rpc.delegation("0x" + "11".repeat(20))).toBe("0x" + "cd".repeat(20));
    const clean = new c.EthRpc((async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200 })) as unknown as typeof fetch, ["https://rpc.example"]);
    expect(await clean.delegation("0x" + "11".repeat(20))).toBeNull();
  });
});

describe("every host the pools code fetches is in the manifest (1.0.5 audit)", () => {
  it("pool status and miner pages", async () => {
    const fs = await import("node:fs");
    const manifest = JSON.parse(fs.readFileSync(new URL("../static/manifest.base.json", import.meta.url), "utf8"));
    const allowed = new Set<string>((manifest.host_permissions as string[]).map((h) => new URL(h.replace("*", "")).host));
    const csp = String(manifest.content_security_policy.extension_pages);
    const seen = new Set<string>();
    const rec = (async (url: string) => { seen.add(new URL(String(url)).host); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const addr = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
    for (const p of c.POOL_GUIDE) if (p.status) await c.poolStatus(p.status, rec, { hashrate: 1e18, blockSeconds: 194 });
    for (const p of c.POOLS) await c.minerState(p.id, addr, rec).catch(() => {});
    expect(seen.size).toBeGreaterThanOrEqual(5);
    for (const h of seen) {
      expect(allowed.has(h), `${h} in host_permissions`).toBe(true);
      expect(csp.includes(`https://${h}`), `${h} in connect-src`).toBe(true);
    }
    for (const p of c.POOLS) expect(allowed.has(new URL(p.host).host), p.host).toBe(true);
  });
});

describe("HeroMiners as it really answers (1.0.5)", () => {
  // Trimmed from pearl.herominers.com/api/stats_address for a miner with 31 workers, 6 November 2026.
  const REAL = {"stats": {"hashes": "7476925335687", "lastShare": "1793931708", "balance": "163194872", "paid": "979160662088", "blocksFound": "4", "firstSeen": "1783248399", "hashrate": 747984, "hashrate_1h": 756897.2, "hashrate_6h": 778393.1666666666, "hashrate_24h": 789825.5166666667, "payments_24h": 3543925144, "payments_7d": 25544248506}, "workers": [{"name": "vm12TB_S6P1NX0TB20848L", "hashrate": 0, "region": "eu-es", "agent": "SRBMiner-MULTI/3.8.3", "lastShare": 1793885863, "hashrate_1h": 0, "hashrate_24h": 8097.458333333333}, {"name": "3070ti", "hashrate": 0, "region": "eu-es", "agent": "peakminer/2.20.6", "lastShare": 1793926671, "hashrate_1h": 0, "hashrate_24h": 122457.925}, {"name": "30s", "hashrate": 132820, "region": "eu-es", "agent": "peakminer/2.20.4", "lastShare": 1793931686, "hashrate_1h": 128450.6, "hashrate_24h": 132615.99166666667}, {"name": "3060ti", "hashrate": 143305, "region": "eu-es", "agent": "peakminer/2.20.4", "lastShare": 1793931708, "hashrate_1h": 151519.4, "hashrate_24h": 146465.93333333332}]};
  const POOL = { config: { fee: 0 }, pool: { realHashrate: 3837427170146255000 } };
  const NOW = 1793931720000;
  it("hashrates are in units of 2^32 hashes; balances in grains; who is online by the time of last share", async () => {
    const s = await c.minerState("herominers", "prl1p85ve2thqyr4wkesav9ul3z7unt4md38u8w0zez5r5nt4hed58j4sp5na37", route({ "stats_address": REAL, "/api/stats": POOL }), NOW);
    expect(s.hashrate).toBeCloseTo(747984 * 4294967296, -9); // 3.2 PH/s, as the pool's page shows
    expect(c.formatHashrate(s.hashrate)).toBe("3.2 PH/s");
    expect(s.hashrate24h).toBeCloseTo(789825.5166666667 * 4294967296, -9);
    expect(s.unpaid).toBe(163194872n); // 1.63 PRL
    expect(s.paid).toBe(979160662088n); // 9,791 PRL
    expect(s.fee).toBe(0);
    const by = Object.fromEntries(s.workers.map((w) => [w.name, w]));
    expect(c.formatHashrate(by["3060ti"]!.hashrate)).toBe("615 TH/s");
    expect(by["3060ti"]!.online).toBe(true);
    expect(by["3070ti"]!.online).toBe(false); // last share 84 minutes before
    expect(by["vm12TB_S6P1NX0TB20848L"]!.online).toBe(false);
    expect(by["3070ti"]!.lastShare).toBe(1793926671);
    expect(c.offlineCheck(s, { offline: [], known: [] }, 10, NOW / 1000).offline.sort()).toEqual(["3070ti", "vm12TB_S6P1NX0TB20848L"]);
  });
});

describe("LuckyPool as it really answers (1.0.5)", () => {
  const ADDR = "prl1p0euqzs6ct6q9a5r0d53uhvlauwupz2zd246p5rmvgt2w488cf9xs8cum0r";
  // pearl.luckypool.io/api/stats (trimmed) and stats_address for an address that mined there in October, 6 November 2026.
  const STATS = { config: { fee: 1, coinUnits: 100000000, minPaymentThreshold: 100000000, paymentInterval: 7200, paymentMode: "prop", ports: [{ port: 3360, tcp: true, tls: true }] }, stats: { miners: 4118, workers: 22630, hashrate: 5707910470150776000 }, network: { height: 139203, difficulty: 231549842742923870, blockTime: 205.48, hashrate: 73440259217507020000 }, pool: { hashrate: "5707910470150776000", miners: "4118", workers: "22630", blocks: ["0xe57e:1793955077:231731954886546240:195569136288006140:0:219123992367:0", "139174", "0xa427:1793952814:231945901403458020:85108975851143170:0:219129544135:0", "139164", "0xdead:1793940000:1:1:1:219129544135:0", "139100"] } };
  const MINER = { stats: { wallet: ADDR, lastShare: "1791492868603", acceptedShares: "18", hashes: "55667940", hashrate: 0, paid: 0, paymentThreshold: 500000000, unlocked: 2096285, locked: 0, hashrateAvg: { "24h": 0, "6h": 0, "1h": 0 } }, workers: [], payments: [], rewards: [{ height: 125117, minerReward: 2096285 }] };
  const NOW = 1793961300000;
  it("the pool page gives the dot its figures, fee and a two-day luck from its blocks", async () => {
    const st = await c.poolStatus("luckypool", answer(STATS), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW);
    expect(st.state).toBe("live");
    expect(st.fee).toBe("1%");
    expect(st.feeRate).toBe(0.01);
    expect(st.detail).toBe("5.7 EH/s · 4,118 miners · paid every 2 hours from 1 PRL");
    expect(st.luck!.found).toBe(2); // the third block is orphaned
    expect(st.luck!.hours).toBeCloseTo((NOW / 1000 - 1793940000) / 3600, 3);
    // With its block stats page (6 November 2026), the week's effort is preferred: 1.1069 → 90% luck over 7 days.
    const day = (block: number, effort = 1) => ({ date: 1793923199, effort, block, solo: 0, orphan: 0, uncle: 0, label: "05-Nov" });
    const BLOCKS = { avg24h: 1.0813, avg7d: 1.1069, avg30d: 1.0481, data: [day(24), day(20), day(28), day(13), day(22), day(22), day(23), day(25), day(33), day(36), day(15)] };
    const withWeek = await c.poolStatus("luckypool", route({ "block-stats": BLOCKS, "/api/stats": STATS }), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW);
    expect(withWeek.luck).toEqual({ found: 100 / 1.1069, expected: 100, hours: 168 });
    expect(withWeek.detail).toBe("5.7 EH/s · 4,118 miners · paid every 2 hours from 1 PRL");
    // Too few blocks that week, an effort no week can give, or no page at all: back to the two-day figure.
    expect((await c.poolStatus("luckypool", route({ "block-stats": { ...BLOCKS, data: [day(3), day(2)] }, "/api/stats": STATS }), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW)).luck!.found).toBe(2);
    expect((await c.poolStatus("luckypool", route({ "block-stats": { ...BLOCKS, avg7d: 0.01 }, "/api/stats": STATS }), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW)).luck!.found).toBe(2);
    expect((await c.poolStatus("luckypool", route({ "block-stats": "<html>", "/api/stats": STATS }), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW)).luck!.found).toBe(2);
    expect((await c.poolStatus("luckypool", route({ "/api/stats": STATS }), { hashrate: 73440259217507020000, blockSeconds: 205.48 }, NOW)).luck!.found).toBe(2);
  });
  it("an address that mined once: balance owed in grains, no workers, last share in milliseconds", async () => {
    const s = await c.minerState("luckypool", ADDR, route({ "stats_address": MINER, "/api/stats": STATS }), NOW);
    expect(s.pool).toBe("luckypool");
    expect(s.hashrate).toBe(0);
    expect(s.workers).toEqual([]);
    expect(s.unpaid).toBe(2096285n); // 0.02 PRL
    expect(s.paid).toBeUndefined();
    expect(s.fee).toBe(0.01);
  });
  it("workers as pools of this kind list them", async () => {
    const mining = { ...MINER, stats: { ...MINER.stats, hashrate: 157774569269164, hashrateAvg: { "24h": 150e12 }, locked: 100000000 }, workers: [{ name: "rig1", hashrate: 157774569269164, lastShare: (NOW - 30_000) / 1000 }, { name: "rig2", hashrate: 0, lastShare: (NOW - 3_600_000) / 1000 }] };
    const s = await c.minerState("luckypool", ADDR, route({ "stats_address": mining, "/api/stats": STATS }), NOW);
    expect(s.workers.map((w) => [w.name, w.online])).toEqual([["rig1", true], ["rig2", false]]);
    expect(s.hashrate24h).toBe(150e12);
    expect(s.unpaid).toBe(102096285n);
  });
});
