import { MAX_FEE_RATE } from "./send";
import { COINBASE_MATURITY, type Network } from "./network";

// Client for Pearl's public Blockbook indexer. Looks addresses up one by one
// (never sends an extended public key, which would link the whole wallet).

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  address: string;
  confirmations: number;
  coinbase: boolean;
}

export interface RawTx {
  txid: string;
  blockHeight?: number;
  blockTime?: number;
  confirmations: number;
  fees?: string;
  vin: { addresses?: string[]; value?: string; coinbase?: string; isAddress?: boolean }[];
  vout: { n: number; addresses?: string[]; value?: string }[];
}

export interface AddressInfo {
  address: string;
  balance: bigint;
  unconfirmed: bigint;
  received: bigint;
  txCount: number;
  txs: RawTx[];
}

export class Indexer {
  constructor(
    readonly net: Network,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async get(path: string): Promise<any> {
    let lastErr: unknown;
    for (const wait of [0, 600, 1500, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const res = await this.fetcher(this.net.indexer + path, { cache: "no-store" });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`Network busy (${res.status})`);
          continue;
        }
        const json = await res.json();
        if (json && typeof json.error === "string") throw new Error(json.error);
        if (!res.ok) throw new Error(`Indexer error ${res.status}`);
        return json;
      } catch (e) {
        lastErr = e;
        if (e instanceof Error && !/busy|fetch|network/i.test(e.message)) throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Could not reach the Pearl network");
  }

  async status(): Promise<{ height: number; inSync: boolean }> {
    const j = await this.get("/api/v2");
    return { height: j.blockbook.bestHeight, inSync: !!j.blockbook.inSync };
  }

  /**
   * Balance and history of one address. The history is read page by page, up
   * to `maxPages` × 1,000 transactions: a mining address can hold thousands of
   * payouts, and a history cut at the first page would hide older rewards.
   */
  async address(address: string, withTxs = true, maxPages = 5): Promise<AddressInfo> {
    const j = await this.get(`/api/v2/address/${address}?details=${withTxs ? "txs&pageSize=1000" : "basic"}`);
    const txs: RawTx[] = j.transactions ?? [];
    const pages = withTxs ? Math.min(maxPages, Number(j.totalPages) || 1) : 1;
    for (let page = 2; page <= pages; page++) {
      const more = await this.get(`/api/v2/address/${address}?details=txs&pageSize=1000&page=${page}`);
      txs.push(...((more.transactions as RawTx[]) ?? []));
    }
    return {
      address,
      balance: BigInt(j.balance ?? "0"),
      unconfirmed: BigInt(j.unconfirmedBalance ?? "0"),
      received: BigInt(j.totalReceived ?? "0"),
      txCount: (j.txs ?? 0) + (j.unconfirmedTxs ?? 0),
      txs,
    };
  }

  /** One transaction, with its inputs and outputs. */
  async tx(txid: string): Promise<RawTx & { vsize?: number; size?: number; vin: { txid?: string; vout?: number; sequence?: number; addresses?: string[]; value?: string; coinbase?: string; isAddress?: boolean }[] }> {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("Invalid transaction");
    return this.get(`/api/v2/tx/${txid}`);
  }

  async utxos(address: string): Promise<Utxo[]> {
    const list: any[] = await this.get(`/api/v2/utxo/${address}`);
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      address,
      confirmations: u.confirmations ?? 0,
      coinbase: !!u.coinbase,
    }));
  }

  /** Fee in grains per vbyte to confirm within about `blocks` blocks. */
  async feeRate(blocks: number): Promise<number> {
    try {
      const j = await this.get(`/api/v2/estimatefee/${blocks}`);
      const perKb = Number(j.result);
      if (!Number.isFinite(perKb) || perKb <= 0) return 1;
      return Math.min(MAX_FEE_RATE, Math.max(1, Math.ceil((perKb * 1e8) / 1000)));
    } catch {
      return 1;
    }
  }

  async broadcast(hex: string): Promise<string> {
    const res = await this.fetcher(this.net.indexer + "/api/v2/sendtx/", { method: "POST", body: hex });
    const j = await res.json().catch(() => ({}));
    if (res.ok && typeof j.result === "string" && /^[0-9a-fA-F]{64}$/.test(j.result)) return j.result;
    const reason = j.error?.message ?? j.error;
    // A clear "no" from the node (a 4xx answer with its reason): the transaction did not go out.
    if (res.status >= 400 && res.status < 500 && res.status !== 429 && typeof reason === "string") throw new Rejected(reason.slice(0, 200));
    // Anything else (gateway error, overload, unreadable answer) says nothing about whether it went out.
    throw new Error("The network did not give a clear answer");
  }
}

/** The network looked at a transaction and refused it (as opposed to a lost connection). */
export class Rejected extends Error {}

export const isCoinbaseTx = (tx: RawTx): boolean =>
  tx.vin.length > 0 && tx.vin.every((i) => !!i.coinbase || (i.isAddress === false && !i.addresses?.length && !i.value));

export const isImmature = (u: Utxo): boolean => u.coinbase && u.confirmations < COINBASE_MATURITY;
