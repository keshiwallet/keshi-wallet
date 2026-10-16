import { MAX_FEE_RATE } from "./send";
import { p2tr, Transaction, SigHash } from "@scure/btc-signer";
import { TaprootControlBlock } from "@scure/btc-signer/psbt.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { btcNet, type Network } from "./network";
import { addressScript } from "./keys";

// Pearlscriptions / PRL-20 inscriptions, following the public spec
// (github.com/Kshot3000/indexer, docs/prl-20-v0-spec.md) and checked
// byte-for-byte against transactions already confirmed on Pearl mainnet.
//
// An inscription is written in two steps:
//   commit  an ordinary payment to a one-off taproot address that commits to the text
//   reveal  spends that payment, which publishes the text on-chain; its first
//           output becomes the owner of the inscription.

/** Value of the output that owns an inscription, as used by Pearlscriptions. */
export const INSCRIPTION_VALUE = 50_000n;
export const MAX_BATCH = 20;

const enc = new TextEncoder();

function push(data: Uint8Array): Uint8Array {
  if (data.length === 0) return Uint8Array.of(0x00);
  if (data.length <= 75) return concatBytes(Uint8Array.of(data.length), data);
  if (data.length <= 255) return concatBytes(Uint8Array.of(0x4c, data.length), data);
  if (data.length <= 520) return concatBytes(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
  throw new Error("Chunk too large");
}

/** `<pubkey> OP_CHECKSIG` followed by one envelope per body. */
export function leafScript(pubkey: Uint8Array, bodies: string[], marker = "prl-20", contentType = "application/json"): Uint8Array {
  if (pubkey.length !== 32) throw new Error("x-only public key expected");
  if (bodies.length < 1 || bodies.length > MAX_BATCH) throw new Error(`Between 1 and ${MAX_BATCH} inscriptions per transaction`);
  const parts: Uint8Array[] = [push(pubkey), Uint8Array.of(0xac)];
  for (const body of bodies) {
    const bytes = enc.encode(body);
    parts.push(Uint8Array.of(0x00, 0x63), push(enc.encode(marker)), push(enc.encode(contentType)), Uint8Array.of(0x00));
    for (let i = 0; i < bytes.length; i += 520) parts.push(push(bytes.subarray(i, i + 520)));
    parts.push(Uint8Array.of(0x68));
  }
  return concatBytes(...parts);
}

export interface Commit {
  address: string;
  script: Uint8Array; // scriptPubKey of the commit output
  leaf: Uint8Array;
  controlBlock: Uint8Array;
}

export function commitFor(pubkey: Uint8Array, bodies: string[], net: Network): Commit {
  const leaf = leafScript(pubkey, bodies);
  const pay = p2tr(pubkey, { script: leaf }, btcNet(net), true);
  const cb = pay.tapLeafScript![0]![0];
  return { address: pay.address!, script: pay.script, leaf, controlBlock: TaprootControlBlock.encode(cb) };
}

/** Sighash of a script-path spend of input 0, as Pearl (BIP-341/342) computes it. */
export function revealSighash(tx: Transaction, commitScript: Uint8Array, amount: bigint, leaf: Uint8Array): Uint8Array {
  return tx.preimageWitnessV1(0, [commitScript], SigHash.DEFAULT, [amount], undefined, leaf, 0xc0);
}

function unsignedReveal(commitTxid: string, commitVout: number, commit: Commit, amount: bigint, owner: string, net: Network, ownerValue: bigint) {
  const tx = new Transaction({ version: 1, allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({ txid: hexToBytes(commitTxid), index: commitVout, witnessUtxo: { script: commit.script, amount }, sequence: 0xffffffff });
  tx.addOutput({ script: addressScript(owner, net), amount: ownerValue });
  return tx;
}

/** Virtual size of the reveal, used to fund the commit output with the right fee. */
export function revealVsize(commit: Commit): number {
  const base = 4 + 1 + 41 + 1 + 43 + 4; // version, counts, input, one taproot output, locktime
  const witness = 2 + 1 + (1 + 64) + (3 + commit.leaf.length) + (1 + commit.controlBlock.length);
  return Math.ceil((base * 4 + witness) / 4);
}

export function revealFee(commit: Commit, feeRate: number): bigint {
  return BigInt(revealVsize(commit)) * BigInt(Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil(Number.isFinite(feeRate) ? feeRate : 1))));
}

/** Build and sign the reveal transaction. `amount` is the value of the commit output. */
export function buildReveal(opts: {
  commitTxid: string;
  commitVout: number;
  commit: Commit;
  amount: bigint;
  owner: string;
  privateKey: Uint8Array;
  net: Network;
  ownerValue?: bigint;
}): { hex: string; txid: string; fee: bigint } {
  const ownerValue = opts.ownerValue ?? INSCRIPTION_VALUE;
  if (opts.amount <= ownerValue) throw new Error("Commit output does not cover the reveal fee");
  const tx = unsignedReveal(opts.commitTxid, opts.commitVout, opts.commit, opts.amount, opts.owner, opts.net, ownerValue);
  const hash = revealSighash(tx, opts.commit.script, opts.amount, opts.commit.leaf);
  const sig = schnorr.sign(hash, opts.privateKey);
  tx.updateInput(0, { finalScriptWitness: [sig, opts.commit.leaf, opts.commit.controlBlock] }, true);
  return { hex: tx.hex, txid: tx.id, fee: opts.amount - ownerValue };
}

/* ------------------------------------------------------------ PRL-20 text */

const TICK = /^[a-z0-9]{1,16}$/;
const INT = /^(0|[1-9]\d*)$/;

/** The note that sets `amount` of a token aside so its coin can carry it to someone else. */
export function transferBody(tick: string, amount: string): string {
  const t = tick.toLowerCase();
  if (!TICK.test(t)) throw new Error("Invalid ticker");
  if (!INT.test(amount) || amount === "0") throw new Error("Enter a whole number of tokens");
  return `{"p":"prl-20","op":"transfer","tick":"${t}","amt":"${amount}"}`;
}

export function mintBody(tick: string, amount: string): string {
  const t = tick.toLowerCase();
  if (!TICK.test(t)) throw new Error("Invalid ticker");
  if (!INT.test(amount) || amount === "0") throw new Error("Invalid amount");
  return `{"p":"prl-20","op":"mint","tick":"${t}","amt":"${amount}"}`;
}
