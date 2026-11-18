import { describe, expect, it } from "vitest";
import * as c from "../src/core";

const TX = "ab".repeat(32);
const NOW = Date.parse("2026-11-16T22:00:00Z");
const bridge = (answer: unknown) => {
  const b: any = Object.create((c as any).Bridge.prototype);
  b.get = async () => answer;
  return b as c.Bridge;
};

describe("Security review of 1.0.6b: a hostile bridge answer", () => {
  it("whatever the bridge answers about a crossing, Keshi reads one of six phases and nothing else", async () => {
    const hostile = [
      { state: "<img src=x onerror=alert(1)>" },
      { state: { toString: () => "minted" } },
      { state: ["minted"] },
      { state: "minted", mintTxHash: "javascript:alert(1)" },
      { state: "MINTED" },
      { state: "minted ", refundedAt: 0 },
      { state: 1 },
      { state: "done" },
      {},
    ];
    for (const h of hostile) {
      const s = await bridge(h).status(TX);
      expect(["pending", "done", "refunded", "failed", "review", "unknown"]).toContain(s.phase);
      // A link to Etherscan is only ever built from a well-formed transaction hash.
      expect(s.ethTx === undefined || /^0x[0-9a-fA-F]{64}$/.test(s.ethTx)).toBe(true);
    }
    // An answer Keshi does not understand is never "arrived": only the bridge's exact words for it are.
    for (const h of hostile) {
      const state = (h as any).state;
      if (state !== "minted" && state !== "finalized") expect((await bridge(h).status(TX)).phase).not.toBe("done");
    }
    // A word Keshi does not know is "unknown", not a hold; the bridge's documented hold, or a reason for one, is a review.
    expect((await bridge({ state: "<script>" }).status(TX)).phase).toBe("unknown");
    expect((await bridge({ state: "some_future_state" }).backStatus("0x" + TX)).phase).toBe("unknown");
    expect((await bridge({ state: "under_review" }).status(TX)).phase).toBe("review");
    expect((await bridge({ state: "odd", anomalyReason: "velocity" }).status(TX))).toEqual({ phase: "review", detail: "velocity" });
    expect([c.isFinal("review"), c.isFinal("unknown"), c.isFinal("pending"), c.isFinal("done"), c.isFinal("refunded"), c.isFinal("failed")]).toEqual([false, false, false, true, true, true]);
    await expect(bridge({}).status("not-a-txid")).rejects.toThrow();
    await expect(bridge({}).backStatus(TX)).rejects.toThrow(); // a Pearl id is not an Ethereum hash
  });
});

describe("Security review of 1.0.6b: figures on the progress line", () => {
  it("no confirmation count, required count or delay can break the line or the bar", () => {
    const odd: unknown[] = [NaN, Infinity, -Infinity, -1, 0, 1e308, "6", null, undefined, {}, [], 2 ** 53];
    for (const n of odd) for (const need of odd) for (const d of [0, NaN, -5, 1e308, "x"]) {
      const p = c.crossingProgress(n as number, need as number, d as number);
      expect(Number.isFinite(p.fraction) && p.fraction >= 0 && p.fraction < 1).toBe(true);
      expect(Number.isInteger(p.need) && p.need >= 1 && p.need <= 10_000).toBe(true);
      expect(Number.isInteger(p.confirmations) && p.confirmations >= 0 && p.confirmations <= p.need).toBe(true);
      expect(p.secondsLeft === null || (Number.isFinite(p.secondsLeft) && p.secondsLeft >= 0 && p.secondsLeft <= 10_000 * 194 + 7 * 86400)).toBe(true);
      if (p.secondsLeft !== null) expect(c.aboutLeft(p.secondsLeft)).toMatch(/^about (a minute|\d{1,5} (min|h)) left$/);
    }
    for (const s of [NaN, -1, Infinity, 0]) expect(c.aboutLeft(s as number)).toMatch(/^about /);
  });
  it("fee advice never divides by zero and never reports a share of 100% or more", () => {
    for (const a of [-1n, 0n, 1n, 10n ** 30n]) for (const f of [-1n, 0n, 1n, 10n ** 30n]) {
      const x = c.bridgeFeeAdvice(a, f);
      expect(x === null || (x.percent >= 0 && x.percent < 100)).toBe(true);
    }
  });
});

describe("Security review of 1.0.6b: the alert's memory, kept outside the encrypted storage", () => {
  it("holds nothing but a transaction number, a direction and a time, whatever was put there", () => {
    const planted = [{ txid: TX, back: false, at: NOW, amount: 5n.toString(), eth: "0x" + "11".repeat(20), phrase: "twelve words", __proto__: { polluted: true } }];
    const read = c.readWatch(planted, NOW);
    expect(read).toEqual([{ txid: TX, back: false, at: NOW }]);
    expect(JSON.stringify(read)).not.toMatch(/amount|eth|phrase|twelve/);
    expect(({} as any).polluted).toBeUndefined();
    // The number that goes into the bridge's URL is hexadecimal only: nothing can be added to the address asked.
    for (const bad of ["../v1/admin", TX + "?x=1", TX + "/../", "%2e%2e", TX.slice(0, 63) + "/", " " + TX]) expect(c.readWatch([{ txid: bad, at: NOW }], NOW)).toEqual([]);
  });
  it("a crossing added by the screen during a round is kept, an ended one is not asked about again", () => {
    const a = { txid: TX, back: false, at: NOW };
    const added = { txid: "cd".repeat(32), back: false, at: NOW };
    expect(c.watchAfter([added, a], [a])).toEqual([added]);
    expect(c.watchAfter([a], [a])).toEqual([]);
    expect(c.watchAfter([], [a])).toEqual([]);
    // The "already told" mark is one fixed word: nothing else planted there is kept.
    expect(c.readWatch([{ txid: TX, at: NOW, told: "<script>" }, { txid: "cd".repeat(32), at: NOW, told: "review" }], NOW)).toEqual([{ txid: TX, back: false, at: NOW }, { txid: "cd".repeat(32), back: false, at: NOW, told: "review" }]);
  });
});

describe("External audit of 1.0.6: answers that lie about their size or their figures", () => {
  const reply = (body: BodyInit, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  it("a bridge answer is cut off at 64 kB while it is read, not after", async () => {
    let pulled = 0;
    const flood = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(16_384).fill(0x20));
      },
    });
    await expect(new c.Bridge(reply(flood)).status(TX)).rejects.toThrow("unreadable");
    // An endless answer: reading stopped a few chunks past the limit instead of going on.
    expect(pulled).toBeLessThan(12);
    await expect(new c.Bridge(reply("x".repeat(70_000))).status(TX)).rejects.toThrow("unreadable");
    await expect(new c.Bridge(reply("not json")).status(TX)).rejects.toThrow("unreadable");
    expect((await new c.Bridge(reply('{"state":"minted"}')).status(TX)).phase).toBe("done");
  });
  it("a quote whose waiting figures are not plain numbers within bounds is refused, not shown", async () => {
    const WPRL = c.WPRL_CONTRACT;
    const serve = (extra: object) =>
      (async (url: string) => new Response(JSON.stringify(String(url).includes("/status") ? { contracts: { wprl: WPRL } } : { amountGrains: "10000000000", feeGrains: "400000000", netGrains: "9600000000", ...extra }))) as unknown as typeof fetch;
    const good = await new c.Bridge(serve({ confirmationsRequired: 6, lane: "slow", slowLaneDelaySeconds: 86400 })).quote(10_000_000_000n);
    expect([good.confirmations, good.delaySeconds, good.slow]).toEqual([6, 86400, true]);
    expect((await new c.Bridge(serve({})).quote(10_000_000_000n)).confirmations).toBe(6);
    for (const bad of [{ confirmationsRequired: "many" }, { confirmationsRequired: 0 }, { confirmationsRequired: -3 }, { confirmationsRequired: 1e9 }, { confirmationsRequired: 6.5 }, { confirmationsRequired: null, slowLaneDelaySeconds: "soon" }, { slowLaneDelaySeconds: -1 }, { slowLaneDelaySeconds: 1e12 }, { confirmationsRequired: [6] }])
      await expect(new c.Bridge(serve(bad)).quote(10_000_000_000n), JSON.stringify(bad)).rejects.toThrow("unreadable");
  });
});

describe("External audit of 1.0.6: the payment alert's memory", () => {
  it("an empty or broken answer that says 200 OK is no reading, and never replaces what was remembered", () => {
    for (const bad of [{}, null, "x", [], { totalReceived: null }, { totalReceived: "" }, { totalReceived: "-5" }, { totalReceived: 1.5 }, { totalReceived: "12", unconfirmedBalance: "soon" }, { totalReceived: "9".repeat(31) }, { balance: "1000" }]) expect(c.readingOf(bad), JSON.stringify(bad)).toBeNull();
    expect(c.readingOf({ totalReceived: "1000" })).toBe(1000n);
    expect(c.readingOf({ totalReceived: "1000", unconfirmedBalance: "50" })).toBe(1050n);
    expect(c.readingOf({ totalReceived: "1000", unconfirmedBalance: "-50" })).toBe(1000n);
    // The sequence of the audit: 1000, then a broken answer, then 1000 again. Nothing is announced.
    const A = "prl1pminer";
    let memory = c.payoutStep(undefined, A, c.readingOf({ totalReceived: "1000" })!).memory;
    const broken = c.readingOf({});
    if (broken !== null) memory = c.payoutStep(memory, A, broken).memory; // the background skips a null reading the same way
    expect(c.payoutStep(memory, A, c.readingOf({ totalReceived: "1000" })!).fresh).toBe(0n);
    expect(c.payoutStep(memory, A, c.readingOf({ totalReceived: "1200" })!).fresh).toBe(200n);
  });
});

describe("External audit of 1.0.6: exchanges in Explore", () => {
  it("a first reading that fails or comes back empty leaves no baseline: the exchanges already there are not news", () => {
    const venue = [{ id: "existingvenue", name: "Existing Venue", url: "https://example.com" }];
    const first = c.marketsStep(undefined, [], 1000);
    const second = c.marketsStep(first, venue, 1010);
    expect(second).toEqual({ known: ["existingvenue"], added: [] });
    expect(c.marketNews(second)).toEqual([]);
    // After the baseline, a new exchange is still announced.
    const third = c.marketsStep(second, [...venue, { id: "newvenue", name: "New Venue", url: "https://example.org" }], 1020);
    expect(c.marketNews(third).map((n) => n.title)).toEqual(["PEARL now trades on New Venue"]);
  });
});
