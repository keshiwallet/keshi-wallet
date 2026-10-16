import { Transaction, RawTx, Script } from "@scure/btc-signer";
import { RawWitness } from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { addressScript } from "./keys";
import type { Network } from "./network";

// BIP-322 "simple" message signing: proves you own an address without
// moving any coins. Used when a site asks you to sign in.

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, msg));
}

export function toSpendTxid(message: string, script: Uint8Array): Uint8Array {
  const msgHash = taggedHash("BIP0322-signed-message", new TextEncoder().encode(message));
  const raw = RawTx.encode({
    version: 0,
    segwitFlag: false,
    inputs: [{ txid: new Uint8Array(32), index: 0xffffffff, finalScriptSig: Script.encode(["OP_0", msgHash]), sequence: 0 }],
    outputs: [{ amount: 0n, script }],
    witnesses: [],
    lockTime: 0,
  } as any);
  return sha256(sha256(raw)).reverse();
}

export function signMessage(message: string, address: string, privateKey: Uint8Array, pubkey: Uint8Array, net: Network): string {
  const script = addressScript(address, net);
  const tx = new Transaction({ version: 0, allowUnknownOutputs: true });
  tx.addInput({ txid: toSpendTxid(message, script), index: 0, sequence: 0, witnessUtxo: { script, amount: 0n }, tapInternalKey: pubkey });
  tx.addOutput({ script: Script.encode(["RETURN"]), amount: 0n });
  tx.signIdx(privateKey, 0);
  tx.finalize();
  const witness = tx.getInput(0).finalScriptWitness!;
  return btoa(String.fromCharCode(...RawWitness.encode(witness)));
}

/**
 * Web addresses a message to sign names that are not the requesting site (nor one of its subdomains or parents).
 * A sign-in text copied from another site would let the requester use the signature to sign in there as you.
 */
export function foreignSites(message: string, origin: string): string[] {
  let own = "";
  try {
    own = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return [];
  }
  const related = (h: string) => h === own || h.endsWith("." + own) || own.endsWith("." + h);
  const found = new Set<string>();
  for (const m of message.toLowerCase().matchAll(/(?:^|[^a-z0-9.@-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/g)) {
    const host = m[1]!.replace(/^www\./, "");
    if (/\.(png|jpe?g|gif|svg|webp|json|txt|pdf|html?|js|ts|md|csv)$/.test(host)) continue; // file names, not sites
    if (!related(host)) found.add(host);
    if (found.size >= 3) break;
  }
  return [...found];
}
