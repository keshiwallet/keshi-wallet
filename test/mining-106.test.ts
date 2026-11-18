import { describe, expect, it } from "vitest";
import * as c from "../src/core";

describe("Mining in 1.0.6", () => {
  it("Peryn lists its 18 locations, every one on 3333 and 3443, the four pool servers first", () => {
    const p = c.POOL_CONNECT.find((x) => x.name === "Peryn")!;
    expect(p.endpoints).toHaveLength(18);
    expect(p.endpoints.slice(0, 4).map((e) => e.host)).toEqual(["pool.peryn.ai", "hk.pool.peryn.ai", "us.pool.peryn.ai", "st-petersburg.pool.peryn.ai"]);
    expect(new Set(p.endpoints.map((e) => e.host)).size).toBe(18);
    expect(p.endpoints.every((e) => e.port === 3333 && e.tlsPort === 3443 && /^([a-z-]+\.)?pool\.peryn\.ai$/.test(e.host))).toBe(true);
    for (const h of ["toronto", "buenos-aires", "santiago", "warsaw", "moscow", "tel-aviv", "johannesburg", "sydney"]) expect(p.endpoints.some((e) => e.host === `${h}.pool.peryn.ai`)).toBe(true);
  });
  it("Pearl Fortune lists Global and Japan, for third-party miners (8888) and its own miner (443)", () => {
    const p = c.POOL_CONNECT.find((x) => x.name === "Pearl Fortune")!;
    expect(p.endpoints.map((e) => `${e.host}:${e.port}`)).toEqual(["global.pearlfortune.org:8888", "jp.pearlfortune.org:8888", "global.pearlfortune.org:443", "jp.pearlfortune.org:443"]);
    expect(p.options!.join(" ")).toMatch(/PPS \(fee 4%\) is the default/);
  });
  it("PearlHash can pay in USDT: AE- and the wallet's Ethereum address, never anything else", () => {
    const eth = "0x7ad4C8e2Bf91a063d5C0eb76A8f3d219c4e5B607";
    const u = c.connectUsdtFor("PearlHash", eth, "rig 01!")!;
    expect(u.user).toBe(`AE-${eth}`);
    expect(u.command).toBe(`wildrig-multi --algo pearlhash --url pool.pearlhash.xyz:9000 --user AE-${eth} --worker rig01`);
    expect(u.notes.join(" ")).toMatch(/5 PRL/);
    // Not an Ethereum address, or a pool without this payout: nothing to copy.
    expect(c.connectUsdtFor("PearlHash", "prl1pabc")).toBeNull();
    expect(c.connectUsdtFor("PearlHash", eth + "00")).toBeNull();
    expect(c.connectUsdtFor("Kryptex", eth)).toBeNull();
    // The PRL username is untouched.
    expect(c.connectFor("PearlHash", "prl1pabc")!.user).toBe("prl1pabc");
  });
  it("the calculator's cards: every family has cards, figures are sane, names are unique", () => {
    expect(new Set(c.GPU_PRESETS.map((g) => g.name)).size).toBe(c.GPU_PRESETS.length);
    for (const fam of c.GPU_FAMILIES) expect(c.GPU_PRESETS.some((g) => g.family === fam)).toBe(true);
    expect(c.GPU_PRESETS.every((g) => g.hashrate >= 30e12 && g.hashrate <= 2e15 && g.watts >= 50 && g.watts <= 1200)).toBe(true);
    const of = (n: string) => c.GPU_PRESETS.find((g) => g.name === n)!;
    expect([of("RTX 4090").hashrate, of("RTX 4090").watts]).toEqual([348.4e12, 438]);
    expect([of("RTX 5090").hashrate, of("RTX 5090").watts]).toEqual([436.8e12, 507]);
  });
});

describe("Payment alert (1.0.6)", () => {
  const A = "prl1pminer";
  it("reads what an address received, pending included, and nothing from a hostile answer", () => {
    expect(c.receivedOf({ totalReceived: "500", unconfirmedBalance: "20" })).toBe(520n);
    expect(c.receivedOf({ totalReceived: "500", unconfirmedBalance: "-20" })).toBe(500n);
    expect(c.receivedOf({ totalReceived: "1e9", unconfirmedBalance: {} })).toBe(0n);
    expect(c.receivedOf(null)).toBe(0n);
  });
  it("locked: the first reading announces nothing, then each increase once", () => {
    let s = c.payoutStep(undefined, A, 1000n);
    expect(s.fresh).toBe(0n);
    s = c.payoutStep(s.memory, A, 1000n);
    expect(s.fresh).toBe(0n);
    s = c.payoutStep(s.memory, A, 1500n);
    expect([s.fresh, s.memory.received, s.memory.announced]).toEqual([500n, "1500", "500"]);
    s = c.payoutStep(s.memory, A, 1500n);
    expect(s.fresh).toBe(0n);
    // Another address starts afresh: its whole history is not a payment.
    expect(c.payoutStep(s.memory, "prl1pother", 9_000_000n).fresh).toBe(0n);
  });
  it("unlocked: a payment to the mining address is named as one, other PRL as PRL, and nothing twice", () => {
    const mem = { address: A, received: "1000", announced: "0" };
    // 300 to the mining address and 200 elsewhere in the wallet.
    expect(c.payoutSplit(mem, A, 1300n, 500n)).toMatchObject({ payout: 300n, rest: 200n, memory: { received: "1300", announced: "0" } });
    // Announced while locked (500): on unlock the wallet's own notification stays quiet.
    const locked = c.payoutStep(mem, A, 1500n).memory;
    expect(c.payoutSplit(locked, A, 1500n, 500n)).toMatchObject({ payout: 0n, rest: 0n });
    // The wallet screen already showed it (no delta left): no notification after the fact.
    expect(c.payoutSplit(mem, A, 1300n, 0n)).toMatchObject({ payout: 0n, rest: 0n, memory: { received: "1300" } });
    // No memory yet for this address: its history is not a payment, the delta is plain PRL.
    expect(c.payoutSplit(undefined, A, 1300n, 50n)).toMatchObject({ payout: 0n, rest: 50n });
  });
});
