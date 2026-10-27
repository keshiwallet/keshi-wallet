import type { Activity } from "./wallet";
import type { Point } from "./market";
import { prlToNumber } from "./amount";

/**
 * How many PRL the wallet held at each moment of a price series, worked
 * backwards from today's balance through the wallet's own history: at a time
 * `t`, the balance was today's minus every payment that came after `t`.
 * Payments still confirming (time 0) count as "after" every past moment.
 */
export function balanceAt(balance: bigint, activity: Activity[], time: number): bigint {
  let b = balance;
  for (const a of activity) if (a.time === 0 || a.time > time) b -= a.net;
  return b < 0n ? 0n : b;
}

/**
 * Value of the wallet's PRL over a period, in dollars when `prices` is a price
 * series, or in PRL when `prices` is null (one point per day). The last point
 * is now, at the latest price.
 */
export function valueSeries(balance: bigint, activity: Activity[], prices: Point[] | null, now = Math.floor(Date.now() / 1000), days = 30): Point[] {
  const pts: Point[] = [];
  if (prices && prices.length) {
    for (const p of prices) pts.push({ time: p.time, value: prlToNumber(balanceAt(balance, activity, p.time)) * p.value });
    const last = prices[prices.length - 1]!;
    if (now > last.time) pts.push({ time: now, value: prlToNumber(balance) * last.value });
    return pts;
  }
  for (let d = days; d >= 1; d--) {
    const t = now - d * 86400;
    pts.push({ time: t, value: prlToNumber(balanceAt(balance, activity, t)) });
  }
  pts.push({ time: now, value: prlToNumber(balance) });
  return pts;
}
