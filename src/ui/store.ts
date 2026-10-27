import * as core from "../core";
import { hexToBytes } from "@noble/hashes/utils.js";
import { local, session, getSettings, setDataKey, newDataKey, label, type Settings, type Site } from "../ext/platform";

// Everything the screens need from the wallet engine, in one place.

export interface Unlocked {
  secrets: core.Secrets;
  expires: number;
}

export async function hasWallet(): Promise<boolean> {
  return !!(await local.get("vault"));
}

/**
 * Every entry a phrase brings in: its first account, then the accounts it has
 * already used on the Pearl network when `restoring` (an account other wallets
 * created and paid to, which would otherwise stay invisible). `found` lists the
 * numbers of those accounts; null when the network could not be asked.
 */
export async function phraseEntries(name: string, phrase: string, restoring: boolean): Promise<{ entries: core.WalletEntry[]; found: number[] | null }> {
  const clean = core.cleanPhrase(phrase);
  const derivation = await core.resolveDerivation(clean);
  const entries: core.WalletEntry[] = [{ name, phrase: clean, derivation }];
  const found = restoring ? await core.usedAccounts(clean, derivation) : [];
  for (const account of found ?? []) entries.push({ name: `${name} · Account ${account + 1}`, phrase: clean, derivation, account });
  return { entries, found };
}

export async function createWallet(phrase: string, password: string, restoring = false): Promise<core.Secrets> {
  if (await hasWallet()) throw new Error("A wallet already exists on this device");
  const { entries } = await phraseEntries("Wallet 1", phrase, restoring);
  const first = entries[0]!;
  const secrets: core.Secrets = { phrase: first.phrase!, derivation: first.derivation, wallets: entries, dataKey: newDataKey() };
  await local.set("vault", await core.lockVault(secrets, password));
  await remember(secrets);
  return secrets;
}

export const CODE_NEEDED = "Enter the 6-digit code from your authenticator app";

interface Tries {
  n: number;
  until: number;
}

/** Wrong passwords slow the next attempt down: 30 seconds after five misses, doubling each time, up to an hour. */
async function failedAttempt(): Promise<void> {
  const t = (await local.get<Tries>("tries")) ?? { n: 0, until: 0 };
  const n = t.n + 1;
  const wait = n >= 5 ? Math.min(3_600_000, 30_000 * 2 ** (n - 5)) : 0;
  await local.set("tries", { n, until: Date.now() + wait });
}

/** Refuses while a wrong-password delay is running. */
async function notLockedOut(): Promise<void> {
  const tries = await local.get<Tries>("tries");
  if (tries && tries.until > Date.now()) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((tries.until - Date.now()) / 1000)} seconds.`);
}

/**
 * Opens the vault to prove the password, for screens that ask for it again while
 * the wallet is unlocked (show the recovery phrase, change a setting). Same
 * wrong-password delay as unlocking: these screens must not allow guessing either.
 */
async function provePassword(file: core.VaultFile, password: string): Promise<core.Secrets> {
  await notLockedOut();
  try {
    return await core.openVault(file, password);
  } catch (e) {
    await failedAttempt();
    throw e;
  }
}

/** The vault's content, after the password (and the authenticator code, when set) are checked, with the wrong-password delay. */
export async function revealSecrets(password: string, code = ""): Promise<core.Secrets> {
  const file = await local.get<core.VaultFile>("vault");
  if (!file) throw new Error("No wallet on this device");
  const secrets = await provePassword(file, password);
  if (secrets.totp) {
    if (!code) throw new Error(CODE_NEEDED);
    if (!core.verifyTotp(secrets.totp, code)) {
      await failedAttempt();
      throw new Error("Wrong code");
    }
  }
  await local.remove("tries");
  return secrets;
}

export async function unlock(password: string, code = ""): Promise<core.Secrets> {
  const file = await local.get<core.VaultFile>("vault");
  if (!file) throw new Error("No wallet on this device");
  const tries = await local.get<Tries>("tries");
  if (tries && tries.until > Date.now()) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((tries.until - Date.now()) / 1000)} seconds.`);
  let secrets: core.Secrets;
  try {
    secrets = await core.openVault(file, password);
  } catch (e) {
    await failedAttempt();
    throw e;
  }
  if (secrets.totp) {
    if (!code) throw new Error(CODE_NEEDED);
    if (!core.verifyTotp(secrets.totp, code)) {
      await failedAttempt();
      throw new Error("Wrong code");
    }
  }
  await local.remove("tries");
  // Older vaults: add the data key and move to the stronger password stretching.
  if (!secrets.dataKey || file.n < core.VAULT_N) {
    secrets = { ...secrets, dataKey: secrets.dataKey ?? newDataKey() };
    await local.set("vault", await core.lockVault(secrets, password));
  }
  setDataKey(secrets.dataKey);
  secrets = await withNames(secrets);
  await remember(secrets);
  return secrets;
}

/* Wallet names the user chose. Kept encrypted next to the vault, so that a
   rename needs no password; they are also written into the vault the next
   time it is saved. The index is stable except when a wallet is removed, and
   removeWallet rewrites this list then. */
const NAMES = "walletNames";

async function withNames(s: core.Secrets): Promise<core.Secrets> {
  const names = (await local.get<Record<string, string>>(NAMES).catch(() => undefined)) ?? {};
  if (!Object.keys(names).length) return s;
  return { ...s, wallets: core.walletsOf(s).map((w, i) => (names[i] ? { ...w, name: names[i]! } : w)) };
}

/** Give wallet number `index` a new name. */
export async function renameWallet(secrets: core.Secrets, index: number, raw: string): Promise<core.Secrets> {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
  if (!name) throw new Error("Enter a name");
  if (index < 0 || index >= core.walletsOf(secrets).length) throw new Error("Unknown wallet");
  const names = (await local.get<Record<string, string>>(NAMES)) ?? {};
  names[index] = name;
  await local.set(NAMES, names);
  const next = await withNames(secrets);
  await remember(next);
  return next;
}

/**
 * Change what the vault holds. The change is applied to the vault as it is
 * stored now, not to a copy a window may have held for a while: a stale window
 * can therefore never drop a wallet, the two-step setting or an exchange key
 * that another window added. Returns the vault's new content.
 */
export async function saveSecrets(change: (stored: core.Secrets) => core.Secrets, password: string): Promise<core.Secrets> {
  const file = await local.get<core.VaultFile>("vault");
  if (!file) throw new Error("No wallet on this device");
  const stored = await provePassword(file, password); // proves the password before re-encrypting
  await local.remove("tries");
  const next = await withNames(change(stored));
  if (core.walletsOf(next).length < core.walletsOf(stored).length) throw new Error("This change would remove a wallet. Nothing was saved.");
  const kept: core.Secrets = { ...next, dataKey: stored.dataKey ?? next.dataKey };
  await local.set("vault", await core.lockVault(kept, password));
  await remember(kept);
  return kept;
}

/** Slide the auto-lock forward while the wallet is being used. */
let touched = 0;
export async function touch(): Promise<void> {
  if (Date.now() - touched < 30_000) return;
  touched = Date.now();
  const u = await session.get<Unlocked>("unlocked");
  if (u && u.expires > Date.now()) await remember(u.secrets);
}

export async function remember(secrets: core.Secrets): Promise<void> {
  setDataKey(secrets.dataKey);
  const s = await getSettings();
  await session.set("unlocked", { secrets, expires: Date.now() + s.autoLockMinutes * 60_000 } satisfies Unlocked);
}

export async function resume(): Promise<core.Secrets | null> {
  const u = await session.get<Unlocked>("unlocked");
  if (!u || u.expires < Date.now()) {
    await lock();
    return null;
  }
  await remember(u.secrets);
  return u.secrets;
}

/** Whether the session is still open, without extending it. */
export async function stillUnlocked(): Promise<boolean> {
  const u = await session.get<Unlocked>("unlocked");
  return !!u && u.expires > Date.now();
}

export async function lock(): Promise<void> {
  setDataKey(null);
  await session.remove("unlocked");
}

/** Cached data is kept per wallet and per network. */
const snapKey = (secrets: core.Secrets, net: core.Network) => `snap:${net.id}:${label(core.accountOf(secrets, net).derive(false, 0).address)}`;

export async function loadCached(secrets: core.Secrets, net: core.Network): Promise<core.Snapshot | undefined> {
  return local.get<core.Snapshot>(snapKey(secrets, net));
}

/** Thrown when the indexer says it is behind the chain: its figures would be incomplete, not wrong, so the last snapshot stays on screen. */
export class IndexerBehind extends Error {}

export async function refresh(secrets: core.Secrets, net: core.Network): Promise<core.Snapshot> {
  const account = core.accountOf(secrets, net);
  const pq = await quantumAddress(secrets, net);
  const indexer = new core.Indexer(net);
  // An indexer that says it is still catching up would show an incomplete wallet: keep the last complete picture instead.
  const status = await indexer.status().catch(() => null);
  if (status && !status.inSync) throw new IndexerBehind("The Pearl indexer is still catching up with the network. Showing the last figures Keshi read; try again in a few minutes.");
  const snap = await core.scan(account, indexer, pq ? [{ address: pq.address, change: false, index: 0, tapRoot: pq.merkleRoot }] : []);
  // Mark coins that carry tokens or inscriptions so they are never spent as money.
  const mine = (await local.get<string[]>("inscriptions:" + net.id)) ?? [];
  snap.protectedOutpoints = [...mine];
  snap.protectionChecked = net.id !== "mainnet";
  if (net.id === "mainnet") {
    try {
      const idx = new core.TokenIndex();
      const holders = [...new Set(snap.utxos.map((u) => u.address))];
      const lists = await Promise.all(holders.map((a) => idx.protectedOutpoints(a)));
      snap.protectedOutpoints.push(...lists.flat());
      snap.protectionChecked = true;
    } catch {
      // The index did not answer. Keep what it said last time about the coins that
      // are still here, rather than starting from nothing: a coin known to carry
      // a token stays protected. The fallback rule in core.spendable still
      // protects small coins, and the user is told the check is incomplete.
      const previous = await loadCached(secrets, net).catch(() => undefined);
      const still = new Set(snap.utxos.map((u) => `${u.txid}:${u.vout}`));
      for (const o of previous?.protectedOutpoints ?? []) if (still.has(o) && !snap.protectedOutpoints.includes(o)) snap.protectedOutpoints.push(o);
    }
  }
  await local.set(snapKey(secrets, net), snap);
  const used = snap.addresses.filter((a) => a.used).map((a) => a.address);
  const watched = [...new Set([...used, snap.receive.address, account.derive(false, 0).address])];
  // Baseline for "PRL received" notifications: total ever received right now.
  let total = 0n;
  try {
    const idx = new core.Indexer(net);
    for (const a of watched.slice(0, 25)) {
      const info = await idx.address(a, false);
      total += info.received + (info.unconfirmed > 0n ? info.unconfirmed : 0n);
    }
    await local.set("watch", { network: net.id, addresses: watched, received: total });
  } catch {
    /* notifications simply start on the next refresh */
  }
  return snap;
}

/* ------------------------------------------------ quantum-ready address */

export interface StoredPq {
  address: string;
  leafScript: string;
  merkleRoot: string;
  controlBlock: string;
  xmssPublicKey: string;
}
const pqKey = (secrets: core.Secrets, net: core.Network) => `pq:${net.id}:${label(core.accountOf(secrets, net).derive(false, 0).address)}`;

/** The wallet's quantum-ready address, if the user has created it. */
export async function quantumAddress(secrets: core.Secrets, net: core.Network): Promise<StoredPq | undefined> {
  if (secrets.key) return undefined; // a wallet made of one imported key has no seed to derive from
  return local.get<StoredPq>(pqKey(secrets, net));
}

/**
 * Create the wallet's quantum-ready address: the first address's key, plus a
 * post-quantum key derived from the same recovery phrase. Takes a second or two.
 */
export async function createQuantumAddress(secrets: core.Secrets, net: core.Network): Promise<StoredPq> {
  if (secrets.key) throw new Error("This wallet was imported from a private key. Quantum-ready addresses need a recovery phrase.");
  const existing = await quantumAddress(secrets, net);
  if (existing) return existing;
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const internal = core.accountOf(secrets, net).derive(false, 0).pubkey;
  const pq = core.derivePqAddress(secrets.phrase, internal, net, false, 0, secrets.derivation ?? "standard", core.accountNumber(secrets));
  const stored: StoredPq = { address: pq.address, leafScript: hex(pq.leafScript), merkleRoot: hex(pq.merkleRoot), controlBlock: hex(pq.controlBlock), xmssPublicKey: hex(pq.xmssPublicKey) };
  await local.set(pqKey(secrets, net), stored);
  return stored;
}

export async function pay(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, p: core.Plan): Promise<string> {
  const account = core.accountOf(secrets, net);
  const { hex, txid } = core.sign(p, snap, account, net);
  const answered = await new core.Indexer(net).broadcast(hex);
  // The transaction ID is worked out here; a server naming another one did not send this payment.
  if (answered.toLowerCase() !== txid) throw new Error("The network answered with a different transaction. Check Activity before sending again.");
  await rememberSent(net, txid, p).catch(() => {});
  return txid;
}

/** What this device sent: who was paid and how much, as the user approved it. Kept encrypted, the last 100. */
export interface SentRecord {
  txid: string;
  to: string;
  amount: string;
  serviceAddress?: string;
  serviceFee: string;
  /** The coins this device spent ("txid:vout=value") and the change it kept: a speed-up is rebuilt from these, never from the network's copy. */
  inputs?: string[];
  change?: string;
  changeAddress?: string;
}

async function rememberSent(net: core.Network, txid: string, p: core.Plan): Promise<void> {
  const key = "sent:" + net.id;
  const list = (await local.get<SentRecord[]>(key)) ?? [];
  const rec: SentRecord = {
    txid,
    to: p.to,
    amount: p.amount.toString(),
    serviceAddress: p.serviceAddress,
    serviceFee: p.serviceFee.toString(),
    inputs: p.inputs.map((u) => `${u.txid}:${u.vout}=${u.value}`),
    change: p.change.toString(),
    changeAddress: p.changeAddress,
  };
  await local.set(key, [rec, ...list.filter((r) => r.txid !== txid)].slice(0, 100));
}

export async function sentRecord(net: core.Network, txid: string): Promise<SentRecord | undefined> {
  return ((await local.get<SentRecord[]>("sent:" + net.id)) ?? []).find((r) => r.txid === txid);
}

export interface PendingReveal {
  /** The payment that funds the mint, kept so it can be sent again if the first try was lost. */
  commitHex?: string;
  hex: string;
  txid: string;
  label: string;
}

export interface MintQuote {
  plan: core.Plan;
  commit: core.Commit;
  revealFee: bigint;
  count: number;
  label: string;
}

/** Work out everything a mint will cost before the user confirms. */
export async function quoteMint(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, token: core.Token, count: number): Promise<MintQuote> {
  if (net.id !== "mainnet") throw new Error("Tokens only exist on Pearl mainnet");
  const account = core.accountOf(secrets, net);
  const me = account.derive(false, 0);
  if (snap.protectionChecked === false) throw new Error("The token index is unreachable, so Keshi cannot check which coins carry tokens. Try again in a moment.");
  const body = core.mintBody(token.ticker, core.wholeAmount(token));
  const commit = core.commitFor(me.pubkey, Array.from({ length: count }, () => body), net);
  const rate = await new core.Indexer(net).feeRate(3);
  const revealFee = core.revealFee(commit, rate);
  const plan = core.plan(snap, net, commit.address, core.INSCRIPTION_VALUE + revealFee, rate, core.serviceFor(net, "mint"));
  return { plan, commit, revealFee, count, label: `${count} mint${count === 1 ? "" : "s"} of ${token.name}` };
}

/** Send the two transactions of a mint. The token lands on the wallet's fixed first address. */
export async function mint(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, q: MintQuote): Promise<string> {
  const account = core.accountOf(secrets, net);
  const me = account.derive(false, 0);
  const first = core.sign(q.plan, snap, account, net);
  const reveal = core.buildReveal({ commitTxid: first.txid, commitVout: 0, commit: q.commit, amount: q.plan.amount, owner: me.address, privateKey: account.privateKey(false, 0), net });
  const indexer = new core.Indexer(net);
  if (await local.get<PendingReveal>("pendingReveal:" + net.id)) throw new Error("An earlier mint is still waiting to be published. Finish it first.");
  // Saved before anything is sent, so step two can always be retried.
  await local.set("pendingReveal:" + net.id, { commitHex: first.hex, hex: reveal.hex, txid: reveal.txid, label: q.label } satisfies PendingReveal);
  if ((await local.get<PendingReveal>("pendingReveal:" + net.id))?.txid !== reveal.txid) throw new Error("Could not save the mint on this device. Nothing was sent.");
  try {
    await indexer.broadcast(first.hex);
  } catch (e) {
    // Only a clear refusal by the network means the payment did not go out.
    // After a lost connection it may have: keep step two so it can be published.
    if (e instanceof core.Rejected) await local.remove("pendingReveal:" + net.id);
    else throw new Error("The connection dropped while sending. Check Activity in a minute: if the payment appears, open Tokens and tap Publish.");
    throw e;
  }
  return publishPending(net, false);
}

/** Step two of a mint. Safe to call again after a failure. */
export async function publishPending(net: core.Network, resendPayment = true): Promise<string> {
  const p = await local.get<PendingReveal>("pendingReveal:" + net.id);
  if (!p) throw new Error("Nothing is waiting to be published");
  const known = (e: unknown) => /already (in|have|known|exists|spent)|txn-already|already-in/i.test(e instanceof Error ? e.message : String(e));
  // If the payment itself never reached the network, send it again first.
  if (p.commitHex && resendPayment) await new core.Indexer(net).broadcast(p.commitHex).catch(() => {});
  try {
    await new core.Indexer(net).broadcast(p.hex);
  } catch (e) {
    if (!known(e)) throw new Error("The payment was sent but the mint is not published yet. Open Tokens and tap Publish to finish it.");
  }
  const mine = (await local.get<string[]>("inscriptions:" + net.id)) ?? [];
  await local.set("inscriptions:" + net.id, [...mine, `${p.txid}:0`]);
  await local.remove("pendingReveal:" + net.id);
  return p.txid;
}

/**
 * Give up on a mint that can no longer be published (its payment never went
 * out, or the coins were spent elsewhere). If the payment did go out, the
 * small amount it set aside for the mint stays unspent on the chain.
 */
export const discardPending = (net: core.Network) => local.remove("pendingReveal:" + net.id);

export const pendingReveal = (net: core.Network) => local.get<PendingReveal>("pendingReveal:" + net.id);

/* ------------------------------------------------ sending tokens and inscriptions */

/** Where each of the wallet's addresses holds a token, largest first. Only addresses Keshi can sign for with an ordinary key. */
export async function tokenHolders(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, ticker: string): Promise<{ address: string; change: boolean; index: number; amount: bigint }[]> {
  if (net.id !== "mainnet") return [];
  const first = core.accountOf(secrets, net).derive(false, 0);
  const known = new Map(snap.addresses.filter((a) => !a.tapRoot).map((a) => [a.address, a]));
  if (!known.has(first.address)) known.set(first.address, { address: first.address, change: false, index: 0, used: true });
  const list = [...known.values()].filter((a) => a.used || a.address === first.address).slice(0, 30);
  const idx = new core.TokenIndex();
  // Every address must answer: an address read as "0" by mistake would hide tokens from the transfer, or pick the wrong coins.
  const amounts = await Promise.all(list.map((a) => idx.balances(a.address).then((b) => BigInt(b[ticker.toLowerCase()] ?? "0"))));
  return list.map((a, i) => ({ address: a.address, change: a.change, index: a.index, amount: amounts[i]! })).filter((h) => h.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : -1));
}

export interface TransferQuote {
  ticker: string;
  name: string;
  amount: bigint;
  to: string;
  holder: { address: string; change: boolean; index: number };
  plan: core.Plan;
  commit: core.Commit;
  revealFee: bigint;
  /** Estimate of the third transaction, the one that hands the coin over. */
  deliverFee: bigint;
  rate: number;
}

/**
 * A token transfer in progress, kept as ONE record from before anything is
 * sent until the tokens are handed over, so that every step can be retried and
 * the transfer is never forgotten while tokens may be sitting in its coin.
 */
export interface PendingTransfer {
  ticker: string;
  name: string;
  amount: string;
  to: string;
  /** The address that holds the tokens and receives the transfer note. */
  holder: string;
  revealTxid: string;
  commitHex: string;
  revealHex: string;
  /** True once the note is on the network (the reveal was accepted or already known). */
  published: boolean;
  /** Fee rate the user approved, in grains per vbyte: the hand-over never pays more than twice that. */
  rate: number;
  at: number;
  /** Set while a window is handing the coin over, so that a second window does not do it again. */
  delivering?: number;
}

export const pendingTransfer = (net: core.Network) => local.get<PendingTransfer>("pendingTransfer:" + net.id);
const saveTransfer = async (net: core.Network, t: PendingTransfer) => {
  await local.set("pendingTransfer:" + net.id, t);
  if ((await pendingTransfer(net))?.revealTxid !== t.revealTxid) throw new Error("Could not save the transfer on this device. Nothing was sent.");
};

/**
 * Forget a transfer. Only allowed when it is certain no token can be in its coin:
 * the note never reached the network, or the index refused it.
 */
export async function discardTransfer(net: core.Network): Promise<void> {
  const t = await pendingTransfer(net);
  if (!t) return;
  const onNetwork = new Error("The transfer note is on the network: the tokens may already be set aside in its coin. Finish sending, or keep them instead.");
  if (t.published) {
    if ((await transferState(net)) !== "refused") throw onNetwork;
    await local.remove("pendingTransfer:" + net.id);
    return;
  }
  // Not marked as published, but an earlier answer may have been lost: ask the network before forgetting anything.
  const idx = new core.Indexer(net);
  const known = (e: unknown) => /already (in|have|known|exists|spent)|txn-already|already-in/i.test(e instanceof Error ? e.message : String(e));
  const unclear = new Error("Could not get a clear answer from the Pearl network. Nothing was discarded; try again in a moment.");
  try {
    await idx.broadcast(t.revealHex);
    await publishTransfer(net, false);
    throw onNetwork;
  } catch (e) {
    if (e === onNetwork) throw e;
    if (known(e)) {
      await publishTransfer(net, false);
      throw onNetwork;
    }
    if (!(e instanceof core.Rejected)) throw unclear;
  }
  // The note was refused. If its payment can still go out, the note could follow it: keep the transfer.
  try {
    await idx.broadcast(t.commitHex);
    throw new Error("The payment for this transfer just went out. Tap Publish to finish the transfer.");
  } catch (e) {
    if (e instanceof Error && /just went out/.test(e.message)) throw e;
    if (!known(e) && !(e instanceof core.Rejected)) throw unclear;
  }
  // Refused, and its payment is either already settled or refused too: this note can never appear. Safe to forget.
  await local.remove("pendingTransfer:" + net.id);
}

/**
 * Work out a token transfer before the user confirms. On Pearl it takes two
 * steps: a "transfer" note is inscribed on the address that holds the tokens,
 * then the coin carrying that note is sent to the recipient.
 */
export async function quoteTokenTransfer(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, ticker: string, name: string, amount: bigint, to: string): Promise<TransferQuote> {
  if (net.id !== "mainnet") throw new Error("Tokens only exist on Pearl mainnet");
  if (!core.isValidAddress(to.trim(), net)) throw new Error(`That is not a valid ${net.hrp}1… address`);
  if (snap.addresses.some((a) => a.address === to.trim())) throw new Error("This is one of your own addresses in Keshi");
  if (amount <= 0n) throw new Error("Enter a whole number of tokens");
  if (snap.protectionChecked === false) throw new Error("The token index is unreachable, so Keshi cannot check which coins carry tokens. Try again in a moment.");
  if (await pendingReveal(net)) throw new Error("A mint is still waiting to be published. Finish it first in Tokens.");
  if (await pendingTransfer(net)) throw new Error("Another token transfer is still on its way. Finish it first in Tokens.");
  const holders = await tokenHolders(secrets, net, snap, ticker);
  const holder = holders.find((h) => h.amount >= amount);
  if (!holder) {
    const most = holders[0]?.amount ?? 0n;
    throw new Error(most > 0n ? `At most ${most.toLocaleString("en-US")} ${name} can be sent in one go: that is what your largest address holds.` : `You hold no ${name}`);
  }
  const account = core.accountOf(secrets, net);
  const key = account.derive(holder.change, holder.index);
  if (key.address !== holder.address) throw new Error("Keshi cannot sign for the address that holds these tokens");
  const commit = core.commitFor(key.pubkey, [core.transferBody(ticker, amount.toString())], net);
  const rate = await new core.Indexer(net).feeRate(3);
  const revealFee = core.revealFee(commit, rate);
  const plan = core.plan(snap, net, commit.address, core.INSCRIPTION_VALUE + revealFee, rate);
  const deliverFee = BigInt(Math.ceil(10.5 + 57.5 * 2 + 43 * 2)) * BigInt(Math.max(1, Math.ceil(rate)));
  return { ticker: ticker.toLowerCase(), name, amount, to: to.trim(), holder, plan, commit, revealFee, deliverFee, rate };
}

/** Steps one and two of a token transfer: the note is written and published. The coin is handed over by `deliverTransfer`. */
export async function startTokenTransfer(secrets: core.Secrets, net: core.Network, snap: core.Snapshot, q: TransferQuote): Promise<void> {
  // Checked again here: another window may have started a transfer since the quote.
  if (await pendingTransfer(net)) throw new Error("Another token transfer is still on its way. Finish it first in Tokens.");
  if (await pendingReveal(net)) throw new Error("A mint is still waiting to be published. Finish it first in Tokens.");
  const account = core.accountOf(secrets, net);
  const first = core.sign(q.plan, snap, account, net);
  const reveal = core.buildReveal({ commitTxid: first.txid, commitVout: 0, commit: q.commit, amount: q.plan.amount, owner: q.holder.address, privateKey: account.privateKey(q.holder.change, q.holder.index), net });
  // One record, saved before anything is sent.
  await saveTransfer(net, { ticker: q.ticker, name: q.name, amount: q.amount.toString(), to: q.to, holder: q.holder.address, revealTxid: reveal.txid, commitHex: first.hex, revealHex: reveal.hex, published: false, rate: q.rate, at: Date.now() });
  try {
    await new core.Indexer(net).broadcast(first.hex);
  } catch (e) {
    if (e instanceof core.Rejected) {
      await local.remove("pendingTransfer:" + net.id);
      throw e;
    }
    throw new Error("The connection dropped while sending. Open Tokens in a minute and tap Publish to finish.");
  }
  await publishTransfer(net, false);
}

/** Put the transfer note on the network. Safe to call again after a failure. */
export async function publishTransfer(net: core.Network, resendPayment = true, again = false): Promise<void> {
  const t = await pendingTransfer(net);
  if (!t) throw new Error("No token transfer is waiting");
  if (t.published && !again) return;
  const known = (e: unknown) => /already (in|have|known|exists|spent)|txn-already|already-in/i.test(e instanceof Error ? e.message : String(e));
  if (resendPayment) await new core.Indexer(net).broadcast(t.commitHex).catch(() => {});
  try {
    await new core.Indexer(net).broadcast(t.revealHex);
  } catch (e) {
    if (!known(e)) throw new Error("The payment was sent but the transfer note is not published yet. Open Tokens and tap Publish to finish.");
  }
  // From here the note's coin may carry tokens: it is never spent as money.
  const mine = (await local.get<string[]>("inscriptions:" + net.id)) ?? [];
  if (!mine.includes(`${t.revealTxid}:0`)) await local.set("inscriptions:" + net.id, [...mine, `${t.revealTxid}:0`]);
  await saveTransfer(net, { ...t, published: true });
}

/**
 * Where the transfer stands. "delivered": its coin has already left (a delivery
 * whose answer was lost); the record is then cleared. "lost": the network has
 * no trace of the note, which can be published again.
 */
export async function transferState(net: core.Network): Promise<"unpublished" | "ready" | "refused" | "unknown" | "delivered" | "lost"> {
  const t = await pendingTransfer(net);
  if (!t) return "unknown";
  if (!t.published) return "unpublished";
  const s = await new core.TokenIndex().transferState(t.holder, `${t.revealTxid}:0`);
  if (s !== "unknown") return s;
  // A note just published is simply not indexed yet: only look further once it has had time to confirm.
  if (Date.now() - t.at < 3 * 60_000) return "unknown";
  try {
    const tx = await new core.Indexer(net).tx(t.revealTxid);
    if ((tx.vout.find((o) => o.n === 0) as { spent?: boolean } | undefined)?.spent) {
      await local.remove("pendingTransfer:" + net.id);
      return "delivered";
    }
    return "unknown";
  } catch (e) {
    return /not found/i.test(e instanceof Error ? e.message : String(e)) ? "lost" : "unknown";
  }
}
export const transferReady = async (net: core.Network): Promise<boolean> => (await transferState(net)) === "ready";

let delivering = false;
/**
 * Step three: send the coin that carries the transfer note to the recipient,
 * or, with `keep`, back to the address that holds the tokens (which cancels the
 * transfer: the tokens become available again there). The tokens travel with the coin.
 */
export async function deliverTransfer(secrets: core.Secrets, net: core.Network, keep = false): Promise<string> {
  if (delivering) throw new Error("Already sending. One moment.");
  delivering = true;
  try {
    const t = await pendingTransfer(net);
    if (!t) throw new Error("No token transfer is waiting");
    if (!t.published) throw new Error("The transfer note is not published yet. Tap Publish first.");
    if (t.delivering && Date.now() - t.delivering < 3 * 60_000) throw new Error("This transfer is being sent from another window. Check again in a few minutes.");
    if ((await new core.TokenIndex().transferState(t.holder, `${t.revealTxid}:0`)) !== "ready") throw new Error("The token index has not accepted the transfer note yet. It usually takes one block; try again in a few minutes.");
    // A fresh look at the wallet: the coins spent by the first step must not be used again.
    const snap = await refresh(secrets, net);
    if (snap.protectionChecked === false) throw new Error("The token index is unreachable, so Keshi cannot check which coins carry tokens. Nothing was sent; try again in a moment.");
    if (!snap.addresses.some((a) => a.address === t.holder)) throw new Error("This transfer belongs to another of your wallets. Switch to it to finish.");
    const coin = snap.utxos.find((u) => u.txid === t.revealTxid && u.vout === 0) ?? { txid: t.revealTxid, vout: 0, value: core.INSCRIPTION_VALUE, address: t.holder, confirmations: 0, coinbase: false };
    if (coin.address !== t.holder) throw new Error("The transfer coin is not where Keshi expected it. Nothing was sent.");
    const fresh = await new core.Indexer(net).feeRate(3);
    const rate = Math.min(fresh, Math.max(1, t.rate) * 2);
    const plan = core.planCoin(snap, net, coin, keep ? t.holder : t.to, rate);
    await saveTransfer(net, { ...t, delivering: Date.now() });
    let txid: string;
    try {
      txid = await pay(secrets, net, snap, plan);
    } catch (e) {
      // A clear refusal: nothing went out, the transfer can be tried again. An unclear answer keeps the marker;
      // the next check sees whether the coin has left.
      if (e instanceof core.Rejected) await saveTransfer(net, { ...t, delivering: undefined });
      throw e;
    }
    await local.remove("pendingTransfer:" + net.id);
    return txid;
  } finally {
    delivering = false;
  }
}

/** Send the coin that holds an inscription to someone else. */
export async function quoteInscriptionSend(net: core.Network, snap: core.Snapshot, ins: core.Inscription, held: core.Inscription[], to: string): Promise<{ plan: core.Plan; together: number }> {
  if (!core.isValidAddress(to.trim(), net)) throw new Error(`That is not a valid ${net.hrp}1… address`);
  if (snap.addresses.some((a) => a.address === to.trim())) throw new Error("This is one of your own addresses in Keshi");
  if (snap.protectionChecked === false) throw new Error("The token index is unreachable, so Keshi cannot check which coins carry tokens. Try again in a moment.");
  const coin = snap.utxos.find((u) => `${u.txid}:${u.vout}` === ins.outpoint);
  if (!coin) throw new Error("This inscription is not in a coin Keshi can send yet. If it just arrived, wait for it to confirm and refresh.");
  const rate = await new core.Indexer(net).feeRate(3);
  return { plan: core.planCoin(snap, net, coin, to.trim(), rate), together: held.filter((h) => h.outpoint === ins.outpoint).length };
}

/* -------------------------------------------------------------- Ethereum sends */

/** Sign and send a prepared Ethereum transfer. Returns its hash at once; it confirms within a minute or two. */
export async function sendEth(secrets: core.Secrets, p: core.EthSendPlan): Promise<string> {
  const acct = core.ethAccountOf(secrets);
  try {
    const signed = core.signEthTx(p.tx, acct.privateKey);
    // Saved before sending: if the answer is lost, the next send warns instead of paying twice.
    await local.set("ethLastSend", { hash: signed.hash, at: Date.now() });
    const hash = await new core.EthRpc().send(signed.raw, signed.hash);
    ethActivityCache.delete(acct.address);
    return hash;
  } catch (e) {
    if (e instanceof Error && /insufficient funds/i.test(e.message)) throw new Error("Not enough ETH on your Ethereum address to pay the Ethereum fee");
    throw e;
  }
}

/** The last Ethereum send from this device, if it went out in the last 30 minutes and is not mined yet. */
export async function unconfirmedEthSend(): Promise<string | null> {
  const last = await local.get<{ hash: string; at: number }>("ethLastSend");
  if (!last || Date.now() - last.at > 30 * 60_000) return null;
  const rpc = new core.EthRpc();
  if (await rpc.mined(last.hash)) return null;
  return (await rpc.knows(last.hash)) ? last.hash : null;
}

/* --------------------------------------------------------------- erase device */

/** Remove every wallet and every setting Keshi keeps on this device. Only the recovery phrase can bring a wallet back. */
export async function eraseDevice(): Promise<void> {
  await lock();
  await session.clear();
  await local.clear();
}

/** PRL-20 balances across the wallet's addresses. */
export async function tokenBalances(secrets: core.Secrets, net: core.Network, snap: core.Snapshot | null): Promise<Record<string, bigint>> {
  if (net.id !== "mainnet") return {};
  const first = core.accountOf(secrets, net).derive(false, 0).address;
  const addrs = [...new Set([first, ...(snap?.addresses.filter((a) => a.used).map((a) => a.address) ?? [])])].slice(0, 30);
  const idx = new core.TokenIndex();
  return core.sumBalances(await Promise.all(addrs.map((a) => idx.balances(a))));
}

/** Inscriptions held by this wallet's addresses (mainnet only), newest number first. */
export async function inscriptions(secrets: core.Secrets, net: core.Network, snap: core.Snapshot | null): Promise<core.Inscription[]> {
  if (net.id !== "mainnet") return [];
  const first = core.accountOf(secrets, net).derive(false, 0).address;
  const addrs = [...new Set([first, ...(snap?.addresses.filter((a) => a.used).map((a) => a.address) ?? [])])].slice(0, 30);
  const idx = new core.TokenIndex();
  const lists = await Promise.all(addrs.map((a) => idx.inscriptions(a))); // an address that cannot be read fails the whole list: "none" must not mean "unknown"
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((i) => !seen.has(i.id) && seen.add(i.id))
    .sort((a, b) => b.number - a.number);
}

export interface Crossing {
  /** Pearl transaction for PRL to wPRL; Ethereum transaction for the way back. */
  txid: string;
  eth: string;
  amount: bigint;
  at: number;
  back?: boolean;
}

export interface EthHoldings {
  address: string;
  eth: bigint;
  wprl: bigint;
  usdt: bigint;
  /** Wrapped ETH, from older swaps or other apps. Keshi offers to turn it into ETH. */
  weth: bigint;
}

export async function ethHoldings(secrets: core.Secrets): Promise<EthHoldings> {
  const { address } = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc();
  const [eth, wprl, usdt, weth] = await Promise.all([
    rpc.ethBalance(address),
    rpc.tokenBalance(core.WPRL_CONTRACT, address),
    rpc.tokenBalance(core.USDT, address),
    rpc.tokenBalance(core.WETH, address),
  ]);
  return { address, eth, wprl, usdt, weth };
}

/** What moved on the wallet's Ethereum address, newest first. Kept a minute so the tab opens at once. */
const ethActivityCache = new Map<string, { at: number; items: core.EthActivity[] }>();
export async function ethActivity(secrets: core.Secrets, fresh = false): Promise<core.EthActivity[]> {
  const { address } = core.ethAccountOf(secrets);
  const hit = ethActivityCache.get(address);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.items;
  const items = await core.loadEthActivity(address);
  ethActivityCache.set(address, { at: Date.now(), items });
  return items;
}

/** Swap on Uniswap from the wallet's own Ethereum address. */
/** Buy an exact amount of wPRL with ETH on Uniswap: one transaction, no permission step, unused ETH refunded. */
export async function buyWithEth(secrets: core.Secrets, q: core.EthBuy, onStep: (t: string) => void): Promise<string> {
  try {
    return await core.ethBuy(new core.EthRpc(), core.ethAccountOf(secrets), q, onStep, core.swapFee());
  } catch (e) {
    if (e instanceof Error && /insufficient funds/i.test(e.message)) throw new Error("Not enough ETH on your Ethereum address to pay the Ethereum fee");
    throw e;
  }
}

/**
 * Send wPRL back through the bridge. Two Ethereum transactions when the bridge
 * is not yet allowed to take this amount (permission, then the return itself);
 * one otherwise. The permission is for this exact amount, never unlimited.
 */
export async function bridgeBack(secrets: core.Secrets, amount: bigint, pearlAddress: string, onStep: (text: string) => void): Promise<string> {
  const acct = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc();
  const [balance, allowance] = await Promise.all([rpc.tokenBalance(core.WPRL_CONTRACT, acct.address), rpc.allowance(core.WPRL_CONTRACT, acct.address, core.BRIDGE_CONTROLLER)]);
  if (balance < amount) throw new Error("Not enough wPRL on your Ethereum address");
  const gasError = (e: unknown) => (e instanceof Error && /insufficient funds/i.test(e.message) ? new Error("Not enough ETH on your Ethereum address to pay the Ethereum fee") : e);
  if (allowance < amount) {
    onStep("Step 1 of 2: allowing the bridge to take this amount…");
    try {
      const tx = await rpc.prepare(acct.address, core.WPRL_CONTRACT, core.callData.approve(core.BRIDGE_CONTROLLER, amount));
      const signed = core.signEthTx(tx, acct.privateKey);
      const hash = await rpc.send(signed.raw, signed.hash);
      if (!(await rpc.wait(hash))) throw new Error("Ethereum rejected the permission step. No wPRL was moved.");
    } catch (e) {
      throw gasError(e);
    }
  }
  onStep(allowance < amount ? "Step 2 of 2: sending wPRL to the bridge…" : "Sending wPRL to the bridge…");
  try {
    const tx = await rpc.prepare(acct.address, core.BRIDGE_CONTROLLER, core.callData.requestBurn(amount, pearlAddress));
    const signed = core.signEthTx(tx, acct.privateKey);
    const hash = await rpc.send(signed.raw, signed.hash);
    await addCrossing({ txid: hash, eth: acct.address, amount, at: Date.now(), back: true });
    if (!(await rpc.wait(hash))) throw new Error("Ethereum rejected the return. Your wPRL was not moved; only the Ethereum fee was spent.");
    return hash;
  } catch (e) {
    throw gasError(e);
  }
}

/**
 * The deposit address for an Ethereum address, remembered the first time it is
 * seen. If the bridge ever answers with a different one, refuse: a changed
 * address would mean someone is trying to redirect the payment.
 */
export async function bridgeDepositAddress(eth: string, net: core.Network): Promise<string> {
  const address = await new core.Bridge().depositAddress(eth);
  if (!core.isValidAddress(address, net)) throw new Error("The bridge returned an invalid deposit address. Nothing was sent.");
  const key = "pin:" + label(eth.toLowerCase());
  const pinned = await local.get<string>(key);
  if (pinned && pinned !== address) throw new Error("The bridge deposit address for this Ethereum address has changed. Stop and check on pearlbridge.xyz before sending.");
  if (!pinned) await local.set(key, address);
  return address;
}

/** Crossings of one account only: each record carries the Ethereum address it belongs to. */
export const crossings = async (eth: string): Promise<Crossing[]> => ((await local.get<Crossing[]>("crossings")) ?? []).filter((c) => c.eth.toLowerCase() === eth.toLowerCase());
export async function addCrossing(c: Crossing): Promise<void> {
  const all = (await local.get<Crossing[]>("crossings")) ?? [];
  // Up to 30 per account, so a busy account never pushes another one's records out.
  const mine = [c, ...all.filter((x) => x.eth.toLowerCase() === c.eth.toLowerCase())].slice(0, 30);
  await local.set("crossings", [...mine, ...all.filter((x) => x.eth.toLowerCase() !== c.eth.toLowerCase())]);
}

/* ------------------------------------------------- Buying with USDT elsewhere */

/** What the wallet's address holds on a source chain: its USDT and the coin that pays fees there. */
export async function usdtSource(secrets: core.Secrets, chain: core.SourceChain): Promise<{ address: string; usdt: bigint; gas: bigint }> {
  const { address } = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc(undefined, chain.rpcs);
  const [usdt, gas] = await Promise.all([rpc.tokenBalance(chain.usdt.address, address), rpc.ethBalance(address)]);
  return { address, usdt, gas };
}

export interface UsdtPurchase {
  txHash: string;
  chain: core.SourceChain["id"];
  /** USDT sent, in the chain's smallest unit. */
  amount: bigint;
  /** What was bought: wPRL, or ETH for the return to Pearl. */
  to: "wprl" | "eth";
  expected: bigint;
  at: number;
  /** The address that paid: purchases are shown to that account only. */
  from: string;
  done?: boolean;
  /** How it ended, kept for good: a failure or a refund must never turn into a neutral "Finished". */
  outcome?: "arrived" | "partial" | "refunded" | "failed";
}

/** Purchases of one account only. Records without a payer (none were ever published) are not shown. */
export async function usdtPurchases(from: string): Promise<UsdtPurchase[]> {
  return ((await local.get<UsdtPurchase[]>("lifi")) ?? []).filter((p) => p.from?.toLowerCase() === from.toLowerCase());
}
export async function recordPurchase(p: UsdtPurchase): Promise<void> {
  const all = ((await local.get<UsdtPurchase[]>("lifi")) ?? []).filter((x) => x.txHash !== p.txHash);
  const same = (x: UsdtPurchase) => x.from?.toLowerCase() === p.from.toLowerCase();
  await local.set("lifi", [p, ...all.filter(same).slice(0, 29), ...all.filter((x) => !same(x))]);
}

/** The lasting outcome of a LI.FI status, or nothing while it is still moving. */
export function purchaseOutcome(s: core.LifiStatus): UsdtPurchase["outcome"] | undefined {
  if (s.status === "DONE") return s.substatus === "PARTIAL" ? "partial" : s.substatus === "REFUNDED" ? "refunded" : "arrived";
  if (s.status === "FAILED") return "failed";
  return undefined;
}

/**
 * Carry out a LI.FI quote on the source chain: allow LI.FI's contract to take
 * the exact USDT amount when needed, then send the transaction LI.FI prepared.
 * The second signature only happens once the first is confirmed, so the user
 * can never be left with a stray permission and nothing sent.
 */
export async function buyWithUsdt(secrets: core.Secrets, chain: core.SourceChain, q: core.LifiQuote, asked: bigint, onStep: (text: string) => void): Promise<string> {
  if (Date.now() - q.at > 5 * core.QUOTE_LIFETIME_MS) throw new Error("This quote has expired. Ask for a fresh one; nothing was sent.");
  // The function that signs checks for itself: the quote must be for this chain and for exactly the USDT the user typed.
  if (q.fromChainId !== chain.chainId || q.tx.chainId !== chain.chainId) throw new Error("Refused: this quote is for another chain. Nothing was sent.");
  if (q.fromAmount !== asked) throw new Error("Refused: the quote spends a different amount of USDT than you entered. Nothing was sent.");
  if (q.tx.to.toLowerCase() !== core.LIFI_DIAMOND.toLowerCase()) throw new Error("Refused: the transaction does not go to LI.FI's contract.");
  const acct = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc(undefined, chain.rpcs);
  const gasError = (e: unknown) => (e instanceof Error && /insufficient funds|gas required exceeds|exceeds the balance/i.test(e.message) ? new Error(`Not enough ${chain.gas} on your address on ${chain.name} to pay its network fee`) : e);
  const [balance, allowance] = await Promise.all([rpc.tokenBalance(chain.usdt.address, acct.address), q.approvalAddress ? rpc.allowance(chain.usdt.address, acct.address, q.approvalAddress) : Promise.resolve(q.fromAmount)]);
  if (balance < q.fromAmount) throw new Error(`Not enough USDT on your address on ${chain.name}`);
  if (allowance < q.fromAmount) {
    onStep(`Step 1 of 2: allowing LI.FI to take ${core.formatUnits(q.fromAmount, chain.usdt.decimals, 2)} USDT…`);
    try {
      const tx = await rpc.prepare(acct.address, chain.usdt.address, core.callData.approve(q.approvalAddress, q.fromAmount), 0n, chain.limits);
      const signed = core.signEthTx(tx, acct.privateKey, chain.chainId);
      const hash = await rpc.send(signed.raw, signed.hash);
      if (!(await rpc.wait(hash))) throw new Error("The permission step was rejected. No USDT was moved.");
    } catch (e) {
      throw gasError(e);
    }
  }
  onStep(allowance < q.fromAmount ? "Step 2 of 2: sending your USDT through LI.FI…" : "Sending your USDT through LI.FI…");
  try {
    const data = hexToBytes(q.tx.data.slice(2));
    const tx = await rpc.prepare(acct.address, q.tx.to, data, q.tx.value, { ...chain.limits, minGas: q.tx.gasLimit ?? undefined });
    const signed = core.signEthTx(tx, acct.privateKey, chain.chainId);
    const hash = await rpc.send(signed.raw, signed.hash);
    await recordPurchase({ txHash: hash, chain: chain.id, amount: q.fromAmount, to: q.toSymbol.toUpperCase() === "WPRL" ? "wprl" : "eth", expected: q.toAmount, at: Date.now(), from: acct.address });
    return hash;
  } catch (e) {
    throw gasError(e);
  }
}

/** Addresses the user already deals with: their own, their contacts, the addresses they watch, and past recipients. */
export async function knownAddresses(snap: core.Snapshot | null): Promise<string[]> {
  const contacts = (await local.get<{ address: string }[]>("contacts")) ?? [];
  const watched = (await local.get<{ address: string }[]>("watched")) ?? [];
  const sent = snap?.activity.filter((a) => a.kind === "sent" && a.counterparty).map((a) => a.counterparty!) ?? [];
  return [...new Set([...contacts.map((c) => c.address), ...watched.map((w) => w.address), ...sent, ...(snap?.addresses.map((a) => a.address) ?? [])])];
}

/** Transactions this wallet made itself (mints), which must never be flagged as suspicious. */
export async function ownTxids(net: core.Network): Promise<Set<string>> {
  return new Set(((await local.get<string[]>("inscriptions:" + net.id)) ?? []).map((o) => o.split(":")[0]!));
}

/** Add one or more wallets to the vault. Needs the wallet password, because the vault is re-encrypted. */
export async function importWallet(secrets: core.Secrets, entries: core.WalletEntry | core.WalletEntry[], password: string): Promise<core.Secrets> {
  void secrets;
  const list = Array.isArray(entries) ? entries : [entries];
  return saveSecrets((stored) => list.reduce((s, e) => core.addWallet(s, e), stored), password);
}

/** Add the next account of the recovery phrase of wallet `index`, named after the wallet as the user sees it. */
export async function addAccount(secrets: core.Secrets, index: number, password: string): Promise<core.Secrets> {
  const name = core.accountName(secrets, index); // from the named list: the vault alone may still say "Wallet 1"
  return saveSecrets((stored) => core.addAccount(stored, index, name), password);
}

/**
 * Forget wallet `index`: its entry in the vault, and what Keshi kept for it on
 * this device (cached balances, site connections, quantum-ready address). The
 * caller must select another wallet afterwards, since indexes above `index`
 * move down by one. The last wallet cannot be removed.
 */
export async function removeWallet(index: number, password: string): Promise<core.Secrets> {
  const file = await local.get<core.VaultFile>("vault");
  if (!file) throw new Error("No wallet on this device");
  const stored = await withNames(await provePassword(file, password));
  await local.remove("tries");
  const gone = core.selectWallet(stored, index);
  if (!core.walletsOf(stored)[index]) throw new Error("Unknown wallet");
  const kept: core.Secrets = { ...core.removeWallet(stored, index), dataKey: stored.dataKey };
  await local.set("vault", await core.lockVault(kept, password));
  // Names are kept by index: write the list again in the new order.
  const names: Record<string, string> = {};
  core.walletsOf(kept).forEach((w, i) => (names[i] = w.name));
  await local.set(NAMES, names);
  await remember(kept);
  // Clean up what was kept for that wallet, unless another entry still derives the same addresses.
  const stillThere = core.walletsOf(kept).some((w) => w.key === gone.key && w.phrase === gone.phrase && core.accountNumber(w) === core.accountNumber(gone));
  if (!stillThere) {
    for (const net of [core.MAINNET, core.TESTNET]) {
      try {
        const snap = await loadCached(gone, net);
        const mine = new Set([...(snap?.addresses.map((a) => a.address) ?? []), core.accountOf(gone, net).derive(false, 0).address]);
        const sites = (await local.get<Record<string, Site>>("sites")) ?? {};
        const left = Object.fromEntries(Object.entries(sites).filter(([, s]) => !mine.has(s.address)));
        if (Object.keys(left).length !== Object.keys(sites).length) await local.set("sites", left);
        await local.remove(snapKey(gone, net));
        await local.remove(pqKey(gone, net));
      } catch {
        /* a wallet whose keys cannot be derived has nothing cached under them */
      }
    }
  }
  return kept;
}

/* ------------------------------------------------ Ethereum tokens and swaps */

export const ethTokens = async (): Promise<core.TokenMeta[]> => (await local.get<core.TokenMeta[]>("ethTokens")) ?? [];
export async function rememberEthToken(t: core.TokenMeta): Promise<void> {
  const list = await ethTokens();
  if (!list.some((x) => x.address.toLowerCase() === t.address.toLowerCase())) await local.set("ethTokens", [...list, t].slice(-30));
}

/** Balance of each token the user added. `balance` is null when it could not be read: unknown is not zero. */
export async function ethTokenBalances(secrets: core.Secrets): Promise<{ meta: core.TokenMeta; balance: bigint | null }[]> {
  const { address } = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc();
  const list = await ethTokens();
  const balances = await Promise.all(list.map((t) => rpc.tokenBalance(t.address, address).catch(() => null)));
  return list.map((meta, i) => ({ meta, balance: balances[i]! }));
}

/** Swap along a Uniswap route from the wallet's own Ethereum address, with the wallet's commission when one is configured. */
export async function swap(secrets: core.Secrets, route: core.Route, onStep: (t: string) => void, eth = false): Promise<string> {
  try {
    return await core.swapRoute(new core.EthRpc(), core.ethAccountOf(secrets), route, onStep, core.swapFee(), 100n, eth);
  } catch (e) {
    if (e instanceof Error && /insufficient funds/i.test(e.message)) throw new Error("Not enough ETH on your Ethereum address to pay the Ethereum fee");
    throw e;
  }
}

/** Turn WETH on the wallet's Ethereum address back into plain ETH (one Ethereum transaction). */
export async function unwrapWeth(secrets: core.Secrets, amount: bigint): Promise<string> {
  const acct = core.ethAccountOf(secrets);
  const rpc = new core.EthRpc();
  try {
    const signed = core.signEthTx(await rpc.prepare(acct.address, core.WETH, core.callData.withdraw(amount)), acct.privateKey);
    const hash = await rpc.send(signed.raw, signed.hash);
    if (!(await rpc.wait(hash))) throw new Error("Ethereum refused the conversion. Your WETH was not moved; only the Ethereum fee was spent.");
    return hash;
  } catch (e) {
    if (e instanceof Error && /insufficient funds/i.test(e.message)) throw new Error("Not enough ETH on your Ethereum address to pay the Ethereum fee");
    throw e;
  }
}

export type { Settings };
