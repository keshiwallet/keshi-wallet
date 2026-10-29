import type { Account, Derived } from "./keys";
import { Indexer, isCoinbaseTx, type RawTx, type Utxo } from "./indexer";

// Finds every address of the wallet that has been used, and turns the raw
// indexer data into a balance, a list of coins to spend and a history.

export interface Activity {
  txid: string;
  time: number; // unix seconds, 0 while unconfirmed
  confirmations: number;
  net: bigint; // + received, - sent (fee included)
  fee: bigint;
  kind: "received" | "sent" | "mined" | "moved";
  counterparty?: string;
  /** The wallet's own addresses this transaction paid. */
  to?: string[];
}

export interface Snapshot {
  updated: number;
  height: number;
  balance: bigint; // confirmed + pending
  pending: bigint;
  immature: bigint;
  /** `tapRoot` is set on quantum-ready addresses: the root of their script tree, as hex. */
  addresses: { address: string; change: boolean; index: number; used: boolean; tapRoot?: string }[];
  receive: Derived; // first unused receive address
  changeAddr: Derived; // first unused change address
  utxos: Utxo[];
  activity: Activity[];
  /** Coins that carry an inscription or a token ("txid:vout"); never spent as money. */
  protectedOutpoints?: string[];
  /** False when the token index could not be reached during the last refresh. */
  protectionChecked?: boolean;
}

const GAP_RECEIVE = 20;
const GAP_CHANGE = 10;

/** An address outside the usual sequence that the wallet also owns (a quantum-ready address). */
export interface ExtraAddress {
  address: string;
  change: boolean;
  index: number;
  /** Root of the address's script tree, as hex. */
  tapRoot: string;
}

export async function scan(account: Account, indexer: Indexer, extra: ExtraAddress[] = []): Promise<Snapshot> {
  const addresses: Snapshot["addresses"] = [];
  const txs = new Map<string, RawTx>();
  const withCoins: string[] = [];
  let balance = 0n;
  let pending = 0n;
  const firstUnused: Record<string, Derived> = {};

  if (account.single) {
    // One key, one address: nothing to search for.
    const d = account.derive(false, 0);
    const info = await indexer.address(d.address);
    addresses.push({ address: d.address, change: false, index: 0, used: info.txCount > 0 });
    balance = info.balance + info.unconfirmed;
    pending = info.unconfirmed;
    if (info.txCount > 0) withCoins.push(d.address);
    for (const t of info.txs) txs.set(t.txid, t);
    firstUnused["false"] = d;
    firstUnused["true"] = d;
  }

  for (const change of account.single ? [] : [false, true]) {
    const gap = change ? GAP_CHANGE : GAP_RECEIVE;
    let empty = 0;
    for (let start = 0; empty < gap; start += gap) {
      const batch = Array.from({ length: gap }, (_, i) => account.derive(change, start + i));
      const infos = await Promise.all(batch.map((d) => indexer.address(d.address)));
      for (let i = 0; i < batch.length; i++) {
        const d = batch[i]!;
        const info = infos[i]!;
        const used = info.txCount > 0;
        addresses.push({ address: d.address, change, index: d.index, used });
        if (used) {
          empty = 0;
          balance += info.balance + info.unconfirmed;
          pending += info.unconfirmed;
          if (info.balance + info.unconfirmed > 0n || info.unconfirmed !== 0n) withCoins.push(d.address);
          for (const t of info.txs) txs.set(t.txid, t);
        } else {
          empty++;
          firstUnused[String(change)] ??= d;
        }
      }
    }
  }

  // Quantum-ready addresses: same keys, a different address each.
  for (const x of extra) {
    const info = await indexer.address(x.address);
    const used = info.txCount > 0;
    addresses.push({ address: x.address, change: x.change, index: x.index, used, tapRoot: x.tapRoot });
    if (!used) continue;
    balance += info.balance + info.unconfirmed;
    pending += info.unconfirmed;
    if (info.balance + info.unconfirmed > 0n || info.unconfirmed !== 0n) withCoins.push(x.address);
    for (const t of info.txs) txs.set(t.txid, t);
  }

  const [status, utxoLists] = await Promise.all([
    indexer.status(),
    Promise.all(withCoins.map((a) => indexer.utxos(a))),
  ]);
  const utxos = utxoLists.flat();
  // Older indexers do not flag mining rewards on coins, so look at the tx.
  for (const u of utxos) {
    const tx = txs.get(u.txid);
    if (tx && isCoinbaseTx(tx)) u.coinbase = true;
  }
  const immature = utxos.filter((u) => u.coinbase && u.confirmations < 100).reduce((s, u) => s + u.value, 0n);

  const mine = new Set(addresses.map((a) => a.address));
  const activity = [...txs.values()].map((t) => describe(t, mine));
  activity.sort((a, b) => (b.time || 1e12) - (a.time || 1e12));

  return {
    updated: Date.now(),
    height: status.height,
    balance,
    pending,
    immature,
    addresses,
    receive: firstUnused["false"]!,
    changeAddr: firstUnused["true"]!,
    utxos,
    activity,
  };
}

export function describe(tx: RawTx, mine: Set<string>): Activity {
  const isMine = (a?: string[]) => !!a?.some((x) => mine.has(x));
  const spent = tx.vin.filter((i) => isMine(i.addresses)).reduce((s, i) => s + BigInt(i.value ?? "0"), 0n);
  const got = tx.vout.filter((o) => isMine(o.addresses)).reduce((s, o) => s + BigInt(o.value ?? "0"), 0n);
  const net = got - spent;
  const fee = BigInt(tx.fees ?? "0");
  const coinbase = isCoinbaseTx(tx);
  let kind: Activity["kind"];
  let counterparty: string | undefined;
  if (coinbase) kind = "mined";
  else if (spent === 0n) {
    kind = "received";
    counterparty = tx.vin[0]?.addresses?.[0];
  } else if (tx.vout.every((o) => isMine(o.addresses))) kind = "moved";
  else {
    kind = "sent";
    counterparty = tx.vout.find((o) => !isMine(o.addresses))?.addresses?.[0];
  }
  const to = [...new Set(tx.vout.flatMap((o) => (o.addresses ?? []).filter((a) => mine.has(a))))];
  return { txid: tx.txid, time: tx.blockTime ?? 0, confirmations: tx.confirmations ?? 0, net, fee, kind, counterparty, to };
}

/* ------------------------------------------------------ suspicious payments */

export type Flag = "dust" | "lookalike";
/** Incoming payments at or below this are treated as unsolicited dust. */
export const DUST_FLAG = 100_000n; // 0.001 PRL

const ends = (a: string) => a.slice(0, 9) + a.slice(-5);

/** The known address that `address` imitates (same beginning and end, different middle), if any. */
export function lookalikeOf(address: string, known: Iterable<string>): string | undefined {
  for (const k of known) if (k !== address && k.length === address.length && ends(k) === ends(address)) return k;
  return undefined;
}

/**
 * Flag payments that look like scams:
 *  - dust: a tiny payment you did not ask for, sent to bait you or to link your addresses;
 *  - lookalike: sent from an address forged to resemble one you use, hoping you copy it later.
 * `own` lists transactions the wallet made itself (never flagged).
 */
export function flagActivity(a: Activity, known: Iterable<string>, own: Set<string> = new Set()): Flag | undefined {
  if (a.kind !== "received" || own.has(a.txid)) return undefined;
  if (a.counterparty && lookalikeOf(a.counterparty, known)) return "lookalike";
  if (a.net > 0n && a.net <= DUST_FLAG) return "dust";
  return undefined;
}
