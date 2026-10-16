// What moved on the wallet's Ethereum address: ETH in and out, wPRL from the
// bridge, swaps on Uniswap, WETH unwrapped. Read from Blockscout's public API
// (no account, no key) and shown in Activity next to the Pearl payments.

import { WPRL_CONTRACT } from "./bridge";
import { UNI_ROUTER, WETH } from "./uniswap";

const BLOCKSCOUT = "https://eth.blockscout.com/api/v2";
const ZERO = "0x0000000000000000000000000000000000000000";

export type EthKind = "received" | "sent" | "swap" | "bridge-in" | "bridge-out" | "unwrap" | "wrap" | "contract";

export interface EthLeg {
  /** ETH, wPRL, WETH, USDT, or the token's symbol. */
  asset: string;
  /** Signed: positive came in, negative went out. */
  amount: bigint;
  decimals: number;
}

export interface EthActivity {
  hash: string;
  /** Unix seconds; 0 while pending. */
  time: number;
  kind: EthKind;
  /** The main movement, shown big. */
  main: EthLeg;
  /** The other side of a swap, shown small. */
  other?: EthLeg;
  /** Who it came from or went to, when it is a plain transfer. */
  counterparty?: string;
  failed?: boolean;
  /** An unknown token that arrived uninvited: the Ethereum version of a dust payment. */
  flag?: "airdrop";
}

/** Tokens Keshi knows and shows by name. Anything else that arrives on its own is treated as spam until proven otherwise. */
export const KNOWN_TOKENS = new Set([WPRL_CONTRACT, WETH, "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"].map((a) => a.toLowerCase()));

const lc = (s: unknown) => String(s ?? "").toLowerCase();
const when = (t: unknown) => (t ? Math.floor(new Date(String(t)).getTime() / 1000) || 0 : 0);
const symbolOf = (t: any) => {
  const s = String(t?.token?.symbol ?? "TOKEN").slice(0, 12);
  if (lc(t?.token?.address) === lc(WPRL_CONTRACT) || /^wprl$/i.test(s)) return "wPRL";
  if (lc(t?.token?.address) === lc(WETH)) return "WETH";
  return s;
};

/**
 * Turns Blockscout's three lists (transactions, token transfers, internal
 * transactions) into one entry per transaction, from the address's point of view.
 */
export function ethActivityOf(address: string, txs: any[], transfers: any[], internals: any[]): EthActivity[] {
  const me = lc(address), router = lc(UNI_ROUTER), weth = lc(WETH), wprl = lc(WPRL_CONTRACT);
  const byHash = new Map<string, { time: number; legs: EthLeg[]; to: string; from: string; failed: boolean; counter?: string; unknownIn?: boolean }>();
  const at = (hash: string, time: number) => {
    let g = byHash.get(hash);
    if (!g) byHash.set(hash, (g = { time, legs: [], to: "", from: "", failed: false }));
    if (!g.time && time) g.time = time;
    return g;
  };
  const add = (g: { legs: EthLeg[] }, leg: EthLeg) => {
    const same = g.legs.find((l) => l.asset === leg.asset);
    if (same) same.amount += leg.amount;
    else g.legs.push(leg);
  };
  for (const t of txs) {
    const hash = String(t?.hash ?? "");
    if (!hash) continue;
    const g = at(hash, when(t.timestamp));
    g.to = lc(t?.to?.hash);
    g.from = lc(t?.from?.hash);
    g.failed = t?.status === "error" || t?.result === "error";
    const value = BigInt(String(t?.value ?? "0"));
    if (value > 0n && !g.failed) {
      if (g.to === me && g.from !== me) add(g, { asset: "ETH", amount: value, decimals: 18 });
      if (g.from === me && g.to !== me) add(g, { asset: "ETH", amount: -value, decimals: 18 });
    }
    if (g.from === me) g.counter = g.to;
    else if (g.to === me) g.counter = g.from;
  }
  for (const t of transfers) {
    const hash = String(t?.transaction_hash ?? "");
    const value = BigInt(String(t?.total?.value ?? "0"));
    if (!hash || value <= 0n) continue;
    const g = at(hash, when(t.timestamp));
    const decimals = Number(t?.total?.decimals ?? t?.token?.decimals ?? 18);
    const asset = symbolOf(t);
    const from = lc(t?.from?.hash), to = lc(t?.to?.hash);
    if (to === me && from !== me) {
      add(g, { asset, amount: value, decimals });
      if (!KNOWN_TOKENS.has(lc(t?.token?.address))) g.unknownIn = true;
    }
    if (from === me && to !== me) add(g, { asset, amount: -value, decimals });
    if (lc(t?.token?.address) === wprl) {
      if (from === ZERO) g.counter = "bridge-in";
      if (to === ZERO) g.counter = "bridge-out";
    }
    if (!g.counter) g.counter = to === me ? from : to;
  }
  for (const t of internals) {
    const hash = String(t?.transaction_hash ?? "");
    const value = BigInt(String(t?.value ?? "0"));
    if (!hash || value <= 0n || t?.success === false) continue;
    const g = at(hash, when(t.timestamp));
    const from = lc(t?.from?.hash), to = lc(t?.to?.hash);
    if (to === me && from !== me) add(g, { asset: "ETH", amount: value, decimals: 18 });
    if (from === me && to !== me) add(g, { asset: "ETH", amount: -value, decimals: 18 });
  }
  const out: EthActivity[] = [];
  for (const [hash, g] of byHash) {
    const legs = g.legs.filter((l) => l.amount !== 0n);
    const ins = legs.filter((l) => l.amount > 0n), outs = legs.filter((l) => l.amount < 0n);
    let kind: EthKind;
    let main: EthLeg | undefined, other: EthLeg | undefined;
    if (g.counter === "bridge-in") {
      kind = "bridge-in";
      main = ins.find((l) => l.asset === "wPRL") ?? ins[0];
    } else if (g.counter === "bridge-out") {
      kind = "bridge-out";
      main = outs.find((l) => l.asset === "wPRL") ?? outs[0];
    } else if ((g.to === router && legs.length) || (ins.length && outs.length)) {
      kind = "swap";
      main = outs[0] ?? ins[0];
      other = outs[0] ? ins[0] : undefined;
    } else if (g.to === weth && ins.length === 1 && ins[0]!.asset === "ETH" && legs.length === 1) {
      kind = "unwrap";
      main = ins[0];
    } else if (g.to === weth && outs.length === 1 && outs[0]!.asset === "ETH" && legs.length === 1) {
      kind = "wrap";
      main = outs[0];
    } else if (ins.length) {
      kind = "received";
      main = ins[0];
    } else if (outs.length) {
      kind = "sent";
      main = outs[0];
    } else if (g.from === me && g.failed) {
      // A transaction of ours that failed: nothing moved, but the fee was spent. A plain permission (approve) is left out.
      kind = "contract";
      main = { asset: "ETH", amount: 0n, decimals: 18 };
    } else continue;
    if (!main) continue;
    const counterparty = g.counter && g.counter.startsWith("0x") ? g.counter : undefined;
    // An unknown token that came in through a transaction we did not send: an airdrop, almost always a lure.
    const flag = g.unknownIn && g.from !== me && kind === "received" ? ("airdrop" as const) : undefined;
    out.push({ hash, time: g.time, kind, main, other, counterparty, failed: g.failed || undefined, flag });
  }
  out.sort((a, b) => (b.time || Infinity) - (a.time || Infinity));
  return out;
}

type Fetch = typeof fetch;

async function page(fetcher: Fetch, path: string, maxPages: number): Promise<any[]> {
  const items: any[] = [];
  let next: Record<string, unknown> | null = null;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams(next ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])) : {});
    const res = await fetcher(`${BLOCKSCOUT}${path}${path.includes("?") ? "&" : "?"}${q}`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return items; // an address Blockscout has never seen: nothing happened there yet
    if (!res.ok) throw new Error(`Ethereum history unavailable (${res.status})`);
    const j = await res.json();
    items.push(...(Array.isArray(j.items) ? j.items : []));
    next = j.next_page_params && typeof j.next_page_params === "object" ? j.next_page_params : null;
    if (!next) break;
  }
  return items;
}

/** The address's Ethereum history, newest first. `maxPages` × 50 entries per list at most. */
export async function loadEthActivity(address: string, fetcher: Fetch = (...a) => fetch(...a), maxPages = 4): Promise<EthActivity[]> {
  const [txs, transfers, internals] = await Promise.all([
    page(fetcher, `/addresses/${address}/transactions`, maxPages),
    page(fetcher, `/addresses/${address}/token-transfers?type=ERC-20`, maxPages),
    page(fetcher, `/addresses/${address}/internal-transactions`, maxPages),
  ]);
  return ethActivityOf(address, txs, transfers, internals);
}

export const ETH_KIND_LABEL: Record<EthKind, string> = {
  received: "Received on Ethereum",
  sent: "Sent on Ethereum",
  swap: "Swapped",
  "bridge-in": "Bridge arrived on Ethereum",
  "bridge-out": "Sent back to Pearl",
  unwrap: "Turned WETH into ETH",
  wrap: "Turned ETH into WETH",
  contract: "Ethereum transaction",
};
