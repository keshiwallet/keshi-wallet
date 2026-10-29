import type { Network } from "./network";
import type { Activity } from "./wallet";

// Mining monitor: the state of the Pearl network, what a pool reports for a
// payout address, and what a given hashrate should earn. Everything here is
// read-only. The only thing ever sent to a pool is the payout address, which
// the pool already knows; nothing else leaves the wallet.

/* ------------------------------------------------------------ emission */

/** Target seconds between blocks (3 min 14 s), from the node's chain parameters. */
export const TARGET_BLOCK_SECONDS = 194;
/** Total supply, in grains (2.1 billion PRL). */
const TOTAL_SUPPLY = 2_100_000_000n * 100_000_000n;
/** "Four years of blocks" at the target time: the emission constant E of the node (validate.go). */
const EMISSION_E = Math.floor((4 * 365 * 24 * 60 * 60) / TARGET_BLOCK_SECONDS); // 650226

/**
 * Block reward at a height, in grains, as the node computes it: a smooth
 * decay with no halvings, subsidy(h) = S × E / ((h + E)(h − 1 + E)).
 * Block 1 pays about 3,230 PRL; block 133,000 about 2,220 PRL.
 */
export function blockSubsidy(height: number): bigint {
  if (!Number.isFinite(height) || height < 1) return 0n;
  const h = BigInt(Math.floor(height)), E = BigInt(EMISSION_E);
  return (TOTAL_SUPPLY * E) / ((h + E) * (h - 1n + E));
}

/* ------------------------------------------------------- network state */

export interface NetworkState {
  height: number;
  difficulty: number;
  /** Average seconds between the last `window` blocks. */
  blockSeconds: number;
  /** Hashes per second, estimated from difficulty and the measured block time. */
  hashrate: number;
  /** Difficulty about 7 days ago, when known; for the trend. */
  difficultyWeekAgo?: number;
  /** Seconds between that block and the tip: the trend is scaled to exactly 7 days with it. */
  weekSpanSeconds?: number;
  /** PRL per block right now. */
  subsidy: bigint;
  at: number;
}

/**
 * Hashes per second behind a difficulty, with Pearl's 2^48 work per unit of
 * difficulty (the node's proof is a 48-bit target per tile, not Bitcoin's 32).
 */
export function hashrateFromDifficulty(difficulty: number, blockSeconds: number): number {
  if (!(difficulty > 0) || !(blockSeconds > 0)) return 0;
  return (difficulty * 2 ** 48) / blockSeconds;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetcher: Fetch, url: string): Promise<any> {
  // A pool or indexer that never answers must not leave the screen waiting forever.
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined;
  const res = await fetcher(url, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Could not read ${new URL(url).host} (${res.status})`);
  return res.json();
}

/**
 * The network, read from the wallet's own indexer: the tip's difficulty, the
 * time of the last blocks, and the difficulty a week ago (about 3,117 blocks).
 */
export async function networkState(net: Network, fetcher: Fetch = fetch, window = 60): Promise<NetworkState> {
  const base = net.indexer + "/api/v2";
  const root = await getJson(fetcher, base);
  const height = Number(root?.blockbook?.bestHeight ?? root?.backend?.blocks ?? 0);
  if (!(height > 0)) throw new Error("The Pearl network did not report its height");
  const [tip, past] = await Promise.all([getJson(fetcher, `${base}/block/${height}`), getJson(fetcher, `${base}/block/${Math.max(1, height - window)}`)]);
  const difficulty = Number(tip?.difficulty ?? root?.backend?.difficulty ?? 0);
  const dt = Number(tip?.time ?? 0) - Number(past?.time ?? 0);
  const blocks = height - Math.max(1, height - window);
  const blockSeconds = dt > 0 && blocks > 0 ? dt / blocks : TARGET_BLOCK_SECONDS;
  let difficultyWeekAgo: number | undefined, weekSpanSeconds: number | undefined;
  try {
    // About a week of blocks at the measured pace; the exact span is then read from the two blocks' times.
    const weekBlocks = Math.round((7 * 86_400) / (blockSeconds > 0 ? blockSeconds : TARGET_BLOCK_SECONDS));
    if (height > weekBlocks) {
      const old = await getJson(fetcher, `${base}/block/${height - weekBlocks}`);
      difficultyWeekAgo = Number(old?.difficulty) || undefined;
      const span = Number(tip?.time ?? 0) - Number(old?.time ?? 0);
      weekSpanSeconds = span > 86_400 ? span : undefined;
    }
  } catch {
    /* the trend is optional */
  }
  return { height, difficulty, blockSeconds, hashrate: hashrateFromDifficulty(difficulty, blockSeconds), difficultyWeekAgo, weekSpanSeconds, subsidy: blockSubsidy(height), at: Date.now() };
}

/* ---------------------------------------------------------------- pools */

export type PoolId = "kryptex" | "herominers";

export interface PoolInfo {
  id: PoolId;
  name: string;
  site: string;
  /** Hosts the wallet talks to for this pool; each must be in the manifest. */
  host: string;
}

export const POOLS: PoolInfo[] = [
  { id: "kryptex", name: "Kryptex", site: "https://pool.kryptex.com/prl", host: "https://pool.kryptex.com" },
  { id: "herominers", name: "HeroMiners", site: "https://pearl.herominers.com", host: "https://pearl.herominers.com" },
];

export interface Worker {
  name: string;
  /** Hashes per second as the pool reports it (0 when offline). */
  hashrate: number;
  /** Unix seconds of the last accepted share, 0 when unknown. */
  lastShare: number;
  online: boolean;
}

export interface MinerState {
  pool: PoolId;
  address: string;
  /** Hashes per second, all workers together. */
  hashrate: number;
  workers: Worker[];
  /** Unpaid balance at the pool, in grains, when the pool says. */
  unpaid?: bigint;
  /** Pool fee as a fraction (0.01 = 1%), when the pool says. */
  fee?: number;
  at: number;
}

/** A worker that has not sent work for this long is shown as offline. */
export const OFFLINE_AFTER_SECONDS = 10 * 60;

const num = (x: unknown) => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : 0;
};
const grains = (x: unknown) => {
  const n = num(x);
  return n > 0 ? BigInt(Math.round(n * 1e8)) : 0n;
};
const cleanName = (x: unknown) => String(x ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 40) || "worker";

/**
 * Kryptex, from its published API (pool.kryptex.com/openapi.yaml): workers with
 * the time of their last share, the miner's balance, and the pool's fee.
 */
async function kryptex(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const base = "https://pool.kryptex.com";
  const a = encodeURIComponent(address);
  const [w, bal, info] = await Promise.all([
    getJson(fetcher, `${base}/prl/api/v3/miner/workers/${a}`),
    getJson(fetcher, `${base}/prl/api/v1/miner/balance/${a}`).catch(() => null),
    getJson(fetcher, `${base}/prl/api/v1/pool/info`).catch(() => null),
  ]);
  // A malformed entry is skipped, not allowed to break the whole list (and with it the offline alert).
  const list: any[] = (Array.isArray(w?.results) ? w.results : Array.isArray(w) ? w : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, 200).map((x) => {
    const last = num(x.last_share ?? x.lastShare);
    const lastShare = last > 1e12 ? Math.floor(last / 1000) : last;
    const hashrate = num(x.hashrate);
    return { name: cleanName(x.worker ?? x.name), hashrate, lastShare, online: hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS) };
  });
  const fee = info ? num(info.fee ?? info.commission) : NaN;
  return {
    pool: "kryptex",
    address,
    hashrate: workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    workers,
    unpaid: bal ? grains(bal.total ?? bal.unconfirmed) : undefined,
    // Kryptex reports its fee in percent ("1" or "3").
    fee: Number.isFinite(fee) && fee > 0 && fee <= 50 ? fee / 100 : undefined,
    at: now,
  };
}

/** HeroMiners, with the stats_address answer their pools share: hashrate, balance and a workers list. */
async function herominers(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const j = await getJson(fetcher, `https://pearl.herominers.com/api/stats_address?address=${encodeURIComponent(address)}&recentBlocksAmount=0&longpoll=false`);
  if (j?.error) throw new Error(/not found|unknown|no data/i.test(String(j.error)) ? "This pool has never seen this address" : "The pool refused the request");
  const list: any[] = (Array.isArray(j?.workers) ? j.workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, 200).map((x) => {
    const last = num(x.lastShare);
    const lastShare = last > 1e12 ? Math.floor(last / 1000) : last;
    const hashrate = num(x.hashrate);
    return { name: cleanName(x.name), hashrate, lastShare, online: hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS) };
  });
  const total = num(j?.stats?.hashrate);
  return {
    pool: "herominers",
    address,
    hashrate: total || workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    workers,
    unpaid: j?.stats?.balance !== undefined ? BigInt(Math.round(num(j.stats.balance))) : undefined,
    at: now,
  };
}

export async function minerState(pool: PoolId, address: string, fetcher: Fetch = fetch, now = Date.now()): Promise<MinerState> {
  if (!/^prl1[02-9ac-hj-np-z]{20,90}$/.test(address)) throw new Error("That is not a Pearl address");
  return pool === "kryptex" ? kryptex(address, fetcher, now) : herominers(address, fetcher, now);
}

/**
 * For the offline alert: which workers count as stopped (silent for `afterMinutes`, or no hashrate and
 * no time of last work, or gone from the pool's list since last seen), which of them are new since the
 * last check (`fresh`, to announce once), and the names to remember.
 */
export function offlineCheck(
  state: Pick<MinerState, "workers">,
  memory: { offline: string[]; known: string[]; idleSince?: Record<string, number> },
  afterMinutes: number,
  nowSeconds: number,
): { offline: string[]; fresh: string[]; known: string[]; total: number; idleSince: Record<string, number> } {
  const limit = afterMinutes * 60;
  // A worker without the time of its last work counts from the first check that saw it idle: the chosen delay applies to it too.
  const idleSince: Record<string, number> = {};
  const before = memory.idleSince ?? {};
  for (const w of state.workers)
    if (w.lastShare <= 0 && !w.online) {
      const seen = Object.prototype.hasOwnProperty.call(before, w.name) ? Number(before[w.name]) : NaN;
      // Already announced before this record existed (an earlier version): it stays announced, not announced again.
      idleSince[w.name] = Number.isFinite(seen) ? seen : memory.offline.includes(w.name) ? nowSeconds - limit : nowSeconds;
    }
  const stopped = state.workers.filter((w) => (w.lastShare > 0 ? nowSeconds - w.lastShare >= limit : !w.online && nowSeconds - idleSince[w.name]! >= limit)).map((w) => w.name);
  const listed = new Set(state.workers.map((w) => w.name));
  const gone = memory.known.filter((n) => !listed.has(n));
  const offline = [...new Set([...stopped, ...gone])];
  const fresh = offline.filter((n) => !memory.offline.includes(n));
  const known = [...new Set([...memory.known, ...listed])].slice(-200);
  return { offline, fresh, known, total: new Set([...listed, ...memory.known]).size, idleSince };
}

/* ----------------------------------------------------------- earnings */

/** Expected PRL per day, in grains, for a hashrate on the current network. */
export function expectedPerDay(hashrate: number, net: Pick<NetworkState, "hashrate" | "blockSeconds" | "subsidy">, poolFee = 0): bigint {
  if (!(hashrate > 0) || !(net.hashrate > 0) || !(net.blockSeconds > 0)) return 0n;
  const share = hashrate / net.hashrate;
  const blocksPerDay = 86_400 / net.blockSeconds;
  const prl = share * blocksPerDay * (Number(net.subsidy) / 1e8) * (1 - Math.min(0.5, Math.max(0, poolFee)));
  return BigInt(Math.round(prl * 1e8));
}

/**
 * Hashes per second from a human figure: "548 TH/s", "1.2 PH/s", "300000000000000".
 * Pearl pools count matrix tiles; the usual sizes are TH/s per card and EH/s for the network.
 */
export function parseHashrate(text: string): number | null {
  const m = String(text).trim().match(/^([\d.,]+)\s*([kmgtpe]?)h?(?:\/s)?$/i);
  if (!m) return null;
  // "1,200" is twelve hundred (thousands separator); "1,2" is one point two.
  const digits = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(m[1]!) ? m[1]!.replace(/,/g, "") : m[1]!.replace(",", ".");
  const n = Number(digits);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult = { "": 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15, e: 1e18 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g" | "t" | "p" | "e"];
  return n * mult;
}

export function formatHashrate(h: number, digits = 1): string {
  if (!(h > 0)) return "0 H/s";
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) {
    h /= 1000;
    i++;
  }
  return `${h.toFixed(h >= 100 ? 0 : digits)} ${units[i]}`;
}

/** Reference figures per card, from pool device pages and public benchmarks (October 2026). Indicative only. */
export interface GpuPreset {
  name: string;
  family: "Blackwell" | "Hopper" | "RTX 50" | "RTX 40" | "RTX 30";
  hashrate: number;
  watts: number;
  /** No public benchmark found yet: shown with a note, never as a promise. */
  unverified?: boolean;
}

/** Reference figures per card, from pool device pages and public benchmarks (October 2026). Indicative only. */
export const GPU_PRESETS: GpuPreset[] = [
  { name: "NVIDIA B200", family: "Blackwell", hashrate: 1.2e15, watts: 950 },
  { name: "NVIDIA H100", family: "Hopper", hashrate: 0.75e15, watts: 700, unverified: true },
  { name: "RTX 5090", family: "RTX 50", hashrate: 400e12, watts: 525 },
  { name: "RTX 5080", family: "RTX 50", hashrate: 230e12, watts: 340, unverified: true },
  { name: "RTX 5070 Ti", family: "RTX 50", hashrate: 170e12, watts: 300, unverified: true },
  { name: "RTX 4090", family: "RTX 40", hashrate: 293e12, watts: 450 },
  { name: "RTX 4080", family: "RTX 40", hashrate: 159e12, watts: 260 },
  { name: "RTX 4070", family: "RTX 40", hashrate: 125e12, watts: 145 },
  { name: "RTX 4060", family: "RTX 40", hashrate: 65e12, watts: 110 },
  { name: "RTX 3090", family: "RTX 30", hashrate: 125e12, watts: 330 },
  { name: "RTX 3080", family: "RTX 30", hashrate: 107e12, watts: 160 },
  { name: "RTX 3070", family: "RTX 30", hashrate: 72e12, watts: 120 },
  { name: "RTX 3060", family: "RTX 30", hashrate: 44e12, watts: 110 },
];

/** The pools miners use, as a guide: fee and scheme as each pool publishes them (October 2026), checked in the app only when a pool answers. */
export interface PoolGuide {
  name: string;
  site: string;
  fee: string;
  scheme: string;
  note?: string;
  /** Can be followed from "My miner". */
  id?: PoolId;
  /** Announced, not mining yet. */
  soon?: boolean;
}
export const POOL_GUIDE: PoolGuide[] = [
  { name: "Kryptex", site: "https://pool.kryptex.com/prl", fee: "1–3%", scheme: "PPS+ / SOLO", note: "Largest pool, public API", id: "kryptex" },
  { name: "PearlHash", site: "https://pearlhash.xyz", fee: "1%", scheme: "PPLNS", note: "Second largest" },
  { name: "HeroMiners", site: "https://pearl.herominers.com", fee: "0–1%", scheme: "PPLNS", id: "herominers" },
  { name: "Pearl Fortune", site: "https://pearlfortune.org", fee: "1–5%", scheme: "PPS" },
  { name: "LuckyPool", site: "https://pearl.luckypool.io", fee: "1%", scheme: "PPLNS" },
  { name: "AlphaPool", site: "https://pearl.alphapool.tech", fee: "1%", scheme: "PROP" },
  { name: "Peryn", site: "https://peryn.ai", fee: "0% for founders", scheme: "PPLNS / FPPS", note: "Mine PEARL and serve AI requests for dollars, on the same GPU", soon: true },
];

export interface Estimate {
  prlPerDay: bigint;
  incomeUsd: number;
  powerUsd: number;
  netUsd: number;
  /** Net over the next 30 days if the difficulty keeps growing at `monthlyGrowth`. */
  net30Usd: number;
}

export function estimate(hashrate: number, watts: number, kwhUsd: number, price: number, net: Pick<NetworkState, "hashrate" | "blockSeconds" | "subsidy"> & { height?: number }, poolFee: number, monthlyGrowth: number): Estimate {
  const prlPerDay = expectedPerDay(hashrate, net, poolFee);
  const incomeUsd = (Number(prlPerDay) / 1e8) * price;
  const powerUsd = (Math.max(0, watts) * 24 * Math.max(0, kwhUsd)) / 1000;
  const netUsd = incomeUsd - powerUsd;
  // Each day the network is a little bigger, so the same hashrate earns a little less.
  const g = Math.max(0, monthlyGrowth);
  let net30Usd = 0;
  // The block reward also shrinks a little every block (no halving, a slow decay).
  const decay = (d: number) => {
    if (!net.height || !(net.blockSeconds > 0) || net.subsidy <= 0n) return 1;
    return Number(blockSubsidy(net.height + Math.round((d * 86_400) / net.blockSeconds))) / Number(net.subsidy);
  };
  for (let d = 0; d < 30; d++) net30Usd += (incomeUsd * decay(d)) / Math.pow(1 + g, d / 30) - powerUsd;
  return { prlPerDay, incomeUsd, powerUsd, netUsd, net30Usd };
}

/** Difficulty change over exactly 7 days, from the block about a week back and the real time between them. */
export function weeklyGrowth(net: NetworkState): number | undefined {
  if (!net.difficultyWeekAgo || !(net.difficulty > 0)) return undefined;
  const ratio = net.difficulty / net.difficultyWeekAgo;
  const span = net.weekSpanSeconds && net.weekSpanSeconds > 0 ? net.weekSpanSeconds : 7 * 86_400;
  return Math.pow(ratio, (7 * 86_400) / span) - 1;
}

/** Difficulty growth over a month, from the change over the last week (compounded over 30 days). */
export function monthlyGrowth(net: NetworkState): number | undefined {
  const weekly = weeklyGrowth(net);
  if (weekly === undefined) return undefined;
  return Math.pow(1 + weekly, 30 / 7) - 1;
}

/**
 * Real yield: what the wallet actually received over the last 7 days against
 * what the hashrate should have earned on today's network. 1 = as expected.
 */
export function realYield(activity: Activity[], hashrate: number, net: NetworkState, poolFee = 0, now = Date.now()): { received: bigint; expected: bigint; ratio: number } | null {
  const since = now / 1000 - 7 * 86_400;
  const received = activity.filter((a) => (a.kind === "received" || a.kind === "mined") && a.net > 0n && a.time >= since).reduce((s, a) => s + a.net, 0n);
  const expected = expectedPerDay(hashrate, net, poolFee) * 7n;
  if (expected <= 0n) return null;
  return { received, expected, ratio: Number(received) / Number(expected) };
}
