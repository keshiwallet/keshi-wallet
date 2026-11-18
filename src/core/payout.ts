// The payment alert of the Mining tab (1.0.6): what arrived on the address a miner is paid to.
// Pure arithmetic over what Pearl's indexer reports; the background does the asking and the telling.

/** What an address has received so far, as the indexer answers for it: confirmed, plus what is on its way in. */
export function receivedOf(j: unknown): bigint {
  const x = (j ?? {}) as { totalReceived?: unknown; unconfirmedBalance?: unknown };
  const big = (v: unknown) => (typeof v === "string" && /^-?\d{1,30}$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) ? BigInt(v) : 0n);
  const pending = big(x.unconfirmedBalance);
  return big(x.totalReceived) + (pending > 0n ? pending : 0n);
}

/**
 * The same figure read strictly, for anything that is remembered: null unless the answer carries a well-formed
 * `totalReceived`. An answer without it (an empty or broken reply that still says "200 OK") is no reading at all,
 * and must never replace what was remembered: the next good reading would be announced as a payment.
 */
export function readingOf(j: unknown): bigint | null {
  const x = (j ?? {}) as { totalReceived?: unknown; unconfirmedBalance?: unknown };
  const big = (v: unknown) => (typeof v === "string" && /^\d{1,30}$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
  const total = big(x.totalReceived);
  if (total === null) return null;
  // The part on its way in is optional in the indexer's answers; when present it must be a number too.
  const p = x.unconfirmedBalance;
  if (p === undefined || p === null) return total;
  const pending = typeof p === "string" && /^-?\d{1,30}$/.test(p) ? BigInt(p) : typeof p === "number" && Number.isSafeInteger(p) ? BigInt(p) : null;
  if (pending === null) return null;
  return total + (pending > 0n ? pending : 0n);
}

/** The alert's memory for one address: what it had received when last read, and what was announced while Keshi was locked. */
export interface PayoutMemory {
  address: string;
  /** Grains, as text. */
  received: string;
  /** Grains announced by the alert that the wallet's own "PRL received" notification has not accounted for yet. */
  announced: string;
}

/**
 * One reading while the wallet's own notification is not running (Keshi locked, or the address is not in this
 * wallet): the first reading of an address announces nothing, and after it every increase is announced once.
 */
export function payoutStep(memory: PayoutMemory | undefined, address: string, received: bigint): { fresh: bigint; memory: PayoutMemory } {
  if (!memory || memory.address !== address) return { fresh: 0n, memory: { address, received: received.toString(), announced: "0" } };
  const before = BigInt(memory.received);
  const fresh = received > before ? received - before : 0n;
  return { fresh, memory: { address, received: received.toString(), announced: (BigInt(memory.announced || "0") + fresh).toString() } };
}

/**
 * One reading while the wallet's own notification runs and the address is one of the wallet's: of what the wallet
 * received since its last notification (`delta`), how much is a payment to the mining address (`payout`) and how
 * much is other PRL (`rest`). What the alert already announced while locked is counted in neither.
 */
export function payoutSplit(memory: PayoutMemory | undefined, address: string, received: bigint, delta: bigint): { payout: bigint; rest: bigint; memory: PayoutMemory } {
  const known = memory && memory.address === address ? memory : undefined;
  const announced = known ? BigInt(known.announced || "0") : 0n;
  const left = delta > announced ? delta - announced : 0n;
  const own = known && received > BigInt(known.received) ? received - BigInt(known.received) : 0n;
  const payout = own < left ? own : left;
  return { payout, rest: left - payout, memory: { address, received: received.toString(), announced: "0" } };
}
