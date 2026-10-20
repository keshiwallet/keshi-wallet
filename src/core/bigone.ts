import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Book, Candle, Ticker } from "./exchange";
import { remoteText } from "./network";

// BigONE, the largest PRL market. Prices are public; orders use the user's
// own BigONE API key, sent straight from their device.

const BASE = "https://big.one/api/v3";
/** The coin's symbol on BigONE: PRL today; PEARL if BigONE renames it like SafeTrade did on 18 Oct 2026. */
const SYMBOLS = ["PRL", "PEARL"];
let known: { pair: string; symbol: string; at: number } | null = null;
/** Forgets the remembered pair name (tests). */
export const forgetBigOnePair = (): void => void (known = null);

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const text = (s: string) => new TextEncoder().encode(s);

/** The signed pass BigONE expects on every private request (a JWT, HS256). */
export function bigoneToken(key: string, secret: string, nowMs = Date.now()): string {
  const head = b64url(text(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(text(JSON.stringify({ type: "OpenAPIV2", sub: key, nonce: (BigInt(nowMs) * 1_000_000n).toString() })));
  return `${head}.${body}.${b64url(hmac(sha256, text(secret), text(`${head}.${body}`)))}`;
}

export class BigOne {
  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private creds?: { key: string; secret: string },
  ) {}

  get connected(): boolean {
    return !!this.creds;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown, auth = false): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) {
      if (!this.creds) throw new Error("Connect your BigONE account first");
      headers.authorization = "Bearer " + bigoneToken(this.creds.key, this.creds.secret);
    }
    const res = await this.fetcher(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || (typeof j.code === "number" && j.code !== 0)) throw new Error(auth ? remoteText("BigONE", j.message) : "BigONE price feed unavailable");
    return j.data;
  }

  /** Finds the PRL/USDT pair under either symbol, from the pair list (kept an hour) or by trying both. */
  private async pair(): Promise<{ pair: string; symbol: string }> {
    if (known && Date.now() - known.at < 3_600_000) return known;
    let found: { pair: string; symbol: string } | null = null;
    try {
      const list: any[] = await this.call("GET", "/asset_pairs");
      const m = list.find((x) => SYMBOLS.includes(String(x.base_asset?.symbol ?? "").toUpperCase()) && String(x.quote_asset?.symbol ?? "").toUpperCase() === "USDT");
      if (m) found = { pair: String(m.name), symbol: String(m.base_asset.symbol).toUpperCase() };
    } catch {
      /* no list: try the known names */
    }
    if (!found) {
      for (const symbol of SYMBOLS) {
        try {
          await this.call("GET", `/asset_pairs/${symbol}-USDT/ticker`);
          found = { pair: `${symbol}-USDT`, symbol };
          break;
        } catch {}
      }
    }
    if (!found) throw new Error("BigONE price feed unavailable");
    known = { ...found, at: Date.now() };
    return found;
  }

  async ticker(): Promise<Ticker & { bid: number; ask: number }> {
    const { pair } = await this.pair();
    const d = await this.call("GET", `/asset_pairs/${pair}/ticker`);
    const last = Number(d.close), open = Number(d.open);
    return { last, change: open > 0 ? ((last - open) / open) * 100 : 0, high: Number(d.high), low: Number(d.low), volume: Number(d.volume), bid: Number(d.bid?.price), ask: Number(d.ask?.price) };
  }

  /** Closing prices, oldest first. BigONE has fixed candle sizes, so the nearest one is used. */
  async candles(periodMinutes = 60, limit = 48): Promise<Candle[]> {
    const sizes: [number, string][] = [[1, "min1"], [5, "min5"], [15, "min15"], [30, "min30"], [60, "hour1"], [180, "hour3"], [240, "hour4"], [360, "hour6"], [720, "hour12"], [1440, "day1"]];
    let [size, name] = sizes[0]!;
    for (const s of sizes) if (s[0] <= periodMinutes) [size, name] = s;
    const count = Math.min(500, Math.ceil((limit * periodMinutes) / size));
    const { pair } = await this.pair();
    const d: any[] = await this.call("GET", `/asset_pairs/${pair}/candles?period=${name}&limit=${count}`);
    if (!Array.isArray(d)) throw new Error("BigONE price feed unavailable");
    return d
      .map((c) => ({ time: Math.floor(new Date(String(c.time)).getTime() / 1000), close: Number(c.close) }))
      .filter((c) => c.time > 0 && c.close > 0)
      .sort((a, b) => a.time - b.time);
  }

  async book(limit = 5): Promise<Book> {
    const { pair } = await this.pair();
    const d = await this.call("GET", `/asset_pairs/${pair}/depth?limit=${limit}`);
    const rows = (l: any[]) => (l ?? []).map((r) => [Number(r.price), Number(r.quantity)] as [number, number]);
    return { asks: rows(d.asks).sort((a, b) => a[0] - b[0]).slice(0, limit), bids: rows(d.bids).sort((a, b) => b[0] - a[0]).slice(0, limit) };
  }

  async balances(): Promise<{ prl: number; usdt: number; usdc: number }> {
    const list: any[] = await this.call("GET", "/viewer/accounts", undefined, true);
    // What can be traded: the balance minus what open orders already hold.
    const of = (s: string) => {
      const a = list.find((x) => x.asset_symbol === s);
      return Math.max(0, Number(a?.balance ?? 0) - Number(a?.locked_balance ?? 0));
    };
    return { prl: SYMBOLS.map(of).reduce((a, b) => a + b, 0), usdt: of("USDT"), usdc: of("USDC") };
  }

  /**
   * Buy or sell `volume` PRL at `price` USDT or better, at once: whatever
   * cannot be matched immediately is cancelled instead of waiting in the book.
   */
  async order(side: "buy" | "sell", volume: string, price: string): Promise<{ id: string; state: string }> {
    const { pair } = await this.pair();
    const d = await this.call("POST", "/viewer/orders", { asset_pair_name: pair, side: side === "buy" ? "BID" : "ASK", price, amount: volume, type: "LIMIT", immediate_or_cancel: true }, true);
    return { id: String(d.id), state: String(d.state) };
  }

  async depositAddress(): Promise<string> {
    const { symbol } = await this.pair();
    const d = await this.call("GET", `/viewer/assets/${symbol}/address`, undefined, true);
    // BigONE lists one address per chain it supports for the asset: keep the Pearl one.
    const list: any[] = Array.isArray(d) ? d : [d];
    const pearl = list.find((a) => typeof a?.value === "string" && /^prl1[0-9a-z]{20,}$/.test(a.value) && !a.memo);
    return String(pearl?.value ?? "");
  }
}
