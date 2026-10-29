import { describe, expect, it } from "vitest";
import * as c from "../src/core";

describe("Pearl emission and network maths", () => {
  it("pays the node's subsidy: about 3,230 PRL at block 1, about 2,223 PRL at block 133,577, never a halving", () => {
    expect(Number(c.blockSubsidy(1)) / 1e8).toBeCloseTo(3230, -1);
    expect(Number(c.blockSubsidy(133_577)) / 1e8).toBeCloseTo(2222.6, 0);
    expect(c.blockSubsidy(0)).toBe(0n);
    expect(c.blockSubsidy(NaN)).toBe(0n);
    // Smooth: each block pays a little less than the one before.
    for (const h of [10, 1000, 100_000, 1_000_000]) expect(c.blockSubsidy(h + 1) < c.blockSubsidy(h)).toBe(true);
  });
  it("turns difficulty into hashrate with 2^48 work per unit", () => {
    expect(c.hashrateFromDifficulty(46_166_734, 169.2) / 1e18).toBeCloseTo(76.8, 0);
    expect(c.hashrateFromDifficulty(0, 100)).toBe(0);
  });
  it("expects a fair share of the day's blocks, minus the pool fee", () => {
    const net = { hashrate: 73e18, blockSeconds: 194, subsidy: c.blockSubsidy(133_577) };
    const prl = Number(c.expectedPerDay(293e12, net, 0)) / 1e8;
    expect(prl).toBeCloseTo(3.97, 1);
    expect(Number(c.expectedPerDay(293e12, net, 0.01)) / 1e8).toBeCloseTo(prl * 0.99, 2);
    expect(c.expectedPerDay(0, net)).toBe(0n);
    expect(c.expectedPerDay(1e12, { ...net, hashrate: 0 })).toBe(0n);
  });
  it("reads and writes hashrates", () => {
    expect(c.parseHashrate("548 TH/s")).toBe(548e12);
    expect(c.parseHashrate("1.2 PH/s")).toBe(1.2e15);
    expect(c.parseHashrate("1,5 th")).toBe(1.5e12);
    expect(c.parseHashrate("abc")).toBeNull();
    expect(c.parseHashrate("-3 TH/s")).toBeNull();
    expect(c.formatHashrate(548e12)).toBe("548 TH/s");
    expect(c.formatHashrate(77.9e18, 2)).toBe("77.90 EH/s");
  });
  it("estimates net income and lets the 30-day figure decay with the difficulty", () => {
    const net = { hashrate: 73e18, blockSeconds: 194, subsidy: c.blockSubsidy(133_577) };
    const e = c.estimate(586e12, 900, 0.2, 1.93, net, 0.01, 0.45);
    expect(e.incomeUsd).toBeCloseTo((Number(e.prlPerDay) / 1e8) * 1.93, 6);
    expect(e.powerUsd).toBeCloseTo(4.32, 2);
    expect(e.netUsd).toBeCloseTo(e.incomeUsd - 4.32, 6);
    expect(e.net30Usd).toBeLessThan(e.netUsd * 30);
    expect(e.net30Usd).toBeGreaterThan(e.netUsd * 30 * 0.7);
  });
});

describe("pool answers", () => {
  const now = 1_800_000_000_000;
  const kry = (workers: any[], extra: any = {}) => async (url: string) => {
    const j = (o: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => o }) as any;
    if (url.includes("/miner/workers/")) return j({ count: workers.length, results: workers });
    if (url.includes("/miner/balance/")) return j({ total: 1.25, threshold: 1, reached_pct: 100, unconfirmed: 0.25, confirmed: 1 });
    if (url.includes("/pool/info")) return j({ ticker: "PRL", fee: 1, fee_type: "PPLNS", ...extra });
    return j({}, false);
  };
  const ADDR = "prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp";
  it("reads Kryptex workers and marks the silent ones offline", async () => {
    const s = await c.minerState("kryptex", ADDR, kry([{ worker: "rig-01", hashrate: 281e12, last_share: now / 1000 - 60 }, { worker: "rig-02", hashrate: 0, last_share: now / 1000 - 1500 }, { worker: "rig-03", hashrate: 267e12, last_share: (now - 30_000) /* ms */ }]), now);
    expect(s.workers.map((w) => w.online)).toEqual([true, false, true]);
    expect(s.hashrate).toBe(548e12);
    expect(s.unpaid).toBe(125_000_000n);
    expect(s.fee).toBe(0.01);
    expect(s.workers[2]!.lastShare).toBe(now / 1000 - 30);
  });
  it("refuses an address that is not Pearl's, and survives an odd answer", async () => {
    await expect(c.minerState("kryptex", "0xabc", kry([]))).rejects.toThrow(/Pearl address/);
    const s = await c.minerState("kryptex", ADDR, kry([{ worker: "<script>x</script>", hashrate: "12e12", last_share: "nope" }]), now);
    expect(s.workers[0]!.name).toBe("<script>x</script>");
    expect(s.workers[0]!.hashrate).toBe(12e12);
    expect(s.workers[0]!.online).toBe(true);
  });
  it("reads a HeroMiners stats_address answer", async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => ({ stats: { hashrate: 100e12, balance: 50_000_000 }, workers: [{ name: "a", hashrate: 100e12, lastShare: now / 1000 - 10 }] }) }) as any;
    const s = await c.minerState("herominers", ADDR, f, now);
    expect(s.hashrate).toBe(100e12);
    expect(s.unpaid).toBe(50_000_000n);
    expect(s.workers[0]!.online).toBe(true);
  });
  it("reads the network from the indexer: tip difficulty, measured block time, difficulty a week ago", async () => {
    const f = async (url: string) => {
      const j = (o: unknown) => ({ ok: true, status: 200, json: async () => o }) as any;
      if (url.endsWith("/api/v2")) return j({ blockbook: { bestHeight: 133_577 }, backend: { difficulty: "46166734" } });
      const h = Number(url.split("/block/")[1]);
      return j({ height: h, difficulty: h === 133_577 ? 46_166_734 : h === 133_517 ? 46_000_000 : 37_000_000, time: 1_700_000_000 + h * 170 });
    };
    const n = await c.networkState(c.MAINNET, f);
    expect(n.height).toBe(133_577);
    expect(n.difficulty).toBe(46_166_734);
    expect(n.blockSeconds).toBeCloseTo(170, 5);
    expect(n.hashrate / 1e18).toBeCloseTo(76.4, 0);
    expect(n.difficultyWeekAgo).toBe(37_000_000);
    expect(c.monthlyGrowth(n)!).toBeGreaterThan(1);
    expect(Number(n.subsidy) / 1e8).toBeCloseTo(2222.6, 0);
  });
});

describe("1.0.4 review fixes", () => {
  it("reads thousands separators in a hashrate", () => {
    expect(c.parseHashrate("1,200 TH/s")).toBe(1.2e15);
    expect(c.parseHashrate("1,2 PH/s")).toBe(1.2e15);
    expect(c.parseHashrate("293 TH/s")).toBe(293e12);
  });
  it("scales the difficulty trend to exactly seven days", () => {
    const base = { height: 1000, difficulty: 110, blockSeconds: 170, hashrate: 1, subsidy: 1n, at: 0, difficultyWeekAgo: 100 };
    expect(c.weeklyGrowth({ ...base, weekSpanSeconds: 7 * 86_400 })).toBeCloseTo(0.1, 6);
    // The same rise over 6.1 days is a little more per 7 days.
    expect(c.weeklyGrowth({ ...base, weekSpanSeconds: 6.1 * 86_400 })!).toBeGreaterThan(0.1);
  });
  it("counts only mining income: block rewards and payments to the payout address, not bridge returns", () => {
    const PAY = "prl1payout", OTHER = "prl1other";
    const t = 1_700_000_000;
    const act = [
      { txid: "a", time: t, confirmations: 9, net: 50_00000000n, fee: 0n, kind: "received" as const, to: [PAY] },
      { txid: "b", time: t + 60, confirmations: 9, net: 20_00000000n, fee: 0n, kind: "received" as const, to: [OTHER] },
      { txid: "c", time: t + 120, confirmations: 9, net: 3_000_00000000n, fee: 0n, kind: "mined" as const, to: [PAY] },
      { txid: "d", time: t + 3600, confirmations: 9, net: 96_00000000n, fee: 0n, kind: "received" as const, to: [PAY] },
      { txid: "e", time: t + 7200, confirmations: 9, net: 10_00000000n, fee: 0n, kind: "received" as const },
    ];
    const kept = c.miningActivity(act, PAY, [{ amount: 100_00000000n, at: (t + 600) * 1000 }]).map((a) => a.txid).sort();
    expect(kept).toEqual(["a", "c", "e"]); // b: another address; d: the bridge return; e: older record without address
  });
  it("lets the 30-day projection follow the shrinking block reward", () => {
    const net = { hashrate: 1e18, blockSeconds: 194, subsidy: c.blockSubsidy(133_000) };
    const flat = c.estimate(1e15, 0, 0, 1, net, 0, 0).net30Usd;
    const decaying = c.estimate(1e15, 0, 0, 1, { ...net, height: 133_000 }, 0, 0).net30Usd;
    expect(decaying).toBeLessThan(flat);
    expect(decaying).toBeGreaterThan(flat * 0.95);
  });
});

describe("offline alert", () => {
  const w = (name: string, hashrate: number, lastShare: number) => ({ name, hashrate, lastShare, online: hashrate > 0 });
  const now = 1_700_000_000;
  it("uses the chosen delay, announces once, and notices a worker that vanished", () => {
    const st = { workers: [w("rig1", 5e14, now - 6 * 60), w("rig2", 5e14, now - 30)] };
    expect(c.offlineCheck(st, { offline: [], known: [] }, 5, now).fresh).toEqual(["rig1"]);
    expect(c.offlineCheck(st, { offline: [], known: [] }, 10, now).fresh).toEqual([]);
    expect(c.offlineCheck(st, { offline: ["rig1"], known: ["rig1", "rig2"] }, 5, now).fresh).toEqual([]);
    const gone = c.offlineCheck({ workers: [w("rig2", 5e14, now - 30)] }, { offline: [], known: ["rig1", "rig2"] }, 10, now);
    expect(gone.fresh).toEqual(["rig1"]);
    expect(gone.total).toBe(2);
    const back = c.offlineCheck(st, { offline: ["rig1"], known: ["rig1", "rig2"] }, 10, now);
    expect(back.offline).toEqual([]); // rig1 sends work again (6 min < 10): cleared, so a later stop is announced again
  });
  it("applies the chosen delay to a worker that has no time of last work", () => {
    const idle = { workers: [w("rig1", 0, 0)] };
    const first = c.offlineCheck(idle, { offline: [], known: [] }, 30, now);
    expect(first.fresh).toEqual([]);
    expect(first.idleSince).toEqual({ rig1: now });
    expect(c.offlineCheck(idle, { offline: [], known: ["rig1"], idleSince: first.idleSince }, 30, now + 29 * 60).fresh).toEqual([]);
    expect(c.offlineCheck(idle, { offline: [], known: ["rig1"], idleSince: first.idleSince }, 30, now + 30 * 60).fresh).toEqual(["rig1"]);
  });
  it("counts idle time for any worker name, and does not announce again a worker an earlier version already announced", () => {
    const idle = { workers: [w("constructor", 0, 0), w("toString", 0, 0)] };
    const first = c.offlineCheck(idle, { offline: [], known: [] }, 10, now);
    expect(c.offlineCheck(idle, { offline: [], known: ["constructor", "toString"], idleSince: first.idleSince }, 10, now + 3600).fresh.sort()).toEqual(["constructor", "toString"]);
    // Saved by 1.0.3 (no idleSince): rig1 was already announced, so it stays offline without a second alert.
    const upgraded = c.offlineCheck({ workers: [w("rig1", 0, 0)] }, { offline: ["rig1"], known: ["rig1"] }, 10, now);
    expect(upgraded.offline).toEqual(["rig1"]);
    expect(upgraded.fresh).toEqual([]);
  });
  it("skips a malformed worker entry instead of failing the whole read", async () => {
    const f = (async (url: string) => new Response(JSON.stringify(String(url).includes("workers") ? { results: [null, { worker: "rig-a", hashrate: 1e14, last_share: Math.floor(Date.now() / 1000) }] } : {}))) as unknown as typeof fetch;
    const st = await c.minerState("kryptex", "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74", f);
    expect(st.workers.map((x) => x.name)).toEqual(["rig-a"]);
    const h = (async () => new Response(JSON.stringify({ stats: { hashrate: 1 }, workers: [null, 5, { name: "w1", hashrate: 1, lastShare: 1 }] }))) as unknown as typeof fetch;
    expect((await c.minerState("herominers", "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74", h)).workers.map((x) => x.name)).toEqual(["w1"]);
  });
});
