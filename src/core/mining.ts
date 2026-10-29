import type { Activity } from "./wallet";

// Mining view: block rewards (flagged "mined"), and payments received on the
// payout address (pool payouts are ordinary payments). See miningActivity for
// what is left out.

/**
 * The payments that count as mining income: block rewards, and payments that reached the payout
 * address, minus the PRL coming back from the bridge (`returns`: amount and time of each return the
 * wallet asked for; the first matching payment within two days, of the amount less at most 3% and
 * 5 PRL of bridge fees, is left out).
 * Payments recorded before Keshi kept their receiving address count as before.
 */
export function miningActivity(activity: Activity[], payoutAddress: string, returns: { amount: bigint; at: number }[] = []): Activity[] {
  const used = new Set<string>();
  const isReturn = (a: Activity) => {
    const t = a.time ? a.time * 1000 : Date.now();
    for (const [i, r] of returns.entries()) {
      if (used.has(String(i))) continue;
      if (t >= r.at - 10 * 60_000 && t <= r.at + 2 * 86_400_000 && a.net <= r.amount && a.net >= (r.amount * 97n) / 100n - 500_000_000n) {
        used.add(String(i));
        return true;
      }
    }
    return false;
  };
  return [...activity]
    .sort((a, b) => (a.time || 1e12) - (b.time || 1e12))
    .filter((a) => {
      if (a.kind === "mined") return a.net > 0n;
      if (a.kind !== "received" || a.net <= 0n) return false;
      if (a.to && !a.to.includes(payoutAddress)) return false;
      return !isReturn(a);
    })
    .reverse();
}

export interface DayTotal {
  start: number; // local midnight, ms
  total: bigint;
  count: number;
}

export interface MiningStats {
  days: DayTotal[]; // oldest first, today last
  today: bigint;
  last: bigint; // sum over the window
  average: bigint; // per day
  payouts: Activity[];
}

export function miningStats(activity: Activity[], now = Date.now(), window = 7): MiningStats {
  const midnight = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = midnight(now);
  const days: DayTotal[] = Array.from({ length: window }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (window - 1 - i));
    return { start: d.getTime(), total: 0n, count: 0 };
  });
  const payouts = activity.filter((a) => (a.kind === "received" || a.kind === "mined") && a.net > 0n);
  for (const p of payouts) {
    const day = midnight(p.time ? p.time * 1000 : now);
    const slot = days.find((d) => d.start === day);
    if (slot) {
      slot.total += p.net;
      slot.count++;
    }
  }
  const last = days.reduce((s, d) => s + d.total, 0n);
  return { days, today: days[window - 1]!.total, last, average: last / BigInt(window), payouts };
}

export type Period = "7D" | "30D" | "90D" | "1Y" | "All";
export const PERIODS: Period[] = ["7D", "30D", "90D", "1Y", "All"];

export interface Bucket {
  start: number; // ms
  label: string;
  total: bigint;
  count: number;
}

export interface PeriodStats {
  period: Period;
  buckets: Bucket[]; // oldest first
  total: bigint; // over the period
  perDay: bigint; // average per day over the period
  days: number; // length of the period in days
  allTime: bigint; // every payout ever seen
  /** Dollar value of the period's payouts at the price of each payout's day, when a price series is given. */
  thenUsd?: number;
}

/**
 * Payouts grouped for one period: a bar per day up to 30 days, per week for 90 days, per month
 * beyond. "All" starts at the first payout. Local calendar, like miningStats.
 */
export function periodStats(activity: Activity[], period: Period, now = Date.now(), prices?: { time: number; value: number }[]): PeriodStats {
  const payouts = activity.filter((a) => (a.kind === "received" || a.kind === "mined") && a.net > 0n);
  const allTime = payouts.reduce((s, p) => s + p.net, 0n);
  const day = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const today = day(now);
  const first = payouts.reduce((m, p) => (p.time && p.time * 1000 < m ? p.time * 1000 : m), now);
  const spanDays = period === "7D" ? 7 : period === "30D" ? 30 : period === "90D" ? 90 : period === "1Y" ? 365 : Math.max(1, Math.round((today.getTime() - day(first).getTime()) / 86_400_000) + 1);
  const since = new Date(today);
  since.setDate(since.getDate() - (spanDays - 1));
  const unit: "day" | "week" | "month" = spanDays <= 31 ? "day" : spanDays <= 120 ? "week" : "month";
  const buckets: Bucket[] = [];
  if (unit === "day") {
    for (let i = 0; i < spanDays; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      buckets.push({ start: d.getTime(), label: i === 0 || i === spanDays - 1 || d.getDate() === 1 || (spanDays > 7 && i % 7 === 0) ? String(d.getDate()) : "", total: 0n, count: 0 });
    }
    if (spanDays === 7) buckets.forEach((b) => (b.label = new Date(b.start).toLocaleDateString("en-GB", { weekday: "narrow" })));
  } else if (unit === "week") {
    const d = new Date(since);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    while (d <= today) {
      buckets.push({ start: d.getTime(), label: d.getDate() <= 7 ? d.toLocaleDateString("en-GB", { month: "short" }) : "", total: 0n, count: 0 });
      d.setDate(d.getDate() + 7);
    }
  } else {
    const d = new Date(since.getFullYear(), since.getMonth(), 1);
    while (d <= today) {
      buckets.push({ start: d.getTime(), label: d.toLocaleDateString("en-GB", { month: "narrow" }), total: 0n, count: 0 });
      d.setMonth(d.getMonth() + 1);
    }
  }
  const find = (ms: number) => {
    for (let i = buckets.length - 1; i >= 0; i--) if (ms >= buckets[i]!.start) return buckets[i];
    return undefined;
  };
  let total = 0n, thenUsd = 0;
  const sorted = prices ? [...prices].sort((a, b) => a.time - b.time) : null;
  const priceAt = (sec: number) => {
    if (!sorted?.length) return undefined;
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (sorted[mid]!.time <= sec) lo = mid;
      else hi = mid - 1;
    }
    return sorted[lo]!.value;
  };
  for (const p of payouts) {
    const ms = p.time ? p.time * 1000 : now;
    if (ms < since.getTime()) continue;
    const b = find(ms);
    if (!b) continue;
    b.total += p.net;
    b.count++;
    total += p.net;
    const pr = priceAt(p.time || Math.floor(now / 1000));
    if (pr !== undefined) thenUsd += (Number(p.net) / 1e8) * pr;
  }
  return { period, buckets, total, perDay: total / BigInt(spanDays), days: spanDays, allTime, thenUsd: sorted ? thenUsd : undefined };
}

export function payoutsCsv(payouts: Activity[]): string {
  const rows = payouts.map((p) =>
    // Only fixed words, numbers and a checked transaction ID: nothing a spreadsheet could run as a formula.
    [p.time ? new Date(p.time * 1000).toISOString() : "pending", (Number(p.net) / 1e8).toFixed(8), p.kind === "mined" ? "block reward" : "payout", Number(p.confirmations) || 0, /^[0-9a-f]{64}$/.test(p.txid) ? p.txid : ""].join(","),
  );
  return ["date,amount_prl,type,confirmations,txid", ...rows].join("\n");
}
