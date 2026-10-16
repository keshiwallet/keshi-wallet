import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountFromPhrase, accountNode, derivationDiffers, newPhrase, resolveDerivation, MAINNET, TESTNET, Indexer } from "../src/core";
import vectors from "./vectors/derivation.json";

// Reference keys produced by btcd's own hdkeychain.DeriveNonStandard (the Go
// code the official Pearl wallet runs), for m/purpose'/coin'/0'/0/0.
describe("official-wallet derivation", () => {
  it("matches the Go reference on every vector, including the rare phrases", () => {
    let rare = 0;
    for (const v of vectors) {
      const seed = mnemonicToSeedSync(v.phrase, "");
      for (const [path, want] of Object.entries(v.keys)) {
        const [purpose, coin] = path.split("/").map(Number);
        const node = accountNode(seed, purpose!, coin!, 0, "pearl").deriveChild(0).deriveChild(0);
        expect(bytesToHex(node.privateKey!)).toBe(want);
        const std = accountNode(seed, purpose!, coin!, 0, "standard").deriveChild(0).deriveChild(0);
        if (bytesToHex(std.privateKey!) !== want) rare++;
      }
      expect(derivationDiffers(v.phrase)).toEqual(v.differs);
    }
    expect(rare).toBeGreaterThan(5);
  });

  it("never hands out a phrase that wallets derive differently", () => {
    for (let i = 0; i < 20; i++) expect(derivationDiffers(newPhrase(i % 2 ? 12 : 24))).toEqual([]);
  });

  const rare = vectors.find((v) => v.differs.includes(MAINNET.coinType))!;
  const fake = (used: string[], fail = false) => (net: typeof MAINNET) =>
    new Indexer(net, (async (url: string) => {
      if (fail) throw new Error("fetch failed");
      const address = String(url).split("/address/")[1]!.split("?")[0]!;
      return new Response(JSON.stringify({ balance: "0", txs: used.includes(address) ? 2 : 0 }));
    }) as typeof fetch);

  it("picks the derivation that already has history", async () => {
    const std = accountFromPhrase(rare.phrase, MAINNET, 0, "standard").derive(false, 0).address;
    const prl = accountFromPhrase(rare.phrase, MAINNET, 0, "pearl").derive(false, 0).address;
    expect(std).not.toBe(prl);
    expect(await resolveDerivation(rare.phrase, fake([std]))).toBe("standard");
    expect(await resolveDerivation(rare.phrase, fake([prl]))).toBe("pearl");
    expect(await resolveDerivation(rare.phrase, fake([]))).toBe("pearl");
  });

  it("refuses to guess when mainnet cannot be reached, and needs no network for ordinary phrases", async () => {
    await expect(resolveDerivation(rare.phrase, fake([], true))).rejects.toThrow(/could not reach/);
    const plain = vectors.find((v) => v.differs.length === 0)!;
    expect(await resolveDerivation(plain.phrase, fake([], true))).toBe("pearl");
    void TESTNET;
  }, 30000);
});
