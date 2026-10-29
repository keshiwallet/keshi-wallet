import { usdtBuyFee } from "./fees";
import { remoteText } from "./network";

/**
 * Buying wPRL with USDT held on another chain, in two steps the wallet can check
 * entirely. First LI.FI carries the USDT (or a little of it as ETH, for fees) from
 * Arbitrum, BNB Chain or Polygon to the same address on Ethereum, with nothing left
 * to run on arrival. Then Keshi itself swaps that USDT for wPRL on Uniswap.
 *
 * A one-step route would end with an instruction run on Ethereum after the bridge
 * (the swap), whose real recipient is buried in data that differs for each bridge
 * and that the wallet cannot read. Such routes are refused: the wallet only signs
 * what it can read, down to who receives the money.
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
/** USDT on Ethereum: what the first step delivers. */
export const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

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
  /** Token and chain of what arrived, as LI.FI reports them. */
  receivedToken?: string;
  receivedChain?: bigint;
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
 * LI.FI's cross-chain functions whose first argument is the `BridgeData` struct, with the size of their
 * argument head in bytes, which is where the ABI places that struct. Generated from the function
 * signatures in lifinance/contracts (config/clearSigningProposal.json, October 2026); every facet
 * deployed on Arbitrum, BNB Chain, Polygon and Ethereum is covered. A call to any other function is
 * refused: in a function whose first argument is something else (a swap's transaction id, say), that
 * argument is chosen by whoever builds the call and could point at a fake struct.
 */
export const LIFI_BRIDGE_CALLS: Record<string, number> = {
  "0x1fd8010c": 64, // startBridgeTokensViaAcross
  "0xa1f1ce43": 64, // startBridgeTokensViaAcrossV4
  "0x6a90d66e": 64, // startBridgeTokensViaAcrossV4Swap
  "0x6a51e9a9": 224, // startBridgeTokensViaAllBridge
  "0xc9851d0b": 128, // startBridgeTokensViaArbitrumBridge
  "0xe0a4201c": 96, // startBridgeTokensViaCelerCircleBridge
  "0x0315138f": 96, // startBridgeTokensViaCentrifuge
  "0x0ad553b3": 64, // startBridgeTokensViaChainflip
  "0x4004633e": 64, // startBridgeTokensViaDeBridgeDln
  "0xbff90b61": 64, // startBridgeTokensViaEco
  "0x678786ea": 192, // startBridgeTokensViaFrax
  "0x5f9af35d": 192, // startBridgeTokensViaGarden
  "0xfc5f1003": 96, // startBridgeTokensViaGasZip
  "0x6f9206ba": 160, // startBridgeTokensViaGlacis
  "0xf66fe519": 32, // startBridgeTokensViaGnosisBridge
  "0xee9e98e0": 64, // startBridgeTokensViaLayerSwap
  "0x7dbcf1d9": 64, // startBridgeTokensViaLiFiIntentEscrowV2
  "0x65782c4b": 256, // startBridgeTokensViaM0
  "0xb4875292": 64, // startBridgeTokensViaMayan
  "0x4213dfff": 128, // startBridgeTokensViaMegaETHBridge
  "0x4698f032": 64, // startBridgeTokensViaNEARIntents
  "0x782621d8": 32, // startBridgeTokensViaOmniBridge
  "0xce8a97a5": 128, // startBridgeTokensViaOptimismBridge
  "0x5080ffe2": 64, // startBridgeTokensViaPaxosTransit
  "0xaf62c7d6": 32, // startBridgeTokensViaPolygonBridge
  "0xf434d6ca": 64, // startBridgeTokensViaPolymerCCTP
  "0x092e8fa4": 96, // startBridgeTokensViaRelayDepository
  "0x3f313808": 64, // startBridgeTokensViaSquid
  "0x14d53077": 64, // startBridgeTokensViaStargate
  "0x0691ff78": 64, // startBridgeTokensViaSuperset
  "0xe23b7a08": 64, // startBridgeTokensViaSymbiosis
  "0x2541ec57": 64, // startBridgeTokensViaThorSwap
  "0x64261d58": 64, // startBridgeTokensViaUnit
  "0x3a3f7332": 96, // swapAndStartBridgeTokensViaAcross
  "0x1794958f": 96, // swapAndStartBridgeTokensViaAcrossV4
  "0x9b054bc4": 96, // swapAndStartBridgeTokensViaAcrossV4Swap
  "0x63267469": 256, // swapAndStartBridgeTokensViaAllBridge
  "0x3cc9517b": 160, // swapAndStartBridgeTokensViaArbitrumBridge
  "0x4f3b0759": 128, // swapAndStartBridgeTokensViaCelerCircleBridge
  "0x8fd4d4dd": 128, // swapAndStartBridgeTokensViaCentrifuge
  "0xee3314a1": 96, // swapAndStartBridgeTokensViaChainflip
  "0x2c7d2db0": 96, // swapAndStartBridgeTokensViaDeBridgeDln
  "0x762aea18": 96, // swapAndStartBridgeTokensViaEco
  "0x07b8e4c7": 224, // swapAndStartBridgeTokensViaFrax
  "0x76ad76fe": 224, // swapAndStartBridgeTokensViaGarden
  "0x606326ff": 128, // swapAndStartBridgeTokensViaGasZip
  "0x9c4b6dd9": 192, // swapAndStartBridgeTokensViaGlacis
  "0x7bf96e0a": 64, // swapAndStartBridgeTokensViaGnosisBridge
  "0x4c279d6b": 96, // swapAndStartBridgeTokensViaLayerSwap
  "0x6d21c5df": 96, // swapAndStartBridgeTokensViaLiFiIntentEscrowV2
  "0xb9eaf86d": 288, // swapAndStartBridgeTokensViaM0
  "0x80c65808": 96, // swapAndStartBridgeTokensViaMayan
  "0x22256e89": 160, // swapAndStartBridgeTokensViaMegaETHBridge
  "0x02631b09": 96, // swapAndStartBridgeTokensViaNEARIntents
  "0x95726782": 64, // swapAndStartBridgeTokensViaOmniBridge
  "0x5bb5d448": 160, // swapAndStartBridgeTokensViaOptimismBridge
  "0x637f1d04": 96, // swapAndStartBridgeTokensViaPaxosTransit
  "0xb4f37581": 64, // swapAndStartBridgeTokensViaPolygonBridge
  "0x17917a4e": 96, // swapAndStartBridgeTokensViaPolymerCCTP
  "0xa3443faa": 128, // swapAndStartBridgeTokensViaRelayDepository
  "0xa8f66666": 96, // swapAndStartBridgeTokensViaSquid
  "0xa6010a66": 96, // swapAndStartBridgeTokensViaStargate
  "0xf26e657f": 96, // swapAndStartBridgeTokensViaSuperset
  "0xc46059b2": 96, // swapAndStartBridgeTokensViaSymbiosis
  "0xad673d88": 96, // swapAndStartBridgeTokensViaThorSwap
  "0x21a3af52": 96, // swapAndStartBridgeTokensViaUnit
};

/**
 * Reads, inside the transaction LI.FI prepared, who will receive the funds and on which chain.
 * Every cross-chain call on LI.FI's contract takes a `BridgeData` struct as its first argument
 * (transactionId, bridge, integrator, referrer, sendingAssetId, receiver, minAmount,
 * destinationChainId, hasSourceSwaps, hasDestinationCall). Anything that does not decode that
 * way is refused: the wallet only signs what it can read.
 */
export function decodeBridgeData(data: string): { receiver: string; destinationChainId: bigint; minAmount: bigint; sendingAssetId: string; hasDestinationCall: boolean } {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (hex.length < 8 + 64) throw new Error("LI.FI's transaction is too short to read");
  const head = LIFI_BRIDGE_CALLS["0x" + hex.slice(0, 8).toLowerCase()];
  if (head === undefined) throw new Error("LI.FI's transaction calls a function Keshi does not know. Nothing was sent.");
  const body = hex.slice(8); // after the 4-byte selector
  const word = (i: number): string => {
    const w = body.slice(i * 64, i * 64 + 64);
    if (w.length !== 64) throw new Error("LI.FI's transaction could not be read");
    return w;
  };
  const offset = BigInt("0x" + word(0));
  // The struct sits right after the arguments' head, where the ABI puts the first dynamic argument.
  if (offset !== BigInt(head) || offset > BigInt(body.length / 2)) throw new Error("LI.FI's transaction could not be read");
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
  return { receiver, destinationChainId, minAmount, sendingAssetId, hasDestinationCall: word(base + 9).endsWith("1") };
}

/** Reads LI.FI's answer into the few figures the wallet shows. Throws on anything that would be unsafe to sign. */
export function parseQuote(j: any, want: { fromChainId: bigint; fromToken: string; toToken: string; fromAddress: string; fromAmount: bigint }): LifiQuote {
  if (!j || typeof j !== "object" || !j.estimate || !j.transactionRequest || !j.action) throw new Error("LI.FI gave an unreadable quote");
  const a = j.action, e = j.estimate, t = j.transactionRequest;
  // The quote must be for exactly what was asked: same chain, same tokens, same recipient.
  if (BigInt(a.fromChainId) !== want.fromChainId || BigInt(a.toChainId) !== 1n) throw new Error("LI.FI quoted a different chain");
  if (String(a.fromToken?.address).toLowerCase() !== want.fromToken.toLowerCase() || String(a.toToken?.address).toLowerCase() !== want.toToken.toLowerCase()) throw new Error("LI.FI quoted a different token");
  if (String(a.toAddress).toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI quoted a different recipient");
  if (BigInt(t.chainId ?? a.fromChainId) !== want.fromChainId) throw new Error("LI.FI's transaction is for a different chain");
  if (String(t.from ?? want.fromAddress).toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI's transaction is for a different sender");
  if (a.fromAddress !== undefined && String(a.fromAddress).toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI's quote is for a different sender");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(t.to)) || !/^0x([0-9a-fA-F]{2})*$/.test(String(t.data ?? "0x"))) throw new Error("LI.FI gave an unreadable transaction");
  // The only contract the wallet calls, and the only one it allows to take USDT, is LI.FI's own. A quote that
  // points anywhere else (the USDT contract itself, an unknown address) is refused, whatever the rest says.
  const diamond = LIFI_DIAMOND.toLowerCase();
  if (String(t.to).toLowerCase() !== diamond) throw new Error("LI.FI's transaction does not go to LI.FI's contract. Nothing was sent.");
  // The recipient and destination written inside the transaction itself, not just in the quote's summary.
  const inside = decodeBridgeData(String(t.data ?? "0x"));
  if (inside.receiver.toLowerCase() !== want.fromAddress.toLowerCase()) throw new Error("LI.FI's transaction would deliver to another address. Nothing was sent.");
  if (inside.destinationChainId !== 1n) throw new Error("LI.FI's transaction would deliver to another chain. Nothing was sent.");
  // An instruction run on Ethereum after the bridge decides for itself who gets the money, and Keshi cannot read it.
  if (inside.hasDestinationCall) throw new Error("LI.FI's route ends with a step on Ethereum that Keshi cannot check. Nothing was sent; try again, or try another chain.");
  // USDT is a token: LI.FI's contract needs a permission, and it must be for LI.FI's contract itself, never missing.
  const approval = String(e.approvalAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(approval) || approval.toLowerCase() !== diamond) throw new Error("LI.FI asks for a permission to an unexpected address. Nothing was sent.");
  const fromAmount = big(e.fromAmount);
  // The amount spent is the one the user typed, in the estimate and in the action: a server cannot quote 5,000 for a request of 50.
  if (fromAmount !== want.fromAmount || big(a.fromAmount ?? e.fromAmount) !== want.fromAmount) throw new Error("LI.FI quoted a different amount of USDT than you entered. Nothing was sent.");
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
  // Fee figures are only shown, never signed, but a negative or unreadable fee would make the review lie.
  const fees: any[] = Array.isArray(e.feeCosts) ? e.feeCosts : [];
  const gases: any[] = Array.isArray(e.gasCosts) ? e.gasCosts : [];
  for (const f of [...fees, ...gases]) {
    if (f?.amountUSD !== undefined && !(Number(f.amountUSD) >= 0)) throw new Error("LI.FI's quote shows an unreadable fee. Nothing was sent; try again.");
  }
  for (const f of fees) {
    const usd = num(f.amountUSD);
    if (f.included) included += usd;
    else extra += usd;
    if (String(f.name ?? "").toLowerCase().includes("integrator") || String(f.description ?? "").toLowerCase().includes("integrator")) keshi += usd;
  }
  const gasUsd = gases.reduce((s: number, g: any) => s + num(g.amountUSD), 0);
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
    receivedToken: j?.receiving?.token?.address ? String(j.receiving.token.address) : undefined,
    receivedChain: j?.receiving?.chainId !== undefined ? big(j.receiving.chainId) : undefined,
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
   * A quote for `fromAmount` of the chain's USDT, delivered as `to` ("usdt" or
   * "eth") on the same address on Ethereum, with nothing run on arrival. Keshi's
   * fee is asked for on the USDT and taken by LI.FI's contract; it is already
   * reflected in the amount quoted.
   */
  async quote(chain: SourceChain, fromAddress: string, fromAmount: bigint, to: "usdt" | "eth"): Promise<LifiQuote> {
    const fee = this.fee;
    const toToken = to === "usdt" ? ETH_USDT : ETH_ZERO;
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
      allowDestinationCall: "false",
      ...(fee && to === "usdt" ? { fee: (Number(fee.bips) / 10_000).toString() } : {}),
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
  if (s.status === "DONE") return s.substatus === "PARTIAL" ? "Arrived, but perhaps not as the token asked for: check Details for what reached your address." : s.substatus === "REFUNDED" ? "Refunded on the source chain. Check Details for the amount returned." : !s.substatus || s.substatus === "COMPLETED" ? "Arrived on your Ethereum address." : "Finished, in a way Keshi does not recognise: check Details for what reached your address.";
  if (s.status === "FAILED") return "Failed. Check Details: LI.FI usually refunds the USDT on the source chain, but not in every case.";
  if (s.status === "PENDING") return s.substatus === "WAIT_SOURCE_CONFIRMATIONS" ? "Confirming on the source chain…" : s.substatus === "REFUND_IN_PROGRESS" ? "Being refunded on the source chain…" : "On its way to Ethereum…";
  if (s.status === "INVALID") return "LI.FI does not recognise this transaction.";
  return "Waiting for the network…";
}
