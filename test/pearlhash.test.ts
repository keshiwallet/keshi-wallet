import { describe, expect, it } from "vitest";
import * as c from "../src/core";

// PearlHash's pages, as they answered on 4 November 2026.
const STATS = { hashrate: 14683153118870135000, hashrate_diff_15s: 52608.84991999943, hashrate_diff_5m: 53115.551573332144, hashrate_diff_60s: 53764.450133333805, total_accounts: 27768, total_workers: 50647 };
const ADDRESS = "prl1p22mlaphr02lv9frhqrw63g4g8d9ytyxgl9x0t00y7p44zyr7e9hs5es9k3";
// An address the pool knows but that is not mining right now, exactly as answered.
const IDLE = { connected_workers: [], estimated_hashrate_15s: 0, estimated_hashrate_60s: 0, estimated_hashrate_5m: 0, balance_transactions: [] };
// A mining address: the worker and balance fields are read defensively, since the pool documents none.
const NOW = Date.parse("2026-11-04T20:00:00.000Z");
const MINING = {
  connected_workers: [
    { name: "rig01", hashrate: 293e12, gpus: 2, last_share: "2026-11-04T19:59:30.000Z" },
    { name: "rig02", hashrate: 0 },
  ],
  estimated_hashrate_15s: 300e12,
  estimated_hashrate_60s: 295e12,
  estimated_hashrate_5m: 293e12,
  balance_transactions: [
    { amount: "10.50000000", reason: "credit", date: "2026-11-04T18:00:00.000Z" },
    { amount: "2.00000000", reason: "credit", date: "2026-11-04T19:00:00.000Z" },
    { amount: "-5.00000000", reason: "payment", date: "2026-11-04T19:30:00.000Z" },
  ],
};
const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("PearlHash pool (1.0.5)", () => {
  it("the pool page gives the dot its figures", async () => {
    const st = await c.poolStatus("pearlhash", answer(STATS));
    expect(st).toEqual({ kind: "pearlhash", state: "live", detail: "14.7 EH/s · 27,768 miners", feeRate: 0.01 });
    expect((await c.poolStatus("pearlhash", answer("<html>", 200))).state).toBe("no-answer");
    expect((await c.poolStatus("pearlhash", answer({}, 503))).state).toBe("no-answer");
  });
  it("follows a miner: connected workers are online, the balance is the sum of its movements", async () => {
    const s = await c.minerState("pearlhash", ADDRESS, answer(MINING), NOW);
    expect(s.pool).toBe("pearlhash");
    expect(s.hashrate).toBe(293e12);
    expect(s.workers.map((w) => [w.name, w.online, w.hashrate])).toEqual([
      ["rig01", true, 293e12],
      ["rig02", true, 0],
    ]);
    expect(s.unpaid).toBe(750_000_000n); // 10.5 + 2 − 5
    expect(s.paid).toBe(500_000_000n); // the 5 PRL payment
    expect(s.fee).toBe(0.01);
  });
  it("a worker that leaves the connected list is reported stopped on the next check", async () => {
    const before = await c.minerState("pearlhash", ADDRESS, answer(MINING), NOW);
    const memory = c.offlineCheck(before, { offline: [], known: [] }, 10, NOW / 1000);
    expect(memory.offline).toEqual([]);
    const after = await c.minerState("pearlhash", ADDRESS, answer({ ...MINING, connected_workers: [MINING.connected_workers[0]] }), NOW + 11 * 60_000);
    const first = c.offlineCheck(after, memory, 10, (NOW + 11 * 60_000) / 1000);
    expect(first.fresh).toEqual([]); // the delay starts when it leaves the list
    const chk = c.offlineCheck(after, first, 10, (NOW + 22 * 60_000) / 1000);
    expect(chk.offline).toEqual(["rig02"]);
    expect(chk.fresh).toEqual(["rig02"]);
  });
  it("an address known but idle: no workers, zero hashrate, no balance to show", async () => {
    const s = await c.minerState("pearlhash", ADDRESS, answer(IDLE), NOW);
    expect(s.workers).toEqual([]);
    expect(s.hashrate).toBe(0);
    expect(s.unpaid).toBeUndefined();
  });
  it("an address the pool has never seen (404) says so; other failures are a refusal", async () => {
    await expect(c.minerState("pearlhash", ADDRESS, answer({ error: "not found" }, 404), NOW)).rejects.toThrow("never seen this address");
    await expect(c.minerState("pearlhash", ADDRESS, answer({}, 500), NOW)).rejects.toThrow("refused");
    await expect(c.minerState("pearlhash", "bc1qnotpearl", answer(IDLE), NOW)).rejects.toThrow("not a Pearl address");
  });
  it("the pool's own page for an address, and the guide", () => {
    const p = c.POOLS.find((x) => x.id === "pearlhash")!;
    expect(c.poolPage(p, ADDRESS)).toBe(`https://pearlhash.xyz/account/${ADDRESS}`);
    expect(c.poolPage(c.POOLS.find((x) => x.id === "kryptex")!, ADDRESS)).toBe("https://pool.kryptex.com/prl");
    const by = Object.fromEntries(c.POOL_GUIDE.map((x) => [x.name, x]));
    expect(by.PearlHash!.id).toBe("pearlhash");
    expect(by.PearlHash!.status).toBe("pearlhash");
    expect(by["Pearl Fortune"]!.scheme).toBe("PPLNS / PPS");
    expect(c.POOL_GUIDE.filter((x) => x.status).map((x) => x.name)).toEqual(["Kryptex", "PearlHash", "HeroMiners", "Pearl Fortune", "LuckyPool", "Peryn"]);
  });
});
