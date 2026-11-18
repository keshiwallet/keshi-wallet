// Counting Keshi's wallets, only for users who ticked "Count my wallet" (1.0.6).
// One signal a day at most, with no identifier in it: the three "first of the day / week / month" marks are
// what lets a server add up active wallets without ever telling two of them apart, or one from itself.
// Pure arithmetic here; src/ext/stats.ts keeps the state and does the sending.

/** What Keshi remembers on the device to build the next signal. Nothing here leaves it except through `Signal`. */
export interface StatsState {
  /** The UTC day, ISO week and month of the last signal that was received. */
  day?: string;
  week?: string;
  month?: string;
  /** A signal has been received at least once from this device. */
  sent?: boolean;
  /** Wallets created and restored on this device since the last signal, while counting was on. */
  created?: number;
  restored?: number;
  /** How many wallets Keshi holds here, as last seen while unlocked. */
  wallets?: number;
  /** When a signal was last attempted, so a server that does not answer is not asked more than once an hour. */
  tried?: number;
}

/** Everything a signal contains. No address, no balance, no identifier, no time. */
export interface Signal {
  /** Format of the signal. */
  s: 1;
  /** Keshi's version and where it runs. */
  v: string;
  b: "chrome" | "firefox" | "android" | "web";
  /** First signal of this UTC day (always 1: there is one a day at most), week and month, and first ever from this device. */
  d: 1;
  w: 0 | 1;
  m: 0 | 1;
  n: 0 | 1;
  /** Numbers only: wallets held, and wallets created and restored since the last signal. */
  wallets: number;
  created: number;
  restored: number;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The UTC day ("2026-11-16"), ISO week ("2026-W47") and month ("2026-11") of a moment. */
export function statsPeriods(now: number): { day: string; week: string; month: string } {
  const d = new Date(now);
  const day = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  // ISO 8601: the week belongs to the year of its Thursday.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const week = `${t.getUTCFullYear()}-W${two(Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7))}`;
  return { day, week, month: day.slice(0, 7) };
}

const count = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.min(max, Math.floor(x)) : 0);

/** The signal to send now, or null when today's has already been received. */
export function nextSignal(state: StatsState, now: number, version: string, browser: Signal["b"]): Signal | null {
  const p = statsPeriods(now);
  if (state.day === p.day) return null;
  return {
    s: 1,
    v: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) ? version : "0.0.0",
    b: browser,
    d: 1,
    w: state.week === p.week ? 0 : 1,
    m: state.month === p.month ? 0 : 1,
    n: state.sent ? 0 : 1,
    wallets: count(state.wallets, 50),
    created: count(state.created, 20),
    restored: count(state.restored, 20),
  };
}

/** The state once `sent` was received: its periods are marked, and what it reported is taken off the counters (not zeroed: a wallet may have been added meanwhile). */
export function afterSignal(state: StatsState, sent: Signal, now: number): StatsState {
  const p = statsPeriods(now);
  return { ...state, ...p, sent: true, created: Math.max(0, count(state.created, 1e6) - sent.created), restored: Math.max(0, count(state.restored, 1e6) - sent.restored) };
}
