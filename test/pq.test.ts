import { describe, it, expect } from "vitest";
import { Transaction, utils as btcUtils } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import * as c from "../src/core";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = c.accountFromPhrase(PHRASE, c.MAINNET);
const first = account.derive(false, 0);
const pq = c.derivePqAddress(PHRASE, first.pubkey, c.MAINNET, false, 0);
const tagged = (tag: string, ...d: Uint8Array[]) => {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(t, t, ...d));
};

describe("quantum-ready address", () => {
  it("is a taproot address that commits to <xmss key> OP_CHECKXMSSSIG and differs from the ordinary one", () => {
    expect(pq.address.startsWith("prl1p")).toBe(true);
    expect(pq.address).not.toBe(first.address);
    expect(c.isValidAddress(pq.address, c.MAINNET)).toBe(true);
    expect(pq.leafScript.length).toBe(66);
    expect(pq.leafScript[0]).toBe(64);
    expect(pq.leafScript[65]).toBe(0xde);
    // Deterministic: the same phrase always gives the same address.
    expect(c.derivePqAddress(PHRASE, first.pubkey, c.MAINNET, false, 0).address).toBe(pq.address);
    // Another network or index gives another key.
    expect(bytesToHex(c.pqSeeds(PHRASE, c.TESTNET, false, 0).privateSeed)).not.toBe(bytesToHex(c.pqSeeds(PHRASE, c.MAINNET, false, 0).privateSeed));
    expect(bytesToHex(c.pqSeeds(PHRASE, c.MAINNET, false, 1).privateSeed)).not.toBe(bytesToHex(c.pqSeeds(PHRASE, c.MAINNET, false, 0).privateSeed));
  }, 60_000);

  it("the control block proves the post-quantum branch belongs to the address (BIP-341 rule)", () => {
    const script = c.addressScript(pq.address, c.MAINNET); // OP_1 <32-byte output key>
    const outputKey = script.slice(2);
    const leaf = tagged("TapLeaf", Uint8Array.of(pq.controlBlock[0]! & 0xfe, pq.leafScript.length), pq.leafScript);
    const internal = pq.controlBlock.slice(1, 33);
    expect(bytesToHex(internal)).toBe(bytesToHex(first.pubkey));
    const [q, parity] = btcUtils.taprootTweakPubkey(internal, leaf);
    expect(bytesToHex(q)).toBe(bytesToHex(outputKey));
    expect(pq.controlBlock[0]! & 1).toBe(parity);
    expect(pq.controlBlock.length).toBe(33); // one leaf: no sibling hashes
  });

  const coin = (address: string, value: bigint, n: number) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, address, confirmations: 10, coinbase: false }) as c.Utxo;
  const dest = account.derive(false, 7).address;

  it("coins on it are spent with an ordinary signature that verifies against the address", () => {
    const snap = {
      utxos: [coin(pq.address, 5_00000000n, 1), coin(first.address, 1_00000000n, 2)],
      addresses: [
        { address: first.address, change: false, index: 0, used: true },
        { address: pq.address, change: false, index: 0, used: true, tapRoot: bytesToHex(pq.merkleRoot) },
      ],
      changeAddr: account.derive(true, 0), receive: first, balance: 0n, pending: 0n, immature: 0n, activity: [], updated: 0, height: 1,
    } as unknown as c.Snapshot;
    const plan = c.plan(snap, c.MAINNET, dest, "max", 5);
    expect(plan.inputs.length).toBe(2);
    const { hex } = c.sign(plan, snap, account, c.MAINNET);
    const tx = Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true });
    // Re-compute what each signature must sign and check it against each address's own key.
    const scripts = plan.inputs.map((u) => c.addressScript(u.address, c.MAINNET));
    const amounts = plan.inputs.map((u) => u.value);
    plan.inputs.forEach((u, i) => {
      const sig = tx.getInput(i).finalScriptWitness![0]!;
      const msg = tx.preimageWitnessV1(i, scripts, 0, amounts);
      expect(schnorr.verify(sig, msg, c.addressScript(u.address, c.MAINNET).slice(2))).toBe(true);
    });
  });

  it("can also be spent the post-quantum way: the XMSS signature covers the tapscript message", () => {
    const tx = new Transaction({ allowUnknownOutputs: true });
    const script = c.addressScript(pq.address, c.MAINNET);
    tx.addInput({ txid: "11".repeat(32), index: 0, witnessUtxo: { script, amount: 2_00000000n } });
    tx.addOutputAddress(dest, 1_99990000n, c.btcNet(c.MAINNET));
    const seeds = c.pqSeeds(PHRASE, c.MAINNET, false, 0);
    const witness = c.signPqInput(tx, 0, [script], [2_00000000n], pq, seeds, 0);
    // Seven items: five signature pieces of 468 bytes, the script, the control block.
    expect(witness.length).toBe(7);
    expect(witness.slice(0, 5).every((w) => w.length === 468)).toBe(true);
    expect(bytesToHex(witness[5]!)).toBe(bytesToHex(pq.leafScript));
    expect(bytesToHex(witness[6]!)).toBe(bytesToHex(pq.controlBlock));
    const msg = tx.preimageWitnessV1(0, [script], 0, [2_00000000n], undefined, pq.leafScript, 0xc0);
    expect(c.xmssVerify(pq.xmssPublicKey, msg, concatBytes(...witness.slice(0, 5)))).toBe(true);
    // The message is not the ordinary (key-path) one: a signature cannot be moved between the two ways.
    expect(bytesToHex(msg)).not.toBe(bytesToHex(tx.preimageWitnessV1(0, [script], 0, [2_00000000n])));
    // The finished transaction serialises with that witness.
    const raw = Transaction.fromRaw(hexToBytes(tx.hex), { allowUnknownOutputs: true });
    expect(raw.getInput(0).finalScriptWitness!.length).toBe(7);
    // A key that is not the address's own is refused.
    expect(() => c.signPqInput(tx, 0, [script], [2_00000000n], pq, c.pqSeeds(PHRASE, c.MAINNET, false, 1), 0)).toThrow(/does not belong/);
  }, 120_000);
});
