import { describe, expect, it } from "vitest";
import * as c from "../src/core";

const item = (title: string, link: string, source: string, date: string, desc = "") =>
  `<item><title>${title}</title><link>${link}</link><description>${desc}</description><pubDate>${date}</pubDate><News:Source>${source}</News:Source></item>`;
const now = new Date();
const ago = (h: number) => new Date(now.getTime() - h * 3600_000).toUTCString();
const bing = (u: string) => `http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=x&amp;url=${encodeURIComponent(u)}&amp;c=1&amp;mkt=en-us`;
const FEED = `<?xml version="1.0"?><rss><channel>
${item("Pearl (PRL) Jumps 27% as AI Mining Narrative Gains Momentum", bing("https://www.altcoinbuzz.io/pearl-prl-price?utm_source=rss"), "Altcoin Buzz", ago(2), "PRL rose on its Proof-of-Useful-Work model.")}
${item("Pearl PRL jumps 27% as AI mining narrative gains momentum - CoinGape", bing("https://coingape.com/pearl-jumps"), "CoinGape", ago(3), "The PRL token rallied.")}
${item("Pearl token plunges after bridge exploit warning", "https://example.news/pearl-exploit", "Example News", ago(5), "The crypto bridge was paused.")}
${item("Pearl Research Labs publishes mining guide", "https://example.org/guide", "Example", ago(8), "A guide to Pearl mining on GPUs.")}
${item("Pearl Jam announces world tour", "https://music.example/pearl-jam", "Music Daily", ago(1), "The band is back.")}
${item("Oyster Pearl (PRL) exit scam", "https://old.example/oyster", "Old News", ago(4), "Oyster Pearl crypto token.")}
${item("Pearl coin listed on new exchange &amp; rallies", "javascript:alert(1)", "Bad", ago(1), "PRL crypto")}
${item("Pearl blockchain gets a record low in volume", "https://example.news/low", "Example News", ago(30), "PRL token volume.")}
${item("Pearl PRL was hot in summer", "https://example.news/old", "Example News", new Date(now.getTime() - 90 * 86400_000).toUTCString(), "PRL crypto token")}
</channel></rss>`;

describe("Pearl news", () => {
  const stories = c.mergeStories(c.parseBing(FEED), now.getTime() / 1000);
  const titles = stories.map((s) => s.title);

  it("goes straight to the article, without Bing's redirect or tracking tags", () => {
    expect(stories[0]!.url).toBe("https://www.altcoinbuzz.io/pearl-prl-price");
  });

  it("shows each story once, crediting the other outlets that ran it", () => {
    expect(titles.filter((t) => /jumps 27%/i.test(t))).toHaveLength(1);
    expect(stories[0]!.alsoIn).toEqual(["CoinGape"]);
  });

  it("keeps only news about the Pearl network, from the last 60 days, with safe links", () => {
    expect(titles.some((t) => /Pearl Jam|Oyster|summer/.test(t))).toBe(false);
    expect(titles.some((t) => /listed on new exchange/.test(t))).toBe(false); // javascript: link refused
    expect(titles).toContain("Pearl Research Labs publishes mining guide");
  });

  it("marks bullish, bearish and neutral news", () => {
    const mood = (re: RegExp) => stories.find((s) => re.test(s.title))!.mood;
    expect(mood(/Jumps 27%/)).toBe("bullish");
    expect(mood(/plunges after bridge exploit/)).toBe("bearish");
    expect(mood(/mining guide/)).toBe("neutral");
    expect(mood(/record low/)).toBe("bearish");
    expect(c.moodOf("PRL delisted from exchange")).toBe("bearish");
    expect(c.moodOf("PRL listed on BigONE")).toBe("bullish");
  });

  it("drops price-prediction filler, in any language", () => {
    const filler = c.parseBing(`<rss><channel>${item("Pearl (PRL) Prévision du prix 2026, 2027, 2028", "https://fr.example/prl", "fr.example", ago(2), "PRL crypto")}${item("Pearl (PRL) price prediction 2026: can PRL reach $5?", "https://x.example/p", "X", ago(2), "PRL crypto")}</channel></rss>`);
    expect(c.mergeStories(filler, now.getTime() / 1000)).toHaveLength(0);
  });
});

const media = (titles: [string, number, string?][], host = "newsroom.example") =>
  `<?xml version="1.0"?><rss><channel><title>Newsroom</title>${titles
    .map(([t, h, d], i) => `<item><title><![CDATA[${t}]]></title><link><![CDATA[https://${host}/story-${i}?utm_source=rss_feed&utm_medium=rss]]></link><description><![CDATA[<p>${d ?? `Story ${i}.`}</p>]]></description><pubDate>${ago(h)}</pubDate></item>`)
    .join("")}</channel></rss>`;

describe("Ethereum and newsroom feeds", () => {
  const FEED = media([
    ["Ethereum's Glamsterdam test goes live on a public testnet", 2],
    ["Live updates: Cryptos tumble, with ETH down 5% as Tom Lee confirms buying limit", 1],
    ["Bitcoin slides below $83K as Ethereum follows", 3],
    ["ETH Zurich researchers publish a new AI model", 2],
    ["Ethereum price prediction 2026: will ETH hit $10K?", 2],
    ["Ethereum developers hold their weekly call", 4],
    ["Ethereum ETF inflows hit a record", 100],
    ["The hype around Ethereum staking ETFs grows", 5],
    ["Bitcoin miners turn to AI compute", 6, "Networks such as Pearl and Bittensor pay GPU miners for AI work."],
    ["Pearl (PRL) lands on a new exchange listing", 7],
  ]);
  const stories = c.mergeStories(c.parseRss(FEED, "media", "CoinDesk"), now.getTime() / 1000);
  const titles = stories.map((s) => s.title);

  it("names the newsroom, and opens the article without tracking tags", () => {
    expect(stories[0]).toMatchObject({ source: "CoinDesk", url: "https://newsroom.example/story-1" });
  });

  it("keeps the important Ethereum stories, of the last 3 days", () => {
    expect(titles).toEqual([
      "Live updates: Cryptos tumble, with ETH down 5% as Tom Lee confirms buying limit",
      "Ethereum's Glamsterdam test goes live on a public testnet",
      "The hype around Ethereum staking ETFs grows",
      "Pearl (PRL) lands on a new exchange listing",
    ]);
    expect(stories.find((s) => /Tom Lee/.test(s.title))).toMatchObject({ topic: "eth", mood: "bearish", importance: "major" });
    expect(stories.find((s) => /listing/.test(s.title))!.topic).toBe("prl");
  });

  it("leaves out stories mainly about another coin, ETH Zurich, filler, minor news and Pearl named in passing", () => {
    expect(c.isAboutEthereum("Bitcoin slides below $83K as Ethereum follows")).toBe(false);
    expect(c.isAboutEthereum("ETH Zurich researchers publish a new AI model")).toBe(false);
    expect(c.isAboutEthereum("The hype around Ethereum staking ETFs grows")).toBe(true);
    expect(c.isAboutEthereum("SOL and ETH rally")).toBe(true);
    expect(c.isAboutEthereum("SEC Clears 3x Leveraged Bitcoin and Ethereum Funds for Trading")).toBe(true);
    expect(c.isAboutEthereum("Kalshi’s 15-min gold markets overtake Ether just weeks after launch")).toBe(false);
    expect(c.isAboutEthereum("Bitcoin ETFs rebound with $119M inflow as Ether extends losses")).toBe(false);
    expect(c.isFiller("Ethereum price prediction 2026: will ETH hit $10K?")).toBe(true);
    expect(c.importanceOf("Ethereum developers hold their weekly call")).toBe("minor");
    expect(c.importanceOf("Pudgy Penguins' Ethereum Layer-2 Abstract Is Shutting Down")).toBe("major");
    expect(c.importanceOf("Bitmine Buys $41M More Ethereum")).toBe("major");
    expect(c.importanceOf("Ethereum bridge hacked for $40M")).toBe("critical");
    expect(c.importanceOf("SEC delays an Ethereum ETF decision")).toBe("critical");
    expect(titles.some((t) => /AI compute/.test(t))).toBe(false);
    expect(c.isAboutPearl({ title: "Bitcoin miners turn to AI, from Pearl to Bittensor", summary: "", via: "media" })).toBe(true);
  });

  it("shows a story once when a newsroom and a Bing search both carry it", () => {
    const fromBing = c.parseBing(`<rss><channel>${item("Pearl (PRL) lands on a new exchange listing", bing("https://newsroom.example/story-9?utm_source=bing"), "CoinDesk", ago(7), "PRL crypto")}${item("Pearl PRL lands on new exchange listing - Sample Wire", "https://wire.example/prl", "Sample Wire", ago(6), "PRL token")}</channel></rss>`);
    const merged = c.mergeStories([...c.parseRss(FEED, "media", "CoinDesk"), ...fromBing], now.getTime() / 1000).filter((s) => s.topic === "prl");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ source: "Sample Wire", alsoIn: ["CoinDesk"] });
  });

  it("merges a story told in different words, but never two stories pointing opposite ways", () => {
    const day = media([
      ["Pudgy Penguins’ Abstract becomes second Ethereum layer 2 to shut in a week", 1],
      ["Pudgy Penguins-backed Ethereum L2 Abstract to shut down after losing ‘tens of millions’", 2],
      ["Ethereum ETFs see record outflows", 3],
      ["Ethereum ETFs see record inflows again", 4],
      ...Array.from({ length: 40 }, (_, i) => [`Market note ${i}: traders watch the Fed and record stock highs`, 5] as [string, number]),
    ]);
    const got = c.mergeStories([...c.parseRss(day, "media", "CoinDesk"), ...c.parseRss(day.replace(/story-/g, "other-"), "media", "The Block").slice(1, 2)], now.getTime() / 1000);
    expect(got.map((s) => s.title)).toEqual([
      "Pudgy Penguins’ Abstract becomes second Ethereum layer 2 to shut in a week",
      "Ethereum ETFs see record outflows",
      "Ethereum ETFs see record inflows again",
    ]);
    expect(got[0]!.alsoIn).toEqual(["The Block"]);
    expect(got.map((s) => s.mood)).toEqual(["bearish", "bearish", "bullish"]);
  });

  it("caps Ethereum at 15 stories, newest first", () => {
    const many = media(Array.from({ length: 30 }, (_, i) => [`Ethereum upgrade lands for k${i}a m${i}b z${i}c`, i + 1] as [string, number]));
    const eth = c.mergeStories(c.parseRss(many, "media", "The Block"), now.getTime() / 1000);
    expect(eth).toHaveLength(c.NEWS_LIMITS.eth.max);
    expect(eth[0]!.title).toBe("Ethereum upgrade lands for k0a m0b z0c");
  });

  it("reads the newsrooms and Bing, never GitHub, and copes with a source that is down", async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      if (url.includes("theblock")) return new Response("busy", { status: 503 });
      if (url.includes("coindesk")) return new Response(FEED);
      return new Response("<rss><channel></channel></rss>");
    }) as unknown as typeof fetch;
    const got = await c.loadNews(fetcher);
    expect(asked.some((u) => u.includes("github"))).toBe(false);
    expect(c.MEDIA_FEEDS.every((f) => asked.includes(f.url))).toBe(true);
    expect(asked.filter((u) => u.includes("bing.com"))).toHaveLength(c.PEARL_QUERIES.length);
    expect(got.length).toBe(4);
    const down = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    await expect(c.loadNews(down)).rejects.toThrow("News is not reachable right now");
  });
});
