import { isValidAddress } from "./keys";
import { isEthAddress } from "./bridge";
import type { Network } from "./network";

// The wallet provider's commission. Values come from fees.config.json at
// build time. With no (valid) fee address, no commission is ever charged.

declare const __KESHI_FEES__: { feeAddress: string; sendPercent: number; sendCapPrl: number; combinePercent: number; combineCapPrl: number; mintFlatPrl?: number; bridgePercent?: number; bridgeCapPrl?: number; ethFeeAddress?: string; swapPercent?: number; usdtBuyPercent?: number } | undefined;

const cfg =
  typeof __KESHI_FEES__ !== "undefined" && __KESHI_FEES__
    ? __KESHI_FEES__
    : { feeAddress: "", sendPercent: 0, sendCapPrl: 0, combinePercent: 0, combineCapPrl: 0 };

export interface Service {
  address: string;
  /** Hundredths of a percent: 20 = 0.20 %. */
  bps: number;
  cap: bigint;
  label: string;
  /** Fixed commission in grains, used instead of the percentage when set. */
  flat?: bigint;
}

const pct = (p: number) => `${Number(p.toFixed(2))}%`;

/** The commission that applies, or undefined when none does (testnet, not configured). */
export function serviceFor(net: Network, kind: "send" | "combine" | "mint" | "bridge", config = cfg): Service | undefined {
  if (net.id !== "mainnet" || !isValidAddress(config.feeAddress, net)) return undefined;
  if (kind === "mint") {
    const flat = config.mintFlatPrl ?? 0;
    if (!(flat > 0) || flat > 5) return undefined; // hard ceiling of 5 PRL per mint
    return { address: config.feeAddress, bps: 0, cap: 0n, label: "per mint", flat: BigInt(Math.round(flat * 1e8)) };
  }
  const percent = kind === "send" ? config.sendPercent : kind === "bridge" ? (config.bridgePercent ?? 0) : config.combinePercent;
  const capPrl = kind === "send" ? config.sendCapPrl : kind === "bridge" ? (config.bridgeCapPrl ?? 0) : config.combineCapPrl;
  const bps = Math.round(percent * 100);
  if (!(bps > 0) || bps > 300) return undefined; // hard ceiling of 3 %: a typo must not drain users
  if (!(capPrl > 0)) return undefined; // a percentage with no ceiling is never charged
  return { address: config.feeAddress, bps, cap: BigInt(Math.round(capPrl * 1e8)), label: pct(percent) };
}

/** Commission on Uniswap swaps, taken from what the user receives and sent to an Ethereum address. */
export function swapFee(config = cfg): { bips: bigint; recipient: string; label: string } | undefined {
  const a = config.ethFeeAddress ?? "";
  const pct = config.swapPercent ?? 0;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a) || !(pct > 0) || pct > 1) return undefined; // the router itself refuses more than 1%
  if (!isEthAddress(a) || Math.round(pct * 100) < 1) return undefined; // bad checksum, or a rate that rounds to nothing
  return { bips: BigInt(Math.round(pct * 100)), recipient: a, label: `${Number(pct.toFixed(2))}%` };
}

/** Keshi's share when buying wPRL with USDT from another chain, asked of LI.FI and paid into its fee collector for the Keshi integration. */
export function usdtBuyFee(config = cfg): { bips: bigint; recipient: string; label: string } | undefined {
  const pct = config.usdtBuyPercent ?? config.swapPercent ?? 0;
  const base = swapFee({ ...config, swapPercent: pct });
  return base;
}
