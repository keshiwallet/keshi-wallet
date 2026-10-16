import { describe, it, expect } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createContract } from "micro-eth-signer/abi.js";
import * as c from "../src/core";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const FEE_TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const ABI = [
  { type: "function", name: "exactInput", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [{ name: "path", type: "bytes" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }] }], outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] },
  { type: "function", name: "sweepTokenWithFee", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }, { name: "feeBips", type: "uint256" }, { name: "feeRecipient", type: "address" }], outputs: [] },
  { type: "function", name: "quoteExactInput", stateMutability: "nonpayable", inputs: [{ name: "path", type: "bytes" }, { name: "amountIn", type: "uint256" }], outputs: [{ name: "amountOut", type: "uint256" }] },
  { type: "function", name: "exactOutput", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [{ name: "path", type: "bytes" }, { name: "recipient", type: "address" }, { name: "amountOut", type: "uint256" }, { name: "amountInMaximum", type: "uint256" }] }], outputs: [{ name: "amountIn", type: "uint256" }] },
  { type: "function", name: "quoteExactOutput", stateMutability: "nonpayable", inputs: [{ name: "path", type: "bytes" }, { name: "amountOut", type: "uint256" }], outputs: [{ name: "amountIn", type: "uint256" }] },
  { type: "function", name: "refundETH", stateMutability: "payable", inputs: [], outputs: [] },
] as const;
const ref: any = createContract(ABI as any);
const hex = (b: Uint8Array) => bytesToHex(b);

describe("any-token swap encoding", () => {
  const path = c.encodePath([c.WPRL_CONTRACT, c.USDT, TOKEN], [3000, 500]);

  it("packs a route as token, fee, token, fee, token", () => {
    expect(hex(path)).toBe(c.WPRL_CONTRACT.slice(2).toLowerCase() + "000bb8" + c.USDT.slice(2).toLowerCase() + "0001f4" + TOKEN.slice(2).toLowerCase());
    expect(path.length).toBe(20 + 3 + 20 + 3 + 20);
  });

  it("uses the published selectors", () => {
    expect(hex(c.routeData.swap(path, ME, 1n, 1n)).slice(0, 8)).toBe("b858183f");
    expect(hex(c.routeData.multicall([new Uint8Array(4)])).slice(0, 8)).toBe("ac9650d8");
    expect(hex(c.routeData.sweepWithFee(TOKEN, 1n, ME, 10n, FEE_TO)).slice(0, 8)).toBe("e0e189a0");
    expect(hex(c.routeData.quote(path, 1n)).slice(0, 8)).toBe("cdca1753");
  });

  it("matches an independent encoder byte for byte", () => {
    const swap = c.routeData.swap(path, ME, 100_00000000n, 123_000000n);
    expect(hex(swap)).toBe(hex(ref.exactInput.encodeInput({ path, recipient: ME, amountIn: 100_00000000n, amountOutMinimum: 123_000000n })));
    const sweep = c.routeData.sweepWithFee(TOKEN, 123_000000n, ME, 10n, FEE_TO);
    expect(hex(sweep)).toBe(hex(ref.sweepTokenWithFee.encodeInput({ token: TOKEN, amountMinimum: 123_000000n, recipient: ME, feeBips: 10n, feeRecipient: FEE_TO })));
    expect(hex(c.routeData.multicall([swap, sweep]))).toBe(hex(ref.multicall.encodeInput([swap, sweep])));
    expect(hex(c.routeData.quote(path, 5n))).toBe(hex(ref.quoteExactInput.encodeInput({ path, amountIn: 5n })));
  });

  it("finds the best route and reads amounts with decimals", async () => {
    const rpc = { raw: async (_to: string, data: Uint8Array) => {
      const h = hex(data);
      const hops = (h.match(new RegExp(c.USDT.slice(2).toLowerCase(), "g")) ?? []).length;
      const viaWeth = h.includes(c.WETH.slice(2).toLowerCase());
      if (!hops) throw new Error("execution reverted");
      return "0x" + (viaWeth ? 900n : h.includes("000bb8" + c.USDT.slice(2).toLowerCase() + "0001f4") ? 1000n : 950n).toString(16).padStart(64, "0");
    } } as unknown as c.EthRpc;
    const r = await c.findRoute(rpc, c.WPRL_CONTRACT, TOKEN, 100n);
    expect(r.amountOut).toBe(1000n);
    expect(r.tokens.map((t) => t.toLowerCase())).toEqual([c.WPRL_CONTRACT, c.USDT, TOKEN].map((t) => t.toLowerCase()));
    expect(r.fees).toEqual([3000, 500]);
    const back = await c.findRoute(rpc, TOKEN, c.WPRL_CONTRACT, 100n);
    expect(back.tokens[0]!.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(back.tokens[back.tokens.length - 1]!.toLowerCase()).toBe(c.WPRL_CONTRACT.toLowerCase());
    expect(c.formatUnits(1234567890n, 6)).toBe("1,234.56789");
    expect(c.parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(c.parseUnits("1.1234567", 6)).toBe(null);
  });

  it("tells a busy server from a missing route, and never floods it", async () => {
    let live = 0, peak = 0;
    const counted = (answer: () => string) => ({ raw: async () => {
      peak = Math.max(peak, ++live);
      await new Promise((ok) => setTimeout(ok, 1));
      live--;
      return answer();
    } }) as unknown as c.EthRpc;
    await expect(c.findRoute(counted(() => { throw new Error("execution reverted"); }), c.WPRL_CONTRACT, TOKEN, 100n, 1)).rejects.toThrow(/no route/);
    expect(peak).toBeLessThanOrEqual(4);
    await expect(c.findRoute(counted(() => { throw new Error("Too Many Requests"); }), c.WPRL_CONTRACT, TOKEN, 100n, 1)).rejects.toThrow(/did not answer/);
    // One good answer after a first refusal is enough: the retry rescues it.
    let n = 0;
    const flaky = { raw: async () => { if (n++ % 2 === 0) throw new Error("Too Many Requests"); return "0x" + (777n).toString(16).padStart(64, "0"); } } as unknown as c.EthRpc;
    expect((await c.findRoute(flaky, c.WPRL_CONTRACT, TOKEN, 100n, 1)).amountOut).toBe(777n);
  });

  it("warns when Ethereum fees are large next to the swap", async () => {
    // Gas at 20 gwei, ETH at $3,000: 250,000 gas costs $15.
    const rpc = { gasPrice: async () => 20_000_000_000n, raw: async () => "0x" + (3000_000000n).toString(16).padStart(64, "0") } as unknown as c.EthRpc;
    expect(await c.swapCostUsd(rpc)).toBeCloseTo(15, 6);
    expect(await c.swapCostUsd({ gasPrice: async () => { throw new Error("down"); }, raw: async () => "0x" } as unknown as c.EthRpc)).toBe(null);
    expect(c.smallSwap(100, 15)!.share).toBeCloseTo(0.15);
    expect(c.smallSwap(1000, 15)).toBe(null); // 1.5%: fine
    expect(c.smallSwap(30, null)).toEqual({ costUsd: null, share: null }); // no estimate: under $50 warns
    expect(c.smallSwap(80, null)).toBe(null);
    expect(c.smallSwap(null, 15)).toBe(null);
  });

  it("reads a token's symbol and decimals", async () => {
    const str = (s: string) => "0x" + (32n).toString(16).padStart(64, "0") + BigInt(s.length).toString(16).padStart(64, "0") + Buffer.from(s).toString("hex").padEnd(64, "0");
    const rpc = { raw: async (_t: string, d: Uint8Array) => (hex(d) === "95d89b41" ? str("DAI") : "0x" + (18n).toString(16).padStart(64, "0")) } as unknown as c.EthRpc;
    expect(await c.tokenMeta(rpc, TOKEN)).toEqual({ address: TOKEN, symbol: "DAI", decimals: 18 });
    await expect(c.tokenMeta({ raw: async () => "0x" } as unknown as c.EthRpc, TOKEN)).rejects.toThrow(/No token/);
  });

  it("only charges a commission when an Ethereum fee address is set, never above 1%", () => {
    const base = { feeAddress: "", sendPercent: 0, sendCapPrl: 0, combinePercent: 0, combineCapPrl: 0 };
    expect(c.swapFee({ ...base, ethFeeAddress: "", swapPercent: 0.1 })).toBeUndefined();
    expect(c.swapFee({ ...base, ethFeeAddress: FEE_TO, swapPercent: 0.1 })!.bips).toBe(10n);
    expect(c.swapFee({ ...base, ethFeeAddress: FEE_TO, swapPercent: 5 })).toBeUndefined();
  });
});

describe("buying PRL with ETH", () => {
  const reversed = c.encodePath([c.WPRL_CONTRACT, c.USDT, c.WETH], [3000, 500]);

  it("encodes exact-output calls byte for byte like the reference encoder", () => {
    expect(hex(c.routeData.swapOut(reversed, ME, 100_00000000n, 42_000_000_000_000_000n))).toBe(hex(ref.exactOutput.encodeInput({ path: reversed, recipient: ME, amountOut: 100_00000000n, amountInMaximum: 42_000_000_000_000_000n })));
    expect(hex(c.routeData.quoteOut(reversed, 5n))).toBe(hex(ref.quoteExactOutput.encodeInput({ path: reversed, amountOut: 5n })));
    expect(hex(c.routeData.refundEth())).toBe(hex(ref.refundETH.encodeInput()));
    expect(hex(c.routeData.swapOut(reversed, ME, 1n, 1n)).slice(0, 8)).toBe("09b81346");
  });

  it("asks every route backwards and keeps the one that costs the least ETH", async () => {
    const asked: string[] = [];
    const rpc = { raw: async (_to: string, data: Uint8Array) => {
      const h = hex(data);
      asked.push(h);
      expect(h.slice(0, 8)).toBe(hex(c.routeData.quoteOut(reversed, 1n)).slice(0, 8));
      // Every quote starts with wPRL (the token bought) and ends with WETH (the token paid).
      const path = h.slice(8 + 64 * 3);
      expect(path.startsWith(c.WPRL_CONTRACT.slice(2).toLowerCase())).toBe(true);
      if (h.includes(c.USDT.slice(2).toLowerCase())) return "0x" + (h.includes("000bb8" + c.USDT.slice(2).toLowerCase() + "0001f4") ? 40n : 45n).toString(16).padStart(64, "0");
      throw new Error("execution reverted");
    } } as unknown as c.EthRpc;
    const q = await c.ethBuyQuote(rpc, 100_00000000n);
    expect(q.eth).toBe(40n);
    expect(q.tokens.map((t) => t.toLowerCase())).toEqual([c.WETH, c.USDT, c.WPRL_CONTRACT].map((t) => t.toLowerCase()));
    expect(q.fees).toEqual([500, 3000]);
    expect(c.ethBuyMax(q)).toBe(40n); // 1% of 40 wei rounds to nothing
    expect(c.ethBuyMax({ ...q, eth: 1_000_000n })).toBe(1_010_000n);
  });

  it("sends the ETH with the swap, takes the commission in wPRL and asks for the change back, in one transaction", async () => {
    const q = { tokens: [c.WETH, c.USDT, c.WPRL_CONTRACT], fees: [500, 3000], wprl: 100_00000000n, eth: 42_000_000_000_000_000n };
    const sent: { to: string; data: Uint8Array; value: bigint }[] = [];
    const rpc = {
      ethBalance: async () => 10n ** 18n,
      rawEach: async () => ["0x" + (42_100_000_000_000_000n).toString(16).padStart(64, "0")],
      prepare: async (_f: string, to: string, data: Uint8Array, value: bigint) => {
        sent.push({ to, data, value });
        return { to, data, value, nonce: 1n, gasLimit: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, chainId: 1n };
      },
      send: async () => "0xhash",
      wait: async () => true,
    } as unknown as c.EthRpc;
    const acct = c.ethAccountOf({ phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" });
    await c.ethBuy(rpc, acct, q, () => {}, { bips: 30n, recipient: FEE_TO });
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe(c.UNI_ROUTER);
    expect(sent[0]!.value).toBe(42_420_000_000_000_000n); // the quote plus 1%
    const d = hex(sent[0]!.data);
    expect(d.slice(0, 8)).toBe("5ae401dc"); // multicall with a deadline
    expect(d).toContain(hex(c.routeData.swapOut(reversed, "0x0000000000000000000000000000000000000002", q.wprl, 42_420_000_000_000_000n)));
    expect(d).toContain(hex(c.routeData.sweepWithFee(c.WPRL_CONTRACT, q.wprl, acct.address, 30n, FEE_TO)));
    expect(d).toContain(hex(c.routeData.refundEth()));
    // A price that got more than 0.5% worse since the quote stops the swap before anything is sent.
    const worse = { ...rpc, rawEach: async () => ["0x" + (42_300_000_000_000_000n).toString(16).padStart(64, "0")] } as unknown as c.EthRpc;
    await expect(c.ethBuy(worse, acct, q, () => {}, undefined)).rejects.toThrow(/price moved/);
    // Not enough ETH for the maximum: refused before any transaction.
    const poor = { ...rpc, ethBalance: async () => 42_000_000_000_000_000n } as unknown as c.EthRpc;
    await expect(c.ethBuy(poor, acct, q, () => {}, undefined)).rejects.toThrow(/Not enough ETH/);
  });
});

describe("several wallets", () => {
  const A = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  it("imports a private key as hex or WIF and gives it one address", () => {
    const hexKey = "0000000000000000000000000000000000000000000000000000000000000001";
    const k = c.parsePrivateKey(hexKey);
    // WIF of private key 1 (compressed), the classic Bitcoin test value.
    expect(bytesToHex(c.parsePrivateKey("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"))).toBe(hexKey);
    const acct = c.accountFromKey(k, c.MAINNET);
    expect(acct.single).toBe(true);
    expect(acct.derive(false, 0).address).toBe(acct.derive(true, 7).address);
    expect(acct.derive(false, 0).address.startsWith("prl1p")).toBe(true);
    expect(() => c.parsePrivateKey("hello")).toThrow(/not a private key/);
    expect(() => c.parsePrivateKey("00".repeat(32))).toThrow(/not valid/);
    // Same key on Bitcoin gives the known taproot address for private key 1.
    expect(c.accountFromKey(k, { ...c.MAINNET, hrp: "bc" }).derive(false, 0).address).toBe("bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9");
  });
  it("keeps old single-wallet vaults working and switches between wallets", () => {
    const old: c.Secrets = { phrase: A };
    expect(c.walletsOf(old)).toEqual([{ name: "Wallet 1", phrase: A, key: undefined }]);
    const two = c.addWallet(old, { name: "Imported", key: "00".repeat(31) + "01" });
    expect(c.walletsOf(two).length).toBe(2);
    expect(c.selectWallet(two, 0).phrase).toBe(A);
    const sel = c.selectWallet(two, 1);
    expect(sel.phrase).toBe("");
    expect(c.accountOf(sel, c.MAINNET).single).toBe(true);
    expect(c.ethAccountOf(sel).address).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(c.ethAccountOf(c.selectWallet(two, 0)).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(() => c.addWallet(two, { name: "Again", phrase: A })).toThrow(/already/);
  });
});

describe("suspicious payments", () => {
  const known = ["prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp"];
  const fake = known[0]!.slice(0, 9) + "x".repeat(known[0]!.length - 14) + known[0]!.slice(-5);
  const act = (over: Partial<c.Activity>): c.Activity => ({ txid: "t", time: 1, confirmations: 1, net: 5_00000000n, fee: 0n, kind: "received", ...over });
  it("flags dust and look-alike senders, and nothing else", () => {
    expect(fake.length).toBe(known[0]!.length);
    expect(c.lookalikeOf(fake, known)).toBe(known[0]);
    expect(c.lookalikeOf(known[0]!, known)).toBeUndefined();
    expect(c.flagActivity(act({ counterparty: fake }), known)).toBe("lookalike");
    expect(c.flagActivity(act({ net: 546n, counterparty: "prl1pother" }), known)).toBe("dust");
    expect(c.flagActivity(act({ net: 50_000n, txid: "mine" }), known, new Set(["mine"]))).toBeUndefined();
    expect(c.flagActivity(act({ counterparty: "prl1pother" }), known)).toBeUndefined();
    expect(c.flagActivity(act({ kind: "mined", net: 100n }), known)).toBeUndefined();
    expect(c.flagActivity(act({ kind: "sent", net: -100n }), known)).toBeUndefined();
  });
});
