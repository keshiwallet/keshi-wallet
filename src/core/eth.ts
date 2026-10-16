import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { cleanPhrase } from "./keys";

// The small part of Ethereum that Keshi needs to hold wPRL and send it back
// through the bridge: one account from the same recovery phrase, token
// balances, and signing two kinds of contract call. Nothing else.

export const ETH_CHAIN_ID = 1n;
const RPCS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

/* ------------------------------------------------------------- account */

export interface EthAccount {
  address: string; // checksummed
  privateKey: Uint8Array;
}

export function checksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return checksumAddress(bytesToHex(keccak_256(pub).slice(12)));
}

/** Standard Ethereum account (m/44'/60'/0'/0/0): the same one MetaMask shows for this phrase. */
export function ethAccountFromPhrase(phrase: string): EthAccount {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(cleanPhrase(phrase), "")).derive("m/44'/60'/0'/0/0");
  const privateKey = node.privateKey!;
  return { address: addressFromPrivateKey(privateKey), privateKey };
}

/* ----------------------------------------------------------------- RLP */

type Rlp = Uint8Array | Rlp[];

const beBytes = (n: bigint): Uint8Array => {
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return hexToBytes(h);
};

function rlpLen(len: number, offset: number): Uint8Array {
  if (len <= 55) return Uint8Array.of(offset + len);
  const l = beBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + l.length), l);
}

export function rlp(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(rlpLen(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlp));
  return concatBytes(rlpLen(body.length, 0xc0), body);
}

/* ------------------------------------------------------------ call data */

const word = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(64, "0"));
const addrWord = (a: string): Uint8Array => hexToBytes(a.slice(2).toLowerCase().padStart(64, "0"));
const selector = (sig: string): Uint8Array => keccak_256(new TextEncoder().encode(sig)).slice(0, 4);

export const callData = {
  balanceOf: (owner: string) => concatBytes(selector("balanceOf(address)"), addrWord(owner)),
  allowance: (owner: string, spender: string) => concatBytes(selector("allowance(address,address)"), addrWord(owner), addrWord(spender)),
  approve: (spender: string, amount: bigint) => concatBytes(selector("approve(address,uint256)"), addrWord(spender), word(amount)),
  transfer: (to: string, amount: bigint) => concatBytes(selector("transfer(address,uint256)"), addrWord(to), word(amount)),
  /** WETH only: turn wrapped ETH back into plain ETH. */
  withdraw: (amount: bigint) => concatBytes(selector("withdraw(uint256)"), word(amount)),
  requestBurn: (amount: bigint, pearlAddress: string) => {
    const text = new TextEncoder().encode(pearlAddress);
    const padded = new Uint8Array(Math.ceil(text.length / 32) * 32);
    padded.set(text);
    return concatBytes(selector("requestBurn(uint256,string)"), word(amount), word(64n), word(BigInt(text.length)), padded);
  },
};

/* -------------------------------------------------------- transactions */

export interface EthTx {
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
}

/** Sign an EIP-1559 transaction for Ethereum mainnet. Returns the raw transaction and its hash. */
export function signEthTx(tx: EthTx, privateKey: Uint8Array): { raw: string; hash: string } {
  const fields: Rlp[] = [beBytes(ETH_CHAIN_ID), beBytes(tx.nonce), beBytes(tx.maxPriorityFeePerGas), beBytes(tx.maxFeePerGas), beBytes(tx.gasLimit), hexToBytes(tx.to.slice(2)), beBytes(tx.value), tx.data, []];
  const digest = keccak_256(concatBytes(Uint8Array.of(2), rlp(fields)));
  const sig = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  const recovery = sig[0]!;
  const r = BigInt("0x" + bytesToHex(sig.slice(1, 33)));
  const s = BigInt("0x" + bytesToHex(sig.slice(33, 65)));
  const signed = concatBytes(Uint8Array.of(2), rlp([...fields, beBytes(BigInt(recovery)), beBytes(r), beBytes(s)]));
  return { raw: "0x" + bytesToHex(signed), hash: "0x" + bytesToHex(keccak_256(signed)) };
}

/* ------------------------------------------------------------------ RPC */

const hex = (n: bigint) => "0x" + n.toString(16);

const GWEI = 1_000_000_000n;
/** Ceilings on what the wallet will sign for Ethereum fees, whatever a server says. */
export const MAX_TIP = 5n * GWEI;
export const MAX_BASE_FEE = 150n * GWEI;
export const MAX_GAS = 900_000n;

export class EthRpc {
  constructor(
    private fetcher: typeof fetch = (...a) => fetch(...a),
    private urls: string[] = RPCS,
  ) {}

  private async call(method: string, params: unknown[]): Promise<any> {
    let last: unknown;
    for (const url of this.urls) {
      try {
        const res = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = await res.json();
        if (j.error) throw new Error(String(j.error.message ?? "Ethereum refused the request"));
        return j.result;
      } catch (e) {
        last = e;
        // A refusal from the network itself (not a connection problem) will not improve on another server.
        if (e instanceof Error && /revert|insufficient|nonce|underpriced|exceeds/i.test(e.message)) break;
      }
    }
    throw last instanceof Error ? last : new Error("Could not reach Ethereum");
  }

  async ethBalance(address: string): Promise<bigint> {
    return BigInt(await this.call("eth_getBalance", [address, "latest"]));
  }
  /** Current price of gas, in wei. */
  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call("eth_gasPrice", []));
  }
  private async read(to: string, data: Uint8Array): Promise<bigint> {
    const r = await this.call("eth_call", [{ to, data: "0x" + bytesToHex(data) }, "latest"]);
    return r && r !== "0x" ? BigInt(r) : 0n;
  }
  /** Raw result of a read-only contract call, as a 0x hex string. */
  async raw(to: string, data: Uint8Array): Promise<string> {
    return String((await this.call("eth_call", [{ to, data: "0x" + bytesToHex(data) }, "latest"])) ?? "0x");
  }
  /**
   * The same read asked of every server on its own, with the answers that came back.
   * Used for prices before a swap: one dishonest server cannot then lower the price
   * the user is protected by.
   */
  async rawEach(to: string, data: Uint8Array): Promise<string[]> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data: "0x" + bytesToHex(data) }, "latest"] });
    const answers = await Promise.allSettled(
      this.urls.map(async (url) => {
        const j = await (await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
        if (j.error) throw new Error(String(j.error.message ?? "refused"));
        return String(j.result ?? "0x");
      }),
    );
    return answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  }
  /** Whether an address holds contract code (a smart contract rather than a person's wallet). */
  async isContract(address: string): Promise<boolean> {
    const code = String((await this.call("eth_getCode", [address, "latest"])) ?? "0x");
    return code !== "0x" && code !== "0x0" && code.length > 2;
  }
  tokenBalance(token: string, owner: string): Promise<bigint> {
    return this.read(token, callData.balanceOf(owner));
  }
  allowance(token: string, owner: string, spender: string): Promise<bigint> {
    return this.read(token, callData.allowance(owner, spender));
  }

  /**
   * The smallest and largest amount (in grains) the bridge contract accepts,
   * read from the contract itself: its website's API does not publish them.
   * `max` 0 means no upper limit.
   */
  async bridgeBounds(controller: string): Promise<{ min: bigint; max: bigint }> {
    const [min, max] = await Promise.all([this.read(controller, selector("minDepositAmount()")), this.read(controller, selector("maxDepositAmount()"))]);
    return { min, max };
  }

  /** Fill in nonce, gas and fees for a contract call. */
  async prepare(from: string, to: string, data: Uint8Array, value = 0n): Promise<EthTx> {
    const [nonce, gas, tip, block] = await Promise.all([
      this.call("eth_getTransactionCount", [from, "pending"]),
      this.call("eth_estimateGas", [{ from, to, data: "0x" + bytesToHex(data), ...(value > 0n ? { value: hex(value) } : {}) }]),
      this.call("eth_maxPriorityFeePerGas", []).catch(() => "0x3b9aca00"),
      this.call("eth_getBlockByNumber", ["latest", false]),
    ]);
    // These numbers come from a public server. They are bounded here so that
    // a wrong or hostile answer cannot burn the user's ETH as fees.
    const base = BigInt(block?.baseFeePerGas ?? "0x0");
    if (base <= 0n) throw new Error("Could not read Ethereum's current fee. Try again in a moment.");
    if (base > MAX_BASE_FEE) throw new Error("Ethereum fees are extremely high right now. Nothing was sent; try again later.");
    const estimate = BigInt(gas);
    if (estimate > MAX_GAS) throw new Error("This transaction would use an abnormal amount of gas. Nothing was sent.");
    const priority = BigInt(tip) > MAX_TIP ? MAX_TIP : BigInt(tip);
    return { nonce: BigInt(nonce), gasLimit: (estimate * 12n) / 10n, maxPriorityFeePerGas: priority, maxFeePerGas: base * 2n + priority, to, value, data };
  }

  /**
   * Broadcast a signed transaction. With `hash` (worked out locally when
   * signing), an "already known" answer counts as sent: it means an earlier
   * attempt did reach the network, and the caller must wait for it rather
   * than sign a second one.
   */
  async send(raw: string, hash?: string): Promise<string> {
    try {
      const answered = String(await this.call("eth_sendRawTransaction", [raw]));
      return hash ?? answered;
    } catch (e) {
      if (hash && e instanceof Error && /already known|known transaction|already imported/i.test(e.message)) return hash;
      // "Nonce too low" or a dropped connection can mean this very transaction already went out: ask before reporting a failure.
      if (hash && (await this.knows(hash))) return hash;
      throw e;
    }
  }

  /** Whether a transaction is already in a block. */
  async mined(hash: string): Promise<boolean> {
    return !!(await this.call("eth_getTransactionReceipt", [hash]).catch(() => null));
  }

  /** Whether the network has seen a transaction (waiting or mined). */
  async knows(hash: string): Promise<boolean> {
    try {
      return !!(await this.call("eth_getTransactionByHash", [hash]));
    } catch {
      return false;
    }
  }

  /** Wait until a transaction is mined. Resolves true on success, false if it failed. */
  async wait(hash: string, timeoutMs = 240_000, everyMs = 4000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = await this.call("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (r) return BigInt(r.status ?? "0x0") === 1n;
      await new Promise((ok) => setTimeout(ok, everyMs));
    }
    throw new Error("Ethereum has not confirmed the transaction yet. Do not send it again: it can still go through. Check your Ethereum address in a few minutes.");
  }
}

export const maxEthCost = (tx: EthTx): bigint => tx.gasLimit * tx.maxFeePerGas;

/** Never ask for less ETH than this for a set of Ethereum transactions: running short costs a second top-up. */
export const MIN_ETH_FOR_FEES = 500_000_000_000_000n; // 0.0005 ETH

/**
 * ETH to keep for sending wPRL back through the bridge (permission step, then
 * the return itself), with room for the gas price to triple. Null when the
 * gas price cannot be read.
 */
export async function bridgeBackEthNeeded(rpc: EthRpc): Promise<bigint | null> {
  try {
    const gas = await rpc.gasPrice();
    if (gas <= 0n) return null;
    const need = gas * 3n * (70_000n + 200_000n);
    return need > MIN_ETH_FOR_FEES ? need : MIN_ETH_FOR_FEES;
  } catch {
    return null;
  }
}
export const formatEth = (wei: bigint, decimals = 5): string => {
  const s = wei.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18, -18 + decimals)}`;
};

/* ------------------------------------------------- sending ETH and tokens */

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ethereum send: the transaction to sign, what the recipient gets, and the most it can cost in fees. */
export interface EthSendPlan {
  tx: EthTx;
  amount: bigint;
  fee: bigint;
}

/**
 * Prepare a plain transfer from the wallet's Ethereum address: ETH (`token`
 * omitted) or an ERC-20 token. With `"max"`, ETH leaves exactly enough for the
 * fee; a token sends the whole balance. Checks the balances first so that a
 * send that cannot go through is refused before anything is signed.
 */
export async function planEthSend(rpc: EthRpc, from: string, to: string, amount: bigint | "max", balances: { eth: bigint; token?: bigint }, token?: string): Promise<EthSendPlan> {
  if (token) {
    const have = balances.token ?? 0n;
    const value = amount === "max" ? have : amount;
    if (value <= 0n) throw new Error("Enter an amount");
    if (value > have) throw new Error("You do not hold that much");
    const tx = await rpc.prepare(from, token, callData.transfer(to, value)).catch((e) => {
      throw /insufficient funds/i.test(errMessage(e)) ? new Error("NO_ETH_FOR_FEE") : e;
    });
    const fee = maxEthCost(tx);
    if (balances.eth < fee) throw new Error("NO_ETH_FOR_FEE");
    return { tx, amount: value, fee };
  }
  if (amount !== "max" && amount > balances.eth) throw new Error("You do not hold that much ETH");
  // The gas is estimated with the real amount when it is known: a contract may do more work when it receives ETH.
  const probe = await rpc.prepare(from, to, new Uint8Array(0), amount === "max" ? 0n : amount).catch((e) => {
    throw /insufficient funds/i.test(errMessage(e)) ? new Error("NO_ETH_FOR_FEE") : e;
  });
  const fee = maxEthCost(probe);
  let value = amount === "max" ? balances.eth - fee : amount;
  if (amount === "max" && value <= 0n) throw new Error("NO_ETH_FOR_FEE");
  if (amount === "max") {
    // Estimated again with the real amount: a contract recipient may need more gas when it receives ETH.
    const real = await rpc.prepare(from, to, new Uint8Array(0), value).catch(() => probe);
    const fee2 = maxEthCost(real);
    if (fee2 > fee) {
      value = balances.eth - fee2;
      if (value <= 0n) throw new Error("NO_ETH_FOR_FEE");
      return { tx: { ...real, value }, amount: value, fee: fee2 };
    }
  }
  if (value <= 0n) throw new Error("Enter an amount");
  if (value + fee > balances.eth) throw new Error(value > balances.eth ? "You do not hold that much ETH" : "NO_ETH_FOR_FEE");
  return { tx: { ...probe, value }, amount: value, fee };
}
