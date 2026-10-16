import { describe, it, expect } from "vitest";
import { Transaction } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import * as c from "../src/core";

// Real Pearl mainnet data: the PRLS deploy (block 57216).
//   reveal 4766da0821b16075bb28a8adc8ce9cee6f8a4cde97ac4cc617761d89deea33cb
//   commit 590eba6a360e3014972d0c1b879f0efdc093811cf69cd09d3acd665e22c07d31:0 (0.001 PRL)
const REVEAL_HEX =
  "01000000000101317dc0225e66cd3a9dd09cf61c8193c0fd0e9f871b0c2d9714300e366aba0e590000000000ffffffff0150c300000000000022512021574490800c6903095739b0b05d3c6a71a470feb194386267ab88c521cf9d970340f88c1bca6cec4f4d9402c8ea1e3dd44f85afadbd0867fbc29b532ea164d89e617471778c41e3b7b999119fbbec992db525635cbf34e6639f334f028db2752f7297208f6f90f3dda16829889d63e58304e36896c48154d5a2d8ff0a6455dc815ff978ac00630670726c2d3230106170706c69636174696f6e2f6a736f6e004c577b2270223a2270726c2d3230222c226f70223a226465706c6f79222c227469636b223a2270726c73222c226d6178223a2232313030303030303030222c226c696d223a22313030303030222c22646563223a223138227d6821c08f6f90f3dda16829889d63e58304e36896c48154d5a2d8ff0a6455dc815ff97800000000";
const REVEAL_TXID = "4766da0821b16075bb28a8adc8ce9cee6f8a4cde97ac4cc617761d89deea33cb";
const COMMIT_SCRIPT = "5120ee40324650840ffcaeff8739a87cb3b8f220692406c3c04c7cdba04e2e3280bc";
const COMMIT_AMOUNT = 100_000n;
const PUBKEY = "8f6f90f3dda16829889d63e58304e36896c48154d5a2d8ff0a6455dc815ff978";
const DEPLOY = '{"p":"prl-20","op":"deploy","tick":"prls","max":"2100000000","lim":"100000","dec":"18"}';

describe("inscriptions match what is already on Pearl mainnet", () => {
  const real = Transaction.fromRaw(hexToBytes(REVEAL_HEX), { allowUnknownInputs: true, allowUnknownOutputs: true });
  const [sig, leaf, control] = real.getInput(0).finalScriptWitness!;

  it("the reference transaction was transcribed correctly", () => {
    expect(real.id).toBe(REVEAL_TXID);
  });

  it("builds the same script, byte for byte", () => {
    expect(bytesToHex(c.leafScript(hexToBytes(PUBKEY), [DEPLOY]))).toBe(bytesToHex(leaf!));
  });

  it("derives the same commit address and control block", () => {
    const commit = c.commitFor(hexToBytes(PUBKEY), [DEPLOY], c.MAINNET);
    expect(bytesToHex(commit.script)).toBe(COMMIT_SCRIPT);
    expect(bytesToHex(commit.controlBlock)).toBe(bytesToHex(control!));
    expect(commit.address).toBe("prl1paeqry3jsss8lethlsuu6sl9nhrezq6fyqmpuqnrumwsyut3jsz7q8erc0n");
  });

  it("computes the signing hash the network accepted", () => {
    const hash = c.revealSighash(real, hexToBytes(COMMIT_SCRIPT), COMMIT_AMOUNT, leaf!);
    expect(schnorr.verify(sig!, hash, hexToBytes(PUBKEY))).toBe(true);
  });
});

describe("minting", () => {
  const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const account = c.accountFromPhrase(ABANDON, c.MAINNET);
  const me = account.derive(false, 0);

  it("writes the mint text exactly as the spec requires", () => {
    expect(c.mintBody("GRNS", "1000")).toBe('{"p":"prl-20","op":"mint","tick":"grns","amt":"1000"}');
    expect(() => c.mintBody("bad tick", "1")).toThrow();
    expect(() => c.mintBody("grns", "01")).toThrow();
    expect(() => c.mintBody("grns", "0")).toThrow();
    expect(() => c.mintBody("grns", "1.5")).toThrow();
  });

  it("produces a reveal that is correctly signed, sized and owned", () => {
    for (const count of [1, 5, 20]) {
      const bodies = Array.from({ length: count }, () => c.mintBody("grns", "1000"));
      const commit = c.commitFor(me.pubkey, bodies, c.MAINNET);
      const amount = c.INSCRIPTION_VALUE + c.revealFee(commit, 834);
      const r = c.buildReveal({ commitTxid: "11".repeat(32), commitVout: 0, commit, amount, owner: me.address, privateKey: account.privateKey(false, 0), net: c.MAINNET });
      const tx = Transaction.fromRaw(hexToBytes(r.hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
      expect(tx.id).toBe(r.txid);
      expect(tx.version).toBe(1);
      expect(tx.outputsLength).toBe(1);
      expect(tx.getOutput(0).amount).toBe(50_000n);
      expect(bytesToHex(tx.getOutput(0).script!)).toBe(bytesToHex(c.addressScript(me.address, c.MAINNET)));
      const [sig, leaf, control] = tx.getInput(0).finalScriptWitness!;
      expect(schnorr.verify(sig!, c.revealSighash(tx, commit.script, amount, leaf!), me.pubkey)).toBe(true);
      expect(control!.length).toBe(33);
      expect(tx.vsize).toBeLessThanOrEqual(c.revealVsize(commit));
      expect(c.revealVsize(commit) - tx.vsize).toBeLessThanOrEqual(1);
      // Same number of envelopes as mints requested.
      expect(bytesToHex(leaf!).split("0063" + "0670726c2d3230").length - 1).toBe(count);
    }
  });

  it("refuses more than 20 mints in one transaction", () => {
    expect(() => c.commitFor(me.pubkey, Array.from({ length: 21 }, () => c.mintBody("grns", "1")), c.MAINNET)).toThrow();
  });
});

// Cross-check with the reference indexer itself (MIT, github.com/Kshot3000/indexer)
// when a local copy is present: it must read our reveal as valid PRL-20 mints.
import { existsSync } from "node:fs";
const REF = "/tmp/prl20idx/apps/indexer-api/src/indexer.js";
const CORE = "/tmp/prl20idx/packages/prl20-core/src/index.js";
describe.skipIf(!existsSync(REF))("the reference indexer reads our mint", () => {
  it("finds every envelope, the right owner output and valid mint operations", async () => {
    const idx: any = await import(/* @vite-ignore */ REF);
    const core: any = await import(/* @vite-ignore */ CORE);
    const account = c.accountFromPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", c.MAINNET);
    const me = account.derive(false, 0);
    const bodies = Array.from({ length: 3 }, () => c.mintBody("grns", "1000"));
    const commit = c.commitFor(me.pubkey, bodies, c.MAINNET);
    const amount = c.INSCRIPTION_VALUE + c.revealFee(commit, 834);
    const r = c.buildReveal({ commitTxid: "22".repeat(32), commitVout: 0, commit, amount, owner: me.address, privateKey: account.privateKey(false, 0), net: c.MAINNET });
    const found = idx.extractTaprootInscriptionsFromRawTxHex(r.hex, {});
    expect(found.length).toBe(3);
    for (const ins of found) {
      expect(ins.marker).toBe("prl-20");
      expect(ins.contentType).toBe("application/json");
      expect(ins.ownerOutputIndex).toBe(0);
      expect(ins.ownerScriptPubKey).toBe(bytesToHex(c.addressScript(me.address, c.MAINNET)));
      const op = core.parsePrl20Operation(ins.body);
      expect(op.op).toBe("mint");
      expect(op.tick ?? op.ticker).toBe("grns");
    }
  });
});
