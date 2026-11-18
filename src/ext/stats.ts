import { isApp, isExtension, local } from "./platform";
import { afterSignal, nextSignal, type Signal, type StatsState } from "../core/stats";

// Keshi's terms, and the optional, anonymous counting of its wallets (1.0.6).
//
// "terms" and "stats" are kept in clear on the device, like the settings: they hold a choice and a few
// numbers, nothing about the wallet. Counting is off until the user ticks it, and stays off when they do not.

/** Raise when the terms change, or when a signal starts carrying something new: everyone is asked again. */
export const TERMS_VERSION = 1;
/** Where signals go: Keshi's own counter (relay/stats-worker.js). It keeps totals per day, no address and no IP. */
export const STATS_URL = "https://stats.keshiwallet.com/v1/signal";

declare const __KESHI_VERSION__: string;
// The counter takes three-part versions only: "1.0.6b" is counted as 1.0.6.
export const signalVersion = (v: unknown): string => (typeof v === "string" ? v.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}/)?.[0] : undefined) ?? "0.0.0";
const VERSION = signalVersion(typeof __KESHI_VERSION__ === "string" ? __KESHI_VERSION__ : "");

export interface Terms {
  version: number;
  at: number;
  /** "Count my wallet" is ticked. */
  count: boolean;
}

export const getTerms = async (): Promise<Terms | undefined> => {
  const t = await local.get<Terms>("terms");
  // Read strictly: anything that is not exactly a terms record is no record, and only `count: true` is a tick.
  return t && typeof t === "object" && typeof t.version === "number" ? { version: t.version, at: typeof t.at === "number" ? t.at : 0, count: t.count === true } : undefined;
};
export const termsAccepted = (t: Terms | undefined): boolean => !!t && t.version >= TERMS_VERSION;

export async function acceptTerms(count: boolean): Promise<void> {
  await local.set("terms", { version: TERMS_VERSION, at: Date.now(), count } satisfies Terms);
  if (!count) await local.remove("stats");
}

/** Settings > Privacy. Turning it off forgets the counters too: nothing waits to be sent later. */
export async function setCounting(on: boolean): Promise<void> {
  const t = await getTerms();
  await local.set("terms", { version: t?.version ?? TERMS_VERSION, at: t?.at ?? Date.now(), count: on } satisfies Terms);
  if (!on) await local.remove("stats");
}

const counting = async (): Promise<boolean> => !!(await getTerms())?.count;

/** A wallet was created or restored here. Counted only while counting is on; never fails the wallet operation. */
export async function noteWallet(kind: "created" | "restored"): Promise<void> {
  try {
    if (!(await counting())) return;
    const st = (await local.get<StatsState>("stats")) ?? {};
    await local.set("stats", { ...st, [kind]: Math.min(1000, (st[kind] ?? 0) + 1) });
  } catch {
    /* counting must never get in the way of a wallet */
  }
}

/** How many wallets Keshi holds, seen while unlocked: the number only. */
export async function noteWalletCount(n: number): Promise<void> {
  try {
    if (!(await counting())) return;
    const st = (await local.get<StatsState>("stats")) ?? {};
    if (st.wallets !== n) await local.set("stats", { ...st, wallets: n });
  } catch {
    /* as above */
  }
}

const where = (): Signal["b"] => (isApp() ? "android" : isExtension ? (/firefox/i.test(globalThis.navigator?.userAgent ?? "") ? "firefox" : "chrome") : "web");

/**
 * Sends today's signal if counting is on and today's has not been received yet. At most one attempt an hour,
 * so a counter that does not answer costs nothing. No cookie, no referrer, no redirect followed. Never throws.
 */
export async function sendSignal(fetcher: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  try {
    if (!(await counting())) return false;
    const st = (await local.get<StatsState>("stats")) ?? {};
    if (typeof st.tried === "number" && st.tried <= now && now - st.tried < 3_600_000) return false;
    const signal = nextSignal(st, now, VERSION, where());
    if (!signal) return false;
    await local.set("stats", { ...st, tried: now });
    const r = await fetcher(STATS_URL, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(signal), credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error" });
    if (!r.ok) return false;
    // Turned off while the signal was on its way: keep nothing.
    if (!(await counting())) return false;
    await local.set("stats", afterSignal((await local.get<StatsState>("stats")) ?? {}, signal, now));
    return true;
  } catch {
    return false;
  }
}
