import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { WPRL_CONTRACT } from "./bridge";
import { callData, signEthTx, type EthRpc } from "./eth";
import { ambiguous } from "./amount";

// Swapping wPRL and USDT on Uniswap v3 (Ethereum mainnet), from the wallet's
// own Ethereum address. No account anywhere: the swap is a contract call.

export const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const UNI_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02
export const UNI_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2
const FEE_TIERS = [100, 500, 3000, 10000];

const word = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(64, "0"));
const addr = (a: string): Uint8Array => hexToBytes(a.slice(2).toLowerCase().padStart(64, "0"));
const sel = (sig: string): Uint8Array => keccak_256(new TextEncoder().encode(sig)).slice(0, 4);

export const uniData = {
  quoteIn: (tokenIn: string, tokenOut: string, amountIn: bigint, fee: number) =>
    concatBytes(sel("quoteExactInputSingle((address,address,uint256,uint24,uint160))"), addr(tokenIn), addr(tokenOut), word(amountIn), word(BigInt(fee)), word(0n)),
  quoteOut: (tokenIn: string, tokenOut: string, amountOut: bigint, fee: number) =>
    concatBytes(sel("quoteExactOutputSingle((address,address,uint256,uint24,uint160))"), addr(tokenIn), addr(tokenOut), word(amountOut), word(BigInt(fee)), word(0n)),
  swapIn: (tokenIn: string, tokenOut: string, fee: number, recipient: string, amountIn: bigint, minOut: bigint) =>
    concatBytes(sel("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"), addr(tokenIn), addr(tokenOut), word(BigInt(fee)), addr(recipient), word(amountIn), word(minOut), word(0n)),
  swapOut: (tokenIn: string, tokenOut: string, fee: number, recipient: string, amountOut: bigint, maxIn: bigint) =>
    concatBytes(sel("exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))"), addr(tokenIn), addr(tokenOut), word(BigInt(fee)), addr(recipient), word(amountOut), word(maxIn), word(0n)),
};

export interface UniQuote {
  wprl: bigint; // 8 decimals
  usdt: bigint; // 6 decimals
  fee: number; // pool fee tier
}

/** Best price across the pool fee tiers. `sell`: USDT received for `wprl`. `buy`: USDT needed to get `wprl`. */
export async function uniQuote(rpc: EthRpc, side: "buy" | "sell", wprl: bigint): Promise<UniQuote> {
  const tries = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const data = side === "sell" ? uniData.quoteIn(WPRL_CONTRACT, USDT, wprl, fee) : uniData.quoteOut(USDT, WPRL_CONTRACT, wprl, fee);
        const out = await rpc.raw(UNI_QUOTER, data);
        const usdt = out.length >= 66 ? BigInt(out.slice(0, 66)) : 0n;
        return usdt > 0n ? { wprl, usdt, fee } : null;
      } catch {
        return null;
      }
    }),
  );
  const ok = tries.filter((t): t is UniQuote => !!t);
  if (!ok.length) throw new Error("Uniswap has no price for this amount right now");
  return ok.reduce((best, t) => (side === "sell" ? (t.usdt > best.usdt ? t : best) : t.usdt < best.usdt ? t : best));
}

const MOVED = "The price moved since this quote. Get the price again; nothing was swapped.";
/** A swap must be mined within 20 minutes or not at all. */
const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

/** PRL price in USDT implied by a quote. */
export const uniPrice = (q: UniQuote): number => Number(q.usdt) / 1e6 / (Number(q.wprl) / 1e8);

/**
 * Run the swap. `slippageBps` is how far the price may move against the user
 * before the swap is refused by the contract (default 1%).
 * Returns the hash of the swap transaction.
 */
export async function uniSwap(rpc: EthRpc, account: { address: string; privateKey: Uint8Array }, side: "buy" | "sell", q: UniQuote, onStep: (t: string) => void, fee?: { bips: bigint; recipient: string }, slippageBps = 100n): Promise<string> {
  const tokenIn = side === "sell" ? WPRL_CONTRACT : USDT;
  const spend = side === "sell" ? q.wprl : (q.usdt * (10_000n + slippageBps)) / 10_000n;
  const [balance, allowance] = await Promise.all([rpc.tokenBalance(tokenIn, account.address), rpc.allowance(tokenIn, account.address, UNI_ROUTER)]);
  if (balance < spend) throw new Error(side === "sell" ? "Not enough wPRL on your Ethereum address" : "Not enough USDT on your Ethereum address");
  const send = async (to: string, data: Uint8Array) => {
    const signed = signEthTx(await rpc.prepare(account.address, to, data), account.privateKey);
    return rpc.send(signed.raw, signed.hash);
  };

  if (allowance < spend) {
    // USDT refuses to change a non-zero permission directly: clear it first.
    if (tokenIn === USDT && allowance > 0n) {
      onStep("Resetting an old USDT permission…");
      if (!(await rpc.wait(await send(USDT, callData.approve(UNI_ROUTER, 0n))))) throw new Error("Ethereum rejected the permission step. Nothing was swapped.");
    }
    onStep("Allowing Uniswap to take this exact amount…");
    if (!(await rpc.wait(await send(tokenIn, callData.approve(UNI_ROUTER, spend))))) throw new Error("Ethereum rejected the permission step. Nothing was swapped.");
  }
  // The price on screen may be minutes old, and the permission step takes time: ask again, and stop if it got worse.
  const fresh = await uniQuote(rpc, side, q.wprl);
  if (side === "sell" ? fresh.usdt * 1000n < q.usdt * 995n : fresh.usdt * 1000n > q.usdt * 1005n) throw new Error(MOVED);
  onStep("Swapping on Uniswap…");
  // With a commission, the router keeps what was bought for one instant, pays
  // the commission out of it and hands the rest to the user, all in one transaction.
  const to = fee ? ROUTER_ITSELF : account.address;
  const minOut = (q.usdt * (10_000n - slippageBps)) / 10_000n;
  const trade = side === "sell" ? uniData.swapIn(WPRL_CONTRACT, USDT, q.fee, to, q.wprl, minOut) : uniData.swapOut(USDT, WPRL_CONTRACT, q.fee, to, q.wprl, spend);
  const data = routeData.multicallBy(
    deadline(),
    fee ? [trade, side === "sell" ? routeData.sweepWithFee(USDT, minOut, account.address, fee.bips, fee.recipient) : routeData.sweepWithFee(WPRL_CONTRACT, q.wprl, account.address, fee.bips, fee.recipient)] : [trade],
  );
  const hash = await send(UNI_ROUTER, data);
  if (!(await rpc.wait(hash))) throw new Error("The swap was refused, usually because the price moved. Nothing was exchanged; only the Ethereum fee was spent.");
  return hash;
}


/* ------------------------------------------------- any token, by contract */

export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
/** In SwapRouter02, this recipient means "keep the tokens in the router for the next call". */
const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";

const pad = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
};
const dyn = (b: Uint8Array): Uint8Array => concatBytes(word(BigInt(b.length)), pad(b));

/** A Uniswap v3 route: token, fee, token, fee, token… packed the way the contracts expect. */
export function encodePath(tokens: string[], fees: number[]): Uint8Array {
  if (tokens.length !== fees.length + 1) throw new Error("Bad route");
  const parts: Uint8Array[] = [];
  tokens.forEach((t, i) => {
    parts.push(hexToBytes(t.slice(2).toLowerCase()));
    if (i < fees.length) parts.push(hexToBytes(fees[i]!.toString(16).padStart(6, "0")));
  });
  return concatBytes(...parts);
}

export const routeData = {
  quote: (path: Uint8Array, amountIn: bigint) => concatBytes(sel("quoteExactInput(bytes,uint256)"), word(64n), word(amountIn), dyn(path)),
  swap: (path: Uint8Array, recipient: string, amountIn: bigint, minOut: bigint) =>
    concatBytes(sel("exactInput((bytes,address,uint256,uint256))"), word(32n), word(128n), addr(recipient), word(amountIn), word(minOut), dyn(path)),
  /** Exact-output quote: how much of the first token buys `amountOut` of the last. The path is given in reverse, as the contracts expect. */
  quoteOut: (reversedPath: Uint8Array, amountOut: bigint) => concatBytes(sel("quoteExactOutput(bytes,uint256)"), word(64n), word(amountOut), dyn(reversedPath)),
  /** Exact-output swap: receive exactly `amountOut`, spend at most `maxIn`. Reversed path, like the quote. */
  swapOut: (reversedPath: Uint8Array, recipient: string, amountOut: bigint, maxIn: bigint) =>
    concatBytes(sel("exactOutput((bytes,address,uint256,uint256))"), word(32n), word(128n), addr(recipient), word(amountOut), word(maxIn), dyn(reversedPath)),
  /** Give back the ETH the router did not need (an exact-output swap paid in ETH is sent the maximum). */
  refundEth: () => sel("refundETH()"),
  /** Turn the WETH left in the router into ETH for `recipient`. */
  unwrap: (minAmount: bigint, recipient: string) => concatBytes(sel("unwrapWETH9(uint256,address)"), word(minAmount), addr(recipient)),
  /** Same, with the wallet's commission taken from the ETH. */
  unwrapWithFee: (minAmount: bigint, recipient: string, feeBips: bigint, feeRecipient: string) =>
    concatBytes(sel("unwrapWETH9WithFee(uint256,address,uint256,address)"), word(minAmount), addr(recipient), word(feeBips), addr(feeRecipient)),
  sweepWithFee: (token: string, minAmount: bigint, recipient: string, feeBips: bigint, feeRecipient: string) =>
    concatBytes(sel("sweepTokenWithFee(address,uint256,address,uint256,address)"), addr(token), word(minAmount), addr(recipient), word(feeBips), addr(feeRecipient)),
  multicall: (calls: Uint8Array[]) => {
    const bodies = calls.map(dyn);
    let offset = BigInt(32 * calls.length);
    const heads = bodies.map((b) => {
      const h = word(offset);
      offset += BigInt(b.length);
      return h;
    });
    return concatBytes(sel("multicall(bytes[])"), word(32n), word(BigInt(calls.length)), ...heads, ...bodies);
  },
  /** Same, but the whole batch is void after `deadline` (Unix seconds): a stuck swap cannot execute hours later. */
  multicallBy: (deadline: bigint, calls: Uint8Array[]) => {
    const bodies = calls.map(dyn);
    let offset = BigInt(32 * calls.length);
    const heads = bodies.map((b) => {
      const h = word(offset);
      offset += BigInt(b.length);
      return h;
    });
    return concatBytes(sel("multicall(uint256,bytes[])"), word(deadline), word(64n), word(BigInt(calls.length)), ...heads, ...bodies);
  },
};

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

function readString(hex: string): string {
  const b = hexToBytes(hex.replace(/^0x/, ""));
  let bytes = b;
  if (b.length >= 96) {
    const len = Number(BigInt("0x" + bytesToHex(b.slice(32, 64))));
    if (len > 0 && len <= b.length - 64) bytes = b.slice(64, 64 + len);
  }
  return new TextDecoder().decode(bytes).replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
}

/** Symbol and decimals of an ERC-20 token. Throws if the address is not a token. */
export async function tokenMeta(rpc: EthRpc, address: string): Promise<TokenMeta> {
  const [sym, dec] = await Promise.all([rpc.raw(address, sel("symbol()")), rpc.raw(address, sel("decimals()"))]);
  if (!dec || dec === "0x") throw new Error("No token found at this contract address");
  const decimals = Number(BigInt(dec.slice(0, 66)));
  if (!(decimals >= 0 && decimals <= 36)) throw new Error("No token found at this contract address");
  return { address, symbol: readString(sym) || "TOKEN", decimals };
}

export interface Route {
  tokens: string[];
  fees: number[];
  amountIn: bigint;
  amountOut: bigint;
}

/**
 * Best route between wPRL and any token: direct, through USDT, or through
 * USDT then WETH. A few read-only calls; nothing is spent.
 */
export async function findRoute(rpc: EthRpc, tokenIn: string, tokenOut: string, amountIn: bigint, retryMs = 500): Promise<Route> {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(tokenIn, tokenOut)) throw new Error("Choose two different tokens");
  // A pool that does not exist answers "reverted": that is a real "no".
  // Anything else (busy or unreachable server) is not an answer, so it is
  // retried once and, if it still fails, reported as such rather than as "no route".
  let unanswered = 0;
  const quote = async (tokens: string[], fees: number[]): Promise<Route | null> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await rpc.raw(UNI_QUOTER, routeData.quote(encodePath(tokens, fees), amountIn));
        const amountOut = out.length >= 66 ? BigInt(out.slice(0, 66)) : 0n;
        return amountOut > 0n ? { tokens, fees, amountIn, amountOut } : null;
      } catch (e) {
        if (e instanceof Error && /revert/i.test(e.message)) return null;
        if (attempt === 0) await new Promise((ok) => setTimeout(ok, retryMs));
      }
    }
    unanswered++;
    return null;
  };
  const best = (list: (Route | null)[]) => list.filter((r): r is Route => !!r).reduce<Route | null>((b, r) => (!b || r.amountOut > b.amountOut ? r : b), null);
  const other = same(tokenIn, WPRL_CONTRACT) ? tokenOut : tokenIn;
  const selling = same(tokenIn, WPRL_CONTRACT); // wPRL is what the user gives
  const order = (mid: string[]) => (selling ? [WPRL_CONTRACT, ...mid, other] : [other, ...mid.slice().reverse(), WPRL_CONTRACT]);
  const flip = (f: number[]) => (selling ? f : f.slice().reverse());

  const candidates: (() => Promise<Route | null>)[] = [];
  for (const f of FEE_TIERS) candidates.push(() => quote(order([]), [f]));
  if (!same(other, USDT)) {
    for (const a of FEE_TIERS) for (const b of FEE_TIERS) candidates.push(() => quote(order([USDT]), flip([a, b])));
    if (!same(other, WETH)) for (const a of FEE_TIERS) for (const c of [500, 3000, 10000]) candidates.push(() => quote(order([USDT, WETH]), flip([a, 500, c])));
  }
  // A few at a time: public Ethereum servers refuse a burst of thirty questions.
  const found: (Route | null)[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < candidates.length) found.push(await candidates[next++]!());
    }),
  );
  const route = best(found);
  if (!route) throw new Error(unanswered > 0 ? "Ethereum did not answer just now. Wait a few seconds and try again." : "Uniswap has no route between these two tokens for this amount");
  return route;
}

/**
 * Swap along a route. The contract refuses the swap if the price moves more
 * than `slippageBps` against the user. With `fee`, the wallet's commission is
 * taken from what is received, inside the same transaction.
 *
 * With `eth`, a route that starts or ends with WETH uses plain ETH instead:
 * ETH is sent with the transaction (no permission step), or the WETH received
 * is turned back into ETH before it reaches the user.
 */
export async function swapRoute(
  rpc: EthRpc,
  account: { address: string; privateKey: Uint8Array },
  route: Route,
  onStep: (t: string) => void,
  fee?: { bips: bigint; recipient: string },
  slippageBps = 100n,
  eth = false,
): Promise<string> {
  const tokenIn = route.tokens[0]!, tokenOut = route.tokens[route.tokens.length - 1]!;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const ethIn = eth && same(tokenIn, WETH), ethOut = eth && same(tokenOut, WETH);
  const [balance, allowance] = ethIn
    ? [await rpc.ethBalance(account.address), route.amountIn]
    : await Promise.all([rpc.tokenBalance(tokenIn, account.address), rpc.allowance(tokenIn, account.address, UNI_ROUTER)]);
  if (balance < route.amountIn) throw new Error(ethIn ? "Not enough ETH on your Ethereum address" : "Not enough of the token you are giving on your Ethereum address");
  const send = async (to: string, data: Uint8Array, value = 0n) => {
    const signed = signEthTx(await rpc.prepare(account.address, to, data, value), account.privateKey);
    return rpc.send(signed.raw, signed.hash);
  };
  const path = encodePath(route.tokens, route.fees);

  if (allowance < route.amountIn) {
    if (allowance > 0n) {
      onStep("Resetting an old permission…");
      if (!(await rpc.wait(await send(tokenIn, callData.approve(UNI_ROUTER, 0n))))) throw new Error("Ethereum rejected the permission step. Nothing was swapped.");
    }
    onStep("Allowing Uniswap to take this exact amount…");
    if (!(await rpc.wait(await send(tokenIn, callData.approve(UNI_ROUTER, route.amountIn))))) throw new Error("Ethereum rejected the permission step. Nothing was swapped.");
  }
  // The price on screen may be minutes old, and the permission step takes time: ask again, and stop if it got worse.
  // Each Ethereum server is asked on its own and the best answer is kept: one server
  // lying about the price cannot lower the minimum the user is protected by.
  const answers = await rpc.rawEach(UNI_QUOTER, routeData.quote(path, route.amountIn));
  if (!answers.length) throw new Error("Could not reach Ethereum to check the price. Nothing was swapped.");
  const fresh = answers.map((a) => (a.length >= 66 ? BigInt(a.slice(0, 66)) : 0n)).reduce((m, v) => (v > m ? v : m), 0n);
  if (fresh * 1000n < route.amountOut * 995n) throw new Error(MOVED);
  onStep("Swapping on Uniswap…");
  const reference = fresh > route.amountOut ? fresh : route.amountOut;
  const minOut = (reference * (10_000n - slippageBps)) / 10_000n;
  const calls = ethOut
    ? [routeData.swap(path, ROUTER_ITSELF, route.amountIn, minOut), fee ? routeData.unwrapWithFee(minOut, account.address, fee.bips, fee.recipient) : routeData.unwrap(minOut, account.address)]
    : fee
      ? [routeData.swap(path, ROUTER_ITSELF, route.amountIn, minOut), routeData.sweepWithFee(tokenOut, minOut, account.address, fee.bips, fee.recipient)]
      : [routeData.swap(path, account.address, route.amountIn, minOut)];
  const hash = await send(UNI_ROUTER, routeData.multicallBy(deadline(), calls), ethIn ? route.amountIn : 0n);
  if (!(await rpc.wait(hash))) throw new Error("The swap was refused, usually because the price moved. Nothing was exchanged; only the Ethereum fee was spent.");
  return hash;
}

/* -------------------------------------------------- PRL for ETH, both ways */

/** An exact amount of wPRL bought with ETH: the route (ETH side first), and the ETH it costs at today's price. */
export interface EthBuy {
  tokens: string[];
  fees: number[];
  wprl: bigint;
  /** Wei the route needs for exactly `wprl`. */
  eth: bigint;
}

/**
 * How much ETH buys exactly `wprl`, over the best route (straight from WETH,
 * or WETH then USDT). Read-only. Throws when no pool can do it.
 */
export async function ethBuyQuote(rpc: EthRpc, wprl: bigint): Promise<EthBuy> {
  if (wprl <= 0n) throw new Error("Enter an amount");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  let unanswered = 0;
  const ask = async (tokens: string[], fees: number[]): Promise<EthBuy | null> => {
    // The quote reads the route backwards: wPRL first, WETH last.
    const reversed = encodePath(tokens.slice().reverse(), fees.slice().reverse());
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await rpc.raw(UNI_QUOTER, routeData.quoteOut(reversed, wprl));
        const eth = out.length >= 66 ? BigInt(out.slice(0, 66)) : 0n;
        return eth > 0n ? { tokens, fees, wprl, eth } : null;
      } catch (e) {
        if (e instanceof Error && /revert/i.test(e.message)) return null;
        if (attempt === 0) await new Promise((ok) => setTimeout(ok, 500));
      }
    }
    unanswered++;
    return null;
  };
  const candidates: (() => Promise<EthBuy | null>)[] = [];
  for (const f of FEE_TIERS) candidates.push(() => ask([WETH, WPRL_CONTRACT], [f]));
  for (const a of [500, 3000]) for (const b of FEE_TIERS) candidates.push(() => ask([WETH, USDT, WPRL_CONTRACT], [a, b]));
  const found: (EthBuy | null)[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < candidates.length) found.push(await candidates[next++]!());
    }),
  );
  const best = found.filter((r): r is EthBuy => !!r && same(r.tokens[0]!, WETH)).reduce<EthBuy | null>((b, r) => (!b || r.eth < b.eth ? r : b), null);
  if (!best) throw new Error(unanswered > 0 ? "Ethereum did not answer just now. Wait a few seconds and try again." : "Uniswap has no price for this amount right now");
  return best;
}

/** Wei the user must hold for `q`: the quoted ETH plus the 1% the price may move before the swap is mined. */
export const ethBuyMax = (q: EthBuy, slippageBps = 100n): bigint => (q.eth * (10_000n + slippageBps)) / 10_000n;

/**
 * Buy exactly `q.wprl` with ETH, in one Ethereum transaction and with no
 * permission step: the ETH travels with the transaction, the router keeps
 * only what the swap needs and gives the rest back in the same call. With
 * `fee`, the wallet's commission is taken from the wPRL received.
 */
export async function ethBuy(rpc: EthRpc, account: { address: string; privateKey: Uint8Array }, q: EthBuy, onStep: (t: string) => void, fee?: { bips: bigint; recipient: string }, slippageBps = 100n): Promise<string> {
  const maxIn = ethBuyMax(q, slippageBps);
  const balance = await rpc.ethBalance(account.address);
  if (balance < maxIn) throw new Error("Not enough ETH on your Ethereum address");
  const reversed = encodePath(q.tokens.slice().reverse(), q.fees.slice().reverse());
  // The price on screen may be minutes old: ask every server again, keep the dearest honest answer, and stop if it got worse.
  const answers = await rpc.rawEach(UNI_QUOTER, routeData.quoteOut(reversed, q.wprl));
  if (!answers.length) throw new Error("Could not reach Ethereum to check the price. Nothing was swapped.");
  const fresh = answers.map((a) => (a.length >= 66 ? BigInt(a.slice(0, 66)) : 0n)).filter((v) => v > 0n).reduce((m, v) => (v > m ? v : m), 0n);
  if (fresh === 0n) throw new Error("Could not reach Ethereum to check the price. Nothing was swapped.");
  if (fresh * 1000n > q.eth * 1005n) throw new Error(MOVED);
  onStep("Swapping on Uniswap…");
  const to = fee ? ROUTER_ITSELF : account.address;
  const calls = [routeData.swapOut(reversed, to, q.wprl, maxIn), ...(fee ? [routeData.sweepWithFee(WPRL_CONTRACT, q.wprl, account.address, fee.bips, fee.recipient)] : []), routeData.refundEth()];
  const signed = signEthTx(await rpc.prepare(account.address, UNI_ROUTER, routeData.multicallBy(deadline(), calls), maxIn), account.privateKey);
  const hash = await rpc.send(signed.raw, signed.hash);
  if (!(await rpc.wait(hash))) throw new Error("The swap was refused, usually because the price moved. Nothing was exchanged; only the Ethereum fee was spent.");
  return hash;
}

/** Today's ETH price in USDT, read from Uniswap's deepest ETH pool. */
export async function ethUsdOnUniswap(rpc: EthRpc): Promise<number> {
  const out = await rpc.raw(UNI_QUOTER, uniData.quoteIn(WETH, USDT, 10n ** 18n, 500));
  const p = out.length >= 66 ? Number(BigInt(out.slice(0, 66))) / 1e6 : 0;
  if (!(p > 0)) throw new Error("No ETH price right now");
  return p;
}

/** Gas a swap typically burns, permission step included. Deliberately a little high. */
const SWAP_GAS = 250_000n;

/**
 * Rough cost of one swap in dollars at today's Ethereum prices, or null when
 * it cannot be estimated. Used only to warn about swaps too small to be worth it.
 */
export async function swapCostUsd(rpc: EthRpc): Promise<number | null> {
  try {
    const [gas, out] = await Promise.all([rpc.gasPrice(), rpc.raw(UNI_QUOTER, uniData.quoteIn(WETH, USDT, 10n ** 18n, 500))]);
    const ethUsd = out.length >= 66 ? Number(BigInt(out.slice(0, 66))) / 1e6 : 0;
    const cost = (Number(gas * SWAP_GAS) / 1e18) * ethUsd;
    return ethUsd > 0 && cost > 0 && Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

/**
 * ETH to keep on hand for one swap, in wei: the permission step plus the swap
 * itself, with room for the gas price to triple before the user comes back,
 * and never less than 0.0005 ETH. Running short would mean a second transfer
 * of ETH, which costs more than the margin. Null when the gas price cannot be read.
 */
export const MIN_SWAP_ETH = 500_000_000_000_000n;
export async function swapEthNeeded(rpc: EthRpc): Promise<bigint | null> {
  try {
    const gas = await rpc.gasPrice();
    if (gas <= 0n) return null;
    const need = gas * 3n * ((SWAP_GAS * 12n) / 10n + 70_000n);
    return need > MIN_SWAP_ETH ? need : MIN_SWAP_ETH;
  } catch {
    return null;
  }
}

/**
 * Whether Ethereum fees eat too much of a swap: more than 5% of its value,
 * or, when the fee cannot be estimated, any swap under $50.
 */
export function smallSwap(valueUsd: number | null, costUsd: number | null): { costUsd: number | null; share: number | null } | null {
  if (!valueUsd || !(valueUsd > 0)) return null;
  if (costUsd === null) return valueUsd < 50 ? { costUsd: null, share: null } : null;
  const share = costUsd / valueUsd;
  return share > 0.05 ? { costUsd, share } : null;
}

/** Amount with decimals, for display. */
export function formatUnits(v: bigint, decimals: number, max = 6): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? s.slice(-decimals).slice(0, max).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

export function parseUnits(text: string, decimals: number): bigint | null {
  if (ambiguous(text)) return null;
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w = "0", f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
