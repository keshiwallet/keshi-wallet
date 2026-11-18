import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { remoteText } from "./network";
import { readJsonCapped } from "./pools";

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
  /**
   * pending: waiting for confirmations or issuing; done: wPRL issued; refunded; failed; review: held by the bridge
   * (its documented "under_review"); unknown: a state Keshi does not know. Neither review nor unknown is an end:
   * a crossing in one of them is asked about again.
   */
  phase: "pending" | "done" | "refunded" | "failed" | "review" | "unknown";
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

/** The most an answer of the bridge may weigh, in bytes. Its largest real answers are a few kilobytes. */
export const BRIDGE_MAX_BYTES = 65_536;

/** A count or a delay from the bridge's quote: a whole number within bounds, or the answer is refused as unreadable. */
function waitFigure(v: unknown, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("The bridge sent an unreadable answer");
  return n;
}

/** The bridge's documented hold ("under_review"), or an answer that carries a reason for one. */
const isReview = (j: any, state: string) => state === "under_review" || state === "review" || (typeof j.anomalyReason === "string" && j.anomalyReason.length > 0);

/** The phases after which nothing more can happen to a crossing. */
export const isFinal = (phase: CrossingStatus["phase"]) => phase === "done" || phase === "refunded" || phase === "failed";

export class Bridge {
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async get(path: string): Promise<any> {
    // Fifteen seconds and 64 kB at most, counted in bytes while the answer is read, before anything is decoded:
    // a bridge that hangs or floods is given up on, not waited for and not held in memory.
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined;
    const res = await this.fetcher(BASE + path, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (!res.ok && res.status !== 404) throw new Error("The bridge is not answering right now");
    let j: unknown;
    try {
      j = await readJsonCapped(res, BRIDGE_MAX_BYTES);
    } catch {
      throw new Error("The bridge sent an unreadable answer");
    }
    if (!j || typeof j !== "object") throw new Error("The bridge sent an unreadable answer");
    return j;
  }

  async quote(amount: bigint): Promise<BridgeQuote> {
    const [q, s] = await Promise.all([this.get(`/quote/mint?amountGrains=${amount}`), this.get("/status")]);
    if (q.error) throw new Error(remoteText("PearlBridge", q.error));
    if (String(s.contracts?.wprl).toLowerCase() !== WPRL_CONTRACT.toLowerCase())
      throw new Error("The bridge reports an unexpected wPRL contract. Nothing was sent.");
    return {
      amount: grains(q.amountGrains),
      fee: grains(q.feeGrains),
      net: grains(q.netGrains),
      slow: q.lane === "slow",
      delaySeconds: waitFigure(q.slowLaneDelaySeconds ?? 0, 0, 30 * 86400),
      confirmations: waitFigure(q.confirmationsRequired ?? 6, 1, 10_000),
      paused: q.paused === true || s.paused === true,
      withinDailyCap: q.withinDailyCap !== false,
    };
  }

  /** The PRL address to pay so that wPRL is issued to `eth`. */
  async depositAddress(eth: string): Promise<string> {
    if (!isEthAddress(eth)) throw new Error("That is not a valid Ethereum address");
    const j = await this.get(`/deposit-address?ethAddress=${eth}`);
    if (j.error) throw new Error(remoteText("PearlBridge", j.error));
    if (typeof j.pearlAddress !== "string" || String(j.ethAddress).toLowerCase() !== eth.toLowerCase())
      throw new Error("The bridge sent an unreadable answer");
    return j.pearlAddress;
  }

  /** Quote for sending wPRL back to PRL. Checks that the bridge names the contracts Keshi expects. */
  async quoteBack(amount: bigint, pearlAddress: string): Promise<{ amount: bigint; fee: bigint; net: bigint; paused: boolean; withinDailyCap: boolean }> {
    const q = await this.get(`/quote/burn?amountGrains=${amount}&pearlAddress=${encodeURIComponent(pearlAddress)}`);
    if (q.error) throw new Error(remoteText("PearlBridge", q.error));
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
    // PearlBridge's documentation names the end of a return trip "unlocked".
    if (state === "unlocked" || state === "finalized") return { phase: "done", pearlTx };
    if (state === "failed" || state === "reorged") return { phase: "failed", pearlTx };
    if (!state || ["pending", "signing", "submitted"].includes(state)) return { phase: "pending", pearlTx };
    if (isReview(j, state)) return { phase: "review", detail: typeof j.anomalyReason === "string" ? j.anomalyReason : undefined, pearlTx };
    // A word Keshi does not know is not a hold: it is said to be unknown, and asked about again.
    return { phase: "unknown", pearlTx };
  }

  async status(pearlTxid: string): Promise<CrossingStatus> {
    if (!/^[0-9a-f]{64}$/i.test(pearlTxid)) throw new Error("Invalid transaction");
    const j = await this.get(`/mints/${pearlTxid}`);
    const ethTx = typeof j.mintTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.mintTxHash) ? j.mintTxHash : undefined;
    if (j.refundedAt != null) return { phase: "refunded", detail: "The bridge sent your PRL back" };
    const state = typeof j.state === "string" ? j.state : "";
    if (state === "minted" || state === "finalized") return { phase: "done", ethTx };
    if (state === "failed" || state === "cancelled") return { phase: "failed", detail: typeof j.cancelReason === "string" ? j.cancelReason : undefined };
    if (!state || ["pending", "attested", "queued", "signing", "submitted", "submitted_stuck", "stuck"].includes(state)) return { phase: "pending", ethTx };
    if (isReview(j, state)) return { phase: "review", detail: typeof j.anomalyReason === "string" ? j.anomalyReason : undefined };
    // A word Keshi does not know is not a hold: it is said to be unknown, and asked about again.
    return { phase: "unknown" };
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

/* ------------------------------------------------------------------ 1.0.6b: fee advice, progress, arrival alert */

/** PearlBridge's fee on the way to Ethereum, as it announces it: 0.5%, and at least 4 PRL per crossing. */
export const BRIDGE_FEE_BPS = 50n;
export const BRIDGE_MIN_FEE = 400_000_000n;
/** The amount from which the percentage applies and the minimum no longer does: 4 PRL / 0.5% = 800 PRL. */
export const BRIDGE_PERCENT_FROM = (BRIDGE_MIN_FEE * 10_000n) / BRIDGE_FEE_BPS;

export interface FeeAdvice {
  /** The bridge's fee as a share of the amount, in percent (one decimal). */
  percent: number;
  /** True when the fee is above the bridge's percentage: its minimum applied. */
  minimum: boolean;
  /** The amount from which this same fee would be the plain percentage. */
  percentFrom: bigint;
}

/** What the bridge's fee weighs on this amount, from the figures of its own quote. Null when there is nothing to say. */
export function bridgeFeeAdvice(amount: bigint, fee: bigint): FeeAdvice | null {
  if (amount <= 0n || fee <= 0n || fee >= amount) return null;
  const percent = Number((fee * 1000n) / amount) / 10;
  // A grain of rounding is not a minimum.
  const minimum = fee * 10_000n > amount * BRIDGE_FEE_BPS + 10_000n;
  return { percent, minimum, percentFrom: (fee * 10_000n) / BRIDGE_FEE_BPS };
}

export interface CrossingProgress {
  /** confirming: Pearl confirmations still counting; delay: the bridge's safety delay; issuing: the bridge is issuing the wPRL. */
  stage: "confirming" | "delay" | "issuing";
  confirmations: number;
  need: number;
  /** 0 to 1, for a progress bar. Never 1: only the bridge says when a crossing is done. */
  fraction: number;
  /** An estimate at Pearl's usual pace, or null once the confirmations are in (the rest is the bridge's own time). */
  secondsLeft: number | null;
}

/** Where a crossing to Ethereum stands, from the confirmations Pearl's indexer reports and what the bridge asked for. */
export function crossingProgress(confirmations: number, need: number, delaySeconds = 0, blockSeconds = 194): CrossingProgress {
  const n = Number.isFinite(need) && need >= 1 ? Math.min(Math.floor(need), 10_000) : 6;
  const c = Number.isFinite(confirmations) && confirmations > 0 ? Math.min(Math.floor(confirmations), 1_000_000) : 0;
  const d = Number.isFinite(delaySeconds) && delaySeconds > 0 ? Math.min(Math.floor(delaySeconds), 7 * 86400) : 0;
  if (c < n) return { stage: "confirming", confirmations: c, need: n, fraction: (c / n) * 0.9, secondsLeft: (n - c) * blockSeconds + d };
  return { stage: d > 0 ? "delay" : "issuing", confirmations: n, need: n, fraction: d > 0 ? 0.9 : 0.95, secondsLeft: null };
}

/** "about 12 min left", "about 3 h left". */
export function aboutLeft(seconds: number): string {
  if (!(seconds > 60)) return "about a minute left";
  const m = seconds / 60;
  if (m < 90) return `about ${Math.round(m)} min left`;
  return `about ${Math.round(m / 60)} h left`;
}

/**
 * A crossing whose arrival is to be announced. Kept outside the encrypted storage so that the alert works with
 * Keshi locked: only the transaction's number and its direction, no amount and no address, and only until it arrives.
 */
export interface BridgeWatch {
  txid: string;
  back: boolean;
  at: number;
  /** Set once a hold for review was announced: the crossing stays watched, and its arrival is still announced later. */
  told?: "review";
}

const WATCH_MS = 3 * 86400_000;

/** The list as stored, read strictly: anything that is not a crossing of the last three days is dropped. Eight at most. */
export function readWatch(x: unknown, now: number): BridgeWatch[] {
  if (!Array.isArray(x)) return [];
  const out: BridgeWatch[] = [];
  for (const w of x.slice(0, 32)) {
    if (!w || typeof w !== "object" || typeof w.txid !== "string" || typeof w.at !== "number") continue;
    const back = w.back === true;
    if (!(back ? /^0x[0-9a-fA-F]{64}$/ : /^[0-9a-f]{64}$/i).test(w.txid)) continue;
    if (!(w.at > 0) || w.at > now + 60_000 || now - w.at > WATCH_MS) continue;
    if (out.some((o) => o.txid === w.txid)) continue;
    out.push(w.told === "review" ? { txid: w.txid, back, at: w.at, told: "review" } : { txid: w.txid, back, at: w.at });
  }
  return out.slice(0, 8);
}

/**
 * One round of answers from the bridge. `ended`: crossings that reached an end (announced, then forgotten).
 * `held`: crossings newly held for review (announced once, and kept: they may still arrive). Everything else is
 * asked about again at the next round, without a word.
 */
export function watchStep(list: BridgeWatch[], results: Record<string, CrossingStatus | undefined>): { ended: { watch: BridgeWatch; phase: CrossingStatus["phase"] }[]; held: BridgeWatch[] } {
  const ended: { watch: BridgeWatch; phase: CrossingStatus["phase"] }[] = [];
  const held: BridgeWatch[] = [];
  for (const w of list) {
    const s = results[w.txid];
    if (!s) continue; // no answer this time
    if (isFinal(s.phase)) ended.push({ watch: w, phase: s.phase });
    else if (s.phase === "review" && w.told !== "review") held.push(w);
  }
  return { ended, held };
}

/**
 * What to keep after a round, from the list as it stands NOW (read again: the screen may have added a crossing, or the
 * alert may have been turned off, while the bridge was being asked): ended crossings leave, held ones are marked as told.
 */
export function watchAfter(fresh: BridgeWatch[], ended: BridgeWatch[], held: BridgeWatch[] = []): BridgeWatch[] {
  return fresh.filter((w) => !ended.some((t) => t.txid === w.txid)).map((w) => (held.some((h) => h.txid === w.txid) ? { ...w, told: "review" as const } : w));
}

/** The notification for a crossing that left "on its way". No amount: none is kept for the alert. */
export function arrivalText(back: boolean, phase: CrossingStatus["phase"]): { title: string; message: string } | null {
  if (phase === "done") return back ? { title: "Your PRL arrived", message: "PearlBridge released your PRL on Pearl. Open Keshi to see it." } : { title: "Your wPRL arrived", message: "PearlBridge issued your wPRL on Ethereum. Open Keshi to see it." };
  if (phase === "refunded") return { title: "Bridge: your PRL was sent back", message: "PearlBridge refunded a crossing. Open Keshi, Bridge, for the details." };
  if (phase === "failed") return { title: "Bridge: a crossing did not go through", message: "Open Keshi, Bridge, for the details." };
  if (phase === "review") return { title: "Bridge: a crossing is held for review", message: "PearlBridge is holding a crossing for review. Keshi keeps watching it. Open Keshi, Bridge, for the details." };
  return null;
}
