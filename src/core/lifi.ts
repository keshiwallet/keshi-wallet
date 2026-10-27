import { WPRL_CONTRACT } from "./bridge";
import { usdtBuyFee } from "./fees";
import { remoteText } from "./network";

/**
 * Buying wPRL with USDT held on another chain, through LI.FI: the user's USDT
 * leaves Arbitrum, BNB Chain or Polygon and wPRL (or a little ETH for fees)
 * lands on the same address on Ethereum. The user signs on the source chain;
 * Keshi never holds the money, and LI.FI's contracts do the bridging and the
 * swap in one go.
 */

declare const __KESHI_LIFI_PROXY__: string | undefined;
/** When Keshi is built with a relay (see relay/README.md), quotes go through it and the key stays on the relay; otherwise straight to LI.FI with the key below. */
export const LIFI_PROXY: string = typeof __KESHI_LIFI_PROXY__ === "string" ? __KESHI_LIFI_PROXY__ : "";
export const LIFI_API = LIFI_PROXY ? `${LIFI_PROXY.replace(/\/$/, "")}/v1` : "https://li.quest/v1";
/** Identifies Keshi to LI.FI, so its share of the fee is credited. It moves no money and signs nothing. Empty when a relay holds the key. */
declare const __KESHI_LIFI_KEY__: string | undefined;
export const LIFI_KEY: string = typeof __KESHI_LIFI_KEY__ === "string" ? __KESHI_LIFI_KEY__ : "";
export const LIFI_INTEGRATOR = "keshi";
export const ETH_ZERO = "0x0000000000000000000000000000000000000000";

/** LI.FI's contract ("Diamond"), the only address Keshi will ever hand USDT to or call for a purchase. The same on every chain below. */
export const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

export interface SourceChain {
  id: "arbitrum" | "bsc" | "polygon";
  name: string;
  chainId: bigint;
  rpcs: string[];
  usdt: { address: string; decimals: number; symbol: string };
  /** What pays the fee on that chain. */
  gas: string;
  explorerTx: string;
  /** Ceilings on what the wallet will sign on that chain, whatever a server says (see EthRpc.prepare). */
  limits: GasLimits;
}
export interface GasLimits {
  maxGas?: bigint;
  minGas?: bigint;
  zeroBaseFee?: boolean;
  /** Highest gas price (wei) the wallet accepts; a server quoting more is refused. */
  maxGasPrice?: bigint;
  /** Lowest and highest priority fee (wei): Polygon's nodes refuse tips under 25 gwei. */
  minTip?: bigint;
  maxTip?: bigint;
}

export const SOURCE_CHAINS: SourceChain[] = [
  {
    id: "arbitrum",
    name: "Arbitrum",
    chainId: 42161n,
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    usdt: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, symbol: "USDT" },
    gas: "ETH",
    explorerTx: "https://arbiscan.io/tx/{hash}",
    // Arbitrum's gas units include the cost of posting to Ethereum: limits are far above Ethereum's; its gas price is tiny.
    limits: { maxGas: 60_000_000n, maxGasPrice: 2_000_000_000n, maxTip: 100_000_000n },
  },
  {
    id: "bsc",
    name: "BNB Chain",
    chainId: 56n,
    rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc.drpc.org"],
    usdt: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" },
    gas: "BNB",
    explorerTx: "https://bscscan.com/tx/{hash}",
    limits: { zeroBaseFee: true, maxGas: 3_000_000n, maxGasPrice: 10_000_000_000n },
  },
  {
    id: "polygon",
    name: "Polygon",
    chainId: 137n,
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    usdt: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, symbol: "USDT" },
    gas: "POL",
    explorerTx: "https://polygonscan.com/tx/{hash}",
    limits: { maxGas: 3_000_000n, maxGasPrice: 1_000_000_000_000n, minTip: 25_000_000_000n, maxTip: 200_000_000_000n },
  },
];

export const sourceChain = (id: string): SourceChain => SOURCE_CHAINS.find((c) => c.id === id) ?? SOURCE_CHAINS[0]!;

export interface LifiQuote {
  id: string;
  tool: string;
  toolName: string;
  fromChainId: bigint;
  fromAmount: bigint;
  /** What arrives on Ethereum, in the destination token's smallest unit. */
  toAmount: bigint;
  toAmountMin: bigint;
  toSymbol: string;
  toDecimals: number;
  fromAmountUsd: number;
  toAmountUsd: number;
  /** Contract to allow to take the USDT, when an approval is needed. */
  approvalAddress: string;
  /** Seconds, as LI.FI estimates it. */
  duration: number;
  /** Fees not already reflected in `toAmount`, in dollars. */
  extraFeesUsd: number;
  /** Fees already deducted from `toAmount` (LI.FI's and Keshi's), in dollars. */
  includedFeesUsd: number;
  keshiFeeUsd: number;
  /** Gas on the source chain, in dollars. */
  gasUsd: number;
  tx: { to: string; data: string; value: bigint; gasLimit: bigint | null; chainId: bigint };
  /** When the quote was read; a quote older than a minute is not signed. */
  at: number;
}
export const QUOTE_LIFETIME_MS = 60_000;

export interface LifiStatus {
  status: "NOT_FOUND" | "INVALID" | "PENDING" | "DONE" | "FAILED";
  substatus?: string;
  message?: string;
  receivedAmount?: bigint;
  receivingTx?: string;
  explorer?: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};


/**
 * Reads, inside the transaction LI.FI prepared, who will receive the funds and on which chain.
 * Every cross-chain call on LI.FI's contract takes a `BridgeData` struct as its first argument
 * (transactionId, bridge, integrator, referrer, sendingAssetId, receiver, minAmount,
 * destinationChainId, hasSourceSwaps, hasDestinationCall). Anything that does not decode that
 * way is refused: the wallet only signs what it can read.
 */
export function decodeBridgeData(data: string): { receiver: string; destinationChainId: bigint; minAmount: bigint; sendingAssetId: string } {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 8 + 64) throw new Error("LI.FI's transaction is too short to read");
  const body = hex.slice(8); // after the 4-byte selector
  const word = (i: number): string => {
    const w = body.slice(i * 64, i * 64 + 64);
    if (w.length !== 64) throw new Error("LI.FI's transaction could not be read");
    return w;
  };
  const offset = BigInt("0x" + word(0));
  if (offset % 32n !== 0n || offset < 32n || offset > BigInt(body.length / 2)) throw new Error("LI.FI's transaction could not be read");
  const base = Number(offset / 32n);
  const addr = (w: string): string => {
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) throw new Error("LI.FI's transaction could not be read");
    return "0x" + w.slice(24);
  };
  const sendingAssetId = addr(word(base + 4));
  const receiver = addr(word(base + 5));
  const minAmount = BigInt("0x" + word(base + 6));
  const destinationChainId = BigInt("0x" + word(base + 7));
  const flag = (w: string) => /^0{63}[01]$/.test(w);
  if (!flag(word(base + 8)) || !flag(word(base + 9))) throw new Error("LI.FI's transaction could not be read");
  return { receiver, destinationChainId, minAmount, sendingAssetId };
}

/** Reads LI.FI's answer into the few figures the wallet shows. Throws on anything that would be unsafe to sign. */
export function parseQuote(j: any, want: { fromChainId: bigint; fromToken: string; toToken: string; fromAddress: string; fromAmount?: bigint }): LifiQuote {
  if (!j || typeof j !== "object" || !j.estimate || !j.transactionRequest || !j.action) throw new Error("LI.FI gave an unreadable quote");
  const a = j.action, e = j.estimate, t = j.transactionRequest;
  // The quote must be for exactly what was asked: same chain, same tokens, same recipient.
  if (BigInt(a.fromChainId) !== want.fromChainId || BigInt(a.toChainId) !== 1n) throw new Error("LI.FI quoted a different chain");
  if (String(a.fromToken?.address).toLowerCase() !== want.fromToken.toLowerCase() || String(a.toToken?.address).toLowerCase() !== want.toToken.toLowerCase()) throw new Error("LI.FI quoted a different token");
  if (String(a.toAddress).toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI quoted a different recipient");
  if (BigInt(t.chainId ?? a.fromChainId) !== want.fromChainId) throw new Error("LI.FI's transaction is for a different chain");
  if (String(t.from ?? want.fromAddress).toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI's transaction is for a different sender");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(t.to)) || !/^0x([0-9a-fA-F]{2})*$/.test(String(t.data ?? "0x"))) throw new Error("LI.FI gave an unreadable transaction");
  // The only contract the wallet calls, and the only one it allows to take USDT, is LI.FI's own. A quote that
  // points anywhere else (the USDT contract itself, an unknown address) is refused, whatever the rest says.
  const diamond = LIFI_DIAMOND.toLowerCase();
  if (String(t.to).toLowerCase() !== diamond) throw new Error("LI.FI's transaction does not go to LI.FI's contract. Nothing was sent.");
  // The recipient and destination written inside the transaction itself, not just in the quote's summary.
  const inside = decodeBridgeData(String(t.data ?? "0x"));
  if (inside.receiver.toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI's transaction would deliver to another address. Nothing was sent.");
  if (inside.destinationChainId !== 1n) throw new Error("LI.FI's transaction would deliver to another chain. Nothing was sent.");
  const approval = String(e.approvalAddress ?? "");
  if (approval && (!/^0x[0-9a-fA-F]{40}$/.test(approval) || approval.toLowerCase() !== diamond)) throw new Error("LI.FI asks for a permission to an unexpected address. Nothing was sent.");
  const fromAmount = big(e.fromAmount);
  // The amount spent is the one the user typed, in the estimate and in the action: a server cannot quote 5,000 for a request of 50.
  if (want.fromAmount !== undefined && (fromAmount !== want.fromAmount || big(a.fromAmount ?? e.fromAmount) !== want.fromAmount)) throw new Error("LI.FI quoted a different amount of USDT than you entered. Nothing was sent.");
  // The amount written inside the transaction: what LI.FI bridges after its fees and any swap on the source chain.
  // It can be lower than what the user pays, never higher, and never zero. Only comparable when the token bridged
  // is the USDT itself: after a swap on the source chain it is counted in another token's units.
  if (inside.minAmount <= 0n || (inside.sendingAssetId.toLowerCase() === want.fromToken.toLowerCase() && inside.minAmount > fromAmount)) throw new Error("LI.FI's transaction would move a different amount than the quote. Nothing was sent.");
  const toAmount = big(e.toAmount), toAmountMin = big(e.toAmountMin);
  if (fromAmount <= 0n || toAmount <= 0n || toAmountMin <= 0n || toAmountMin > toAmount) throw new Error("LI.FI gave an unreadable amount");
  if (toAmountMin < (toAmount * 97n) / 100n) throw new Error("LI.FI's floor is more than 3% under its quote. Nothing was sent.");
  // Dollar figures are required: without them the loss check below could not run.
  const fromUsd = num(e.fromAmountUSD), toUsd = num(e.toAmountUSD);
  if (!(fromUsd > 0) || !(toUsd > 0)) throw new Error("LI.FI's quote has no dollar value. Nothing was sent; try again.");
  if (toUsd < fromUsd * 0.8) throw new Error("This route would lose more than 20% of the amount. Nothing was sent; try a larger amount or try again later.");
  const value = big(t.value);
  // USDT is a token: the transaction never needs to carry the chain's coin.
  if (value !== 0n) throw new Error("LI.FI's transaction asks for the chain's coin on top of the USDT. Nothing was sent.");
  let extra = 0, included = 0, keshi = 0;
  for (const f of e.feeCosts ?? []) {
    const usd = num(f.amountUSD);
    if (f.included) included += usd;
    else extra += usd;
    if (String(f.name ?? "").toLowerCase().includes("integrator") || String(f.description ?? "").toLowerCase().includes("integrator")) keshi += usd;
  }
  const gasUsd = (e.gasCosts ?? []).reduce((s: number, g: any) => s + num(g.amountUSD), 0);
  return {
    id: String(j.id ?? ""),
    tool: String(j.tool ?? ""),
    toolName: String(j.toolDetails?.name ?? j.tool ?? "LI.FI"),
    fromChainId: want.fromChainId,
    fromAmount,
    toAmount,
    toAmountMin,
    toSymbol: String(a.toToken?.symbol ?? ""),
    toDecimals: Number(a.toToken?.decimals ?? 0),
    fromAmountUsd: fromUsd,
    toAmountUsd: toUsd,
    approvalAddress: String(e.approvalAddress ?? ""),
    duration: num(e.executionDuration),
    extraFeesUsd: extra,
    includedFeesUsd: included,
    keshiFeeUsd: keshi,
    gasUsd,
    tx: { to: String(t.to), data: String(t.data ?? "0x"), value, gasLimit: t.gasLimit ? big(t.gasLimit) : null, chainId: want.fromChainId },
    at: Date.now(),
  };
}

export function parseStatus(j: any): LifiStatus {
  const status = String(j?.status ?? "NOT_FOUND") as LifiStatus["status"];
  return {
    status: ["NOT_FOUND", "INVALID", "PENDING", "DONE", "FAILED"].includes(status) ? status : "NOT_FOUND",
    substatus: j?.substatus ? String(j.substatus) : undefined,
    message: j?.substatusMessage ? String(j.substatusMessage) : undefined,
    receivedAmount: j?.receiving?.amount ? big(j.receiving.amount) : undefined,
    receivingTx: j?.receiving?.txHash ? String(j.receiving.txHash) : undefined,
    explorer: /^https:\/\/scan\.li\.fi\/tx\/0x[0-9a-fA-F]{64}$/.test(String(j?.lifiExplorerLink ?? "")) ? String(j.lifiExplorerLink) : undefined,
  };
}

export class LiFi {
  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private apiKey = LIFI_KEY,
    private fee = usdtBuyFee(),
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const q = new URLSearchParams(params).toString();
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers["x-lifi-api-key"] = this.apiKey;
    const res = await this.fetcher(`${LIFI_API}${path}?${q}`, { headers, cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(remoteText("LI.FI", String(j?.message ?? `error ${res.status}`)));
    return j;
  }

  /**
   * A quote for `fromAmount` of the chain's USDT, delivered as `to` ("wprl" or
   * "eth") on the same address on Ethereum. Keshi's fee is asked for here and
   * taken by LI.FI's contract; it is already reflected in the amount quoted.
   */
  async quote(chain: SourceChain, fromAddress: string, fromAmount: bigint, to: "wprl" | "eth"): Promise<LifiQuote> {
    const fee = this.fee;
    const toToken = to === "wprl" ? WPRL_CONTRACT : ETH_ZERO;
    const j = await this.get("/quote", {
      fromChain: chain.chainId.toString(),
      toChain: "1",
      fromToken: chain.usdt.address,
      toToken,
      fromAmount: fromAmount.toString(),
      fromAddress,
      toAddress: fromAddress,
      slippage: "0.01",
      integrator: LIFI_INTEGRATOR,
      ...(fee && to === "wprl" ? { fee: (Number(fee.bips) / 10_000).toString() } : {}),
    });
    return parseQuote(j, { fromChainId: chain.chainId, fromToken: chain.usdt.address, toToken, fromAddress, fromAmount });
  }

  async status(txHash: string, chain: SourceChain): Promise<LifiStatus> {
    try {
      return parseStatus(await this.get("/status", { txHash, fromChain: chain.chainId.toString(), toChain: "1" }));
    } catch (e) {
      // Not found yet is a normal early answer, not a failure.
      if (e instanceof Error && /not found|1003|404/i.test(e.message)) return { status: "NOT_FOUND" };
      throw e;
    }
  }
}

/** Plain-words version of a LI.FI status, for the screen. */
export function describeStatus(s: LifiStatus): string {
  if (s.status === "DONE") return s.substatus === "PARTIAL" ? "Arrived, partly: the route delivered less than quoted." : s.substatus === "REFUNDED" ? "Refunded on the source chain. Check Details for the amount returned." : "Arrived on your Ethereum address.";
  if (s.status === "FAILED") return "Failed. Check Details: LI.FI usually refunds the USDT on the source chain, but not in every case.";
  if (s.status === "PENDING") return s.substatus === "WAIT_SOURCE_CONFIRMATIONS" ? "Confirming on the source chain…" : s.substatus === "REFUND_IN_PROGRESS" ? "Being refunded on the source chain…" : "On its way to Ethereum…";
  if (s.status === "INVALID") return "LI.FI does not recognise this transaction.";
  return "Waiting for the network…";
}
