import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction, utils as btcUtils } from "@scure/btc-signer";
import { bech32m } from "@scure/base";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { accountNode, cleanPhrase, type Derivation } from "./keys";
import type { Network } from "./network";
import { xmssKeygen, xmssSign, XMSS_PK_LEN, XMSS_SIG_LEN } from "./xmss";

// Quantum-ready addresses. A normal Pearl address can be spent with one
// signature (Schnorr), which a large quantum computer could one day forge. A
// quantum-ready address commits, in addition, to a hash-based key (XMSS) that
// such a computer cannot break: the same address offers a second, post-quantum
// way to spend, through Pearl's OP_CHECKXMSSSIG.
//
// Built the way the official Pearl wallet builds them (`getnewaddress` with
// the pq option): the XMSS seeds come from m/222'/coin'/account'/branch/index,
// expanded with HKDF, and the address is a taproot output whose script tree is
// the single leaf `<xmss public key> OP_CHECKXMSSSIG`.

const OP_CHECKXMSSSIG = 0xde;
const LEAF_VERSION = 0xc0;
const PQ_PURPOSE = 222;

const tagged = (tag: string, ...data: Uint8Array[]): Uint8Array => {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...data));
};

/** The secret seeds of the post-quantum key that goes with address (change, index). */
export function pqSeeds(phrase: string, net: Network, change: boolean, index: number, account = 0, mode: Derivation = "pearl"): { privateSeed: Uint8Array; publicSeed: Uint8Array } {
  const seed = mnemonicToSeedSync(cleanPhrase(phrase), "");
  const node = accountNode(seed, PQ_PURPOSE, net.coinType, account, mode).deriveChild(change ? 1 : 0).deriveChild(index);
  // The elliptic-curve key at this path is never used as such: it only feeds the expansion.
  const out = hkdf(sha256, node.privateKey!, undefined, new TextEncoder().encode("XMSS-SEED-EXPANSION"), 96);
  return { privateSeed: out.slice(0, 64), publicSeed: out.slice(64, 96) };
}

export interface PqAddress {
  address: string;
  /** The script of the post-quantum branch: <xmss public key> OP_CHECKXMSSSIG. */
  leafScript: Uint8Array;
  /** Root of the script tree (with one leaf, its hash). Needed to sign the ordinary way too. */
  merkleRoot: Uint8Array;
  /** Proves, when spending the post-quantum way, that the branch belongs to the address. */
  controlBlock: Uint8Array;
  xmssPublicKey: Uint8Array;
}

/** The quantum-ready address for an internal (x-only) key and its XMSS public key. */
export function pqAddress(internalKey: Uint8Array, xmssPublicKey: Uint8Array, net: Network): PqAddress {
  if (internalKey.length !== 32 || xmssPublicKey.length !== XMSS_PK_LEN) throw new Error("Bad key length");
  const leafScript = concatBytes(Uint8Array.of(XMSS_PK_LEN), xmssPublicKey, Uint8Array.of(OP_CHECKXMSSSIG));
  const merkleRoot = tagged("TapLeaf", Uint8Array.of(LEAF_VERSION, leafScript.length), leafScript);
  const [outputKey, parity] = btcUtils.taprootTweakPubkey(internalKey, merkleRoot);
  const address = bech32m.encode(net.hrp, [1, ...bech32m.toWords(outputKey)]);
  const controlBlock = concatBytes(Uint8Array.of(LEAF_VERSION | parity), internalKey);
  return { address, leafScript, merkleRoot, controlBlock, xmssPublicKey };
}

/** Derive the post-quantum key and the address in one go. Takes a second or two. */
export function derivePqAddress(phrase: string, internalKey: Uint8Array, net: Network, change: boolean, index: number, mode: Derivation = "pearl", account = 0): PqAddress {
  const { privateSeed, publicSeed } = pqSeeds(phrase, net, change, index, account, mode);
  const { pk } = xmssKeygen(privateSeed, publicSeed);
  privateSeed.fill(0);
  return pqAddress(internalKey, pk, net);
}

/**
 * Spend input `idx` of `tx` the post-quantum way: an XMSS signature instead of
 * the ordinary one. `uid` is the number of the one-time key to use (0 to 30);
 * it must never be used twice for the same address.
 *
 * `prevScripts` and `amounts` describe every input of the transaction, in order.
 */
export function signPqInput(
  tx: Transaction,
  idx: number,
  prevScripts: Uint8Array[],
  amounts: bigint[],
  pq: PqAddress,
  seeds: { privateSeed: Uint8Array; publicSeed: Uint8Array },
  uid: number,
): Uint8Array[] {
  const { sk, pk } = xmssKeygen(seeds.privateSeed, seeds.publicSeed);
  if (!pk.every((b, i) => b === pq.xmssPublicKey[i])) throw new Error("This post-quantum key does not belong to the address");
  // Same message the node checks: the tapscript signature hash of this leaf.
  const msg = tx.preimageWitnessV1(idx, prevScripts as Parameters<Transaction["preimageWitnessV1"]>[1], 0, amounts, undefined, pq.leafScript as Parameters<Transaction["preimageWitnessV1"]>[5], LEAF_VERSION);
  const sig = xmssSign(uid, sk, msg);
  sk.fill(0);
  // The node takes the signature in five pieces: one piece would exceed its size limit per item.
  const piece = XMSS_SIG_LEN / 5;
  const witness: Uint8Array[] = [0, 1, 2, 3, 4].map((i) => sig.slice(i * piece, (i + 1) * piece));
  witness.push(new Uint8Array(pq.leafScript), new Uint8Array(pq.controlBlock));
  tx.updateInput(idx, { finalScriptWitness: witness }, true);
  return witness;
}

export const pqFromHex = (h: { address: string; leafScript: string; merkleRoot: string; controlBlock: string; xmssPublicKey: string }): PqAddress => ({
  address: h.address,
  leafScript: hexToBytes(h.leafScript),
  merkleRoot: hexToBytes(h.merkleRoot),
  controlBlock: hexToBytes(h.controlBlock),
  xmssPublicKey: hexToBytes(h.xmssPublicKey),
});
