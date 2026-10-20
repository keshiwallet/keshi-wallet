import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { remoteText } from "./network";

// SafeTrade (the exchange where PRL trades against USDT and USDC). Prices and the order book
// are public. Orders are placed with the user's OWN SafeTrade API key, straight
// from their device: the wallet never holds their exchange funds.

const BASE = "https://safe.trade/api/v2/peatio";
/** The coin's id on SafeTrade: "prl" until 18 October 2026, "pearl" since. Both are accepted. */
const COIN_IDS = ["pearl", "prl"];
export type Quote = "usdt" | "usdc";

export interface Ticker {
  last: number;
  change: number; // percent over 24h
  high: number;
  low: number;
  volume: number;
}
export interface Book {
  asks: [number, number][]; // price, amount (lowest first)
  bids: [number, number][]; // highest first
}
export interface Candle {
  time: number;
  close: number;
}

export class Exchange {
  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private creds?: { key: string; secret: string },
    readonly quote: Quote = "usdt",
  ) {}

  /**
   * SafeTrade renamed the coin's ticker from PRL to PEARL on 18 October 2026, which changes the
   * market id in its API (prlusdt -> pearlusdt). Rather than guessing, the market list is read
   * once and the pair is found by its coins, under either name; the answer is kept for an hour.
   */
  private static known = new Map<Quote, { market: string; coin: string; at: number }>();
  private async resolve(): Promise<{ market: string; coin: string }> {
    const hit = Exchange.known.get(this.quote);
    if (hit && Date.now() - hit.at < 3_600_000) return hit;
    let found: { market: string; coin: string } | null = null;
    try {
      const list: any[] = await this.pub("/markets");
      const ours = (m: any) => COIN_IDS.includes(String(m.base_unit ?? "").toLowerCase()) && String(m.quote_unit ?? "").toLowerCase() === this.quote;
      const m = list.find((x) => ours(x) && x.state === "enabled") ?? list.find(ours);
      if (m) found = { market: String(m.id), coin: String(m.base_unit).toLowerCase() };
    } catch {
      /* the list is unavailable: try the known names below */
    }
    if (!found) {
      for (const coin of COIN_IDS) {
        try {
          await this.pub(`/markets/${coin + this.quote}/tickers`);
          found = { market: coin + this.quote, coin };
          break;
        } catch {}
      }
    }
    if (!found) throw new Error("Price feed unavailable");
    Exchange.known.set(this.quote, { ...found, at: Date.now() });
    return found;
  }

  private async pub(path: string): Promise<any> {
    const res = await this.fetcher(`${BASE}/public${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error("Price feed unavailable");
    return res.json();
  }

  async ticker(): Promise<Ticker> {
    const { market } = await this.resolve();
    const j = await this.pub(`/markets/${market}/tickers`);
    const t = j.ticker ?? j;
    return {
      last: Number(t.last),
      change: parseFloat(String(t.price_change_percent ?? "0")),
      high: Number(t.high),
      low: Number(t.low),
      volume: Number(t.vol ?? t.volume ?? 0),
    };
  }

  async book(limit = 12): Promise<Book> {
    const { market } = await this.resolve();
    const j = await this.pub(`/markets/${market}/depth?limit=${limit}`);
    const rows = (l: any[]) => (l ?? []).map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
    return {
      asks: rows(j.asks).sort((a, b) => a[0] - b[0]).slice(0, limit),
      bids: rows(j.bids).sort((a, b) => b[0] - a[0]).slice(0, limit),
    };
  }

  async candles(periodMinutes = 60, limit = 48): Promise<Candle[]> {
    const { market } = await this.resolve();
    const j: number[][] = await this.pub(`/markets/${market}/k-line?period=${periodMinutes}&limit=${limit}`);
    if (!Array.isArray(j)) throw new Error("Price feed unavailable");
    return j.map((c) => ({ time: c[0]!, close: Number(c[4]) })).filter((c) => c.close > 0);
  }

  get connected(): boolean {
    return !!this.creds;
  }

  private async priv(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<any> {
    if (!this.creds) throw new Error("Connect your SafeTrade API key first");
    const nonce = Date.now().toString();
    const signature = bytesToHex(hmac(sha256, new TextEncoder().encode(this.creds.secret), new TextEncoder().encode(nonce + this.creds.key)));
    const res = await this.fetcher(BASE + path, {
      method,
      headers: {
        "X-Auth-Apikey": this.creds.key,
        "X-Auth-Nonce": nonce,
        "X-Auth-Signature": signature,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(Array.isArray(j.errors) ? remoteText("SafeTrade", j.errors.join(", ")) : "The exchange refused the request");
    return j;
  }

  async balances(): Promise<{ prl: number; usdt: number; usdc: number }> {
    const list: any[] = await this.priv("GET", "/account/balances");
    const of = (c: string) => Number(list.find((b) => String(b.currency).toLowerCase() === c)?.balance ?? 0);
    return { prl: COIN_IDS.map(of).reduce((a, b) => a + b, 0), usdt: of("usdt"), usdc: of("usdc") };
  }

  async order(side: "buy" | "sell", volume: string, price?: string): Promise<{ id: string; state: string }> {
    const { market } = await this.resolve();
    const body: Record<string, string> = { market, side, volume, ord_type: price ? "limit" : "market" };
    if (price) body.price = price;
    const j = await this.priv("POST", "/market/orders", body);
    return { id: String(j.id), state: String(j.state) };
  }

  /** The address to send PRL to in order to sell it on the exchange. */
  async depositAddress(): Promise<string> {
    const { coin } = await this.resolve();
    const j = await this.priv("GET", `/account/deposit_address/${coin}`);
    return String(j.address ?? "");
  }
}

/**
 * What `qty` PRL really costs (or brings) when it eats through an order book:
 * the levels are taken in order until the quantity is filled. `avg` is the
 * average price per PRL for the part that fills; `filled` says how much the
 * book could take, so a thin market is not shown as its top price.
 */
export function walkBook(levels: [number, number][], qty: number): { avg: number; filled: number; enough: boolean } {
  let left = qty;
  let cost = 0;
  for (const [price, size] of levels) {
    if (left <= 0) break;
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, left);
    cost += take * price;
    left -= take;
  }
  const filled = qty - left;
  return { avg: filled > 0 ? cost / filled : 0, filled, enough: left <= 1e-9 };
}
