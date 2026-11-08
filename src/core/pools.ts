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

/** The most a pool's answer may weigh: the largest real one (LuckyPool's stats with its charts) is under 100 kB. */
export const JSON_MAX_BYTES = 4 * 1024 * 1024;

/** Reads a JSON answer without ever holding more than JSON_MAX_BYTES of it: a page that keeps streaming is cut off, not parsed. */
export async function readJsonCapped(res: Response, max = JSON_MAX_BYTES): Promise<any> {
  const declared = Number(res.headers?.get?.("content-length") ?? 0);
  if (declared > max) throw new Error("Answer too large");
  let text: string;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new Error("Answer too large");
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    text = new TextDecoder().decode(all);
  } else if (typeof res.text === "function") {
    text = await res.text();
    if (text.length > max) throw new Error("Answer too large");
  } else {
    return res.json(); // a stand-in answer in tests, with no body to stream
  }
  return JSON.parse(text);
}

async function getJson(fetcher: Fetch, url: string): Promise<any> {
  // A pool or indexer that never answers must not leave the screen waiting forever.
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined;
  const res = await fetcher(url, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (!res.ok) throw new Error(`Could not read ${new URL(url).host} (${res.status})`);
  return readJsonCapped(res);
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

export type PoolId = "kryptex" | "herominers" | "peryn" | "pearlhash" | "pearlfortune" | "luckypool";

export interface PoolInfo {
  id: PoolId;
  name: string;
  site: string;
  /** Hosts the wallet talks to for this pool; each must be in the manifest. */
  host: string;
  /** The pool's own page for one address, when it has one: the address goes at the end. */
  account?: string;
}
/** Where to see this address on the pool's site. */
export const poolPage = (p: PoolInfo, address: string) => (p.account ? p.account + encodeURIComponent(address) : p.site);

export const POOLS: PoolInfo[] = [
  { id: "kryptex", name: "Kryptex", site: "https://pool.kryptex.com/prl", host: "https://pool.kryptex.com" },
  { id: "herominers", name: "HeroMiners", site: "https://pearl.herominers.com", host: "https://pearl.herominers.com" },
  { id: "peryn", name: "Peryn", site: "https://app.peryn.ai/address", host: "https://app.peryn.ai" },
  { id: "pearlhash", name: "PearlHash", site: "https://pearlhash.xyz", host: "https://pearlhash.xyz", account: "https://pearlhash.xyz/account/" },
  { id: "pearlfortune", name: "Pearl Fortune", site: "https://pearlfortune.org", host: "https://pearlfortune.org" },
  { id: "luckypool", name: "LuckyPool", site: "https://pearl.luckypool.io", host: "https://pearl.luckypool.io" },
];

export interface Worker {
  name: string;
  /** Hashes per second as the pool reports it (0 when offline). */
  hashrate: number;
  /** Unix seconds of the last accepted share, 0 when unknown. */
  lastShare: number;
  online: boolean;
  /** Unix seconds the worker connected, when the pool says: a fresh connection ramps up and is not a drop. */
  since?: number;
}

export interface MinerState {
  pool: PoolId;
  address: string;
  /** Hashes per second, all workers together. */
  hashrate: number;
  workers: Worker[];
  /** Unpaid balance at the pool, in grains, when the pool says. */
  unpaid?: bigint;
  /** Paid out by the pool so far, in grains, when the pool says. */
  paid?: bigint;
  /** Average over the last 24 hours, when the pool gives one next to the current figure. */
  hashrate24h?: number;
  /** Pool fee as a fraction (0.01 = 1%), when the pool says. */
  fee?: number;
  /** False when the pool's worker list could not be read this time: `workers` is then not an answer, and no alert is drawn from it. */
  workersKnown?: boolean;
  at: number;
}

/** A worker that has not sent work for this long is shown as offline. */
export const OFFLINE_AFTER_SECONDS = 10 * 60;

/** A figure as the pool wrote it, or 0. Capped at 1e27 so that no unit multiplication can reach Infinity. */
const num = (x: unknown) => {
  const n = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? Math.min(n, 1e27) : 0;
};
/** PRL (a number) to grains; nothing above the total supply is believed. */
const grains = (x: unknown) => {
  const n = num(x);
  return n > 0 && n <= 2.1e9 ? BigInt(Math.round(n * 1e8)) : 0n;
};
/** Workers kept per miner state: enough for any farm, bounded for memory. */
export const WORKERS_MAX = 5000;
const cleanName = (x: unknown) => String(x ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 40) || "worker";
/** "12.34567890" (a PRL amount written with decimals) to grains, exactly; nonsense is 0. */
const grainsOfDecimal = (x: unknown): bigint => {
  if (typeof x === "number") return grains(x);
  const t = String(x ?? "").trim();
  // A PRL amount is at most "2100000000.00000000": anything longer is not one, and is not worth a regex.
  if (t.length > 24) return 0n;
  const m = t.match(/^(\d{1,10})(?:\.(\d{0,8})\d*)?$/);
  if (!m) return 0n;
  return BigInt(m[1]!) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
};
/** A time the pool gives as seconds, milliseconds or ISO text, to unix seconds; 0 when unknown. */
const seconds = (x: unknown): number => {
  if (typeof x === "string" && /[-:T]/.test(x)) {
    const t = Date.parse(x);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  }
  const n = num(x);
  return n > 1e12 ? Math.floor(n / 1000) : n;
};

/** Kryptex gives its fee as a fraction ("0.03" for 3%) on its pool page, and in percent ("3") elsewhere: both read as a fraction, nonsense dropped. */
function kryptexFee(x: unknown): number | undefined {
  const n = num(x);
  if (!(n > 0)) return undefined;
  const f = n < 1 ? n : n / 100;
  return f <= 0.5 ? f : undefined;
}

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
  // As Kryptex answers (6 November 2026): worker, status "online" | "offline", last_share in milliseconds,
  // avg_hashrate_30m / _3h / _24h as decimal strings. Older shapes with hashrate / lastShare are still read.
  const all: Worker[] = list.map((x) => {
    const last = num(x.last_share ?? x.lastShare);
    const lastShare = last > 1e12 ? Math.floor(last / 1000) : last;
    const hashrate = num(x.avg_hashrate_30m ?? x.hashrate);
    const status = String(x.status ?? "").toLowerCase();
    const online = status === "online" ? true : status === "offline" ? false : hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS);
    const opened = seconds(x.opened_at);
    return { name: cleanName(x.worker ?? x.name), hashrate, lastShare, online, since: opened > 0 ? opened : undefined };
  });
  const day = list.reduce((s, x) => s + num(x.avg_hashrate_24h), 0);
  // A farm can have thousands of workers: all of them are kept, so the alerts watch every one (the screen shows the first thousand).
  const workers = all.length > WORKERS_MAX ? all.slice(0, WORKERS_MAX) : all;
  const fee = info ? kryptexFee(info.fee ?? info.commission) : undefined;
  return {
    pool: "kryptex",
    address,
    hashrate: all.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    hashrate24h: day > 0 ? day : undefined,
    workers,
    unpaid: bal ? grains(bal.total ?? bal.unconfirmed) : undefined,
    paid: bal && num(bal.paid) > 0 ? grains(bal.paid) : undefined,
    fee,
    at: now,
  };
}

/** HeroMiners, with the stats_address answer their pools share: hashrate, balance and a workers list. */
/** HeroMiners counts hashrate in units of 2^32 hashes (its pool.hashrate × 2^32 = its pool.realHashrate, to the hash). */
const HEROMINERS_UNIT = 4294967296;
async function herominers(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  // As pearl.herominers.com/api/stats_address answers (6 November 2026): stats.hashrate, hashrate_24h and each worker's
  // hashrate in units of 2^32 hashes; balance and paid in grains; lastShare in seconds (strings or numbers).
  const [j, pool] = await Promise.all([
    getJson(fetcher, `https://pearl.herominers.com/api/stats_address?address=${encodeURIComponent(address)}&recentBlocksAmount=0&longpoll=false`),
    getJson(fetcher, "https://pearl.herominers.com/api/stats").catch(() => null),
  ]);
  if (j?.error) throw new Error(/not found|unknown|no data/i.test(String(j.error)) ? "This pool has never seen this address" : "The pool refused the request");
  const list: any[] = (Array.isArray(j?.workers) ? j.workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, WORKERS_MAX).map((x) => {
    const last = num(x.lastShare);
    const lastShare = last > 1e12 ? Math.floor(last / 1000) : last;
    const hashrate = num(x.hashrate) * HEROMINERS_UNIT;
    return { name: cleanName(x.name), hashrate, lastShare, online: hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS) };
  });
  const total = num(j?.stats?.hashrate) * HEROMINERS_UNIT;
  const day = num(j?.stats?.hashrate_24h) * HEROMINERS_UNIT;
  const feePct = pool && typeof pool?.config?.fee === "number" ? num(pool.config.fee) : NaN;
  return {
    pool: "herominers",
    address,
    hashrate: total || workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    workers,
    unpaid: j?.stats?.balance !== undefined ? BigInt(Math.round(Math.min(2.1e17, Math.max(0, num(j.stats.balance))))) : undefined,
    paid: num(j?.stats?.paid) > 0 ? BigInt(Math.round(Math.min(2.1e17, num(j.stats.paid)))) : undefined,
    hashrate24h: day > 0 ? day : undefined,
    fee: Number.isFinite(feePct) && feePct >= 0 && feePct <= 50 ? feePct / 100 : undefined,
    at: now,
  };
}

/**
 * Peryn, from its documented API (docs.peryn.ai, "Pool API", v1): one page per address with
 * every worker, whether it is online (an accepted share in the last few minutes, as Peryn counts it),
 * the balance owed, and the pool's fee from the pool page. Hashrates are in MAC/s, which is the
 * unit every Pearl pool shows as H/s.
 */
async function peryn(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const base = "https://app.peryn.ai/api/v1";
  const [j, pool] = await Promise.all([getJson(fetcher, `${base}/miner/${encodeURIComponent(address)}`), getJson(fetcher, `${base}/pool`).catch(() => null)]);
  if (j?.error) throw new Error(/invalid_address/i.test(String(j.error)) ? "That is not a Pearl address for this network" : "The pool refused the request");
  const list: any[] = (Array.isArray(j?.workers) ? j.workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, WORKERS_MAX).map((x) => {
    const lastShare = seconds(x.lastShare);
    const hashrate = num(x.hashrate1h ?? x.hashrate);
    const online = x.online === true || (x.online !== false && hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS));
    return { name: cleanName(x.name), hashrate, lastShare, online };
  });
  const total = num(j?.hashrate1h);
  const feePct = num(pool?.fees?.fpps?.feePct ?? pool?.fees?.pplns?.feePct);
  return {
    pool: "peryn",
    address,
    hashrate: total || workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    workers,
    unpaid: j?.balance && typeof j.balance === "object" ? grainsOfDecimal(j.balance.owedPrl) + grainsOfDecimal(j.balance.pendingPrl) : undefined,
    paid: j?.balance && typeof j.balance === "object" && grainsOfDecimal(j.balance.paidPrl) > 0n ? grainsOfDecimal(j.balance.paidPrl) : undefined,
    hashrate24h: num(j?.hashrate24h) > 0 ? num(j.hashrate24h) : undefined,
    fee: feePct > 0 && feePct <= 50 ? feePct / 100 : undefined,
    at: now,
  };
}

/**
 * PearlHash, from the page its site reads for one address (pearlhash.xyz/api/account/<address>,
 * as it answered on 4 November 2026): the workers connected right now, the estimated hashrate,
 * and the balance movements. A worker is online while it is in the connected list; one that
 * leaves the list is reported stopped by the offline check. An address the pool has never seen
 * answers 404.
 */
async function pearlhash(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const base = "https://pearlhash.xyz/api";
  let j: any;
  try {
    j = await getJson(fetcher, `${base}/account/${encodeURIComponent(address)}`);
  } catch (e) {
    throw new Error(/\b404\b/.test(String((e as Error)?.message)) ? "This pool has never seen this address" : "The pool refused the request");
  }
  const list: any[] = (Array.isArray(j?.connected_workers) ? j.connected_workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, WORKERS_MAX).map((x) => {
    const hashrate = num(x.hashrate ?? x.estimated_hashrate_5m ?? x.estimated_hashrate_60s ?? x.hashrate_5m ?? x.hashrate_60s);
    // Listed as connected: online, whatever its hashrate so far (a worker just started has none yet).
    // No time of last share is kept: PearlHash says who is connected, and a worker that leaves the list is the stopped one.
    return { name: cleanName(x.name ?? x.worker ?? x.id), hashrate, lastShare: 0, online: true };
  });
  const total = num(j?.estimated_hashrate_5m ?? j?.estimated_hashrate_60s ?? j?.estimated_hashrate_15s);
  // The balance is the sum of its movements: credits add, payments take away. Unknown shapes count for nothing.
  const moves: any[] = (Array.isArray(j?.balance_transactions) ? j.balance_transactions : []).filter((x: unknown) => x && typeof x === "object");
  let unpaid: bigint | undefined;
  let paid = 0n;
  if (moves.length) {
    unpaid = 0n;
    for (const t of moves) {
      const amount = grainsOfDecimal(t.amount ?? t.amount_prl ?? t.value);
      const reason = String(t.reason ?? t.type ?? t.kind ?? "").toLowerCase();
      const n = num(t.amount ?? t.amount_prl ?? t.value);
      if (n < 0) { unpaid -= grainsOfDecimal(-n); paid += grainsOfDecimal(-n); }
      else if (/pay|withdraw|sent/.test(reason)) { unpaid -= amount; paid += amount; }
      else unpaid += amount;
    }
    if (unpaid < 0n) unpaid = 0n;
  }
  return { pool: "pearlhash", address, hashrate: total || workers.reduce((s, x) => s + x.hashrate, 0), workers, unpaid, paid: paid > 0n ? paid : undefined, fee: 0.01, at: now };
}

/**
 * Pearl Fortune, from the pages its Address Lookup reads (pearlfortune.org/api/v1, as they
 * answered on 4 November 2026): the rolling hashrate of the address, the workers connected,
 * the balance from the ledger, and the fee of the address's own payment mode (PPS or PPLNS).
 */
async function pearlfortune(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const base = `https://pearlfortune.org/api/v1/miners/${encodeURIComponent(address)}`;
  const [m, conn, ledger, mode] = await Promise.all([
    getJson(fetcher, `${base}?hours=24&tz_offset_min=0`),
    // A failed worker-list request is not an empty list: the state says so, and the alerts wait for a real answer.
    getJson(fetcher, `${base}/connections`).catch(() => undefined),
    getJson(fetcher, `${base}/ledger?page=1&page_size=1`).catch(() => null),
    getJson(fetcher, `${base}/address-mode`).catch(() => null),
  ]);
  const d = m?.data && typeof m.data === "object" ? m.data : null;
  if (!d) throw new Error("The pool refused the request");
  const rolling: any[] = Array.isArray(d.hourly_shares?.rolling_hashrates) ? d.hourly_shares.rolling_hashrates : [];
  const h1 = rolling.find((r) => r && num(r.hours) === 1) ?? rolling[0];
  const h24 = rolling.find((r) => r && num(r.hours) === 24);
  const workersKnown = conn !== undefined && Array.isArray(conn?.data?.workers);
  const list: any[] = (workersKnown ? conn.data.workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, WORKERS_MAX).map((x) => {
    const hashrate = num(x.hashrate ?? x.hashrate_1h ?? x.effective_hashrate);
    const lastShare = seconds(x.last_share ?? x.last_share_at ?? x.last_seen ?? x.last_seen_at ?? x.lastShare ?? x.updated_at);
    return { name: cleanName(x.worker_name ?? x.name ?? x.worker ?? x.id), hashrate, lastShare, online: x.online !== false };
  });
  const feeRate = num(mode?.data?.bridge?.payment_mode === "pps" ? mode?.data?.bridge?.pps_fee_rate : d.pending_shares?.pending_fee_quote?.rate);
  const bal = ledger?.data?.balance_atomic;
  return {
    pool: "pearlfortune",
    workersKnown,
    address,
    hashrate: num(h1?.hashrate) || workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    hashrate24h: num(h24?.hashrate) > 0 ? num(h24.hashrate) : undefined,
    workers,
    // balance_atomic is already in grains (atomic_units_per_coin is 100000000).
    // Capped like every other pool figure: more than 18 digits is not a balance.
    unpaid: bal !== undefined && bal !== null && /^\d{1,18}$/.test(String(bal)) ? BigInt(String(bal)) : undefined,
    fee: feeRate > 0 && feeRate <= 0.5 ? feeRate : undefined,
    at: now,
  };
}

/**
 * LuckyPool, from the page its "Your stats" reads (pearl.luckypool.io/api/stats_address, as it answered on
 * 6 November 2026): stats.hashrate in H/s, hashrateAvg["24h"], lastShare in milliseconds, unlocked and locked
 * balances in grains, paid in grains; the pool's fee from its stats page. Workers are read as the other
 * pools of this kind list them (name, hashrate, lastShare).
 */
async function luckypool(address: string, fetcher: Fetch, now: number): Promise<MinerState> {
  const [j, pool] = await Promise.all([
    getJson(fetcher, `https://pearl.luckypool.io/api/stats_address?address=${encodeURIComponent(address)}`),
    getJson(fetcher, "https://pearl.luckypool.io/api/stats").catch(() => null),
  ]);
  if (j?.error) throw new Error(/not found|unknown|no data|invalid/i.test(String(j.error)) ? "This pool has never seen this address" : "The pool refused the request");
  const list: any[] = (Array.isArray(j?.workers) ? j.workers : []).filter((x: unknown) => x && typeof x === "object");
  const workers: Worker[] = list.slice(0, WORKERS_MAX).map((x) => {
    const lastShare = seconds(x.lastShare ?? x.last_share ?? x.lastSeen);
    const hashrate = num(x.hashrate ?? x.hashrate_1h ?? x.hashrateAvg?.["1h"]);
    return { name: cleanName(x.name ?? x.worker ?? x.id), hashrate, lastShare, online: hashrate > 0 && (lastShare === 0 || now / 1000 - lastShare < OFFLINE_AFTER_SECONDS) };
  });
  const st = j?.stats && typeof j.stats === "object" ? j.stats : {};
  const total = num(st.hashrate);
  const day = num(st.hashrateAvg?.["24h"]);
  const toGrains = (x: unknown) => BigInt(Math.round(Math.min(2.1e17, Math.max(0, num(x)))));
  const feePct = pool && typeof pool?.config?.fee === "number" ? num(pool.config.fee) : NaN;
  return {
    pool: "luckypool",
    address,
    hashrate: total || workers.reduce((s, x) => s + (x.online ? x.hashrate : 0), 0),
    workers,
    unpaid: st.unlocked !== undefined || st.locked !== undefined ? toGrains(st.unlocked) + toGrains(st.locked) : undefined,
    paid: num(st.paid) > 0 ? toGrains(st.paid) : undefined,
    hashrate24h: day > 0 ? day : undefined,
    fee: Number.isFinite(feePct) && feePct >= 0 && feePct <= 50 ? feePct / 100 : undefined,
    at: now,
  };
}

export async function minerState(pool: PoolId, address: string, fetcher: Fetch = fetch, now = Date.now()): Promise<MinerState> {
  if (!/^prl1[02-9ac-hj-np-z]{20,90}$/.test(address)) throw new Error("That is not a Pearl address");
  const read = async () => {
    switch (pool) {
      case "kryptex": return kryptex(address, fetcher, now);
      case "peryn": return peryn(address, fetcher, now);
      case "pearlhash": return pearlhash(address, fetcher, now);
      case "pearlfortune": return pearlfortune(address, fetcher, now);
      case "luckypool": return luckypool(address, fetcher, now);
      default: return herominers(address, fetcher, now);
    }
  };
  const state = await read();
  return { ...state, workers: distinctNames(state.workers) };
}

/** Two rigs with the same name stay two rigs: the second is "name #2", so counts and alerts keep them apart. */
export function distinctNames(workers: Worker[]): Worker[] {
  const seen = new Map<string, number>();
  return workers.map((w) => {
    const n = (seen.get(w.name) ?? 0) + 1;
    seen.set(w.name, n);
    return n === 1 ? w : { ...w, name: `${w.name} #${n}`.slice(0, 44) };
  });
}

/**
 * For the offline alert: which workers count as stopped (silent for `afterMinutes`, or no hashrate and
 * no time of last work, or gone from the pool's list since last seen), which of them are new since the
 * last check (`fresh`, to announce once), and the names to remember.
 */
/** How long a worker may be missing from the pool's list before it is forgotten. */
export const FORGET_SECONDS = 7 * 86400;

export function offlineCheck(
  state: Pick<MinerState, "workers" | "workersKnown">,
  memory: { offline: string[]; known: string[]; idleSince?: Record<string, number> },
  afterMinutes: number,
  nowSeconds: number,
): { offline: string[]; fresh: string[]; known: string[]; total: number; idleSince: Record<string, number> } {
  // No worker list this time: nothing is announced and the memory is kept as it was, until the pool answers again.
  if (state.workersKnown === false) return { offline: memory.offline, fresh: [], known: memory.known, total: memory.known.length, idleSince: memory.idleSince ?? {} };
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
  // A worker that left the list (pools that list only connected workers drop it at once) gets the same delay as an idle one:
  // a reconnection that straddles a check is not a stop.
  // A name absent for a week is forgotten: a rig renamed or retired is not "stopped" forever.
  const gone: string[] = [];
  const forgotten = new Set<string>();
  for (const n of memory.known)
    if (!listed.has(n)) {
      const seen = Object.prototype.hasOwnProperty.call(before, n) ? Number(before[n]) : NaN;
      const since = Number.isFinite(seen) ? seen : memory.offline.includes(n) ? nowSeconds - limit : nowSeconds;
      if (nowSeconds - since >= FORGET_SECONDS) {
        forgotten.add(n);
        continue;
      }
      idleSince[n] = since;
      if (nowSeconds - since >= limit) gone.push(n);
    }
  const offline = [...new Set([...stopped, ...gone])];
  const fresh = offline.filter((n) => !memory.offline.includes(n));
  const remembered = memory.known.filter((n) => !forgotten.has(n));
  const known = [...new Set([...remembered, ...listed])].slice(-WORKERS_MAX);
  return { offline, fresh, known, total: new Set([...listed, ...remembered]).size, idleSince };
}

/* ----------------------------------------------------------- earnings */

/** Expected PRL per day, in grains, for a hashrate on the current network. */
export function expectedPerDay(hashrate: number, net: Pick<NetworkState, "hashrate" | "blockSeconds" | "subsidy">, poolFee = 0): bigint {
  if (!(hashrate > 0) || !(net.hashrate > 0) || !(net.blockSeconds > 0)) return 0n;
  const share = hashrate / net.hashrate;
  const blocksPerDay = 86_400 / net.blockSeconds;
  const prl = share * blocksPerDay * (Number(net.subsidy) / 1e8) * (1 - Math.min(0.5, Math.max(0, poolFee)));
  if (!Number.isFinite(prl)) return 0n;
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
  const h = n * mult;
  return Number.isFinite(h) ? h : null;
}

export function formatHashrate(h: number, digits = 1): string {
  if (!(h > 0) || !Number.isFinite(h)) return "0 H/s";
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
  /** Has a public page Keshi may ask whether it answers (the dot next to its name). */
  status?: PoolStatusKind;
}
export const POOL_GUIDE: PoolGuide[] = [
  { name: "Kryptex", site: "https://pool.kryptex.com/prl", fee: "1–3%", scheme: "PPS+ / SOLO", note: "Largest pool, public API", id: "kryptex", status: "kryptex" },
  { name: "PearlHash", site: "https://pearlhash.xyz", fee: "1%", scheme: "PPLNS", note: "WildRig recommended, TLS on port 9443", id: "pearlhash", status: "pearlhash" },
  { name: "HeroMiners", site: "https://pearl.herominers.com", fee: "0–1%", scheme: "PROP", note: "Paid every hour from 1 PRL", id: "herominers", status: "herominers" },
  { name: "Pearl Fortune", site: "https://pearlfortune.org", fee: "2–4%", scheme: "PPLNS / PPS", id: "pearlfortune", status: "pearlfortune" },
  { name: "LuckyPool", site: "https://pearl.luckypool.io", fee: "1%", scheme: "PROP", note: "Pool or solo, Pearl + NOCK merge mining", id: "luckypool", status: "luckypool" },
  { name: "Peryn", site: "https://peryn.ai/mine", fee: "1%", scheme: "PPS+ / PPLNS", note: "Mine PEARL and serve AI requests for dollars, on the same GPU", id: "peryn", status: "peryn" },
];

/* ----------------------------------------------------------- pool status */

/**
 * Whether a pool answers right now, for the dot next to its name. Only pools with a
 * public API are asked (Kryptex, HeroMiners, Peryn, PearlHash, Pearl Fortune, LuckyPool): the others have no address Keshi
 * may call. "No answer" means the pool's API did not answer Keshi within 15 seconds,
 * which can be the pool, the network, or this computer: it is not "the pool is down".
 */
export type PoolStatusKind = "kryptex" | "herominers" | "peryn" | "pearlhash" | "pearlfortune" | "luckypool";
export interface PoolStatus {
  kind: PoolStatusKind;
  state: "live" | "no-answer" | "coming";
  /** A short line read from the pool itself (hashrate, miners, payouts), when it says. */
  detail?: string;
  /** The pool's fee as it reports it now, as text ("1%"), when it says. */
  fee?: string;
  /** The same fee as a fraction, for the default scheme (the lower one when the pool has two), for estimates. */
  feeRate?: number;
  /** Blocks found against blocks expected, when the pool publishes its blocks and the network is known. */
  luck?: Luck;
  /** Each stratum host the pool lists and whether it says it is up (Peryn publishes this). */
  servers?: Record<string, boolean>;
}

/** Peryn's pool page (app.peryn.ai/api/v1/pool, documented at docs.peryn.ai), the numbers the Mining tab shows. */
export interface PerynState {
  /** Mining open: at least one stratum region up, or miners connected. */
  live: boolean;
  /** Pool hashrate over the last 10 minutes, in hashes (MAC) per second. */
  hashrate: number;
  miners: number;
  workers: number;
  blocksFound: number;
  /** Fee as a fraction (0.01 = 1%) for the default scheme (PPS+), when given. */
  fee?: number;
  /** Payout schedule and minimum, as text, when given. */
  payout?: string;
  /** Founding Miners rate, as Peryn words it ("0% PPLNS, 0.5% PPS+"), when announced. */
  founding?: string;
  /** Regions whose stratum is up, out of those listed. */
  regionsUp: number;
  regions: number;
  /** Each listed stratum host and whether it is up. */
  servers: Record<string, boolean>;
  /** Network figures Peryn publishes, for a cross-check with the indexer. */
  networkHashrate?: number;
  networkDifficulty?: number;
}

export function parsePeryn(j: any): PerynState {
  if (!j || typeof j !== "object") throw new Error("Peryn's answer is not readable");
  const p = j.pool && typeof j.pool === "object" ? j.pool : {};
  const regions: any[] = Array.isArray(j.stratum) ? j.stratum.filter((r: unknown) => r && typeof r === "object") : [];
  const regionsUp = regions.filter((r) => String(r.status ?? "").toLowerCase() === "up").length;
  const servers: Record<string, boolean> = {};
  for (const r of regions.slice(0, 50)) {
    const host = String(r.host ?? "").toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 80);
    if (host) servers[host] = String(r.status ?? "").toLowerCase() === "up";
  }
  const miners = Math.max(0, Math.floor(num(p.miners)));
  const feePct = num(j?.fees?.fpps?.feePct ?? j?.fees?.pplns?.feePct);
  const minPrl = num(j?.payouts?.minimumPrl);
  const schedule = typeof j?.payouts?.schedule === "string" ? j.payouts.schedule.replace(/[^\x20-\x7e]/g, "").slice(0, 40) : "";
  const foundingText = typeof j?.fees?.founding === "string" ? j.fees.founding.slice(0, 200) : "";
  const fp = foundingText.match(/(\d+(?:\.\d+)?)%\s*on\s*PPLNS/i);
  const fs = foundingText.match(/(\d+(?:\.\d+)?)%\s*on\s*PPS\+?/i);
  const founding = fp || fs ? [fp ? `${fp[1]}% PPLNS` : "", fs ? `${fs[1]}% PPS+` : ""].filter(Boolean).join(", ") : undefined;
  return {
    live: regionsUp > 0 || miners > 0,
    founding,
    hashrate: Math.max(0, num(p.hashrate10m ?? p.hashrate24h)),
    miners,
    workers: Math.max(0, Math.floor(num(p.workers))),
    blocksFound: Math.max(0, Math.floor(num(p.blocksFound))),
    fee: feePct > 0 && feePct <= 50 ? feePct / 100 : undefined,
    payout: schedule || minPrl > 0 ? `${schedule ? `paid ${schedule}` : "paid"}${minPrl > 0 ? `, from ${minPrl} PRL` : ""}` : undefined,
    regionsUp,
    regions: regions.length,
    servers,
    networkHashrate: num(j?.networkStats?.hashrate) > 0 ? num(j.networkStats.hashrate) : undefined,
    networkDifficulty: num(j?.networkStats?.difficulty) > 0 ? num(j.networkStats.difficulty) : undefined,
  };
}

export async function perynState(fetcher: Fetch = fetch): Promise<PerynState> {
  return parsePeryn(await getJson(fetcher, "https://app.peryn.ai/api/v1/pool"));
}

type NetForLuck = Pick<NetworkState, "hashrate" | "blockSeconds">;
/** One pool's status. Never throws: a pool that cannot be read is "no-answer". */
export async function poolStatus(kind: PoolStatusKind, fetcher: Fetch = fetch, net?: NetForLuck, now = Date.now()): Promise<PoolStatus> {
  const st = await poolStatusRaw(kind, fetcher, net, now);
  // A page that answered 200 with nothing Keshi could read (no fee, no figure) is not a pool that answered.
  if (st.state === "live" && !st.detail && st.fee === undefined && !st.servers) return { kind, state: "no-answer" };
  return st;
}

async function poolStatusRaw(kind: PoolStatusKind, fetcher: Fetch, net: NetForLuck | undefined, now: number): Promise<PoolStatus> {
  const pct = (f: number | undefined) => (f !== undefined ? `${Number((f * 100).toFixed(2))}%` : undefined);
  try {
    if (kind === "peryn") {
      const s = await perynState(fetcher);
      if (!s.live) return { kind, state: "coming", fee: s.fee !== undefined ? `${Number((s.fee * 100).toFixed(2))}%` : undefined };
      const parts = [s.hashrate > 0 ? formatHashrate(s.hashrate) : "", s.miners > 0 ? `${s.miners} miner${s.miners === 1 ? "" : "s"}` : "", s.payout ?? "", s.regions > 0 && s.regionsUp < s.regions ? `${s.regionsUp}/${s.regions} regions up` : "", s.founding ? `Founding Miners ${s.founding}` : ""].filter(Boolean);
      // Peryn pays per share by default (PPS+): its real cost is its fee, so its blocks are not fetched.
      return { kind, state: "live", detail: parts.join(" · ") || undefined, fee: pct(s.fee), feeRate: s.fee, servers: s.servers };
    }
    if (kind === "luckypool") {
      // As pearl.luckypool.io/api/stats answers (6 November 2026): config.fee in percent, stats.hashrate in H/s, stats.miners,
      // paymentInterval in seconds, minPaymentThreshold in grains, and pool.blocks as "hash:time:difficulty:shares:orphaned:reward:…"
      // strings paired with heights, newest first.
      const [j, bs] = await Promise.all([
        getJson(fetcher, "https://pearl.luckypool.io/api/stats"),
        // Its "block stats" page (6 November 2026): avg7d is the week's effort, data[] one line a day with the blocks found.
        net ? getJson(fetcher, "https://pearl.luckypool.io/api/block-stats").catch(() => null) : null,
      ]);
      if (!j || typeof j !== "object") throw new Error("not readable");
      const fee = num(j?.config?.fee);
      const ok = typeof j?.config?.fee === "number" && fee >= 0 && fee <= 50;
      const h = num(j?.stats?.hashrate ?? j?.pool?.hashrate);
      const miners = Math.max(0, Math.floor(num(j?.stats?.miners ?? j?.pool?.miners)));
      const every = num(j?.config?.paymentInterval);
      const minGrains = num(j?.config?.minPaymentThreshold);
      const parts = [
        h > 0 ? formatHashrate(h) : "",
        miners > 0 ? `${miners.toLocaleString("en-US")} miners` : "",
        every >= 3600 || minGrains > 0 ? `paid${every >= 3600 ? ` every ${every === 3600 ? "hour" : `${Math.round(every / 3600)} hours`}` : ""}${minGrains > 0 ? ` from ${Number((minGrains / 1e8).toFixed(2))} PRL` : ""}` : "",
      ].filter(Boolean);
      // Luck: the week's effort from its block stats when the pool found enough blocks that week; otherwise the last
      // two days of its blocks list, against its current hashrate.
      let luck: Luck | undefined;
      const effort = num(bs?.avg7d);
      const days: unknown[] = Array.isArray(bs?.data) ? bs.data.slice(-7) : [];
      const week = days.reduce<number>((n, d: any) => n + Math.max(0, Math.floor(num(d?.block))), 0);
      if (effort >= 0.1 && effort <= 10 && week >= LUCK_MIN_BLOCKS) luck = { found: 100 / effort, expected: 100, hours: 168 };
      const raw: any[] = Array.isArray(j?.pool?.blocks) ? j.pool.blocks : [];
      if (!luck && net && h > 0 && raw.length) {
        const since = now / 1000 - 48 * 3600;
        let found = 0;
        let oldest = now / 1000;
        for (const x of raw.slice(0, 400)) {
          if (typeof x !== "string") continue;
          const f = x.split(":");
          const t = seconds(f[1]);
          // "hash:time:difficulty:shares:orphaned:..." — a candidate block has fewer fields and counts as found.
          if (f.length < 2 || !(t > 0) || t < since) continue;
          oldest = Math.min(oldest, t);
          if (f[4] !== "1") found++;
        }
        const hours = Math.max(1, (now / 1000 - oldest) / 3600);
        if (found > 0) luck = { found, expected: expectedBlocks(h, net, hours), hours };
      }
      return { kind, state: "live", detail: parts.join(" · ") || undefined, fee: ok ? `${Number(fee.toFixed(2))}%` : undefined, feeRate: ok ? fee / 100 : undefined, luck };
    }
    if (kind === "pearlhash") {
      // PearlHash's stats page: pool hashrate, accounts and workers. The fee is as it announces it (1%).
      const j = await getJson(fetcher, "https://pearlhash.xyz/api/stats");
      if (!j || typeof j !== "object") throw new Error("not readable");
      const h = num(j.hashrate);
      const miners = Math.max(0, Math.floor(num(j.total_accounts)));
      const parts = [h > 0 ? formatHashrate(h) : "", miners > 0 ? `${miners.toLocaleString("en-US")} miners` : ""].filter(Boolean);
      return { kind, state: "live", detail: parts.join(" · ") || undefined, feeRate: 0.01 };
    }
    if (kind === "pearlfortune") {
      // Pearl Fortune's summary page: rolling pool hashrate, blocks in 24 h, and both fees.
      const [j, fees] = await Promise.all([getJson(fetcher, "https://pearlfortune.org/api/v1/summary?hours=24&tz_offset_min=0"), getJson(fetcher, "https://pearlfortune.org/api/v1/stats/pool-fee-rate").catch(() => null)]);
      const d = j?.data;
      if (!d || typeof d !== "object") throw new Error("not readable");
      const rolling: any[] = Array.isArray(d.pool_stats?.rolling_stats) ? d.pool_stats.rolling_stats : [];
      const h = num((rolling.find((r) => r && num(r.hours) === 1) ?? {}).hashrate);
      const blocks = Math.max(0, Math.floor(num(rolling.find((r) => r && num(r.hours) === 24)?.block_count)));
      const asPct = (x: unknown) => { const n = num(x); return n > 0 && n <= 0.5 ? Number((n * 100).toFixed(2)) : undefined; };
      const pplns = asPct(fees?.data?.pool_fee_rate ?? d.pool_stats?.pool_fee_rate);
      const pps = asPct(fees?.data?.pps_fee_rate);
      const parts = [h > 0 ? formatHashrate(h) : "", blocks > 0 ? `${blocks} blocks in 24 h` : ""].filter(Boolean);
      const fee = pplns !== undefined && pps !== undefined ? (pplns === pps ? `${pplns}%` : `${Math.min(pplns, pps)}–${Math.max(pplns, pps)}%`) : pplns !== undefined ? `${pplns}%` : undefined;
      // Luck over a week when the summary gives one (its "1W" view), else over the 24 hours it always covers.
      let luck: Luck | undefined;
      if (net) {
        const week = await getJson(fetcher, "https://pearlfortune.org/api/v1/summary?hours=168&tz_offset_min=0").catch(() => null);
        const weekly: any[] = Array.isArray(week?.data?.pool_stats?.rolling_stats) ? week.data.pool_stats.rolling_stats : [];
        for (const [hours, list] of [[168, weekly], [24, rolling]] as [number, any[]][]) {
          const w = list.find((r) => r && num(r.hours) === hours);
          const hr = num(w?.hashrate);
          const found = Math.max(0, Math.floor(num(w?.block_count)));
          if (hr > 0 && found > 0) {
            luck = { found, expected: expectedBlocks(hr, net, hours), hours };
            break;
          }
        }
      }
      const low = pplns !== undefined && pps !== undefined ? Math.min(pplns, pps) : pplns;
      return { kind, state: "live", detail: parts.join(" · ") || undefined, fee, feeRate: low !== undefined ? low / 100 : undefined, luck };
    }
    if (kind === "kryptex") {
      const info = await getJson(fetcher, "https://pool.kryptex.com/prl/api/v1/pool/info");
      const fee = kryptexFee(info?.fee ?? info?.commission);
      // As pool.kryptex.com/prl/api/v1/pool/info answers (6 November 2026): hashrate in H/s, miners, minpay in PRL.
      const h = num(info?.hashrate);
      const miners = Math.max(0, Math.floor(num(info?.miners)));
      const minpay = num(info?.minpay);
      const parts = [h > 0 ? formatHashrate(h) : "", miners > 0 ? `${miners.toLocaleString("en-US")} miners` : "", minpay > 0 ? `paid from ${minpay} PRL` : ""].filter(Boolean);
      return { kind, state: "live", detail: parts.join(" · ") || undefined, fee: pct(fee), feeRate: fee };
    }
    // HeroMiners: the pool's own stats page. Any readable answer means the pool is there.
    const j = await getJson(fetcher, "https://pearl.herominers.com/api/stats");
    // As pearl.herominers.com/api/stats answers (6 November 2026): config.fee in percent (0 = free), pool.realHashrate in H/s
    // (pool.hashrate is in units of 2^32 hashes), pool.effort_7d as the pool's own luck over a week (1.0 = as expected),
    // minPaymentThreshold in grains, paymentsInterval in seconds.
    const fee = num(j?.config?.fee);
    const ok = typeof j?.config?.fee === "number" && fee >= 0 && fee <= 50;
    const ph = num(j?.pool?.realHashrate) || num(j?.pool?.hashrate) * 4294967296;
    const miners = Math.max(0, Math.floor(num(j?.pool?.miners)));
    const minGrains = num(j?.config?.minPaymentThreshold);
    const every = num(j?.config?.paymentsInterval);
    const parts = [
      ph > 0 ? formatHashrate(ph) : "",
      miners > 0 ? `${miners.toLocaleString("en-US")} miners` : "",
      every > 0 || minGrains > 0 ? `paid${every >= 3600 ? ` every ${every === 3600 ? "hour" : `${Math.round(every / 3600)} hours`}` : ""}${minGrains > 0 ? ` from ${Number((minGrains / 1e8).toFixed(2))} PRL` : ""}` : "",
    ].filter(Boolean);
    // The pool's effort is work done over work expected: luck is its inverse. Scaled to 100 expected blocks so the gate passes
    // on a week of this pool's blocks (about 18 a day).
    // Shown only while the pool really finds blocks: an effort outside 0.1–10 is not a week's figure, and a pool with fewer
    // than LUCK_MIN_BLOCKS in all, or none in the last week, has no luck to speak of.
    let luck: Luck | undefined;
    const effort = num(j?.pool?.effort_7d);
    const total = Math.floor(num(j?.pool?.totalBlocks));
    const blocks: unknown[] = Array.isArray(j?.pool?.blocks) ? j.pool.blocks.slice(0, 400) : [];
    const weekAgo = now / 1000 - 7 * 86400;
    const recent = blocks.some((x) => typeof x === "string" && seconds(x.split(":")[1]) >= weekAgo);
    if (effort >= 0.1 && effort <= 10 && total >= LUCK_MIN_BLOCKS && recent) luck = { found: 100 / effort, expected: 100, hours: 168 };
    return { kind, state: "live", detail: parts.join(" · ") || undefined, fee: ok ? `${Number(fee.toFixed(2))}%` : undefined, feeRate: ok ? fee / 100 : undefined, luck };
  } catch {
    return { kind, state: "no-answer" };
  }
}

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

/* ----------------------------------------------------------- connecting a miner */

/** One address a miner can point at, as the pool publishes it. */
export interface PoolEndpoint {
  label: string;
  host: string;
  port: number;
  /** Port for an encrypted connection, when the pool offers one (the same port when it serves both). */
  tlsPort?: number;
}
export interface PoolConnect {
  name: string;
  endpoints: PoolEndpoint[];
  /** How the username is written, with ADDRESS and WORKER as placeholders. */
  user: string;
  /** What to put as the password, when the pool says. */
  password?: string;
  /** Options the pool documents (payout mode, merge mining…), one per line. */
  options?: string[];
  /** The miner the pool recommends or documents first, and its command with ADDRESS and WORKER as placeholders. */
  miner: string;
  command: string;
  /** The pool's own setup page. */
  guide: string;
}

/**
 * Connection details, copied from each pool's own pages (4 November 2026). Nothing here is
 * read from the network: a pool that moves must be followed by a Keshi update, and until
 * then its site (the guide link) is the reference.
 */
export const POOL_CONNECT: PoolConnect[] = [
  {
    name: "Kryptex",
    endpoints: [
      { label: "Global", host: "prl.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "Europe", host: "prl-eu.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "North America", host: "prl-us.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "South America", host: "prl-br.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "Singapore", host: "prl-sg.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "China (Hong Kong)", host: "prl-hk.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "Russia", host: "prl-ru.kryptex.network", port: 7048, tlsPort: 8048 },
      { label: "Middle East", host: "prl-ae.kryptex.network", port: 7048, tlsPort: 8048 },
    ],
    user: "ADDRESS/WORKER",
    options: ["PPS+ (3%) by default. Solo mining (1%): write solo:ADDRESS/WORKER as the username.", "Plain connections on port 7048, TLS on 8048. Minimum payout 1 PRL."],
    miner: "SRBMiner-MULTI",
    command: "SRBMiner-MULTI --disable-cpu --algorithm pearlhash --pool prl.kryptex.network:7048 --wallet ADDRESS/WORKER",
    guide: "https://pool.kryptex.com/articles/how-to-mine-pearl-en",
  },
  {
    name: "PearlHash",
    endpoints: [
      { label: "Main", host: "pool.pearlhash.xyz", port: 9000, tlsPort: 9443 },
      { label: "Asia / China", host: "hk.pearlhash.net", port: 9000, tlsPort: 9443 },
      { label: "Global", host: "global.pearlhash.net", port: 9000, tlsPort: 9443 },
      { label: "Global 2", host: "global2.pearlhash.net", port: 9000, tlsPort: 9443 },
    ],
    user: "ADDRESS",
    password: "x",
    options: ["WildRig Multi 0.51.6 or newer is the miner PearlHash recommends; its dev fee is 0% on this pool.", "The worker name goes in the miner's own worker option, or after a dot in the username."],
    miner: "WildRig Multi",
    command: "wildrig-multi --algo pearlhash --url stratum+ssl://pool.pearlhash.xyz:9443 --user ADDRESS.WORKER --pass x",
    guide: "https://pearlhash.xyz/hiveos",
  },
  {
    name: "HeroMiners",
    endpoints: [
      { label: "Germany", host: "de.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "France", host: "fr.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Spain", host: "es.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Finland", host: "fi.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Russia", host: "ru.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Canada", host: "ca.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "USA", host: "us.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "USA 2", host: "us2.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "USA 3", host: "us3.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Brazil", host: "br.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Turkey", host: "tr.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Singapore", host: "sg.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Hong Kong", host: "hk.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Japan", host: "jp.pearl.herominers.com", port: 1200, tlsPort: 1200 },
      { label: "Australia", host: "au.pearl.herominers.com", port: 1200, tlsPort: 1200 },
    ],
    user: "ADDRESS.WORKER",
    password: "x",
    options: ["Port 1200 starts at difficulty 2.1 M; plain and encrypted connections share it (stratum+tcp:// or stratum+ssl://).", "PROP rewards, paid every hour from 1 PRL after 100 confirmations. No merge mining on Pearl."],
    miner: "SRBMiner-MULTI",
    command: "SRBMiner-MULTI --disable-cpu --algorithm pearlhash --pool de.pearl.herominers.com:1200 --wallet ADDRESS.WORKER",
    guide: "https://pearl.herominers.com",
  },
  {
    name: "Pearl Fortune",
    endpoints: [
      { label: "Third-party miners", host: "global.pearlfortune.org", port: 8888 },
      { label: "Official pearl-miner", host: "global.pearlfortune.org", port: 443 },
    ],
    user: "ADDRESS",
    options: ["PPS (fee 4%) or PPLNS (fee 2%): chosen per address on pearlfortune.org.", "The official pearlfortune/pearl-miner takes --address and --worker; third-party miners use port 8888."],
    miner: "SRBMiner-MULTI",
    command: "SRBMiner-MULTI --disable-cpu --algorithm pearlhash --pool global.pearlfortune.org:8888 --wallet ADDRESS",
    guide: "https://pearlfortune.org/#faq",
  },
  {
    name: "LuckyPool",
    endpoints: [
      { label: "Europe 1", host: "pearl-eu1.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Europe 2", host: "pearl-eu2.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Poland", host: "pearl-pl.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Turkey", host: "pearl-tr.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Russia", host: "pearl-ru.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "US East", host: "pearl-us-east.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "US West", host: "pearl-us-west.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "US Central", host: "pearl-us-central.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "US Chicago", host: "pearl-us-ord.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Brazil", host: "pearl-br.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Canada 1", host: "pearl-ca1.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Canada 2", host: "pearl-ca2.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Singapore 1", host: "pearl-sg1.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Singapore 2", host: "pearl-sg2.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Indonesia", host: "pearl-id.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Hong Kong", host: "pearl-hk.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "India", host: "pearl-in.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Japan", host: "pearl-jp.luckypool.io", port: 3361, tlsPort: 3361 },
      { label: "Australia", host: "pearl-au.luckypool.io", port: 3361, tlsPort: 3361 },
    ],
    user: "ADDRESS.WORKER",
    password: "x",
    options: [
      "Ports by rig size: 3360 under 500 TH/s, 3361 for 500 to 1,000 TH/s, 3362 above; plain and TLS on the same port.",
      "PROP rewards at 1%. Solo mining (1%): write solo:ADDRESS.WORKER as the username.",
      "Pearl + Nockchain merge mining: write ADDRESS+NOCK_ADDRESS.WORKER with a native Nockchain address (not a 0x one).",
      "If your network blocks mining traffic, use the same server name with lproute.com in place of luckypool.io.",
    ],
    miner: "SRBMiner-MULTI",
    command: "SRBMiner-MULTI --algorithm pearlhash --pool pearl-eu2.luckypool.io:3361 --wallet ADDRESS --worker WORKER",
    guide: "https://pearl.luckypool.io/how-to-mine",
  },
  {
    name: "Peryn",
    endpoints: [
      { label: "Europe (Frankfurt)", host: "pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "US East (New York)", host: "us-east.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "US West (San Francisco)", host: "us-west.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "South America (São Paulo)", host: "sao-paulo.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "Southeast Asia (Singapore)", host: "singapore.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "Hong Kong", host: "hk.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "Japan (Tokyo)", host: "tokyo.pool.peryn.ai", port: 3333, tlsPort: 3443 },
      { label: "India (Mumbai)", host: "mumbai.pool.peryn.ai", port: 3333, tlsPort: 3443 },
    ],
    user: "ADDRESS.WORKER",
    password: "x",
    options: ["PPS+ is the default. For PPLNS, use x;mode=pplns as the password.", "Peryn also has its own miner and installer: see the guide below.", "Paid every 2 hours from 1 PRL."],
    miner: "SRBMiner-MULTI",
    command: "SRBMiner-MULTI --disable-cpu --algorithm pearlhash --pool pool.peryn.ai:3333 --wallet ADDRESS.WORKER --password x",
    guide: "https://peryn.ai/mine",
  },
];

/** A worker name a pool accepts: letters, digits, dash and underscore. */
export const cleanWorker = (s: string) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "rig01";

/** The pool's placeholders filled in: username and command for this address and worker. */
export function connectFor(name: string, address: string, worker = "rig01"): { user: string; command: string; connect: PoolConnect } | null {
  const c = POOL_CONNECT.find((p) => p.name === name);
  if (!c) return null;
  const w = cleanWorker(worker);
  const fill = (s: string) => s.replace(/ADDRESS/g, address).replace(/WORKER/g, w);
  return { user: fill(c.user), command: fill(c.command), connect: c };
}

/* ----------------------------------------------------------- real cost */

/** Blocks a pool found against the blocks its hashrate should have found, over a window. */
export interface Luck {
  found: number;
  expected: number;
  hours: number;
}

/** Expected blocks for a pool's hashrate on the network, over `hours`. */
export function expectedBlocks(poolHashrate: number, net: Pick<NetworkState, "hashrate" | "blockSeconds">, hours: number): number {
  if (!(poolHashrate > 0) || !(net.hashrate > 0) || !(net.blockSeconds > 0) || !(hours > 0)) return 0;
  return (poolHashrate / net.hashrate) * ((hours * 3600) / net.blockSeconds);
}

/** Enough blocks for luck to mean something: under this, the figure is noise. */
export const LUCK_MIN_BLOCKS = 20;

/**
 * What a miner really gives up at a pool: the fee, and for PPLNS / PROP schemes the pool's luck
 * (blocks found against blocks expected), since those pass the luck on to miners. PPS / PPS+ pay
 * per share, so the pool bears the luck and the real cost is the fee. Null when the luck is
 * needed but too few blocks are known.
 */
export function realCost(fee: number, scheme: string, luck?: Luck): { pct: number; luckPct?: number } | null {
  const f = Math.min(0.5, Math.max(0, fee));
  if (/PPS/i.test(scheme) && !/PPLNS/i.test(scheme.split("/")[0]!)) return { pct: f * 100 };
  if (!luck || !(luck.expected >= LUCK_MIN_BLOCKS)) return null;
  const l = luck.found / luck.expected;
  return { pct: Math.max(0, (1 - (1 - f) * l) * 100), luckPct: l * 100 };
}

/* ----------------------------------------------------------- hashrate drop */

/** Per worker: its usual hashrate (a slow average), how many readings built it, the last reading, and whether it is announced low. */
export interface RateMemory {
  rates: Record<string, { avg: number; n: number; last?: number }>;
  low: string[];
  /** Seen low once: announced only if still low on the next check. */
  pending?: string[];
}
/** A worker is announced when it falls under this share of its usual hashrate, and cleared when it is back over 80%. */
export const DROP_BELOW = 0.6;
const DROP_MIN_READINGS = 5;
/** A worker connected for less than this is ramping up, not dropping. */
const RAMP_SECONDS = 30 * 60;

/**
 * For the hashrate alert: which online workers now run well under their usual hashrate (`low`),
 * which of them are new since the last check (`fresh`, to announce once), and the averages to keep.
 * A drop counts after two checks in a row, never for a worker connected less than 30 minutes ago,
 * and never while the reading is climbing back (a restart ramps up from zero). Offline workers are
 * the offline alert's business and are left out here.
 */
export function dropCheck(state: Pick<MinerState, "workers" | "workersKnown">, memory: RateMemory | undefined, nowSeconds = Date.now() / 1000): { low: string[]; fresh: { name: string; now: number; usual: number }[]; rates: RateMemory["rates"]; pending: string[] } {
  if (state.workersKnown === false) return { low: memory?.low ?? [], fresh: [], rates: memory?.rates ?? {}, pending: memory?.pending ?? [] };
  const rates: RateMemory["rates"] = {};
  const low: string[] = [];
  const pending: string[] = [];
  const fresh: { name: string; now: number; usual: number }[] = [];
  const was = memory?.low ?? [];
  const wasPending = memory?.pending ?? [];
  for (const w of state.workers) {
    if (!w.online || !(w.hashrate > 0)) {
      const keep = memory?.rates[w.name];
      if (keep) rates[w.name] = keep;
      // Still counted as low while it is off: coming back as low as before is not a new drop.
      if (was.includes(w.name)) low.push(w.name);
      continue;
    }
    const m = memory?.rates[w.name];
    const usual = m && m.n >= DROP_MIN_READINGS ? m.avg : 0;
    const wasLow = was.includes(w.name);
    const young = w.since !== undefined && w.since > 0 && nowSeconds - w.since < RAMP_SECONDS;
    const climbing = m?.last !== undefined && m.last > 0 && w.hashrate > m.last * 1.15;
    if (usual > 0 && w.hashrate < usual * DROP_BELOW && !young && !climbing) {
      if (wasLow) low.push(w.name);
      else if (wasPending.includes(w.name)) {
        low.push(w.name);
        fresh.push({ name: w.name, now: w.hashrate, usual });
      } else pending.push(w.name);
      // The average is not pulled down by the reading that is being watched.
      rates[w.name] = { ...m!, last: w.hashrate };
    } else if (usual > 0 && wasLow && w.hashrate < usual * 0.8) {
      low.push(w.name);
      rates[w.name] = { ...m!, last: w.hashrate };
    } else if (m && (climbing || young) && usual > 0) {
      // Ramping up: the partial readings do not teach the average anything.
      rates[w.name] = { ...m, last: w.hashrate };
    } else {
      rates[w.name] = m ? { avg: m.avg + (w.hashrate - m.avg) * 0.1, n: Math.min(1000, m.n + 1), last: w.hashrate } : { avg: w.hashrate, n: 1, last: w.hashrate };
    }
  }
  return { low, fresh, rates, pending };
}
