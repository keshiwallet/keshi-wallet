import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { accountNode, accountFromPhrase, ethAccountFromPhrase, addAccount, addWallet, removeWallet, phraseKeptElsewhere, selectWallet, accountOf, ethAccountOf, usedAccounts, walletsOf, ACCOUNT_SCAN_LIMIT, MAINNET, Indexer, type Secrets } from "../src/core";
import vectors from "./vectors/accounts.json";

// Accounts other than the first one: m/86'/coin'/account'/branch/index, the
// way the official Pearl wallet numbers them.

describe("accounts of a recovery phrase", () => {
  it("derives accounts 1, 2 and 7 like the official wallet's DeriveNonStandard, on every vector", () => {
    let checked = 0;
    for (const v of vectors) {
      const seed = mnemonicToSeedSync(v.phrase, "");
      for (const [path, want] of Object.entries(v.keys)) {
        const [purpose, coin, acct, branch, index] = path.replace("'", "").split("/").map(Number);
        const node = accountNode(seed, purpose!, coin!, acct!, "pearl").deriveChild(branch!).deriveChild(index!);
        expect(bytesToHex(node.privateKey!)).toBe(want);
        checked++;
      }
    }
    expect(checked).toBe(vectors.length * 27);
  });

  it("gives each account its own addresses, on both derivations", () => {
    const phrase = vectors[0]!.phrase;
    for (const mode of ["pearl", "standard"] as const) {
      const a0 = accountFromPhrase(phrase, MAINNET, 0, mode).derive(false, 0).address;
      const a1 = accountFromPhrase(phrase, MAINNET, 1, mode).derive(false, 0).address;
      const a2 = accountFromPhrase(phrase, MAINNET, 2, mode).derive(false, 0).address;
      expect(new Set([a0, a1, a2]).size).toBe(3);
      expect(accountFromPhrase(phrase, MAINNET, 1, mode).derive(false, 0).address).toBe(a1);
    }
    expect(() => accountFromPhrase(phrase, MAINNET, -1)).toThrow(/account/);
    expect(() => accountFromPhrase(phrase, MAINNET, 1.5)).toThrow(/account/);
  });

  it("numbers Ethereum accounts the MetaMask way: m/44'/60'/0'/0/n", () => {
    // Account 0 is unchanged from earlier versions; account 1 is MetaMask's "Account 2".
    const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(ethAccountFromPhrase(phrase).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(ethAccountFromPhrase(phrase, 1).address).toBe("0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0");
    expect(ethAccountFromPhrase(phrase, 1).address).not.toBe(ethAccountFromPhrase(phrase, 0).address);
  });
});

const phrase = vectors[0]!.phrase;
const other = vectors[1]!.phrase;
const base: Secrets = { phrase, derivation: "pearl", wallets: [{ name: "Wallet 1", phrase, derivation: "pearl" }] };

describe("the wallet list", () => {
  it("adds the next free account of a phrase, named after its first account", () => {
    let s = addAccount(base, 0);
    expect(walletsOf(s).map((w) => [w.name, w.account])).toEqual([
      ["Wallet 1", undefined],
      ["Wallet 1 · Account 2", 1],
    ]);
    s = addAccount(s, 1); // from the second account: still the next free number of that phrase
    expect(walletsOf(s)[2]).toMatchObject({ name: "Wallet 1 · Account 3", account: 2, derivation: "pearl" });
    s = removeWallet(s, 1);
    s = addAccount(s, 0); // the gap is filled first
    expect(walletsOf(s).map((w) => w.account ?? 0)).toEqual([0, 2, 1]);
    expect(() => addAccount({ ...base, wallets: [{ name: "K", key: "11".repeat(32) }] }, 0)).toThrow(/private key/);
    expect(() => addAccount(base, 5)).toThrow(/No such wallet/);
  });

  it("refuses the same account twice, but welcomes the same phrase under another account", () => {
    expect(() => addWallet(base, { name: "Again", phrase })).toThrow(/already in Keshi/);
    expect(() => addWallet(base, { name: "Again", phrase: phrase.toUpperCase() + " " })).toThrow(/already in Keshi/);
    const s = addWallet(base, { name: "Second", phrase, account: 1 });
    expect(walletsOf(s)).toHaveLength(2);
    expect(() => addWallet(s, { name: "Again", phrase, account: 1 })).toThrow(/Account 2 of this phrase is already in Keshi/);
  });

  it("selects the account along with the phrase, and derives from it", () => {
    const s = addWallet(addWallet(base, { name: "Second", phrase, account: 1 }), { name: "Other", phrase: other, derivation: "pearl" });
    const first = selectWallet(s, 0);
    const second = selectWallet(s, 1);
    expect(second.phrase).toBe(phrase);
    expect(second.account).toBe(1);
    expect(accountOf(second, MAINNET).derive(false, 0).address).toBe(accountFromPhrase(phrase, MAINNET, 1, "pearl").derive(false, 0).address);
    expect(accountOf(first, MAINNET).derive(false, 0).address).toBe(accountFromPhrase(phrase, MAINNET, 0, "pearl").derive(false, 0).address);
    expect(ethAccountOf(second).address).toBe(ethAccountFromPhrase(phrase, 1).address);
    expect(ethAccountOf(first).address).toBe(ethAccountFromPhrase(phrase).address);
    expect(selectWallet(s, 2).account).toBeUndefined();
  });

  it("removes a wallet but never the last one, and knows when the phrase stays", () => {
    const s = addWallet(addWallet(base, { name: "Second", phrase, account: 1 }), { name: "Other", phrase: other, derivation: "pearl" });
    expect(phraseKeptElsewhere(s, 1)).toBe(true); // account 2: the phrase stays with account 1
    expect(phraseKeptElsewhere(s, 2)).toBe(false); // the only entry of the other phrase
    const less = removeWallet(s, 2);
    expect(walletsOf(less).map((w) => w.name)).toEqual(["Wallet 1", "Second"]);
    expect(() => removeWallet(base, 0)).toThrow(/at least one wallet/);
    expect(() => removeWallet(s, 9)).toThrow(/No such wallet/);
  });
});

describe("finding the accounts a phrase already used", () => {
  const fake = (used: string[], fail = false) =>
    new Indexer(MAINNET, (async (url: string) => {
      if (fail) throw new Error("fetch failed");
      const address = String(url).split("/address/")[1]!.split("?")[0]!;
      return new Response(JSON.stringify({ balance: "0", txs: used.includes(address) ? 1 : 0 }));
    }) as typeof fetch);
  const first = (account: number, change = false, index = 0) => accountFromPhrase(phrase, MAINNET, account, "pearl").derive(change, index).address;

  it("walks accounts 1, 2, ... and stops at the first one never used", async () => {
    expect(await usedAccounts(phrase, "pearl", fake([]))).toEqual([]);
    expect(await usedAccounts(phrase, "pearl", fake([first(1)]))).toEqual([1]);
    expect(await usedAccounts(phrase, "pearl", fake([first(1, true), first(2, false, 2)]))).toEqual([1, 2]);
    // Account 3 was skipped by the wallet that made these: Keshi stops before it, like the official wallet would.
    expect(await usedAccounts(phrase, "pearl", fake([first(1), first(3)]))).toEqual([1]);
  });

  it("looks at a bounded number of accounts", async () => {
    const all = Array.from({ length: ACCOUNT_SCAN_LIMIT + 5 }, (_, i) => first(i + 1));
    const found = await usedAccounts(phrase, "pearl", fake(all));
    expect(found).toHaveLength(ACCOUNT_SCAN_LIMIT);
  }, 60_000);

  it("answers null, not 'none', when the network cannot be reached", async () => {
    expect(await usedAccounts(phrase, "pearl", fake([], true))).toBeNull();
  }, 30_000);
});

// Keys that come out shorter than 32 bytes at some level (about 1 in 256 at each
// level): the only place where the official wallet's DeriveNonStandard and
// standard BIP-32 can part ways. Every level, branch and index included, was
// derived with the official wallet's logic (see test/vectors/short-keys.json).
describe("short keys at every level of the path", () => {
  it("matches the official wallet on 1,500+ seeds whose purpose, coin, account or branch key is short", async () => {
    const { default: short } = await import("./vectors/short-keys.json");
    let branch = 0;
    for (const v of short) {
      const got = bytesToHex(accountNode(hexToBytes(v.seed), v.purpose, v.coin, v.account, "pearl").deriveChild(v.branch).deriveChild(v.index).privateKey!);
      expect(got).toBe(v.key);
      if (v.short[3] === "S") branch++;
    }
    expect(short.length).toBeGreaterThan(1500);
    expect(branch).toBeGreaterThan(400); // the branch key itself short: the branch/index levels are covered too
  });
});
