// News for the Explore tab: Pearl (PRL), and Ethereum, the network Keshi
// bridges to. Read-only public feeds, no account, no key:
// - the RSS feeds of the largest crypto newsrooms (CoinDesk, Cointelegraph,
//   The Block, Decrypt, CryptoSlate, BeInCrypto);
// - Bing News searches for Pearl, which find any outlet that covers it.
// Like a news desk, it keeps a story only when it is really about Pearl or
// Ethereum, drops price-prediction filler, keeps only the important Ethereum
// stories, and shows a story carried by many outlets once. Each story is
// marked bullish, bearish or neutral from the words of its title.

export type Mood = "bullish" | "bearish" | "neutral";
export type Topic = "prl" | "eth";
export type Importance = "critical" | "major" | "minor";

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  /** Unix seconds. */
  time: number;
  summary: string;
  mood: Mood;
  topic: Topic;
  importance: Importance;
  /** Other outlets that ran the same story. */
  alsoIn: string[];
}

/** The largest crypto newsrooms, read straight from their own RSS feeds. */
export const MEDIA_FEEDS: { name: string; url: string }[] = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
  { name: "BeInCrypto", url: "https://beincrypto.com/feed/" },
];
const BING = "https://www.bing.com/news/search?format=rss&setlang=en-US&cc=US&q=";
export const PEARL_QUERIES = ['"Pearl" PRL crypto', '"Pearl" blockchain "Proof-of-Useful-Work"', '"Pearl Research Labs"'];
/** How far back each topic goes, and how many stories it shows at most. Pearl news is rarer, so it reaches further back. */
export const NEWS_LIMITS: Record<Topic, { days: number; max: number }> = { prl: { days: 60, max: 30 }, eth: { days: 3, max: 15 } };

/* ---------------------------------------------------------------- parsing */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/<[^>]+>/g, " ") // tags that were escaped inside the text
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (block: string, name: string): string => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]! : "";
};

/** Only https web links are ever opened. Bing's redirect links are unwrapped to the article itself. */
export function articleUrl(raw: string): string | null {
  try {
    let u = new URL(decodeText(raw));
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.searchParams.get("url")) u = new URL(u.searchParams.get("url")!);
    if (u.protocol !== "https:") return null; // every newsroom Keshi reads serves https; a plain-http link would be a feed problem, not a story
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

export interface Raw {
  title: string;
  url: string;
  source: string;
  time: number;
  summary: string;
  /** "search": a Bing search for Pearl found it. "media": a newsroom's own feed, about everything in crypto. */
  via: "search" | "media";
}

/** Reads an RSS feed. `source` names the outlet when the feed is a newsroom's own; Bing names it per item. */
export function parseRss(xml: string, via: Raw["via"], source = ""): Raw[] {
  const out: Raw[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const b = m[1]!;
    const url = articleUrl(tag(b, "link") || tag(b, "guid"));
    const title = decodeText(tag(b, "title"));
    if (!url || !title) continue;
    const time = Math.floor(Date.parse(decodeText(tag(b, "pubDate"))) / 1000);
    const name = source || decodeText(tag(b, "News:Source") || tag(b, "source")) || new URL(url).hostname.replace(/^www\./, "");
    out.push({ title, url, source: name, time: Number.isFinite(time) ? time : 0, summary: decodeText(tag(b, "description")).slice(0, 280), via });
  }
  return out;
}

export const parseBing = (xml: string): Raw[] => parseRss(xml, "search");

/* ------------------------------------------------------------------ topic */

const PEARL_NAME = /\bpearl\b/i;
const PEARL_TICKER = /(^|[^A-Za-z0-9])\$?PRL(?![A-Za-z0-9])/;
const CRYPTO_CONTEXT = /\b(prl|wprl|crypto|token|coin|blockchain|mining|miners?|proof[- ]of[- ]useful[- ]work|pouw|pearl research|altcoin|exchange|listing|bridge|wallet|layer[- ]?1|l1|gpu|ai inference)\b/i;
/** The 2017-2018 "Oyster Pearl" token also used the ticker PRL. */
const NOT_THIS_PEARL = /oyster pearl|pearl jam|pearl harbor|pearl river|black pearl|pearl abyss|mother[- ]of[- ]pearl|pearl jewel|pearls? (necklace|earring)/i;

/** About the Pearl network. A newsroom's general feed must name Pearl in the headline itself, not in passing. */
export function isAboutPearl(r: { title: string; summary: string; via?: Raw["via"] }): boolean {
  const text = `${r.title} ${r.summary}`;
  const named = r.via === "media" ? PEARL_NAME.test(r.title) || PEARL_TICKER.test(r.title) : PEARL_NAME.test(text) || PEARL_TICKER.test(text);
  return named && CRYPTO_CONTEXT.test(text) && !NOT_THIS_PEARL.test(text);
}

const ETH_NAME = /\b(ethereum|ether|vitalik|buterin)\b/i;
const ETH_TICKER = /(^|[^A-Za-z0-9])\$?ETH(?![A-Za-z0-9])/;
const NOT_ETH = /\beth z(u|ü)rich\b/i;
/** Other coins, by name (any case) or by ticker (capitals only, so "sol" or "hype" in a sentence do not count). */
const OTHER_NAMES = /\b(bitcoin|solana|ripple|cardano|dogecoin|tron|toncoin|avalanche|polkadot|litecoin|chainlink|hyperliquid|shiba inu|monero|zcash|stellar)\b/i;
const OTHER_TICKERS = /(^|[^A-Za-z0-9])\$?(BTC|SOL|XRP|BNB|ADA|DOGE|TRX|TON|AVAX|DOT|LTC|LINK|SUI|HYPE|SHIB|PEPE|XMR|ZEC|XLM)(?![A-Za-z0-9])/;

/** Where the first of these patterns matches in the text, and where that match ends (the leading separator left out). */
const firstAt = (text: string, ...res: RegExp[]): { at: number; end: number } => {
  let best = { at: Infinity, end: Infinity };
  for (const re of res) {
    const m = re.exec(text);
    if (!m) continue;
    const lead = re.source.startsWith("(^|") ? (m[1]?.length ?? 0) : 0;
    if (m.index + lead < best.at) best = { at: m.index + lead, end: m.index + m[0].length };
  }
  return best;
};

/** "...overtake Ether", "faster than Ethereum": Ethereum is only the yardstick there. */
const COMPARED = /\b(overtak(e|es|en|ing)|outpac(e|es|ed|ing)|surpass(es|ed|ing)?|beat(s|ing)?|than|flip(s|ped|ping)?|vs\.?|versus|rivals?|like)\s+(the\s+)?$/i;

/**
 * About Ethereum: the headline names it as its subject. It must come before any other coin
 * ("Bitcoin slides, Ethereum follows" is a Bitcoin story), unless the two lead together
 * ("Bitcoin and Ethereum ETFs..."), and not as a mere comparison ("...overtake Ether").
 */
export function isAboutEthereum(title: string): boolean {
  if (NOT_ETH.test(title)) return false;
  const eth = firstAt(title, ETH_NAME, ETH_TICKER);
  if (eth.at === Infinity) return false;
  if (COMPARED.test(title.slice(0, eth.at))) return false;
  const other = firstAt(title, OTHER_NAMES, OTHER_TICKERS);
  if (eth.at <= other.at) return true;
  return other.end <= eth.at && /^\s*(and|&|,|\/)\s*$/i.test(title.slice(other.end, eth.at)) && !COMPARED.test(title.slice(0, other.at));
}

export function topicOf(r: Raw): Topic | null {
  if (isAboutPearl(r)) return "prl";
  if (isAboutEthereum(r.title)) return "eth";
  return null;
}

/** Price-prediction and "what to buy" filler, sponsored posts: no news in them. */
const FILLER = /\bprice (prediction|forecast|analysis)s?\b|\bpredictions?\b.*\b20\d\d\b|\bpr[ée]vision|\bhow to buy\b|\bwhere to buy\b|\bbest (crypto|coins?|altcoins?|tokens?) to buy\b|\bsponsored\b|\bpress release\b/i;
export const isFiller = (title: string): boolean => FILLER.test(title);

/* ------------------------------------------------------------- importance */

const CRITICAL = [
  /\bhack(s|ed|ers?)?\b/, /\bexploit(s|ed)?\b/, /\bstolen\b/, /\bdrain(s|ed)?\b/, /\bbreach(es|ed)?\b/, /\bvulnerabilit(y|ies)\b/, /\bdelist(s|ed|ing)?\b/,
  /\bban(s|ned)?\b/, /\blawsuits?\b/, /\bsue[sd]?\b/, /\bfraud\b/, /\barrest(s|ed)?\b/, /\bbankrupt(cy)?\b/, /\binsolven(t|cy)\b/, /\bcrash(es|ed)?\b/,
  /\bplung(e|es|ed)\b/, /\bplummet(s|ed)?\b/, /\brug[- ]?pull\b/, /\bexit scam\b/, /\bponzi\b/, /\bscam\b/, /\boutage\b/, /\bhalt(s|ed)?\b/, /\bpaused?\b/,
];
const MAJOR = [
  /\bpartner(s|ship|ships)?\b/, /\blaunch(es|ed)?\b/, /\blisting\b/, /\blisted\b/, /\bbinance\b/, /\bcoinbase\b/, /\bupgrade[sd]?\b/, /\b(hard[- ]?)?fork\b/,
  /\bmainnet\b/, /\btestnet\b/, /\bairdrop\b/, /\binvest(s|ment|ments|ors)?\b/, /\bfunding\b/, /\bacqui(re|res|red|sition)\b/, /\betfs?\b/, /\bapprov(al|ed|es)\b/,
  /\bregulat(ion|ions|or|ors|ory)\b/, /\binstitution(al|s)?\b/, /\bwhales?\b/, /\ball[- ]time high\b/, /\bath\b/, /\brecord\b/, /\bbreakout\b/, /\brall(y|ies|ied)\b/,
  /\bsurg(e|es|ed)\b/, /\bsoar(s|ed)?\b/, /\btumbl(e|es|ed)\b/, /\bstaking\b/, /\btreasur(y|ies)\b/, /\bfoundation\b/, /\broadmap\b/,
  /\b(pectra|fusaka|glamsterdam|dencun)\b/, /\d+(\.\d+)?%/, /\bshut(s|ting)?( down)?\b/, /\b(buys|buying|bought|accumulat(e|es|ed|es|ing|ion))\b/,
  /\$\d+(\.\d+)?\s?(m|b|bn|million|billion)\b/,
];

/** Critical (hacks, bans, crashes), major (listings, upgrades, ETFs, big moves) or minor, from the headline. */
export function importanceOf(title: string): Importance {
  const t = title.toLowerCase();
  if (/\bSEC\b/.test(title) || CRITICAL.some((re) => re.test(t))) return "critical";
  if (MAJOR.some((re) => re.test(t))) return "major";
  return "minor";
}

/* ------------------------------------------------------------------- mood */

const BULLISH = [
  /\bjump(s|ed)?\b/, /\bsurg(e|es|ed|ing)\b/, /\bsoar(s|ed|ing)?\b/, /\brall(y|ies|ied)\b/, /\bgains?\b/, /\bclimb(s|ed)?\b/, /\brises?\b/, /\brising\b/, /\brecord\b(?!\s+(lows?|outflows?|losses|liquidations?|drops?|declines?))/,
  /\ball[- ]time high\b/, /\bath\b/, /\bbreak(s|out)\b/, /\b(is |gets |now )?listed\b/, /\blisting\b/, /\blaunch(es|ed)?\b/, /\bpartner(s|ship|ships)?\b/, /\bintegrat(es|ed|ion)\b/,
  /\badoption\b/, /\bupgrade[sd]?\b/, /\bmainnet\b/, /\bmilestone\b/, /\bbullish\b/, /\bboost(s|ed)?\b/, /\bexpand(s|ed|ion)\b/, /\bapprov(al|ed|es)\b/, /\binvest(s|ment|ors)\b/,
  /\bfunding\b/, /\braises?\b/, /\bgrowth\b/, /\boutperform(s|ed)?\b/, /\bmomentum\b/, /\bspikes?\b/, /\bdoubles?\b/, /\binflows?\b/,
];
const BEARISH = [
  /\bdrop(s|ped)?\b/, /\bfall(s|en|ing)?\b/, /\bfell\b/, /\bplung(e|es|ed)\b/, /\bcrash(es|ed)?\b/, /\bslump(s|ed)?\b/, /\bs[ia]nks?\b/, /\btumbl(e|es|ed)\b/, /\bdeclin(e|es|ed)\b/,
  /\blosses\b/, /\bdump(s|ed|ing)?\b/, /\bsell[- ]?off\b/, /\bhack(s|ed|er|ers)?\b/, /\bexploit(s|ed)?\b/, /\bbreach\b/, /\bscam\b/, /\bfraud\b/, /\brug[- ]?pull\b/, /\blawsuit\b/,
  /\bsue[sd]?\b/, /\binvestigation\b/, /\bdelist(s|ed|ing)?\b/, /\bhalt(s|ed)?\b/, /\bpaused?\b/, /\boutage\b/, /\bbugs?\b/, /\bvulnerabilit(y|ies)\b/, /\battack(s|ed)?\b/,
  /\bwarn(s|ing|ed)?\b/, /\bbearish\b/, /\bconcerns?\b/, /\bdilution\b/, /\bunlocks?\b/, /\bwhale(s)? (sell|dump)/, /\bplummet(s|ed)?\b/, /\bcollaps(e|es|ed)\b/, /\b(new|record|all[- ]time|multi[- ]month) lows?\b/,
  /\boutflows?\b/, /\bslides?\b/, /\bdown \d+(\.\d+)?%/, /\bshut(s|ting)?( down)?\b/, /\bextends? losses\b/,
];

/** Bullish, bearish or neutral, from the title first (counted twice) and the summary. */
export function moodOf(title: string, summary = ""): Mood {
  const count = (text: string, list: RegExp[]) => list.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  // Word boundaries keep "delisted" from counting as "listed".
  const t = title.toLowerCase(), s = summary.toLowerCase();
  const score = 2 * (count(t, BULLISH) - count(t, BEARISH)) + (count(s, BULLISH) - count(s, BEARISH));
  return score > 0 ? "bullish" : score < 0 ? "bearish" : "neutral";
}

/* ---------------------------------------------------------------- dedupe */

const STOP = new Set("a an the of to in on for and or with as at by from is are be its it this that after over into up amid new says how why what".split(" "));

export function titleWords(title: string, source = ""): Set<string> {
  let t = title.toLowerCase();
  if (source) t = t.replace(new RegExp(`\\s[-|–—]\\s${source.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
  t = t.replace(/\s[-|–—]\s[^-|–—]{2,40}$/, ""); // " - Outlet" at the end of a headline
  return new Set(
    t
      .replace(/[^a-z0-9%$. ]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/\.$/, ""))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

const similar = (a: Set<string>, b: Set<string>): number => {
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / Math.max(1, Math.min(a.size, b.size));
};

const COINS: [string, RegExp[]][] = [
  ["eth", [ETH_NAME, ETH_TICKER]],
  ["prl", [PEARL_NAME, PEARL_TICKER]],
  ["btc", [/\bbitcoin\b/i, /(^|[^A-Za-z0-9])\$?BTC(?![A-Za-z0-9])/]],
  ["sol", [/\bsolana\b/i, /(^|[^A-Za-z0-9])\$?SOL(?![A-Za-z0-9])/]],
  ["xrp", [/\bripple\b/i, /(^|[^A-Za-z0-9])\$?XRP(?![A-Za-z0-9])/]],
  ["zec", [/\bzcash\b/i, /(^|[^A-Za-z0-9])\$?ZEC(?![A-Za-z0-9])/]],
];
const coinsIn = (title: string): string => COINS.filter(([, res]) => res.some((re) => re.test(title))).map(([c]) => c).join(",");

/**
 * Two headlines tell the same story when they share the same link, most of their words,
 * or enough of their rare words (names like "Pudgy Penguins" or "Abstract", which few
 * headlines of the day use) while naming the same coins and running within two days.
 * Headlines pointing opposite ways (one bullish, one bearish) are never merged.
 */
function sameStory(a: Story, b: Story, rare: (w: string) => boolean): boolean {
  if (a.url === b.url) return true;
  if (a.words.size < 3 || b.words.size < 3) return false;
  // "Record inflows" and "record outflows" share their words but not their story.
  if (a.mood !== b.mood && a.mood !== "neutral" && b.mood !== "neutral") return false;
  const sim = similar(a.words, b.words);
  if (sim >= 0.7) return true;
  if (sim < 0.35 || a.coins !== b.coins || Math.abs(a.time - b.time) > 2 * 86400) return false;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w) && rare(w)) shared++;
  return shared >= 2;
}
type Story = NewsItem & { words: Set<string>; coins: string };

/**
 * The news desk: keeps Pearl and Ethereum stories only, drops filler and stale
 * stories, keeps Ethereum's important stories only, and merges one story told by
 * several outlets. Newest first.
 */
export function mergeStories(raws: Raw[], now = Date.now() / 1000): NewsItem[] {
  // How many of today's headlines use each word: a word few of them use names a story.
  const df = new Map<string, number>();
  for (const r of raws) for (const w of titleWords(r.title, r.source)) df.set(w, (df.get(w) ?? 0) + 1);
  const rareLimit = Math.max(4, Math.ceil(raws.length * 0.05));
  const rare = (w: string) => (df.get(w) ?? 0) <= rareLimit && !/^\d|%$|^\$/.test(w);

  const kept: (Raw & { topic: Topic; importance: Importance })[] = [];
  for (const r of raws) {
    if (isFiller(r.title)) continue;
    const topic = topicOf(r);
    if (!topic) continue;
    if (r.time && now - r.time > NEWS_LIMITS[topic].days * 86400) continue;
    const importance = importanceOf(r.title);
    if (topic === "eth" && importance === "minor") continue;
    kept.push({ ...r, topic, importance });
  }
  kept.sort((a, b) => b.time - a.time);
  const out: Story[] = [];
  const shown: Record<Topic, number> = { prl: 0, eth: 0 };
  for (const r of kept) {
    const story: Story = { id: storyId(r.url), title: r.title, url: r.url, source: r.source, time: r.time, summary: r.summary, mood: moodOf(r.title, r.summary), topic: r.topic, importance: r.importance, alsoIn: [], words: titleWords(r.title, r.source), coins: coinsIn(r.title) };
    const same = out.find((o) => sameStory(o, story, rare));
    if (same) {
      if (r.source !== same.source && !same.alsoIn.includes(r.source)) same.alsoIn.push(r.source);
      continue;
    }
    if (shown[r.topic] >= NEWS_LIMITS[r.topic].max) continue;
    shown[r.topic]++;
    out.push(story);
  }
  return out.map(({ words: _w, coins: _c, ...item }) => item);
}

/** Short stable id for a link, to remember what was already read. */
export function storyId(url: string): string {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/* ---------------------------------------------------------------- loading */

export async function loadNews(fetcher: typeof fetch = (...a) => fetch(...a)): Promise<NewsItem[]> {
  const get = async (url: string) => {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(12_000) : undefined;
    const res = await fetcher(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" }, cache: "no-store", signal });
    if (!res.ok) throw new Error(`News source answered ${res.status}`);
    return res.text();
  };
  const results = await Promise.allSettled([
    ...PEARL_QUERIES.map((q) => get(BING + encodeURIComponent(q)).then((x) => parseRss(x, "search"))),
    ...MEDIA_FEEDS.map((f) => get(f.url).then((x) => parseRss(x, "media", f.name))),
  ]);
  const raws = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (!raws.length && results.every((r) => r.status === "rejected")) throw new Error("News is not reachable right now");
  return mergeStories(raws);
}
