import { hexToBytes } from "@noble/hashes/utils.js";
import { accountFromKey, accountFromPhrase, type Account } from "./keys";
import { addressFromPrivateKey, ethAccountFromPhrase, type EthAccount } from "./eth";
import { MAINNET, TESTNET, type Network } from "./network";
import { derivationDiffers, type Derivation } from "./keys";
import { Indexer } from "./indexer";
import type { Secrets, WalletEntry } from "./vault";

// Several wallets in one vault. `Secrets.wallets` is the list; the wallet in
// use is copied into `phrase` / `key` so the rest of the code reads one place.

export function walletsOf(s: Secrets): WalletEntry[] {
  return s.wallets?.length ? s.wallets : [{ name: "Wallet 1", phrase: s.phrase, key: s.key, derivation: s.derivation }];
}

/** The same secrets with wallet number `index` selected. */
export function selectWallet(s: Secrets, index: number): Secrets {
  const wallets = walletsOf(s);
  const w = wallets[Math.min(Math.max(0, index), wallets.length - 1)]!;
  return { ...s, wallets, phrase: w.phrase ?? "", key: w.key, derivation: w.derivation };
}

export function addWallet(s: Secrets, entry: WalletEntry): Secrets {
  const wallets = walletsOf(s);
  if (wallets.some((w) => (entry.phrase && w.phrase === entry.phrase) || (entry.key && w.key === entry.key))) throw new Error("This wallet is already in Keshi");
  return { ...s, wallets: [...wallets, entry] };
}

export function accountOf(s: Secrets, net: Network): Account {
  return s.key ? accountFromKey(hexToBytes(s.key), net) : accountFromPhrase(s.phrase, net, 0, s.derivation ?? "standard");
}

export function ethAccountOf(s: Secrets): EthAccount {
  if (!s.key) return ethAccountFromPhrase(s.phrase);
  const privateKey = hexToBytes(s.key);
  return { address: addressFromPrivateKey(privateKey), privateKey };
}

/**
 * Which derivation a restored phrase should use. Almost always both give the
 * same addresses and the answer is "pearl" at once. For the rare phrase where
 * they differ, look at the network: the one that has already been used wins.
 */
/**
 * A new phrase comes from the device's secure random generator (128 or 256 bits of
 * chance), so no one else can hold the same one. As a visible proof, Keshi also asks
 * the Pearl network whether its first addresses were ever used: true (never used),
 * false (used: the phrase must be thrown away), null when the network cannot answer.
 */
export async function phraseIsUnused(phrase: string, indexer: Indexer = new Indexer(MAINNET)): Promise<boolean | null> {
  try {
    const account = accountFromPhrase(phrase, MAINNET, 0, "pearl");
    const seen = await Promise.all([account.derive(false, 0), account.derive(false, 1), account.derive(true, 0)].map((d) => indexer.address(d.address, false)));
    return !seen.some((a) => a.txCount > 0);
  } catch {
    return null;
  }
}

export async function resolveDerivation(phrase: string, indexerFor: (net: Network) => Indexer = (n) => new Indexer(n)): Promise<Derivation> {
  const differs = derivationDiffers(phrase);
  for (const net of [MAINNET, TESTNET]) {
    if (!differs.includes(net.coinType)) continue;
    const used = async (mode: Derivation) => {
      const account = accountFromPhrase(phrase, net, 0, mode);
      const seen = await Promise.all([account.derive(false, 0), account.derive(false, 1), account.derive(true, 0)].map((d) => indexerFor(net).address(d.address, false)));
      return seen.some((a) => a.txCount > 0);
    };
    try {
      if (await used("pearl")) return "pearl";
      if (await used("standard")) return "standard";
    } catch {
      // Mainnet must answer: guessing could show an empty wallet. The testnet is not worth blocking for.
      if (net.id === "mainnet") throw new Error("Keshi needs to check this recovery phrase on the Pearl network and could not reach it. Check your connection and try again.");
    }
  }
  return "pearl";
}
