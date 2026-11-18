import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as c from "../src/core";

// Pearl's own params.go, as its master branch had it on 16 November 2026.
const PARAMS = readFileSync(new URL("./fixtures-pearl-params.go.txt", import.meta.url), "utf8");
const NOW = Math.floor(Date.parse("2026-11-16T19:00:00Z") / 1000);
// GitHub's releases answer, trimmed to the fields read; tags and dates are Pearl's real ones.
const RELEASES = [
  { tag_name: "v1.5.7", name: "v1.5.7", draft: false, prerelease: false, published_at: "2026-11-12T17:10:06Z", html_url: "https://evil.example/phish", body: "security: harden P2P decoding, peer replies, SigCache and adjusted time (#501)\r\nFixes GHSA-qrmq-4xvp-6xh8" },
  { tag_name: "pearl-wallet-v3.0.1", name: "Wallet 3.0.1", draft: false, prerelease: false, published_at: "2026-11-10T10:00:00Z", body: "desktop wallet" },
  { tag_name: "v1.5.6-rc1", name: "rc", draft: false, prerelease: true, published_at: "2026-11-05T10:00:00Z", body: "" },
  { tag_name: "v1.5.5", name: "v1.5.5", draft: false, prerelease: false, published_at: "2026-10-28T16:56:46Z", body: "feat(node): add Prometheus metrics endpoint" },
  { tag_name: "v1.4.0", name: "v1.4.0 hardfork", draft: false, prerelease: false, published_at: "2026-08-09T10:00:00Z", body: "old" },
  { tag_name: "v9.9.9", name: "draft", draft: true, prerelease: false, published_at: "2026-11-15T10:00:00Z", body: "" },
];

describe("Explore: Pearl's own releases (1.0.6)", () => {
  it("node releases of the last 60 days become news; drafts, pre-releases and wallet tags do not", () => {
    const items = c.parseReleases(RELEASES, NOW);
    expect(items.map((i) => [i.title, i.importance])).toEqual([
      ["Pearl node v1.5.7 released: security release", "major"],
      ["Pearl node v1.5.5 released", "minor"],
    ]);
    // The link is built by Keshi from the tag: a link in the answer is never followed.
    expect(items[0]!.url).toBe("https://github.com/pearl-research-labs/pearl/releases/tag/v1.5.7");
    expect(items[0]).toMatchObject({ source: "Pearl Research Labs", topic: "prl", mood: "neutral" });
  });
  it("a fork in a release is said so, and a hostile or broken answer gives nothing", () => {
    const fork = c.parseReleases([{ tag_name: "v1.6.0", name: "v1.6.0 hardfork at block 150000", published_at: "2026-11-15T10:00:00Z", body: "" }], NOW);
    expect([fork[0]!.title, fork[0]!.importance]).toEqual(["Pearl node v1.6.0 released: fork", "major"]);
    for (const bad of [null, {}, "x", [null, 1, { tag_name: "v1.0.0<script>", published_at: "2026-11-15T10:00:00Z" }, { tag_name: "v1.0.0", published_at: "never" }, { tag_name: "v1.0.0", published_at: "2031-01-01T00:00:00Z" }]]) expect(c.parseReleases(bad, NOW)).toEqual([]);
    const odd = c.parseReleases([{ tag_name: "v1.0.1", name: "‮evil\u0000", published_at: "2026-11-15T10:00:00Z", body: "<img src=x onerror=alert(1)>".repeat(100) }], NOW)[0]!;
    expect(odd.summary.length).toBeLessThanOrEqual(280);
    expect(odd.title).toBe("Pearl node v1.0.1 released");
  });
});

describe("Explore: forks scheduled in Pearl's code (1.0.6)", () => {
  it("reads the main network's fork heights from Pearl's real file, not the test networks'", () => {
    expect(c.parseForks(PARAMS)).toEqual([
      { name: "MoE", height: 71935 },
      { name: "Dense only", height: 91630 },
      { name: "Rank penalty", height: 96251 },
      { name: "Salted seed", height: 99000 },
    ]);
  });
  it("today none is ahead; a new height in the file shows up with the blocks left", () => {
    expect(c.upcomingForks(c.parseForks(PARAMS), 144_500)).toEqual([]);
    const withFp8 = PARAMS.replace("SaltedSeedForkHeight: 99000,", "SaltedSeedForkHeight: 99000,\n\n\tFP8ForkHeight: 150_000,");
    const up = c.upcomingForks(c.parseForks(withFp8), 144_500);
    expect(up).toEqual([{ name: "FP8", height: 150000, blocksLeft: 5500, secondsLeft: 5500 * c.TARGET_BLOCK_SECONDS }]);
    expect(c.aboutIn(up[0]!.secondsLeft)).toBe("in about 12 days");
    expect([c.aboutIn(1800), c.aboutIn(3600 * 5.2)]).toEqual(["in less than an hour", "in about 5 hours"]);
    // No height known for the network, or a placeholder far away: nothing is claimed.
    expect(c.upcomingForks(c.parseForks(withFp8), 0)).toEqual([]);
    expect(c.upcomingForks([{ name: "Later", height: 999_999_999 }], 144_500)).toEqual([]);
    expect(c.parseForks("package chaincfg")).toEqual([]);
  });
});

describe("Explore: exchanges where PEARL starts trading (1.0.6)", () => {
  const T = (id: string, name: string, extra = {}) => ({ base: "PEARL", target: "USD", market: { name, identifier: id }, trade_url: `https://${id}.example/trade/PEARL-USD`, ...extra });
  it("the first reading takes note; a new exchange afterwards is news for 30 days, once", () => {
    const first = c.parseMarkets({ tickers: [T("safe_trade", "SafeTrade"), T("bigone", "BigONE"), T("bigone", "BigONE"), T("ghost", "Ghost", { is_stale: true })] });
    expect(first.map((m) => m.id)).toEqual(["safe_trade", "bigone"]);
    let mem = c.marketsStep(undefined, first, NOW);
    expect([mem.known, c.marketNews(mem)]).toEqual([["safe_trade", "bigone"], []]);
    const later = c.parseMarkets({ tickers: [T("safe_trade", "SafeTrade"), T("bigone", "BigONE"), T("kraken", "Kraken"), T("gdax", "Coinbase Exchange", { trade_url: "javascript:alert(1)" })] });
    mem = c.marketsStep(mem, later, NOW + 3600);
    expect(c.marketNews(mem).map((n) => [n.title, n.url, n.importance, n.mood])).toEqual([
      ["PEARL now trades on Kraken", "https://kraken.example/trade/PEARL-USD", "major", "bullish"],
      ["PEARL now trades on Coinbase Exchange", "https://www.coingecko.com/en/coins/pearl-2", "major", "bullish"],
    ]);
    // Seen again: not announced twice. A failed (empty) reading forgets nothing. After 30 days the news is dropped, the exchange stays known.
    expect(c.marketsStep(mem, later, NOW + 7200).added).toHaveLength(2);
    expect(c.marketsStep(mem, [], NOW + 7200)).toEqual(mem);
    const old = c.marketsStep(mem, later, NOW + 31 * 86400);
    expect([old.added, old.known.includes("kraken")]).toEqual([[], true]);
  });
  it("a broken memory or answer is survived", () => {
    expect(c.parseMarkets(null)).toEqual([]);
    expect(c.parseMarkets({ tickers: [null, { market: { identifier: "<x>", name: "X" } }, { market: { identifier: "ok", name: "" } }] })).toEqual([]);
    expect(c.marketsStep({ known: "x", added: "y" } as any, [{ id: "a", name: "A", url: "https://a.example" }], NOW)).toEqual({ known: ["a"], added: [] });
  });
});

describe("Explore: the three sources together (1.0.6)", () => {
  const serve = (map: Record<string, string | null>) =>
    (async (url: string) => {
      const hit = Object.entries(map).find(([k]) => String(url).includes(k));
      if (!hit || hit[1] === null) return new Response("no", { status: 500 });
      return new Response(hit[1], { status: 200 });
    }) as unknown as typeof fetch;
  it("reads releases, forks and markets, asking only public pages", async () => {
    const asked: string[] = [];
    const f = (async (url: string, init: RequestInit) => {
      asked.push(String(url));
      expect(init.credentials).toBe("omit");
      return serve({ "api.github.com": JSON.stringify(RELEASES), "raw.githubusercontent.com": PARAMS, "/api/v2": '{"blockbook":{"bestHeight":144500}}', coingecko: '{"tickers":[]}' })(url, init);
    }) as unknown as typeof fetch;
    const o = await c.loadOfficial("https://blockbook.pearlresearch.ai", undefined, f, NOW);
    expect(o.items.map((i) => i.title)).toEqual(["Pearl node v1.5.7 released: security release", "Pearl node v1.5.5 released"]);
    expect(o.forks).toEqual([]);
    expect(asked.sort()).toEqual([c.MARKETS_URL, c.RELEASES_URL, "https://blockbook.pearlresearch.ai/api/v2", c.PARAMS_URL].sort());
  });
  it("each source may fail alone; an unreadable fork file claims nothing rather than 'no fork'", async () => {
    const o = await c.loadOfficial("https://i.example", undefined, serve({ "api.github.com": null, "raw.githubusercontent.com": "garbage", "/api/v2": '{"blockbook":{"bestHeight":144500}}', coingecko: null }), NOW);
    expect(o).toEqual({ items: [], forks: undefined, markets: { known: [], added: [] } });
    const noTip = await c.loadOfficial("https://i.example", undefined, serve({ "api.github.com": "not json", "raw.githubusercontent.com": PARAMS, "/api/v2": null, coingecko: "{}" }), NOW);
    expect(noTip.forks).toBeUndefined();
  });
});

describe("Home: the price curve ends on the live price (1.0.6)", () => {
  const S = [{ time: 100, value: 1.52 }, { time: 200, value: 1.67 }];
  it("adds the live price as the last point, so the curve and the balance show the same figure", () => {
    const out = c.withLivePrice(S, 1.68, 500)!;
    expect(out).toEqual([...S, { time: 500, value: 1.68 }]);
    expect(S).toHaveLength(2); // the remembered series is not changed
    expect(c.withLivePrice(S, 1.68, 50)!.at(-1)!.time).toBe(201);
  });
  it("leaves the curve alone without a live price, when it already matches, or when the sources disagree", () => {
    for (const live of [null, undefined, 0, -1, NaN, 1.67, 3.4, 0.5]) expect(c.withLivePrice(S, live as any, 500)).toBe(S);
    expect(c.withLivePrice(null, 1.68)).toBeNull();
    expect(c.withLivePrice([], 1.68)).toEqual([]);
  });
});
