import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// PearlBridge: moves PRL to Ethereum as wPRL (an ERC-20 token) and back.
// Keshi only uses its public, read-only API (api.pearlbridge.xyz/v1). The
// bridge is run by PearlBridge, not by Keshi: PRL sent to a deposit address
// is locked by them and wPRL is issued to the Ethereum address it belongs to.

const BASE = "https://api.pearlbridge.xyz/v1";
export const BRIDGE_SITE = "https://pearlbridge.xyz/";

/** wPRL token contract on Ethereum. A different answer from the API means something is wrong. */
export const WPRL_CONTRACT = "0x07696DcaB55E62cfef953666b29Fe1970518cB00";
/** The bridge contract that takes wPRL back. */
export const BRIDGE_CONTROLLER = "0xA6571B73489d4eBFA269a107208665dF7C80Aef5";

export interface BridgeQuote {
  amount: bigint;
  fee: bigint;
  net: bigint; // wPRL received, in grains (wPRL has 8 decimals like PRL)
  slow: boolean; // large amounts wait before release
  delaySeconds: number;
  confirmations: number;
  paused: boolean;
  withinDailyCap: boolean;
}

export interface CrossingStatus {
  /** pending: waiting for confirmations or issuing; done: wPRL issued; refunded; failed; review: held by the bridge. */
  phase: "pending" | "done" | "refunded" | "failed" | "review";
  ethTx?: string;
  detail?: string;
}

/** True for a well-formed Ethereum address; mixed-case ones must carry a valid checksum. */
export function isEthAddress(a: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const ch = body[i]!;
    if (/[a-fA-F]/.test(ch) && (parseInt(hash[i]!, 16) >= 8) !== (ch === ch.toUpperCase())) return false;
  }
  return true;
}

const grains = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("The bridge sent an unreadable answer");
  return BigInt(v);
};

export class Bridge {
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async get(path: string): Promise<any> {
    const res = await this.fetcher(BASE + path, { headers: { accept: "application/json" } });
    if (!res.ok && res.status !== 404) throw new Error("The bridge is not answering right now");
    const j = await res.json();
    if (!j || typeof j !== "object") throw new Error("The bridge sent an unreadable answer");
    return j;
  }

  async quote(amount: bigint): Promise<BridgeQuote> {
    const [q, s] = await Promise.all([this.get(`/quote/mint?amountGrains=${amount}`), this.get("/status")]);
    if (q.error) throw new Error(String(q.error));
    if (String(s.contracts?.wprl).toLowerCase() !== WPRL_CONTRACT.toLowerCase())
      throw new Error("The bridge reports an unexpected wPRL contract. Nothing was sent.");
    return {
      amount: grains(q.amountGrains),
      fee: grains(q.feeGrains),
      net: grains(q.netGrains),
      slow: q.lane === "slow",
      delaySeconds: Number(q.slowLaneDelaySeconds ?? 0),
      confirmations: Number(q.confirmationsRequired ?? 6),
      paused: q.paused === true || s.paused === true,
      withinDailyCap: q.withinDailyCap !== false,
    };
  }

  /** The PRL address to pay so that wPRL is issued to `eth`. */
  async depositAddress(eth: string): Promise<string> {
    if (!isEthAddress(eth)) throw new Error("That is not a valid Ethereum address");
    const j = await this.get(`/deposit-address?ethAddress=${eth}`);
    if (j.error) throw new Error(String(j.error));
    if (typeof j.pearlAddress !== "string" || String(j.ethAddress).toLowerCase() !== eth.toLowerCase())
      throw new Error("The bridge sent an unreadable answer");
    return j.pearlAddress;
  }

  /** Quote for sending wPRL back to PRL. Checks that the bridge names the contracts Keshi expects. */
  async quoteBack(amount: bigint, pearlAddress: string): Promise<{ amount: bigint; fee: bigint; net: bigint; paused: boolean; withinDailyCap: boolean }> {
    const q = await this.get(`/quote/burn?amountGrains=${amount}&pearlAddress=${encodeURIComponent(pearlAddress)}`);
    if (q.error) throw new Error(String(q.error));
    if (q.addressCheck && q.addressCheck.valid !== true) throw new Error("The bridge does not accept this PRL address");
    const steps = q.transaction?.steps ?? [];
    const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
    if (Number(q.transaction?.chainId) !== 1 || !same(steps[0]?.to, WPRL_CONTRACT) || !same(steps[1]?.to, BRIDGE_CONTROLLER) || !same(steps[0]?.args?.[0], BRIDGE_CONTROLLER))
      throw new Error("The bridge reports unexpected contracts. Nothing was sent.");
    return { amount: grains(q.amountGrains), fee: grains(q.feeGrains), net: grains(q.netGrains), paused: q.paused === true, withinDailyCap: q.withinDailyCap !== false };
  }

  /** Status of a return trip, by the hash of its Ethereum transaction. */
  async backStatus(ethTxHash: string): Promise<CrossingStatus & { pearlTx?: string }> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ethTxHash)) throw new Error("Invalid transaction");
    const j = await this.get(`/burns/${ethTxHash}`);
    const state = typeof j.state === "string" ? j.state : "";
    const pearlTx = typeof j.pearlTxId === "string" && /^[0-9a-f]{64}$/i.test(j.pearlTxId) ? j.pearlTxId : undefined;
    if (state === "finalized") return { phase: "done", pearlTx };
    if (state === "failed" || state === "reorged") return { phase: "failed", pearlTx };
    if (!state || ["pending", "signing", "submitted"].includes(state)) return { phase: "pending", pearlTx };
    return { phase: "review", detail: typeof j.anomalyReason === "string" ? j.anomalyReason : undefined, pearlTx };
  }

  async status(pearlTxid: string): Promise<CrossingStatus> {
    if (!/^[0-9a-f]{64}$/i.test(pearlTxid)) throw new Error("Invalid transaction");
    const j = await this.get(`/mints/${pearlTxid}`);
    const ethTx = typeof j.mintTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.mintTxHash) ? j.mintTxHash : undefined;
    if (j.refundedAt != null) return { phase: "refunded", detail: "The bridge sent your PRL back" };
    const state = typeof j.state === "string" ? j.state : "";
    if (state === "minted" || state === "finalized") return { phase: "done", ethTx };
    if (state === "failed" || state === "cancelled") return { phase: "failed", detail: typeof j.cancelReason === "string" ? j.cancelReason : undefined };
    if (!state || ["pending", "queued", "signing", "submitted", "submitted_stuck"].includes(state)) return { phase: "pending", ethTx };
    return { phase: "review", detail: typeof j.anomalyReason === "string" ? j.anomalyReason : undefined };
  }
}

/**
 * Refuse an amount the bridge contract would not process. A PRL deposit below
 * its minimum is not turned into wPRL, so it must be caught before sending.
 * Checked on what arrives after the bridge fee, to stay on the safe side.
 */
export function checkBridgeBounds(amount: bigint, net: bigint, bounds: { min: bigint; max: bigint }, format: (v: bigint) => string): void {
  if (net < bounds.min) throw new Error(`The bridge accepts ${format(bounds.min)} PRL or more after its fee. Enter a larger amount.`);
  if (bounds.max > 0n && amount > bounds.max) throw new Error(`The bridge accepts at most ${format(bounds.max)} PRL at a time. Enter a smaller amount.`);
}
