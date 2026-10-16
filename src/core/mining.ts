import type { Activity } from "./wallet";

// Mining view: every incoming payment counts as a payout (pool payouts are
// ordinary payments; solo block rewards are flagged "mined").

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

export function payoutsCsv(payouts: Activity[]): string {
  const rows = payouts.map((p) =>
    // Only fixed words, numbers and a checked transaction ID: nothing a spreadsheet could run as a formula.
    [p.time ? new Date(p.time * 1000).toISOString() : "pending", (Number(p.net) / 1e8).toFixed(8), p.kind === "mined" ? "block reward" : "payout", Number(p.confirmations) || 0, /^[0-9a-f]{64}$/.test(p.txid) ? p.txid : ""].join(","),
  );
  return ["date,amount_prl,type,confirmations,txid", ...rows].join("\n");
}
