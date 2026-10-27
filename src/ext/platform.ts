import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

// Thin layer over storage. Browser extension: the extension's own storage.
// Phone app: the phone's app storage (set by the app at start-up). Plain web
// page (preview): web storage. The unlocked session is kept in memory only,
// outside the extension, so it is gone as soon as the app is closed.
//
// Everything that says something about the user (balances, addresses, history,
// contacts, connected sites, bridge crossings) is encrypted on disk with a
// data key that lives inside the password-protected vault. While the wallet is
// locked that data cannot be read, by Keshi or by anyone copying the files.
const ext: typeof chrome | undefined = typeof chrome !== "undefined" && chrome.storage ? chrome : undefined;

const enc = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $b: x.toString() } : x instanceof Uint8Array ? { $u: Array.from(x) } : x));
const dec = (s: string) =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && "$b" in x ? BigInt(x.$b) : x && typeof x === "object" && "$u" in x ? Uint8Array.from(x.$u) : x));

/** Local keys whose values are encrypted at rest. Settings and the vault itself are not in this list. */
const SEALED = /^(snap:|contacts$|sites$|crossings$|watch$|watched$|lifi$|ethTokens$|inscriptions:|pendingReveal:|pendingTransfer:|ethLastSend$|pin:|pq:|bridgeEth$|walletNames$|newsRead$|sent:)/;
let dataKey: Uint8Array | null = null;

/** Give (or take away) the key that unlocks the encrypted local data. */
export function setDataKey(hex?: string | null): void {
  dataKey = hex && /^[0-9a-f]{64}$/.test(hex) ? hexToBytes(hex) : null;
}
export const newDataKey = (): string => bytesToHex(randomBytes(32));

/**
 * Short one-way label, so storage key names never contain an address. Keyed
 * with the data key: without the password, nobody can test whether a given
 * address belongs to this wallet by hashing it.
 */
export const label = (text: string): string => {
  if (!dataKey) throw new Error("Wallet is locked");
  return bytesToHex(hmac(sha256, dataKey, new TextEncoder().encode(text))).slice(0, 24);
};

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Encrypts a value for one storage key. The key name is bound in, so a value cannot be moved to another key. */
function seal(plain: string, key: string): string {
  const nonce = randomBytes(24);
  return JSON.stringify({ $e: bytesToHex(nonce) + bytesToHex(xchacha20poly1305(dataKey!, nonce, utf8(key)).encrypt(utf8(plain))) });
}

/**
 * Returns the stored text in clear, or undefined when the wallet is locked or
 * the value is not a genuine encrypted one. Clear text is never accepted for
 * these keys: anything that can write to the storage file without the password
 * must not be able to plant contacts, connected sites or addresses.
 */
function unseal(stored: string, key: string): string | undefined {
  if (!dataKey || !stored.startsWith('{"$e":"')) return undefined;
  try {
    const raw = hexToBytes(JSON.parse(stored).$e);
    return new TextDecoder().decode(xchacha20poly1305(dataKey, raw.slice(0, 24), utf8(key)).decrypt(raw.slice(24)));
  } catch {
    return undefined;
  }
}

/** Where the phone app keeps its files. Values are strings; the vault and private data arrive already encrypted. */
export interface NativeStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Remove everything Keshi stored (used when the user erases the wallet from this device). */
  clear?(): Promise<void>;
}
let native: NativeStore | null = null;
export function useNativeStorage(store: NativeStore): void {
  native = store;
}
export const isApp = (): boolean => !!native;

const memory = new Map<string, string>();
const inMemory = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
};

function area(kind: "local" | "session") {
  const web = () => (kind === "session" ? inMemory : native ? null : globalThis.localStorage);
  return {
    async get<T>(key: string): Promise<T | undefined> {
      let s: string | null | undefined;
      if (ext) {
        const r = await ext.storage[kind].get(key);
        s = typeof r[key] === "string" ? (r[key] as string) : undefined;
      } else if (kind === "local" && native) s = await native.get("keshi:" + key);
      else s = web()!.getItem("keshi:" + key);
      if (s && kind === "local" && SEALED.test(key)) s = unseal(s, key);
      return s ? dec(s) : undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      let s = enc(value);
      if (kind === "local" && SEALED.test(key)) {
        if (!dataKey) throw new Error("Wallet is locked"); // never write user data in clear, and never pretend it was saved
        s = seal(s, key);
      }
      if (ext) await ext.storage[kind].set({ [key]: s });
      else if (kind === "local" && native) await native.set("keshi:" + key, s);
      else web()!.setItem("keshi:" + key, s);
    },
    async remove(key: string): Promise<void> {
      if (ext) await ext.storage[kind].remove(key);
      else if (kind === "local" && native) await native.remove("keshi:" + key);
      else web()!.removeItem("keshi:" + key);
    },
    /** Everything Keshi keeps in this area, gone. */
    async clear(): Promise<void> {
      if (ext) await ext.storage[kind].clear();
      else if (kind === "local" && native) {
        if (native.clear) await native.clear();
        else for (const k of ["vault", "tries", "settings"]) await native.remove("keshi:" + k);
      } else {
        const w = web()!;
        if (w === inMemory) memory.clear();
        else for (const k of Object.keys(localStorage)) if (k.startsWith("keshi:")) localStorage.removeItem(k);
      }
    },
  };
}

export const local = area("local");
export const session = area("session");
export const isExtension = !!ext;

export interface Settings {
  network: "mainnet" | "testnet";
  autoLockMinutes: number;
  hideBalance: boolean;
  quote: "usdt" | "usdc";
  theme: "system" | "light" | "dark";
  /** Which wallet of the vault is in use. */
  wallet: number;
  /** Unit of the total on the home screen. */
  unit: "prl" | "usd";
  /** Whether the home screen and Activity read the wallet's Ethereum address from public servers. On by default since 1.0.3 (Settings > Privacy turns it off); Swap, Bridge, Buy with USDT and Receive ETH turn it back on when used. */
  ethereum: boolean;
  /** The three-step explanation on Buy with USDT has been read and closed. */
  usdtIntroSeen?: boolean;
}
export const DEFAULT_SETTINGS: Settings = { network: "mainnet", autoLockMinutes: 15, hideBalance: false, quote: "usdt", theme: "system", wallet: 0, unit: "prl", ethereum: true };

export interface Site {
  address: string;
  publicKey: string;
  since: number;
}
export interface Contact {
  name: string;
  address: string;
}
export interface DappRequest {
  /** Chosen by the wallet. */
  id: string;
  /** The page's own reference, echoed back with the answer. */
  pageId: string;
  /** When the request arrived; old requests are dropped. */
  at: number;
  windowId?: number;
  origin: string;
  tabId: number;
  method: "connect" | "signMessage" | "sendPayment";
  params: any;
}

export const getSettings = async (): Promise<Settings> => ({ ...DEFAULT_SETTINGS, ...((await local.get<Settings>("settings")) ?? {}) });
