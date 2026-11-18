import { type NewsItem, readTextCapped, storyId } from "./news";
import { TARGET_BLOCK_SECONDS } from "./pools";

// Explore, first-hand sources for Pearl (1.0.6): what the newsrooms rarely carry.
//  1. Pearl's own node releases, from its GitHub repository.
//  2. Exchanges where PEARL starts trading, from CoinGecko's list of markets.
//  3. A fork scheduled in Pearl's code, with the blocks left.
// Everything here is public and read-only; nothing about the wallet is sent.

const REPO = "pearl-research-labs/pearl";
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
export const PARAMS_URL = `https://raw.githubusercontent.com/${REPO}/master/node/chaincfg/params.go`;
export const MARKETS_URL = "https://api.coingecko.com/api/v3/coins/pearl-2/tickers?depth=false";
const RELEASE_PAGE = `https://github.com/${REPO}/releases/tag/`;
const DAY = 86400;
/** The estimate uses Pearl's target pace, and says "about". */
const BLOCK_SECONDS = TARGET_BLOCK_SECONDS;

const clean = (x: unknown, max: number) => String(typeof x === "string" ? x : "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/* ------------------------------------------------------------ releases */

/** Node releases ("v1.5.7"), newest first, as news. Drafts, pre-releases and other tags (the desktop wallet's) are left out. */
export function parseReleases(json: unknown, now: number, days = 60, max = 5): NewsItem[] {
  if (!Array.isArray(json)) return [];
  const out: NewsItem[] = [];
  for (const r of json.slice(0, 30)) {
    if (!r || typeof r !== "object" || r.draft === true || r.prerelease === true) continue;
    const tag = clean(r.tag_name, 24);
    if (!/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tag)) continue;
    const time = Math.floor(Date.parse(String(r.published_at ?? "")) / 1000);
    if (!Number.isFinite(time) || time <= 0 || time > now + DAY || now - time > days * DAY) continue;
    const body = clean(r.body, 600);
    const text = `${clean(r.name, 120)} ${body}`;
    // What makes a release matter to everyone: a fork, a security fix, an upgrade that cannot wait.
    const fork = /\b(hard|soft)[- ]?fork\b|\bactivation height\b/i.test(text);
    const security = /\bsecurity\b|\bvulnerab|\bGHSA-|\bCVE-/i.test(text);
    const url = RELEASE_PAGE + tag; // built here, never taken from the answer
    out.push({
      id: storyId(url),
      title: `Pearl node ${tag} released${fork ? ": fork" : security ? ": security release" : ""}`,
      url,
      source: "Pearl Research Labs",
      time,
      summary: body.slice(0, 280),
      mood: "neutral",
      topic: "prl",
      importance: fork || security ? "major" : "minor",
      alsoIn: [],
    });
  }
  return out.sort((a, b) => b.time - a.time).slice(0, max);
}

/* --------------------------------------------------------------- forks */

export interface Fork {
  name: string;
  height: number;
}

/** The fork heights of Pearl's main network, as its code (node/chaincfg/params.go) sets them. */
export function parseForks(paramsGo: string): Fork[] {
  const start = paramsGo.indexOf("var MainNetParams");
  if (start < 0) return [];
  // The main network's own block: up to the next network's parameters.
  const next = paramsGo.slice(start + 20).search(/\nvar \w+Params\s*=/);
  const block = paramsGo.slice(start, next < 0 ? start + 20_000 : start + 20 + next).slice(0, 20_000);
  const out: Fork[] = [];
  for (const m of block.matchAll(/^\s*([A-Z][A-Za-z0-9]{1,40})ForkHeight:\s*([0-9][0-9_]{0,12})\s*,/gm)) {
    const height = Number(m[2]!.replace(/_/g, ""));
    if (!Number.isSafeInteger(height) || height <= 0) continue;
    // "SaltedSeed" -> "Salted seed", "MoE" stays "MoE", "FP8" stays "FP8".
    const words = m[1]!.replace(/([a-z0-9])([A-Z][a-z])/g, "$1 $2").split(" ");
    out.push({ name: words.map((w, i) => (i === 0 || /[A-Z0-9]{2}/.test(w) ? w : w.toLowerCase())).join(" "), height });
  }
  return out.slice(0, 40);
}

export interface UpcomingFork extends Fork {
  blocksLeft: number;
  /** Seconds left at Pearl's usual pace: an estimate. */
  secondsLeft: number;
}

/** Forks still ahead of the network, nearest first. A height absurdly far ahead is a placeholder, not a date. */
export function upcomingForks(forks: Fork[], tip: number): UpcomingFork[] {
  if (!(tip > 0)) return [];
  return forks
    .filter((f) => f.height > tip && f.height - tip < 2_000_000)
    .map((f) => ({ ...f, blocksLeft: f.height - tip, secondsLeft: (f.height - tip) * BLOCK_SECONDS }))
    .sort((a, b) => a.height - b.height);
}

/** "in about 3 days", "in about 5 hours". */
export function aboutIn(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return "in less than an hour";
  if (h < 48) return `in about ${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `in about ${Math.round(h / 24)} days`;
}

/* ------------------------------------------------------------- markets */

export interface Market {
  id: string;
  name: string;
  url: string;
}

/** The exchanges where PEARL trades right now, as CoinGecko lists them. Stale or abnormal markets are left out. */
export function parseMarkets(json: unknown): Market[] {
  const list = (json as { tickers?: unknown })?.tickers;
  if (!Array.isArray(list)) return [];
  const seen = new Map<string, Market>();
  for (const t of list.slice(0, 300)) {
    if (!t || typeof t !== "object" || t.is_stale === true || t.is_anomaly === true) continue;
    const id = clean(t.market?.identifier, 40).toLowerCase();
    const name = clean(t.market?.name, 40);
    if (!/^[a-z0-9_-]{2,40}$/.test(id) || !name || seen.has(id)) continue;
    let url = "https://www.coingecko.com/en/coins/pearl-2";
    try {
      const u = new URL(String(t.trade_url ?? ""));
      if (u.protocol === "https:") url = u.toString().slice(0, 300);
    } catch {
      /* no usable link: CoinGecko's own page */
    }
    seen.set(id, { id, name, url });
  }
  return [...seen.values()];
}

/** What Keshi remembers between visits: the exchanges already known, and those that appeared since, with the day they were first seen. */
export interface MarketMemory {
  known: string[];
  added: { id: string; name: string; url: string; at: number }[];
}

/**
 * One reading of the markets. The first reading only takes note (nothing is "new" yet); after it, an exchange
 * never seen before is kept as news for 30 days. An empty reading changes nothing: it is a failed answer, not a delisting.
 */
export function marketsStep(memory: MarketMemory | undefined, markets: Market[], now: number): MarketMemory {
  // No exchange known yet means no baseline yet (a first reading that failed or came back empty leaves none):
  // the first reading that does list exchanges is taken as the baseline, never announced as news.
  const list = Array.isArray(memory?.known) ? memory!.known.filter((x) => typeof x === "string").slice(0, 500) : [];
  const known = list.length > 0 ? list : null;
  const added = (Array.isArray(memory?.added) ? memory!.added : []).filter((a) => a && typeof a.at === "number" && now - a.at < 30 * DAY).slice(0, 20);
  if (!markets.length) return { known: known ?? [], added };
  if (!known) return { known: markets.map((m) => m.id), added: [] };
  const fresh = markets.filter((m) => !known.includes(m.id)).slice(0, 5);
  return { known: [...known, ...fresh.map((m) => m.id)].slice(0, 500), added: [...fresh.map((m) => ({ ...m, at: now })), ...added].slice(0, 20) };
}

export function marketNews(memory: MarketMemory): NewsItem[] {
  return memory.added.map((a) => ({
    id: storyId(`keshi:market:${a.id}`),
    title: `PEARL now trades on ${a.name}`,
    url: a.url,
    source: "CoinGecko markets",
    time: a.at,
    summary: `${a.name} appeared among the exchanges CoinGecko lists for PEARL.`,
    mood: "bullish",
    topic: "prl",
    importance: "major",
    alsoIn: [],
  }));
}

/* ---------------------------------------------------------------- load */

export interface Official {
  items: NewsItem[];
  /** Undefined when Pearl's code or the network's height could not be read: nothing is claimed then. */
  forks?: UpcomingFork[];
  markets: MarketMemory;
}

/**
 * Reads the three sources. Each one may fail on its own without touching the others, and none of them can
 * stop the news: a source that does not answer simply adds nothing this time.
 */
export async function loadOfficial(indexer: string, memory: MarketMemory | undefined, fetcher: typeof fetch = (...a) => fetch(...a), now = Math.floor(Date.now() / 1000)): Promise<Official> {
  const get = async (url: string, accept: string) => {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(12_000) : undefined;
    const res = await fetcher(url, { headers: { accept }, cache: "no-store", signal, credentials: "omit", redirect: "error" });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return readTextCapped(res, 1024 * 1024);
  };
  const [rel, params, tipJson, mk] = await Promise.allSettled([
    get(RELEASES_URL, "application/vnd.github+json").then((t) => JSON.parse(t)),
    get(PARAMS_URL, "text/plain"),
    get(`${indexer}/api/v2`, "application/json").then((t) => JSON.parse(t)),
    get(MARKETS_URL, "application/json").then((t) => JSON.parse(t)),
  ]);
  const releases = rel.status === "fulfilled" ? parseReleases(rel.value, now) : [];
  const markets = marketsStep(memory, mk.status === "fulfilled" ? parseMarkets(mk.value) : [], now);
  const tip = tipJson.status === "fulfilled" ? Number(tipJson.value?.blockbook?.bestHeight ?? tipJson.value?.backend?.blocks ?? 0) : 0;
  const all = params.status === "fulfilled" ? parseForks(params.value) : [];
  // Pearl has forked before, so a main-network block with no fork height at all means the file was not understood.
  const forks = all.length > 0 && tip > 0 ? upcomingForks(all, tip) : undefined;
  return { items: [...releases, ...marketNews(markets)], forks, markets };
}
