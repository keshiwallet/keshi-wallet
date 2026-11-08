import { describe, expect, it } from "vitest";
import * as c from "../src/core";

// Pearl Fortune's pages, as they answered on 4 November 2026 (trimmed).
const ADDRESS = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
const NOW = Date.parse("2026-11-04T20:30:00.000Z");
const SUMMARY = { data: { chain: "pearl", stats: { latest_height: 138443, network_hashrate: "103.83 EH/s" }, pool_stats: { rolling_stats: [{ hours: 0, hashrate: 0 }, { hours: 1, hashrate: 8613687335758720000, hashrate_str: "8.61 EH/s", block_count: 4 }, { hours: 24, hashrate: 7973653346993542000, block_count: 43 }], pool_fee_rate: 0.019999999995537317 }, pool_detail: { display_name: "Pearl Fortune", block_count: 43, total_reward: 94457.29 } } };
const MINER_IDLE = { data: { miner_address: "prl1p22mla...hs5es9k3", balances: null, pending_shares: { pps_pending_amount_q64: "0", pending_fee_quote: { rate: 0.019999999995537317 } }, hourly_shares: { hours: 24, series: [], rolling_hashrates: [{ hours: 1, hashrate: 0, hashrate_str: "0.00 H/s" }, { hours: 8, hashrate: 0 }, { hours: 24, hashrate: 0 }], credited_amount_by_window_atomic: { h1: 0, h8: 0, h24: 0 } } } };
const CONN_IDLE = { data: { configured: true, online: false, address: "prl1p22mla...hs5es9k3", workers: [] } };
const LEDGER_IDLE = { data: { chain_name: "pearl", address: ADDRESS, immature_q64: "0", remainder_q64: "0", balance_atomic: "0", atomic_units_per_coin: "100000000", entries: [] } };
const MODE_PPS = { data: { bridge: { address: ADDRESS, payment_mode: "pps", pps_fee_rate: 0.04 }, bridge_configured: true } };
// A mining address: the worker fields are read defensively, since the pool documents none.
const MINER = { data: { ...MINER_IDLE.data, hourly_shares: { ...MINER_IDLE.data.hourly_shares, rolling_hashrates: [{ hours: 1, hashrate: 1_200_000_000_000_000 }, { hours: 24, hashrate: 1_100_000_000_000_000 }] } } };
const CONN = { data: { configured: true, online: true, address: ADDRESS, workers: [{ worker_name: "G-10", hashrate: 800e12, last_seen: "2026-11-05T04:29:40+08:00" }, { worker_name: "wjr17", hashrate: 400e12, last_seen: "2026-11-05T04:29:10+08:00" }] } };
const LEDGER = { data: { ...LEDGER_IDLE.data, balance_atomic: "123456789012" } };
const MODE_PPLNS = { data: { bridge: { address: ADDRESS, payment_mode: "pplns" }, bridge_configured: true } };
const route = (map: Record<string, unknown>) =>
  (async (url: string) => {
    const u = String(url);
    const hit = Object.entries(map).find(([k]) => (k === "miner" ? /\/miners\/[^/?]+\?hours/.test(u) : u.includes(k)));
    return new Response(JSON.stringify(hit ? hit[1] : { error: "not_found" }), { status: hit ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

describe("Pearl Fortune pool (1.0.5)", () => {
  it("the summary page gives the dot its figures and both fees", async () => {
    const st = await c.poolStatus("pearlfortune", route({ "/summary": SUMMARY, "/pool-fee-rate": { data: { chain: "pearl", pool_fee_rate: 0.019999999995537317, pps_fee_rate: 0.04 } } }));
    expect(st).toEqual({ kind: "pearlfortune", state: "live", detail: "8.6 EH/s · 43 blocks in 24 h", fee: "2–4%", feeRate: 0.02, luck: undefined });
    // Without the fee page, the PPLNS fee from the summary.
    expect((await c.poolStatus("pearlfortune", route({ "/summary": SUMMARY }))).fee).toBe("2%");
    expect((await c.poolStatus("pearlfortune", route({}))).state).toBe("no-answer");
  });
  it("follows a mining address: rolling hashrate, connected workers, ledger balance, the fee of its mode", async () => {
    const s = await c.minerState("pearlfortune", ADDRESS, route({ miner: MINER, "/connections": CONN, "/ledger": LEDGER, "/address-mode": MODE_PPS }), NOW);
    expect(s.pool).toBe("pearlfortune");
    expect(s.hashrate).toBe(1_200_000_000_000_000);
    expect(s.workers.map((w) => [w.name, w.online, w.hashrate])).toEqual([
      ["G-10", true, 800e12],
      ["wjr17", true, 400e12],
    ]);
    expect(s.workers[0]!.lastShare).toBe(Math.floor(Date.parse("2026-11-05T04:29:40+08:00") / 1000));
    expect(s.hashrate24h).toBe(1_100_000_000_000_000);
    expect(s.unpaid).toBe(123456789012n); // 1,234.56789012 PRL, atomic units are grains
    expect(s.fee).toBe(0.04); // PPS mode
  });
  it("in PPLNS mode the fee is the pool's PPLNS quote", async () => {
    const s = await c.minerState("pearlfortune", ADDRESS, route({ miner: MINER, "/connections": CONN, "/ledger": LEDGER, "/address-mode": MODE_PPLNS }), NOW);
    expect(s.fee).toBeCloseTo(0.02, 6);
  });
  it("an idle address, exactly as the pool answered: zero, no workers, zero balance", async () => {
    const s = await c.minerState("pearlfortune", ADDRESS, route({ miner: MINER_IDLE, "/connections": CONN_IDLE, "/ledger": LEDGER_IDLE, "/address-mode": MODE_PPS }), NOW);
    expect(s.hashrate).toBe(0);
    expect(s.workers).toEqual([]);
    expect(s.unpaid).toBe(0n);
    expect(s.fee).toBe(0.04);
  });
  it("still answers when the side pages are missing; refuses when the main page is", async () => {
    const s = await c.minerState("pearlfortune", ADDRESS, route({ miner: MINER }), NOW);
    expect(s.hashrate).toBe(1_200_000_000_000_000);
    expect(s.workers).toEqual([]);
    expect(s.unpaid).toBeUndefined();
    await expect(c.minerState("pearlfortune", ADDRESS, route({ "/connections": CONN }), NOW)).rejects.toThrow();
  });
  it("a worker that leaves the connected list is reported stopped", async () => {
    const before = await c.minerState("pearlfortune", ADDRESS, route({ miner: MINER, "/connections": CONN }), NOW);
    const memory = c.offlineCheck(before, { offline: [], known: [] }, 10, NOW / 1000);
    const later = NOW + 11 * 60_000;
    const only = (at: number) => route({ miner: MINER, "/connections": { data: { ...CONN.data, workers: [{ ...CONN.data.workers[0], last_seen: new Date(at - 20_000).toISOString() }] } } });
    const after = await c.minerState("pearlfortune", ADDRESS, only(later), later);
    // Gone from the connected list: the chosen delay applies, as for an idle worker.
    const m2 = c.offlineCheck(after, memory, 10, later / 1000);
    expect(m2.fresh).toEqual([]);
    const afterwards = await c.minerState("pearlfortune", ADDRESS, only(later + 600_000), later + 600_000);
    expect(c.offlineCheck(afterwards, m2, 10, later / 1000 + 600).fresh).toEqual(["wjr17"]);
  });
  it("the guide and the pools list", () => {
    const by = Object.fromEntries(c.POOL_GUIDE.map((x) => [x.name, x]));
    expect(by["Pearl Fortune"]!.id).toBe("pearlfortune");
    expect(by["Pearl Fortune"]!.fee).toBe("2–4%");
    expect(c.POOLS.map((p) => p.id)).toEqual(["kryptex", "herominers", "peryn", "pearlhash", "pearlfortune", "luckypool"]);
    expect(c.POOL_GUIDE.filter((x) => !x.status).map((x) => x.name)).toEqual([]);
  });
});
