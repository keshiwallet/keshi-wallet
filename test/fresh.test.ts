import { describe, expect, it } from "vitest";
import * as c from "../src/core";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const indexer = (txCount: (address: string) => number) => ({ address: async (address: string) => ({ txCount: txCount(address) }) }) as unknown as c.Indexer;

describe("a new wallet is nobody else's", () => {
  it("makes every phrase from fresh randomness", () => {
    const seen = new Set(Array.from({ length: 200 }, () => c.newPhrase(24)));
    expect(seen.size).toBe(200);
    for (const p of seen) expect(c.isValidPhrase(p)).toBe(true);
    expect(c.newPhrase(12).split(" ")).toHaveLength(12);
  });

  it("says a phrase is unused only when the network has never seen its addresses", async () => {
    expect(await c.phraseIsUnused(PHRASE, indexer(() => 0))).toBe(true);
    const first = c.accountFromPhrase(PHRASE, c.MAINNET, 0, "pearl").derive(false, 0).address;
    expect(await c.phraseIsUnused(PHRASE, indexer((a) => (a === first ? 3 : 0)))).toBe(false);
  });

  it("does not claim anything when the network cannot answer", async () => {
    const down = { address: async () => { throw new Error("offline"); } } as unknown as c.Indexer;
    expect(await c.phraseIsUnused(PHRASE, down)).toBeNull();
  });
});

describe("swap prices are checked with every Ethereum server", () => {
  it("collects each server's own answer, so one lying server cannot lower the price on its own", async () => {
    const fetcher = (async (url: string) => {
      if (url.includes("down")) throw new Error("offline");
      const result = url.includes("honest") ? "0x" + (1000n).toString(16).padStart(64, "0") : "0x" + (10n).toString(16).padStart(64, "0");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    }) as unknown as typeof fetch;
    const rpc = new c.EthRpc(fetcher, ["https://liar.test", "https://honest.test", "https://down.test"]);
    const answers = await rpc.rawEach("0x61fFE014bA17989E743c5F6cB21bF9697530B21e", new Uint8Array([1, 2, 3]));
    expect(answers.map((a) => BigInt(a))).toEqual([10n, 1000n]);
  });
});
