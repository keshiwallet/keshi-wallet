import "./_localstorage";
import { describe, expect, it } from "vitest";
import * as c from "../src/core";
import { local } from "../src/ext/platform";
import { signalVersion } from "../src/ext/stats";
import * as store from "../src/ui/store";

const PRL = 100_000_000n;
const TX = "ab".repeat(32);
const ETHTX = "0x" + "cd".repeat(32);
const NOW = Date.parse("2026-11-16T20:00:00Z");

describe("Bridge fee advice (1.0.6b)", () => {
  it("800 PRL is where PearlBridge's 0.5% takes over from its 4 PRL minimum", () => {
    expect(c.BRIDGE_PERCENT_FROM).toBe(800n * PRL);
    // 100 PRL: the minimum, 4% of the amount.
    expect(c.bridgeFeeAdvice(100n * PRL, 4n * PRL)).toEqual({ percent: 4, minimum: true, percentFrom: 800n * PRL });
    // 800 PRL and 2,000 PRL: the plain percentage.
    expect(c.bridgeFeeAdvice(800n * PRL, 4n * PRL)).toMatchObject({ percent: 0.5, minimum: false });
    expect(c.bridgeFeeAdvice(2000n * PRL, 10n * PRL)).toMatchObject({ percent: 0.5, minimum: false });
    // The advice follows the quote's own fee, whatever the bridge charges that day.
    expect(c.bridgeFeeAdvice(100n * PRL, 6n * PRL)).toEqual({ percent: 6, minimum: true, percentFrom: 1200n * PRL });
  });
  it("says nothing on figures that make no sense", () => {
    for (const [a, f] of [[0n, 1n], [-5n, 1n], [100n, 0n], [100n, -1n], [100n, 100n], [100n, 500n]] as const) expect(c.bridgeFeeAdvice(a, f)).toBeNull();
  });
});

describe("Crossing progress (1.0.6b)", () => {
  it("counts Pearl's confirmations and estimates the time left at Pearl's pace", () => {
    expect(c.crossingProgress(0, 6)).toEqual({ stage: "confirming", confirmations: 0, need: 6, fraction: 0, secondsLeft: 6 * 194 });
    const p = c.crossingProgress(4, 6);
    expect([p.stage, p.confirmations, p.need, p.secondsLeft]).toEqual(["confirming", 4, 6, 2 * 194]);
    expect(p.fraction).toBeCloseTo(0.6);
    expect(c.aboutLeft(p.secondsLeft!)).toBe("about 6 min left");
    // A large amount: the bridge's safety delay comes on top.
    expect(c.crossingProgress(10, 12, 86400).secondsLeft).toBe(2 * 194 + 86400);
    expect(c.aboutLeft(2 * 194 + 86400)).toBe("about 24 h left");
    expect(c.aboutLeft(30)).toBe("about a minute left");
  });
  it("never shows a crossing as finished: only the bridge says so", () => {
    expect(c.crossingProgress(6, 6)).toMatchObject({ stage: "issuing", confirmations: 6, fraction: 0.95, secondsLeft: null });
    expect(c.crossingProgress(900, 6, 3600)).toMatchObject({ stage: "delay", confirmations: 6, fraction: 0.9, secondsLeft: null });
    for (const [n, need, d] of [[NaN, NaN, NaN], [-3, -1, -1], [1e30, 1e30, 1e30], [Infinity, 0, Infinity]] as const) {
      const p = c.crossingProgress(n, need, d);
      expect(p.fraction >= 0 && p.fraction < 1 && p.need >= 1 && p.confirmations >= 0 && p.confirmations <= p.need).toBe(true);
      expect(p.secondsLeft === null || (Number.isFinite(p.secondsLeft) && p.secondsLeft >= 0)).toBe(true);
    }
  });
});

describe("Arrival alert (1.0.6b)", () => {
  it("what is kept outside the encrypted storage is read strictly: a transaction number, a direction, a time", () => {
    const list = c.readWatch(
      [
        { txid: TX, back: false, at: NOW - 60_000, amount: "123", eth: "0xabc", address: "prl1p..." },
        { txid: ETHTX, back: true, at: NOW - 60_000 },
        { txid: TX, back: false, at: NOW - 30_000 }, // twice the same
        { txid: ETHTX, back: false, at: NOW }, // an Ethereum hash is not a Pearl one
        { txid: TX.slice(2), back: false, at: NOW },
        { txid: "ef".repeat(32), back: false, at: NOW - 4 * 86400_000 }, // older than three days
        { txid: "12".repeat(32), back: false, at: NOW + 3600_000 }, // from the future
        { txid: "<script>", at: NOW },
        null,
        "x",
      ],
      NOW,
    );
    expect(list).toEqual([
      { txid: TX, back: false, at: NOW - 60_000 },
      { txid: ETHTX, back: true, at: NOW - 60_000 },
    ]);
    for (const bad of [null, undefined, "x", 7, {}]) expect(c.readWatch(bad, NOW)).toEqual([]);
    expect(c.readWatch(Array.from({ length: 30 }, (_, i) => ({ txid: i.toString(16).padStart(64, "0"), at: NOW })), NOW)).toHaveLength(8);
  });
  it("a crossing is announced once, when it reaches its end; no answer means ask again", () => {
    const a = { txid: TX, back: false, at: NOW };
    const b = { txid: ETHTX, back: true, at: NOW };
    const d = { txid: "ef".repeat(32), back: false, at: NOW };
    const step = c.watchStep([a, b, d], { [TX]: { phase: "done" }, [ETHTX]: { phase: "pending" } });
    expect(step).toEqual({ ended: [{ watch: a, phase: "done" }], held: [] });
    const keep = c.watchAfter([a, b, d], step.ended.map((t) => t.watch), step.held);
    expect(keep).toEqual([b, d]);
    // Announced and dropped: the next round has nothing to say about it.
    expect(c.watchStep(keep, { [TX]: { phase: "done" } })).toEqual({ ended: [], held: [] });
  });
  it("a crossing held for review is announced once and kept, so that its later arrival is announced too", () => {
    const a = { txid: TX, back: false, at: NOW };
    const first = c.watchStep([a], { [TX]: { phase: "review" } });
    expect(first).toEqual({ ended: [], held: [a] });
    const kept = c.watchAfter([a], [], first.held);
    expect(kept).toEqual([{ ...a, told: "review" }]);
    // Still held: not said twice. The mark survives a trip through storage.
    expect(c.watchStep(c.readWatch(kept, NOW), { [TX]: { phase: "review" } })).toEqual({ ended: [], held: [] });
    // The bridge lets it through: the arrival is announced, and the crossing leaves the list.
    const later = c.watchStep(kept, { [TX]: { phase: "done" } });
    expect(later.ended).toEqual([{ watch: kept[0], phase: "done" }]);
    expect(c.watchAfter(kept, later.ended.map((t) => t.watch))).toEqual([]);
    // A state Keshi does not know is neither announced nor dropped.
    expect(c.watchStep([a], { [TX]: { phase: "unknown" } })).toEqual({ ended: [], held: [] });
    expect(c.arrivalText(false, "unknown")).toBeNull();
  });
  it("names what happened, without any amount", () => {
    expect(c.arrivalText(false, "done")!.title).toBe("Your wPRL arrived");
    expect(c.arrivalText(true, "done")!.title).toBe("Your PRL arrived");
    expect(c.arrivalText(false, "refunded")!.title).toMatch(/sent back/);
    expect(c.arrivalText(false, "review")!.title).toMatch(/held for review/);
    expect(c.arrivalText(false, "failed")!.title).toMatch(/did not go through/);
    expect(c.arrivalText(false, "pending")).toBeNull();
    for (const p of ["done", "refunded", "failed", "review"] as const) for (const back of [true, false]) expect(c.arrivalText(back, p)!.message).not.toMatch(/\d/);
  });
  it("turning the alert off forgets the crossings it was watching, and nothing is kept while it is off", async () => {
    await local.remove("bridgeAlert");
    await local.remove("bridgeWatch");
    expect(await store.bridgeAlertOn()).toBe(true);
    await store.watchCrossing(TX, false);
    await store.watchCrossing(ETHTX, true);
    await store.watchCrossing(TX, false); // the same crossing again
    const kept = (await local.get<c.BridgeWatch[]>("bridgeWatch"))!;
    expect(kept.map((w) => [w.txid, w.back])).toEqual([[TX, false], [ETHTX, true]]);
    expect(Object.keys(kept[0]!).sort()).toEqual(["at", "back", "txid"]);
    await store.setBridgeAlert(false);
    expect(await local.get("bridgeWatch")).toBeUndefined();
    await store.watchCrossing(TX, false);
    expect(await local.get("bridgeWatch")).toBeUndefined();
    await store.setBridgeAlert(true);
    await local.remove("bridgeAlert");
  });
});

describe("Version 1.0.6b", () => {
  it("is counted as 1.0.6: the counter takes three-part versions only", () => {
    expect([signalVersion("1.0.6b"), signalVersion("1.0.6.1"), signalVersion("1.0.6"), signalVersion("12.3.45-rc")]).toEqual(["1.0.6", "1.0.6", "1.0.6", "12.3.45"]);
    for (const bad of ["", "b1.0.6", "1.0", undefined, null, 7]) expect(signalVersion(bad)).toBe("0.0.0");
  });
});
