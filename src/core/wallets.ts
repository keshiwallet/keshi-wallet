import { hexToBytes } from "@noble/hashes/utils.js";
import { accountFromKey, accountFromPhrase, cleanPhrase, type Account } from "./keys";
import { addressFromPrivateKey, ethAccountFromPhrase, type EthAccount } from "./eth";
import { MAINNET, TESTNET, type Network } from "./network";
import { derivationDiffers, type Derivation } from "./keys";
import { Indexer } from "./indexer";
import type { Secrets, WalletEntry } from "./vault";

// Several wallets in one vault. `Secrets.wallets` is the list; the wallet in
// use is copied into `phrase` / `key` / `account` so the rest of the code reads
// one place.
//
// A recovery phrase holds many accounts (m/86'/coin'/account'), the way the
// official Pearl wallet numbers them. Each account is its own entry in the
// list, with its own addresses, history and Ethereum address. Entries that
// share a phrase differ by their account number.

export function walletsOf(s: Secrets): WalletEntry[] {
  return s.wallets?.length ? s.wallets : [{ name: "Wallet 1", phrase: s.phrase, key: s.key, derivation: s.derivation, account: s.account }];
}

/** The account number of an entry: absent means the first account. */
export const accountNumber = (w: { account?: number }): number => w.account ?? 0;

const samePhrase = (a: string | undefined, b: string | undefined) => !!a && !!b && cleanPhrase(a) === cleanPhrase(b);

/** The same secrets with wallet number `index` selected. */
export function selectWallet(s: Secrets, index: number): Secrets {
  const wallets = walletsOf(s);
  const w = wallets[Math.min(Math.max(0, index), wallets.length - 1)]!;
  return { ...s, wallets, phrase: w.phrase ?? "", key: w.key, derivation: w.derivation, account: w.account };
}

export function addWallet(s: Secrets, entry: WalletEntry): Secrets {
  const wallets = walletsOf(s);
  const twin = wallets.some((w) => (entry.phrase && samePhrase(w.phrase, entry.phrase) && accountNumber(w) === accountNumber(entry)) || (entry.key && w.key === entry.key));
  if (twin) throw new Error(accountNumber(entry) > 0 ? `Account ${accountNumber(entry) + 1} of this phrase is already in Keshi` : "This wallet is already in Keshi");
  return { ...s, wallets: [...wallets, entry] };
}

/**
 * Add the next account of the phrase of wallet `index`: the smallest account
 * number of that phrase not yet in the list. The new entry takes the derivation
 * of the wallet it comes from, so all its accounts agree with the official wallet.
 */
export function addAccount(s: Secrets, index: number, name?: string): Secrets {
  const base = walletsOf(s)[index]!;
  const account = nextAccountNumber(s, index);
  const entry: WalletEntry = { name: name?.trim() || accountName(s, index), phrase: base.phrase, derivation: base.derivation, account };
  return addWallet(s, entry);
}

/** The name `addAccount` would give the next account of wallet `index`: after the first account of its phrase. */
export function accountName(s: Secrets, index: number): string {
  const wallets = walletsOf(s);
  return `${baseName(wallets[index]!, wallets)} · Account ${nextAccountNumber(s, index) + 1}`;
}

/** The account number `addAccount` would give the phrase of wallet `index`. */
export function nextAccountNumber(s: Secrets, index: number): number {
  const wallets = walletsOf(s);
  const base = wallets[index];
  if (!base) throw new Error("No such wallet");
  if (!base.phrase) throw new Error("This wallet was imported from a private key: it has a single address and no other account.");
  const taken = new Set(wallets.filter((w) => samePhrase(w.phrase, base.phrase)).map(accountNumber));
  let account = 0;
  while (taken.has(account)) account++;
  return account;
}

/** The name the phrase of wallet `index` goes by: the name of its first account, or of the wallet itself. */
export function phraseName(s: Secrets, index: number): string {
  const wallets = walletsOf(s);
  return baseName(wallets[index]!, wallets);
}

/** The name of the first account of a phrase, which other accounts of the same phrase are named after. */
function baseName(w: WalletEntry, wallets: WalletEntry[]): string {
  const first = wallets.find((x) => samePhrase(x.phrase, w.phrase) && accountNumber(x) === 0);
  return (first ?? w).name.replace(/ · Account \d+$/, "");
}

/**
 * Forget wallet `index`. The last wallet cannot be removed. The caller must
 * select another wallet afterwards: the indexes after `index` move down by one.
 */
export function removeWallet(s: Secrets, index: number): Secrets {
  const wallets = walletsOf(s);
  if (!wallets[index]) throw new Error("No such wallet");
  if (wallets.length === 1) throw new Error("Keshi keeps at least one wallet. Add another wallet before removing this one.");
  return { ...s, wallets: wallets.filter((_, i) => i !== index) };
}

/** True when another entry keeps the same recovery phrase, so removing this one does not forget the phrase. */
export function phraseKeptElsewhere(s: Secrets, index: number): boolean {
  const wallets = walletsOf(s);
  const w = wallets[index];
  return !!w?.phrase && wallets.some((x, i) => i !== index && samePhrase(x.phrase, w.phrase));
}

export function accountOf(s: Secrets, net: Network): Account {
  return s.key ? accountFromKey(hexToBytes(s.key), net) : accountFromPhrase(s.phrase, net, accountNumber(s), s.derivation ?? "standard");
}

export function ethAccountOf(s: Secrets): EthAccount {
  if (!s.key) return ethAccountFromPhrase(s.phrase, accountNumber(s));
  const privateKey = hexToBytes(s.key);
  return { address: addressFromPrivateKey(privateKey), privateKey };
}

/** Whether any of the first addresses of an account were ever used on the network. */
async function accountUsed(phrase: string, net: Network, account: number, mode: Derivation, indexer: Indexer): Promise<boolean> {
  const acct = accountFromPhrase(phrase, net, account, mode);
  const first = [acct.derive(false, 0), acct.derive(false, 1), acct.derive(false, 2), acct.derive(true, 0)];
  const seen = await Promise.all(first.map((d) => indexer.address(d.address, false)));
  return seen.some((a) => a.txCount > 0);
}

/** How many accounts past the first one `usedAccounts` looks at before giving up. */
export const ACCOUNT_SCAN_LIMIT = 20;

/**
 * The account numbers, after the first one, that this phrase has already used on
 * the Pearl network: 1, 2, ... until an account that was never used, as wallets
 * create accounts in order. Returns null when the network cannot be reached, so
 * that "nothing found" is never confused with "could not look".
 */
export async function usedAccounts(phrase: string, mode: Derivation, indexer: Indexer = new Indexer(MAINNET)): Promise<number[] | null> {
  const found: number[] = [];
  try {
    for (let account = 1; account <= ACCOUNT_SCAN_LIMIT; account++) {
      if (!(await accountUsed(phrase, indexer.net, account, mode, indexer))) break;
      found.push(account);
    }
    return found;
  } catch {
    return null;
  }
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
