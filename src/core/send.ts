import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Account } from "./keys";
import { addressScript, isValidAddress } from "./keys";
import { DUST, type Network } from "./network";
import type { Utxo } from "./indexer";
import type { Snapshot } from "./wallet";
import type { Service } from "./fees";

// Builds and signs a payment. Nothing here talks to the network.

export interface Plan {
  inputs: Utxo[];
  to: string;
  amount: bigint; // what the recipient gets
  fee: bigint; // network fee
  /** Wallet commission, paid to `serviceAddress`. 0 when none applies. */
  serviceFee: bigint;
  serviceAddress?: string;
  serviceLabel?: string;
  change: bigint;
  changeAddress: string;
  vsize: number;
}

// Taproot key-path sizes in virtual bytes.
// From 253 inputs or outputs on, their counter takes 3 bytes instead of 1.
const vsize = (ins: number, outs: number) => Math.ceil(10.5 + 57.5 * ins + 43 * outs + (ins >= 253 ? 2 : 0) + (outs >= 253 ? 2 : 0));
/** Size of a Keshi payment with this many inputs and outputs, measured locally (never trusted from a server). */
export const estimateVsize = vsize;

/**
 * Highest network fee rate the wallet will ever sign, in grains per vbyte.
 * The rate comes from a server: a wrong or hostile answer must not be able to
 * burn the user's coins as fees. About ten times the busiest rate seen so far.
 */
export const MAX_FEE_RATE = 10_000;

/**
 * Very small coins are left alone: on Pearl they can carry an inscription
 * (a PRL-20 token or a collectible), and spending one as ordinary money would
 * destroy it. Coins the token index flags as carrying an inscription are
 * excluded by name; coins of 0.0005 PRL or less (the size Pearlscriptions
 * uses) are excluded as a fallback for when the index is unreachable.
 */
export const PROTECTED_BELOW = 50_000n;

export const spendable = (snap: Snapshot): Utxo[] =>
  snap.utxos.filter((u) => !(u.coinbase && u.confirmations < 100) && u.value > PROTECTED_BELOW && !snap.protectedOutpoints?.includes(`${u.txid}:${u.vout}`));

export const spendableTotal = (snap: Snapshot): bigint => spendable(snap).reduce((s, u) => s + u.value, 0n);

/**
 * Choose coins for a payment. `amount: "max"` empties the wallet (the fee is
 * taken from the amount). Throws a plain-language error when it cannot work.
 */
/** Commission on `amount`, capped. Too small to be a real output: no commission. */
export function commission(amount: bigint, service?: Service): bigint {
  if (!service) return 0n;
  if (service.flat) return service.flat;
  let fee = (amount * BigInt(service.bps)) / 10_000n;
  if (service.cap > 0n && fee > service.cap) fee = service.cap;
  return fee > DUST ? fee : 0n;
}

/**
 * Send one particular coin, the one that holds an inscription or a token
 * transfer, to `to`. Pearlscriptions moves what a coin holds to the FIRST
 * output of the transaction that spends it, and loses it when two such coins
 * are spent together, so the plan is built for that:
 *  - the chosen coin is input 0 and nothing else that is protected is spent;
 *  - the recipient is output 0 and receives `keep` grains (or the whole coin
 *    when it is smaller); the rest of a large coin comes back as change;
 *  - the network fee comes from ordinary spendable coins.
 */
export function planCoin(snap: Snapshot, net: Network, coin: Utxo, to: string, feeRate: number, keep = PROTECTED_BELOW): Plan {
  if (!isValidAddress(to, net)) throw new Error(`That is not a valid ${net.hrp}1… address`);
  // Without the token index, Keshi cannot tell which other coins carry something: one of them riding along would be lost.
  if (snap.protectionChecked === false) throw new Error("The token index is unreachable, so Keshi cannot check which coins carry tokens. Nothing was sent; try again in a moment.");
  if (!snap.addresses.some((a) => a.address === coin.address)) throw new Error("This coin does not belong to this wallet");
  if (coin.coinbase && coin.confirmations < 100) throw new Error("This coin is not spendable yet");
  const rate = BigInt(Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(Number.isFinite(feeRate) ? feeRate : 1))));
  const out0 = coin.value > keep ? keep : coin.value;
  if (out0 <= DUST) throw new Error("This coin is too small to send on its own");
  const same = (u: Utxo) => u.txid === coin.txid && u.vout === coin.vout;
  const funding = spendable(snap).filter((u) => !same(u)).sort((a, b) => (b.value > a.value ? 1 : -1));
  const changeAddress = snap.changeAddr.address;
  const inputs: Utxo[] = [coin];
  let total = coin.value;
  for (let i = 0; i <= funding.length; i++) {
    const withChange = BigInt(vsize(inputs.length, 2)) * rate;
    if (total >= out0 + withChange + DUST) return { inputs, to, amount: out0, fee: withChange, serviceFee: 0n, change: total - out0 - withChange, changeAddress, vsize: vsize(inputs.length, 2) };
    const noChange = BigInt(vsize(inputs.length, 1)) * rate;
    if (total >= out0 + noChange) return { inputs, to, amount: out0, fee: total - out0, serviceFee: 0n, change: 0n, changeAddress, vsize: vsize(inputs.length, 1) };
    if (i === funding.length || inputs.length >= 200) break;
    inputs.push(funding[i]!);
    total += funding[i]!.value;
  }
  // No ordinary coin left for the fee: the coin pays its own fee. What it carries follows output 0 whatever its value.
  const alone = BigInt(vsize(1, 1)) * rate;
  if (coin.value - alone > DUST) return { inputs: [coin], to, amount: coin.value - alone, fee: alone, serviceFee: 0n, change: 0n, changeAddress, vsize: vsize(1, 1) };
  throw new Error("Not enough PRL to pay the network fee for this transfer");
}

export function plan(snap: Snapshot, net: Network, to: string, amount: bigint | "max", feeRate: number, service?: Service, maxInputs = 400): Plan {
  if (!isValidAddress(to, net)) throw new Error(`That is not a valid ${net.hrp}1… address`);
  const coins = spendable(snap).sort((a, b) => (b.value > a.value ? 1 : -1));
  if (coins.length === 0) throw new Error("No spendable PRL yet");
  const rate = BigInt(Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(Number.isFinite(feeRate) ? feeRate : 1))));
  const changeAddress = snap.changeAddr.address;
  if (service && service.address === to) service = undefined;
  const tag = (s: bigint) => (s > 0n ? { serviceFee: s, serviceAddress: service!.address, serviceLabel: service!.label } : { serviceFee: 0n });

  if (amount === "max") {
    const inputs = coins.slice(0, maxInputs);
    const total = inputs.reduce((s, u) => s + u.value, 0n);
    // First assume a commission output exists; drop it if the commission is nil.
    let size = vsize(inputs.length, service ? 2 : 1);
    let fee = BigInt(size) * rate;
    let svc = commission(total - fee, service);
    if (svc === 0n && service) {
      size = vsize(inputs.length, 1);
      fee = BigInt(size) * rate;
    }
    if (total - fee - svc <= DUST) throw new Error("Balance is too small to cover the network fee");
    return { inputs, to, amount: total - fee - svc, fee, ...tag(svc), change: 0n, changeAddress, vsize: size };
  }

  if (amount <= DUST) throw new Error("Amount is too small to send");
  const svc = commission(amount, service);
  const extra = svc > 0n ? 1 : 0;
  const need = amount + svc;
  const inputs: Utxo[] = [];
  let total = 0n;
  for (const c of coins) {
    if (inputs.length >= maxInputs) break;
    inputs.push(c);
    total += c.value;
    const feeWithChange = BigInt(vsize(inputs.length, 2 + extra)) * rate;
    if (total >= need + feeWithChange + DUST) {
      return { inputs, to, amount, fee: feeWithChange, ...tag(svc), change: total - need - feeWithChange, changeAddress, vsize: vsize(inputs.length, 2 + extra) };
    }
    const feeNoChange = BigInt(vsize(inputs.length, 1 + extra)) * rate;
    if (total >= need + feeNoChange) {
      // Leftover too small to pay for a change output of its own: it goes to the network fee.
      return { inputs, to, amount, fee: total - need, ...tag(svc), change: 0n, changeAddress, vsize: vsize(inputs.length, 1 + extra) };
    }
  }
  if (inputs.length >= maxInputs && coins.length > maxInputs)
    throw new Error("Too many small coins for one payment. Combine your mining payouts first (Mining tab).");
  throw new Error(svc > 0n ? "Not enough PRL to cover the amount plus the fees" : "Not enough PRL to cover the amount plus the network fee");
}

/** Inputs below 0xfffffffe signal that the payment may be replaced by one paying a higher fee (BIP 125). */
export const RBF_SEQUENCE = 0xfffffffd;

export function sign(p: Plan, snap: Snapshot, account: Account, net: Network): { hex: string; txid: string } {
  // Last line of defence: whatever built this plan, the fee it burns must be sane.
  const totalIn = p.inputs.reduce((s, u) => s + u.value, 0n);
  if (p.amount <= 0n || p.fee < 0n || p.serviceFee < 0n || p.change < 0n) throw new Error("Invalid payment");
  if (totalIn !== p.amount + p.fee + p.serviceFee + p.change) throw new Error("Payment does not add up. Nothing was sent.");
  // One change output's worth of leftover may be folded into the fee, never more.
  if (p.fee > BigInt(p.vsize + 43) * BigInt(MAX_FEE_RATE) + DUST) throw new Error("The network fee is abnormally high. Nothing was sent.");
  const byAddress = new Map(snap.addresses.map((a) => [a.address, a]));
  // The change must come back to this wallet: its fresh change address, or one of its own addresses (a speed-up reuses the original).
  if (p.change > 0n && p.changeAddress !== snap.changeAddr.address && !byAddress.get(p.changeAddress)?.change) throw new Error("The change would leave the wallet. Nothing was sent.");
  // Pearl's v2 (P2MR) outputs are unknown to the library; addressScript() only ever produces the two scripts Pearl accepts.
  const tx = new Transaction({ allowUnknownOutputs: true });
  const keys: Uint8Array[] = [];
  for (const u of p.inputs) {
    const a = byAddress.get(u.address);
    if (!a) throw new Error("Coin does not belong to this wallet");
    const d = account.derive(a.change, a.index);
    tx.addInput({
      txid: hexToBytes(u.txid),
      index: u.vout,
      witnessUtxo: { script: addressScript(u.address, net), amount: u.value },
      // Opt-in replace-by-fee: a payment stuck with too low a fee can be sped up later.
      sequence: RBF_SEQUENCE,
      tapInternalKey: d.pubkey,
      // A quantum-ready address also commits to a script tree; the ordinary signature must account for it.
      ...(a.tapRoot ? { tapMerkleRoot: hexToBytes(a.tapRoot) } : {}),
    });
    keys.push(account.privateKey(a.change, a.index));
  }
  tx.addOutput({ script: addressScript(p.to, net), amount: p.amount }); // raw script: scure only knows v1, Pearl also has v2
  if (p.serviceFee > 0n && p.serviceAddress) tx.addOutput({ script: addressScript(p.serviceAddress, net), amount: p.serviceFee });
  if (p.change > 0n) tx.addOutput({ script: addressScript(p.changeAddress, net), amount: p.change });
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, txid: tx.id };
}

/**
 * A faster version of a payment still waiting for confirmation: the same
 * inputs and the same outputs, with a higher network fee taken from the
 * change. The network then keeps the faster one and drops the other. Only for
 * payments made by this wallet with replace-by-fee on, and with change to pay
 * from: the recipient always gets exactly the same amount.
 */
export function speedUpPlan(
  tx: { txid: string; confirmations: number; fees?: string; vsize?: number; vin: { txid?: string; vout?: number; sequence?: number; addresses?: string[]; value?: string }[]; vout: { n: number; addresses?: string[]; value?: string; spent?: boolean }[] },
  snap: Snapshot,
  newRate: number,
  approved: { inputs: string[]; change: string; changeAddress: string } | undefined,
): Plan {
  if (tx.confirmations > 0) throw new Error("This payment is already confirmed");
  // The coins and the change must be the ones this device approved: the indexer's copy only says whether it is still waiting.
  // Without that record (a payment sent by an older Keshi), a server could describe other coins of the wallet, and the
  // "faster version" would be a second payment instead of a replacement. Such payments are not sped up.
  if (!approved || !approved.inputs?.length || approved.change === undefined || !approved.changeAddress)
    throw new Error("This payment was sent by an older version of Keshi, which did not keep what is needed to speed it up safely. It will confirm when the network is less busy.");
  {
    const got = tx.vin.map((i) => `${i.txid}:${i.vout}=${BigInt(i.value ?? "0")}`).sort().join("|");
    if (got !== [...approved.inputs].sort().join("|")) throw new Error("The network's copy of this payment spends other coins than the ones you approved. Nothing was changed.");
    const ch = tx.vout.find((o) => o.addresses?.length === 1 && o.addresses[0] === approved.changeAddress);
    if (!ch || BigInt(ch.value ?? "0") !== BigInt(approved.change)) throw new Error("The network's copy of this payment does not match what you sent. Nothing was changed.");
  }
  // Replacing it would cancel whatever already spends it (a later payment, a token mint's second step).
  if (tx.vout.some((o) => (o as { spent?: boolean }).spent)) throw new Error("A later payment already builds on this one, so it cannot be sped up. It will confirm with it.");
  const mine = new Map(snap.addresses.map((a) => [a.address, a]));
  if (!tx.vin.every((i) => typeof i.sequence === "number" && i.sequence < 0xfffffffe)) throw new Error("This payment was sent without the speed-up option. It will confirm when the network is less busy.");
  const inputs: Utxo[] = tx.vin.map((i) => {
    const address = i.addresses?.[0] ?? "";
    if (!mine.has(address) || i.addresses!.length !== 1 || !i.txid || typeof i.vout !== "number") throw new Error("This payment was not made by this wallet");
    return { txid: i.txid, vout: i.vout, value: BigInt(i.value ?? "0"), address, confirmations: 0, coinbase: false };
  });
  const outs = [...tx.vout].sort((a, b) => a.n - b.n).map((o) => ({ address: o.addresses?.length === 1 ? o.addresses[0]! : "", value: BigInt(o.value ?? "0") }));
  if (outs.some((o) => !o.address)) throw new Error("Keshi cannot rebuild this payment");
  // Keshi's own layout: recipient first, then the commission (if any), then the change.
  const changeIdx = outs.findIndex((o, i) => i > 0 && mine.get(o.address)?.change === true);
  if (changeIdx < 0) throw new Error("This payment has no change to pay a higher fee from");
  if (outs.length > 3 || (outs.length === 3 && changeIdx !== 2)) throw new Error("Keshi cannot rebuild this payment");
  const totalIn = inputs.reduce((s, u) => s + u.value, 0n);
  const totalOut = outs.reduce((s, o) => s + o.value, 0n);
  const oldFee = totalIn - totalOut;
  // Always measured here, never taken from the server: a hostile indexer announcing a huge size would inflate the fee
  // (and the ceiling in sign(), which relies on this same number).
  const size = vsize(inputs.length, outs.length);
  const rate = BigInt(Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(newRate))));
  // The replacement must pay more than the original, plus the relay fee for its own size.
  let fee = BigInt(size) * rate;
  if (fee < oldFee + BigInt(size)) fee = oldFee + BigInt(size);
  const change = outs[changeIdx]!.value - (fee - oldFee);
  if (change <= DUST) throw new Error("The change of this payment is too small to pay a higher fee");
  const service = changeIdx === 2 ? outs[1]! : undefined;
  return {
    inputs,
    to: outs[0]!.address,
    amount: outs[0]!.value,
    fee,
    serviceFee: service?.value ?? 0n,
    serviceAddress: service?.address,
    change,
    changeAddress: outs[changeIdx]!.address,
    vsize: size,
  };
}

/** The id of a signed transaction given as hex. */
export const txidOfHex = (hex: string): string => Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true }).id;
