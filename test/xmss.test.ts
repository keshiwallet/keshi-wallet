import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { xmssKeygen, xmssSign, xmssVerify, XMSS_SIG_LEN } from "../src/core/xmss";

// Vectors produced by the library the Pearl node itself uses (xmss/ in
// pearl-research-labs/pearl), compiled unchanged. Keys and signatures must
// match it byte for byte.
const vectors: Record<string, string>[] = JSON.parse(readFileSync(new URL("./vectors/xmss.json", import.meta.url), "utf8"));

describe("post-quantum signatures (XMSS), against Pearl's own library", () => {
  it("derives the same public and secret keys", () => {
    for (const v of vectors) {
      const { pk, sk } = xmssKeygen(hexToBytes(v.priv!), hexToBytes(v.pub!));
      expect(bytesToHex(pk)).toBe(v.pk);
      expect(bytesToHex(sk)).toBe(v.sk);
    }
  }, 120_000);

  it("produces the same signatures, and they verify", () => {
    for (const v of vectors.slice(0, 2)) {
      const sk = hexToBytes(v.sk!), pk = hexToBytes(v.pk!), msg = hexToBytes(v.msg!);
      for (const uid of [0, 5, 30]) {
        const sig = xmssSign(uid, sk, msg);
        expect(sig.length).toBe(XMSS_SIG_LEN);
        expect(bytesToHex(sig)).toBe(v["sig" + uid]);
        expect(xmssVerify(pk, msg, sig)).toBe(true);
      }
    }
  }, 240_000);

  it("accepts the node library's signatures and rejects altered ones", () => {
    const v = vectors[2]!;
    const pk = hexToBytes(v.pk!), msg = hexToBytes(v.msg!), sig = hexToBytes(v.sig5!);
    expect(xmssVerify(pk, msg, sig)).toBe(true);
    const badSig = sig.slice();
    badSig[100]! ^= 1;
    expect(xmssVerify(pk, msg, badSig)).toBe(false);
    const badMsg = msg.slice();
    badMsg[0]! ^= 1;
    expect(xmssVerify(pk, badMsg, sig)).toBe(false);
  });

  it("refuses to sign with a number outside the safe range", () => {
    const sk = hexToBytes(vectors[0]!.sk!), msg = hexToBytes(vectors[0]!.msg!);
    expect(() => xmssSign(31, sk, msg)).toThrow(/no signatures left/);
    expect(() => xmssSign(-1, sk, msg)).toThrow();
  });
});
