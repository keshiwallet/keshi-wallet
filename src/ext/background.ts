import { local, session, getSettings, setDataKey, type DappRequest, type Site, siteGrantFor } from "./platform";
import { networkById } from "../core/network";
import { dropCheck, formatHashrate, minerState, offlineCheck } from "../core/pools";
import type { MinerAlert, MinerAlertState } from "./platform";
import { formatPrl } from "../core/amount";
import { sendSignal } from "./stats";
import { payoutSplit, payoutStep, readingOf, type PayoutMemory } from "../core/payout";
import { arrivalText, Bridge, readWatch, watchAfter, watchStep, type CrossingStatus } from "../core/bridge";

// Background worker. It signs nothing itself: it routes requests from websites
// to an approval window, auto-locks, and announces incoming PRL. It reads the
// unlocked session only to open the encrypted list of connected sites.

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
});
chrome.runtime.onStartup?.addListener(() => chrome.alarms.create("tick", { periodInMinutes: 1 }));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.keshi !== "request") return;
  // Trust the browser's view of the page origin, not what the page claims.
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  // Only top-level web pages may talk to the wallet.
  if (!/^https?:\/\/[^/]+$/.test(origin) || sender.frameId !== 0 || typeof sender.tab?.id !== "number") return void reply({ error: "Not available here" });
  // One request at a time: the limits below must not be raced by a burst.
  const tabId = sender.tab.id;
  const run = queue.then(() => handle(msg, origin, tabId));
  queue = run.catch(() => {});
  run.then(reply, () => reply({ error: "The wallet could not handle this request" }));
  return true;
});

let queue: Promise<unknown> = Promise.resolve();

/** The background can read the user's encrypted data only while the wallet is unlocked. */
async function loadKey(): Promise<boolean> {
  const u = await session.get<{ secrets: { dataKey?: string }; expires: number }>("unlocked");
  const open = !!u && u.expires > Date.now();
  setDataKey(open ? u!.secrets.dataKey : null);
  return open;
}

const REQ = "req:";
const MAX_WAITING = 3; // approval windows open at once, all sites together
const REQUEST_LIFE = 10 * 60_000;

/** Requests still waiting for the user. Stale ones are dropped on the way. */
async function waiting(): Promise<DappRequest[]> {
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith(REQ));
  const out: DappRequest[] = [];
  for (const k of keys) {
    const r = await session.get<DappRequest>(k);
    if (!r || Date.now() - r.at > REQUEST_LIFE) await session.remove(k);
    else out.push(r);
  }
  return out;
}

/** Keep only what each method needs, with hard limits: a page must not be able to fill the wallet's storage. */
function clean(method: string, params: any): DappRequest["params"] | null {
  if (method === "connect") return {};
  if (method === "signMessage") return typeof params?.message === "string" && params.message.length > 0 && params.message.length <= 4000 ? { message: params.message } : null;
  if (method === "sendPayment")
    return typeof params?.to === "string" && params.to.length <= 100 && typeof params?.amount === "string" && params.amount.length <= 30 ? { to: params.to, amount: params.amount } : null;
  return null;
}

/** After a "no" to a connection, the same site may not ask again for a minute: no nagging until the user gives in. */
const COOL_DOWN = 60_000;
const coolKey = (origin: string) => "cool:" + origin;

async function handle(msg: { id: unknown; method: unknown; params: any; active?: unknown }, origin: string, tabId: number) {
  if (typeof msg.id !== "string" || msg.id.length > 64 || typeof msg.method !== "string") return { error: "Invalid request" };
  const unlocked = await loadKey();
  const sites = (unlocked && (await local.get<Record<string, Site>>("sites"))) || {};
  const settings = await getSettings();
  // A grant answers only on the wallet and network it was given on: after a switch the site sees nothing until it reconnects.
  const site = siteGrantFor(Object.prototype.hasOwnProperty.call(sites, origin) ? sites[origin] : undefined, settings);
  switch (msg.method) {
    case "getNetwork":
      return site ? { result: settings.network } : { error: "Connect first" };
    case "getAccounts":
      return { result: site ? [site.address] : [] };
    case "disconnect":
      if (!unlocked) return { error: "Keshi is locked. Open it and unlock it first." };
      delete sites[origin]; // whatever wallet it was given on
      await local.set("sites", sites);
      return { result: true };
    case "connect": {
      if (site) return { result: { address: site.address, publicKey: site.publicKey } };
      // A site may open Keshi only right after the person clicks on it, never by itself on page load or in a loop.
      if (msg.active === false) return { error: "Keshi opens only after you click on the site. Click the site's connect button." };
      const until = await session.get<number>(coolKey(origin));
      if (typeof until === "number" && until > Date.now()) return { error: "The user rejected the request" };
      break;
    }
    case "signMessage":
    case "sendPayment": {
      // Same answer whether locked or not: a site that is not connected learns nothing.
      if (!site) return { error: "Connect first" };
      // Like connecting: only right after a click, and not again for a minute after a refusal. A site cannot nag.
      if (msg.active === false) return { error: "Keshi opens only after you click on the site." };
      const until = await session.get<number>(coolKey(origin));
      if (typeof until === "number" && until > Date.now()) return { error: "The user rejected the request" };
      break;
    }
    default:
      return { error: "Unknown method" };
  }
  const params = clean(msg.method, msg.params);
  if (!params) return { error: msg.method === "signMessage" ? "Invalid message" : "Invalid payment" };
  const open = await waiting();
  if (open.some((r) => r.origin === origin)) return { error: "A request from this site is already waiting in Keshi" };
  if (open.length >= MAX_WAITING) return { error: "Too many requests are waiting in Keshi" };
  // The wallet names the request itself; the page's own id is only echoed back with the answer.
  const id = crypto.randomUUID();
  const req: DappRequest = { id, pageId: msg.id, origin, tabId, method: msg.method as DappRequest["method"], params, at: Date.now() };
  await session.set(REQ + id, req);
  try {
    const win = await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?approve=${id}`), type: "popup", width: 396, height: 640 });
    // Only if the request is still waiting: the user may already have answered.
    if (typeof win?.id === "number" && (await session.get(REQ + id))) await session.set(REQ + id, { ...req, windowId: win.id });
  } catch {
    await session.remove(REQ + id);
    return { error: "Keshi could not open its window" };
  }
  return { pending: true };
}

// Closing the approval window is a "no": tell the page and forget the request.
chrome.windows.onRemoved.addListener(async (windowId) => {
  for (const r of await waiting()) {
    if (r.windowId !== windowId) continue;
    await session.remove(REQ + r.id);
    await session.set(coolKey(r.origin), Date.now() + COOL_DOWN);
    chrome.tabs.sendMessage(r.tabId, { keshi: "response", id: r.pageId, origin: r.origin, error: "The user rejected the request" }).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener(async () => {
  // Auto-lock.
  const s = await session.get<{ expires: number }>("unlocked");
  if (s && s.expires < Date.now()) await session.remove("unlocked");
  // The miner alert works locked too: it needs only the pool and the payout address, kept for it unencrypted.
  await checkMiner().catch(() => {});
  // The bridge's arrival alert (1.0.6b) works locked too: it holds only the transaction numbers of crossings on their way.
  await checkBridge().catch(() => {});
  // Only for those who ticked "Count my wallet": one anonymous signal a day. It does nothing otherwise, and never throws.
  void sendSignal();
  const unlocked = await loadKey();
  const watch = unlocked ? await local.get<{ network: string; addresses: string[]; received: bigint }>("watch") : undefined;
  // The payment alert of the followed miner (1.0.6). When that address is one the wallet already watches, the
  // notification below tells it apart; otherwise (Keshi locked, or someone else's address) it is asked for here.
  const mined = await local.get<MinerAlert>("minerAlert");
  const paid = mined?.payout ? mined.address : undefined;
  const inWallet = !!paid && !!watch && watch.network === "mainnet" && watch.addresses.slice(0, 25).includes(paid);
  if (paid && !inWallet) await checkPayout(paid).catch(() => {});
  if (!unlocked) return; // locked: balances and addresses are unreadable, so no notification for the wallet itself

  // Incoming payment notification.
  if (!watch?.addresses.length) return;
  const net = networkById(watch.network);
  try {
    let total = 0n;
    let minedReceived: bigint | undefined;
    for (const a of watch.addresses.slice(0, 25)) {
      const r = await fetch(`${net.indexer}/api/v2/address/${a}?details=basic`, { cache: "no-store" });
      if (!r.ok) return;
      // An answer without a well-formed total is no reading: nothing is compared and nothing is remembered this time.
      const got = readingOf(await r.json());
      if (got === null) return;
      if (inWallet && a === paid) minedReceived = got;
      total += got;
    }
    const delta = total > watch.received ? total - watch.received : 0n;
    // What the payment alert said while Keshi was locked is not said again, and a payment to the mining address is named as one.
    const memory = paid ? await local.get<PayoutMemory>("minerPayout") : undefined;
    const split = inWallet && minedReceived !== undefined ? payoutSplit(memory, paid!, minedReceived, delta) : null;
    const hidden = (await getSettings()).hideBalance;
    // Remembered first, announced second: a reading that could not be saved is not announced again and again.
    if (split) await local.set("minerPayout", split.memory);
    if (total > watch.received) await local.set("watch", { ...watch, received: total });
    if (split && split.payout > 0n) notifyPayout(paid!, split.payout, !!hidden);
    const rest = split ? split.rest : delta;
    if (rest > 0n) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon/128.png"),
        title: "PRL received",
        // With the balance hidden in Keshi, the amount stays out of the system's notification centre too.
        message: hidden ? "PRL arrived in your wallet." : `+${formatPrl(rest)} PRL arrived in your wallet.`,
      });
    }
  } catch {
    /* offline: try again on the next tick */
  }
});

/**
 * The bridge's arrival alert (1.0.6b). While a crossing is on its way, PearlBridge's public API is asked about it once a
 * minute, with its transaction number only; the first answer other than "on its way" is announced once and the crossing
 * is forgotten. Nothing is asked when no crossing is waiting, and a crossing is dropped after three days.
 */
let bridgeRound = false;
async function checkBridge(): Promise<void> {
  // One round at a time: a round still waiting for the bridge is not joined by a second one.
  if (bridgeRound) return;
  bridgeRound = true;
  try {
    const stored = await local.get<unknown>("bridgeWatch");
    if (stored === undefined) return;
    const list = (await local.get<boolean>("bridgeAlert")) === false ? [] : readWatch(stored, Date.now());
    if (!list.length) return void (await local.remove("bridgeWatch"));
    // The size and time limits of an answer are the Bridge's own (64 kB counted while reading, fifteen seconds).
    const bridge = new Bridge((url, init) => fetch(url, { ...init, cache: "no-store", credentials: "omit", redirect: "error" }));
    const results: Record<string, CrossingStatus | undefined> = {};
    for (const w of list) results[w.txid] = await (w.back ? bridge.backStatus(w.txid) : bridge.status(w.txid)).catch(() => undefined);
    const { ended, held } = watchStep(list, results);
    if (!ended.length && !held.length) return;
    // Saved first, announced second: what could not be saved is not announced every minute. The list is read
    // again: the screen may have added a crossing, or the alert may have been turned off, meanwhile.
    const off = (await local.get<boolean>("bridgeAlert")) === false;
    const keep = off ? [] : watchAfter(readWatch(await local.get<unknown>("bridgeWatch"), Date.now()), ended.map((t) => t.watch), held);
    if (keep.length) await local.set("bridgeWatch", keep);
    else await local.remove("bridgeWatch");
    if (off) return;
    // Best effort from here: a notification the system refuses is not retried.
    for (const t of [...ended, ...held.map((watch) => ({ watch, phase: "review" as const }))]) {
      const text = arrivalText(t.watch.back, t.phase);
      if (text) chrome.notifications.create({ type: "basic", iconUrl: chrome.runtime.getURL("icon/128.png"), title: text.title, message: text.message });
    }
  } finally {
    bridgeRound = false;
  }
}

function notifyPayout(address: string, amount: bigint, hidden: boolean): void {
  const short = `${address.slice(0, 8)}…${address.slice(-4)}`;
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon/128.png"),
    // Named for what is known: PRL arrived on that address. Anyone can send PRL to an address, so it is not called a payment "from your pool".
    title: "PRL received on your mining address",
    message: hidden ? `PRL arrived on ${short}.` : `+${formatPrl(amount)} PRL arrived on ${short}.`,
  });
}

/**
 * The payment alert while the wallet's own notification cannot cover the mining address: Pearl's public indexer is
 * asked what the address received, once a minute. The first reading announces nothing. Only the address is sent.
 */
async function checkPayout(address: string): Promise<void> {
  // The address was checked when the miner was followed; checked again here, since it is read back from storage into a URL.
  if (!/^prl1[02-9ac-hj-np-z]{6,90}$/.test(address)) return;
  const r = await fetch(`${networkById("mainnet").indexer}/api/v2/address/${encodeURIComponent(address)}?details=basic`, { cache: "no-store", redirect: "error" });
  if (!r.ok) return;
  // An answer without a well-formed total is no reading: what was remembered stays, and nothing is announced.
  const reading = readingOf(await r.json());
  if (reading === null) return;
  const step = payoutStep(await local.get<PayoutMemory>("minerPayout"), address, reading);
  // Stopped following, or the alert turned off, meanwhile: say nothing and keep nothing.
  const now = await local.get<MinerAlert>("minerAlert");
  if (!now?.payout || now.address !== address) return;
  // Remembered first, announced second: a reading that could not be saved is not announced every minute.
  await local.set("minerPayout", step.memory);
  if (step.fresh > 0n) notifyPayout(address, step.fresh, !!(await getSettings()).hideBalance);
}

/**
 * Every few minutes, ask the followed pool which workers still send work. A
 * worker silent for longer than the chosen delay is announced once, and again
 * only after it came back. Only the payout address is sent, to a pool that
 * already knows it.
 */
async function checkMiner(): Promise<void> {
  const m = await local.get<MinerAlert>("minerAlert");
  if (!m?.address || m.stops === false) return;
  const last = (await session.get<number>("miner:checked")) ?? 0;
  // Asked about every 2 minutes, so a 5-minute delay is announced within 5 to 7 minutes.
  if (Date.now() - last < 2 * 60_000 - 5_000) return;
  await session.set("miner:checked", Date.now());
  const state = await minerState(m.pool, m.address);
  const stored = await local.get<MinerAlertState>("minerAlertState");
  // The memory belongs to one pool and one address: another pool's worker names must not be reported missing here.
  const before = stored && stored.address === m.address && (stored.pool ?? m.pool) === m.pool ? stored : undefined;
  const memory = before ?? { address: m.address, offline: [], known: [] };
  const { offline, fresh, known, total, idleSince } = offlineCheck(state, memory, m.afterMinutes, Date.now() / 1000);
  // Stopped following meanwhile: say nothing and keep nothing.
  if ((await local.get<MinerAlert>("minerAlert"))?.address !== m.address) return;
  if (fresh.length) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: fresh.length === 1 ? `${fresh[0]} stopped mining` : `${fresh.length} workers stopped mining`,
      message: `No work received for ${m.afterMinutes} min or more. ${Math.max(0, total - offline.length)} of ${total} worker${total === 1 ? "" : "s"} still mining.`,
    });
  }
  // A worker still mining but well under its usual hashrate (a card that dropped out, a throttled rig): said once, until it is back.
  const drop = dropCheck(state, before?.rates ? { rates: before.rates, low: before.low ?? [], pending: before.pending ?? [] } : undefined, Date.now() / 1000);
  // One notification however many workers dropped at once (a farm-wide throttle is one event).
  if (drop.fresh.length === 1) {
    const d = drop.fresh[0]!;
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: `${d.name} hashrate dropped`,
      message: `${formatHashrate(d.now)} now, usually ${formatHashrate(d.usual)}. Still sending work.`,
    });
  } else if (drop.fresh.length > 1) {
    const sum = (k: "now" | "usual") => drop.fresh.reduce((a, d) => a + d[k], 0);
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: `${drop.fresh.length} workers run under their usual hashrate`,
      message: `${formatHashrate(sum("now"))} now, usually ${formatHashrate(sum("usual"))} between them. Still sending work.`,
    });
  }
  await local.set("minerAlertState", { address: m.address, pool: m.pool, offline, known, idleSince, rates: drop.rates, low: drop.low, pending: drop.pending } satisfies MinerAlertState);
}
