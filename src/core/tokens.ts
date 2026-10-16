// PRL-20 tokens: memecoins and other tokens issued on Pearl as inscriptions,
// indexed by Pearlscriptions. Read-only market view.

const BASE = "https://www.pearlscriptions.com";
export const TOKEN_MARKET_URL = BASE + "/market";

/** A file, picture or text inscribed on Pearl and owned by one of the wallet's coins. Read-only: Keshi shows it and never spends the coin that holds it. */
export interface Inscription {
  id: string;
  /** Canonical number (-1 when the index did not give one). */
  number: number;
  contentType: string;
  image: boolean;
  /** First characters of a text inscription, as the index gives them. */
  preview: string;
  bytes: number;
  /** The coin that holds it, "txid:vout". */
  outpoint: string;
  marker: string;
}

/** Raster formats only: an SVG can carry scripts, so it is listed but never drawn. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 400_000;

export interface Token {
  ticker: string;
  name: string; // display ticker
  maxSupply: number;
  minted: number;
  holders: number;
  mintProgress: number; // percent
  mintFeePrl: number;
  /** Tokens received per mint. */
  perMint: number;
  /** The exact per-mint amount as whole-number text; empty when the index gave something else. */
  perMintText: string;
  remaining: number;
  /** The inscription that created the token: its unique identifier (there is no contract address). */
  deployId: string;
  /** Cheapest active listing, in grains per token. Undefined when nothing is for sale. */
  floorGrains?: number;
  listings: number;
}

export class TokenIndex {
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async get(path: string): Promise<any> {
    const res = await this.fetcher(BASE + path);
    if (!res.ok) throw new Error("Token index unavailable");
    return res.json();
  }

  /** PRL-20 balances of one address: ticker -> whole-token amount (as text, can be huge). */
  async balances(address: string): Promise<Record<string, string>> {
    const j = await this.get(`/api/addresses/${address}/balances`);
    return j.tokens ?? {};
  }

  /**
   * Whether the index has accepted a token transfer on `outpoint` ("txid:vout"):
   * the coin is listed at `address` with a transfer lot on it. Until then the
   * coin must not be sent, or the tokens would not travel with it.
   */
  async transferReady(address: string, outpoint: string): Promise<boolean> {
    return (await this.transferState(address, outpoint)) === "ready";
  }

  /**
   * "ready": the coin carries an accepted transfer lot. "refused": the index
   * has the coin and its inscription but made no lot of it (the note was not
   * valid, so no token moved). "unknown": the index has not seen it yet.
   */
  async transferState(address: string, outpoint: string): Promise<"ready" | "refused" | "unknown"> {
    for (let page = 1; page <= 20; page++) {
      const j = await this.get(`/api/addresses/${address}/utxos?limit=100&page=${page}`);
      if (!j || !Array.isArray(j.utxos)) throw new Error("Token index answered in an unexpected form");
      const hit = j.utxos.find((u: any) => `${u.txid}:${u.vout}` === outpoint);
      if (hit) return hit.transferLotId ? "ready" : hit.inscriptionId ? "refused" : "unknown";
      if (!j.hasNext) break;
    }
    return "unknown";
  }

  /** Coins of an address that carry an inscription or a transfer lot. */
  async protectedOutpoints(address: string): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 20; page++) {
      const j = await this.get(`/api/addresses/${address}/utxos?limit=100&page=${page}`);
      if (!j || !Array.isArray(j.utxos)) throw new Error("Token index answered in an unexpected form");
      if (page === 20 && j.hasNext) throw new Error("Too many coins to check");
      for (const u of j.utxos) if (u.protected || u.spendable === false || u.inscriptionId || u.transferLotId) out.push(`${u.txid}:${u.vout}`);
      if (!j.hasNext) break;
    }
    return out;
  }

  /** Inscriptions (files, images, text, collections) an address owns. PRL-20 operations are left out: tokens have their own list. */
  async inscriptions(address: string): Promise<Inscription[]> {
    const out: Inscription[] = [];
    for (let page = 1; page <= 5; page++) {
      const j = await this.get(`/api/addresses/${address}/inscriptions?limit=100&page=${page}`);
      const items = Array.isArray(j?.inscriptions) ? j.inscriptions : Array.isArray(j?.items) ? j.items : [];
      for (const x of items) {
        const marker = String(x.protocolMarker ?? x.marker ?? "");
        if (marker === "prl-20") continue;
        const id = String(x.id ?? x.inscriptionId ?? "");
        if (!id) continue;
        const type = String(x.contentType ?? "").toLowerCase().split(";")[0]!.trim();
        out.push({
          id,
          number: Number.isFinite(Number(x.inscriptionNumber)) ? Number(x.inscriptionNumber) : -1,
          contentType: type,
          image: IMAGE_TYPES.has(type),
          preview: typeof x.bodyPreview === "string" ? x.bodyPreview.slice(0, 160) : "",
          bytes: Number(x.byteLength ?? 0) || 0,
          outpoint: String(x.currentOutpoint ?? x.ownerOutpoint ?? ""),
          marker,
        });
      }
      if (!j?.hasNext) break;
    }
    return out;
  }

  /** The picture of an image inscription, as a data: URL the popup can show. Small files only; anything else gives undefined. */
  async inscriptionImage(ins: Inscription): Promise<string | undefined> {
    if (!ins.image || ins.bytes > MAX_IMAGE_BYTES) return undefined;
    const j = await this.get(`/api/inscriptions/${encodeURIComponent(ins.id)}/content`);
    const b64 = typeof j?.bodyBase64 === "string" ? j.bodyBase64 : "";
    const type = String(j?.contentType ?? "").toLowerCase().split(";")[0]!.trim();
    if (!b64 || !IMAGE_TYPES.has(type) || b64.length > MAX_IMAGE_BYTES * 1.4 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return undefined;
    return `data:${type};base64,${b64}`;
  }

  async tokens(): Promise<Token[]> {
    const [t, l] = await Promise.all([this.get("/api/tokens?limit=200"), this.get("/api/market/listings").catch(() => ({ listings: [] }))]);
    const floor = new Map<string, { min: number; n: number }>();
    for (const x of l.listings ?? []) {
      if (x.assetType !== "prl-20" || x.status !== "active" || x.valid === false) continue;
      const tick = String(x.asset?.ticker ?? x.tick ?? "").toLowerCase();
      const unit = Number(x.unitPriceGrain ?? x.asset?.unitPriceGrain);
      if (!tick || !(unit > 0)) continue;
      const f = floor.get(tick) ?? { min: Infinity, n: 0 };
      floor.set(tick, { min: Math.min(f.min, unit), n: f.n + 1 });
    }
    const list: Token[] = (t.tokens ?? []).map((x: any) => {
      const tick = String(x.ticker).toLowerCase();
      const f = floor.get(tick);
      return {
        ticker: tick,
        name: String(x.displayTicker ?? x.ticker).toUpperCase(),
        maxSupply: Number(x.maxSupply ?? 0),
        minted: Number(x.mintedSupply ?? 0),
        holders: Number(x.holderCount ?? 0),
        mintProgress: Number(x.mintProgress ?? 0),
        mintFeePrl: Number(x.mintFeePrl ?? 0),
        perMint: Number(x.mintAmount ?? x.mintLimit ?? 0),
        perMintText: /^\d{1,60}$/.test(String(x.mintAmount ?? x.mintLimit ?? "")) ? String(x.mintAmount ?? x.mintLimit) : Number.isSafeInteger(Number(x.mintAmount ?? x.mintLimit)) && Number(x.mintAmount ?? x.mintLimit) > 0 ? String(Number(x.mintAmount ?? x.mintLimit)) : "",
        remaining: Number(x.remainingSupply ?? 0),
        deployId: String(x.deployInscriptionId ?? ""),
        floorGrains: f?.min,
        listings: f?.n ?? 0,
      };
    });
    return list.sort((a, b) => b.holders - a.holders || b.minted - a.minted);
  }
}

/** Value of every minted token at the cheapest listing price, in PRL. */
export const tokenCapPrl = (t: Token): number | undefined => (t.floorGrains ? (t.floorGrains / 1e8) * t.minted : undefined);

/** Whole-number text for amounts: the API can return more than a JS number holds exactly. */
export const wholeAmount = (t: Pick<Token, "perMint" | "perMintText">): string => {
  if (t.perMintText) return t.perMintText;
  if (!Number.isSafeInteger(t.perMint) || t.perMint <= 0) throw new Error("This token's mint amount cannot be read exactly. Nothing was sent.");
  return String(t.perMint);
};

/** The text a mint inscription carries for this token. */
export const mintMessage = (t: Token): string => `{"p":"prl-20","op":"mint","tick":"${t.ticker}","amt":"${wholeAmount(t)}"}`;

/** Add up balances from several addresses. */
export function sumBalances(list: Record<string, string>[]): Record<string, bigint> {
  const total: Record<string, bigint> = {};
  for (const b of list) for (const [k, v] of Object.entries(b)) if (/^\d+$/.test(v)) total[k.toLowerCase()] = (total[k.toLowerCase()] ?? 0n) + BigInt(v);
  return total;
}
