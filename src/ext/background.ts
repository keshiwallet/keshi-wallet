import { local, session, getSettings, setDataKey, type DappRequest, type Site } from "./platform";
import { networkById } from "../core/network";
import { formatPrl } from "../core/amount";

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
  const site = Object.prototype.hasOwnProperty.call(sites, origin) ? sites[origin] : undefined;
  switch (msg.method) {
    case "getNetwork":
      return site ? { result: (await getSettings()).network } : { error: "Connect first" };
    case "getAccounts":
      return { result: site ? [site.address] : [] };
    case "disconnect":
      if (!unlocked) return { error: "Keshi is locked. Open it and unlock it first." };
      delete sites[origin];
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
  if (!(await loadKey())) return; // locked: balances and addresses are unreadable, so no notification

  // Incoming payment notification.
  const watch = await local.get<{ network: string; addresses: string[]; received: bigint }>("watch");
  if (!watch?.addresses.length) return;
  const net = networkById(watch.network);
  try {
    let total = 0n;
    for (const a of watch.addresses.slice(0, 25)) {
      const r = await fetch(`${net.indexer}/api/v2/address/${a}?details=basic`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      total += BigInt(j.totalReceived ?? "0") + (BigInt(j.unconfirmedBalance ?? "0") > 0n ? BigInt(j.unconfirmedBalance) : 0n);
    }
    if (total > watch.received) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon/128.png"),
        title: "PRL received",
        // With the balance hidden in Keshi, the amount stays out of the system's notification centre too.
        message: (await getSettings()).hideBalance ? "PRL arrived in your wallet." : `+${formatPrl(total - watch.received)} PRL arrived in your wallet.`,
      });
      await local.set("watch", { ...watch, received: total });
    }
  } catch {
    /* offline: try again on the next tick */
  }
});
