// Market data for PRL from CoinGecko: market cap, supply, and a price history
// used when the exchange's own chart is unavailable. Read-only, no account.

const BASE = "https://api.coingecko.com/api/v3";
const ID = "pearl-2";

export interface MarketInfo {
  price: number; // USD
  change24h: number; // percent
  marketCap: number; // USD
  volume24h: number; // USD
  supply: number; // PRL in circulation
}
export interface Point {
  time: number; // unix seconds
  value: number;
}

const historyCache = new Map<number, { at: number; data: { prices: Point[]; caps: Point[] } }>();

export class MarketData {
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async get(path: string): Promise<any> {
    const res = await this.fetcher(BASE + path);
    if (!res.ok) throw new Error("Market data unavailable");
    return res.json();
  }

  /** Today's ETH price in dollars, for the Ethereum lines of the wallet. */
  async ethPrice(): Promise<number | null> {
    const j = await this.get("/simple/price?ids=ethereum&vs_currencies=usd");
    const p = Number(j?.ethereum?.usd);
    return Number.isFinite(p) && p > 0 ? p : null;
  }

  async info(): Promise<MarketInfo> {
    const [c] = await this.get(`/coins/markets?vs_currency=usd&ids=${ID}`);
    if (!c) throw new Error("Market data unavailable");
    return {
      price: Number(c.current_price),
      change24h: Number(c.price_change_percentage_24h ?? 0),
      marketCap: Number(c.market_cap ?? 0),
      volume24h: Number(c.total_volume ?? 0),
      supply: Number(c.circulating_supply ?? 0),
    };
  }

  /** Price and market-cap history in USD over the last `days` days. */
  async history(days: number): Promise<{ prices: Point[]; caps: Point[] }> {
    // The free CoinGecko API limits how often it can be asked: a series is kept for 5 minutes.
    const hit = historyCache.get(days);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.data;
    const j = await this.get(`/coins/${ID}/market_chart?vs_currency=usd&days=${days}`);
    const pts = (l: number[][]) => (l ?? []).map((p) => ({ time: Math.floor(p[0]! / 1000), value: Number(p[1]) })).filter((p) => p.value > 0);
    const data = { prices: pts(j.prices), caps: pts(j.market_caps) };
    if (data.prices.length > 1) historyCache.set(days, { at: Date.now(), data });
    return data;
  }
}
