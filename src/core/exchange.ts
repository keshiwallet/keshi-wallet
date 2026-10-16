import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// SafeTrade (the exchange where PRL trades against USDT and USDC). Prices and the order book
// are public. Orders are placed with the user's OWN SafeTrade API key, straight
// from their device: the wallet never holds their exchange funds.

const BASE = "https://safe.trade/api/v2/peatio";
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

  private get market(): string {
    return "prl" + this.quote;
  }

  private async pub(path: string): Promise<any> {
    const res = await this.fetcher(`${BASE}/public${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error("Price feed unavailable");
    return res.json();
  }

  async ticker(): Promise<Ticker> {
    const j = await this.pub(`/markets/${this.market}/tickers`);
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
    const j = await this.pub(`/markets/${this.market}/depth?limit=${limit}`);
    const rows = (l: any[]) => (l ?? []).map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
    return {
      asks: rows(j.asks).sort((a, b) => a[0] - b[0]).slice(0, limit),
      bids: rows(j.bids).sort((a, b) => b[0] - a[0]).slice(0, limit),
    };
  }

  async candles(periodMinutes = 60, limit = 48): Promise<Candle[]> {
    const j: number[][] = await this.pub(`/markets/${this.market}/k-line?period=${periodMinutes}&limit=${limit}`);
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
    if (!res.ok) throw new Error(Array.isArray(j.errors) ? j.errors.join(", ") : "The exchange refused the request");
    return j;
  }

  async balances(): Promise<{ prl: number; usdt: number; usdc: number }> {
    const list: any[] = await this.priv("GET", "/account/balances");
    const of = (c: string) => Number(list.find((b) => b.currency === c)?.balance ?? 0);
    return { prl: of("prl"), usdt: of("usdt"), usdc: of("usdc") };
  }

  async order(side: "buy" | "sell", volume: string, price?: string): Promise<{ id: string; state: string }> {
    const body: Record<string, string> = { market: this.market, side, volume, ord_type: price ? "limit" : "market" };
    if (price) body.price = price;
    const j = await this.priv("POST", "/market/orders", body);
    return { id: String(j.id), state: String(j.state) };
  }

  /** The address to send PRL to in order to sell it on the exchange. */
  async depositAddress(): Promise<string> {
    const j = await this.priv("GET", "/account/deposit_address/prl");
    return String(j.address ?? "");
  }
}
