import { describe, expect, it } from "vitest";
import { Transaction as RefTx } from "micro-eth-signer";
import * as c from "../src/core";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ARB = c.sourceChain("arbitrum");
const FROM = c.ethAccountFromPhrase(ABANDON).address;

/** Calldata shaped like LI.FI's startBridgeTokensViaStargate(BridgeData, StargateData): selector, offsets, then the struct. */
const bridgeCalldata = (receiver: string, destChain = 1n, minAmount = 100_000_000n, destinationCall = 0n) => {
  const w = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase().padStart(64, "0") : v.toString(16).padStart(64, "0"));
  const head = w(0x40n) + w(0x200n); // offsets: BridgeData at 0x40, second arg later
  const struct = [w("0x" + "11".repeat(32)), w(0x140n), w(0x180n), w(0n), w(ARB.usdt.address), w(receiver), w(minAmount), w(destChain), w(0n), w(destinationCall)].join("");
  return "0x" + "14d53077" + head + struct + w(5n) + w("0x" + "72656c6179" + "0".repeat(54)) + w(5n) + w("0x" + "6b65736869" + "0".repeat(54));
};

const quote = (over: any = {}) => ({
  id: "q1",
  tool: "relay",
  toolDetails: { key: "relay", name: "Relay" },
  action: { fromChainId: 42161, toChainId: 1, fromToken: { address: ARB.usdt.address, symbol: "USDT", decimals: 6 }, toToken: { address: c.WPRL_CONTRACT, symbol: "WPRL", decimals: 8 }, fromAmount: "100000000", toAddress: FROM, fromAddress: FROM },
  estimate: {
    fromAmount: "100000000", toAmount: "4547686600", toAmountMin: "4502209700", fromAmountUSD: "99.88", toAmountUSD: "99.62",
    approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", executionDuration: 3,
    feeCosts: [{ name: "Integrator Fee", description: "Keshi", percentage: "0.003", amountUSD: "0.30", included: true }, { name: "LIFI Fee", percentage: "0.0025", amountUSD: "0.25", included: true }],
    gasCosts: [{ type: "SEND", amountUSD: "0.01" }],
  },
  transactionRequest: { from: FROM, to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: bridgeCalldata(FROM), value: "0x0", gasLimit: "0x30d40", chainId: 42161 },
  ...over,
});

describe("LI.FI quotes", () => {
  it("refuses a quote with no permission address, a negative fee, or another sender (audit, October 2026)", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    const { approvalAddress: _gone, ...noApproval } = quote().estimate;
    expect(() => c.parseQuote(quote({ estimate: noApproval }), want)).toThrow(/permission/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, feeCosts: [{ name: "LIFI Fee", amountUSD: "-5", included: true }] } }), want)).toThrow(/unreadable fee/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, gasCosts: [{ amountUSD: "NaN" }] } }), want)).toThrow(/unreadable fee/);
    expect(() => c.parseQuote(quote({ action: { ...quote().action, fromAddress: "0x" + "99".repeat(20) } }), want)).toThrow(/different sender/);
  });
  it("reads the figures the screen shows", () => {
    const q = c.parseQuote(quote(), { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n });
    expect(q.toAmount).toBe(4547686600n);
    expect(q.toAmountMin).toBe(4502209700n);
    expect(q.includedFeesUsd).toBeCloseTo(0.55);
    expect(q.keshiFeeUsd).toBeCloseTo(0.3);
    expect(q.gasUsd).toBeCloseTo(0.01);
    expect(q.toolName).toBe("Relay");
    expect(q.tx.gasLimit).toBe(200_000n);
    expect(q.duration).toBe(3);
  });
  it("refuses a quote for another recipient, chain or token", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    const other = "0x8Efc8EBff262e006B71fE4993886B4139E04c861";
    expect(() => c.parseQuote(quote({ action: { ...quote().action, toAddress: other } }), want)).toThrow(/recipient/);
    expect(() => c.parseQuote(quote({ action: { ...quote().action, toChainId: 10 } }), want)).toThrow(/chain/);
    expect(() => c.parseQuote(quote({ action: { ...quote().action, toToken: { address: c.USDT } } }), want)).toThrow(/token/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, chainId: 1 } }), want)).toThrow(/different chain/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, from: other } }), want)).toThrow(/sender/);
  });
  it("refuses a quote that spends a different amount of USDT than the one typed", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    expect(c.parseQuote(quote(), want).fromAmount).toBe(100_000000n);
    const big = { ...quote().estimate, fromAmount: "5000000000", fromAmountUSD: "4994", toAmountUSD: "4981", toAmount: "227384330000", toAmountMin: "225110486700" };
    expect(() => c.parseQuote(quote({ estimate: big, action: { ...quote().action, fromAmount: "5000000000" } }), want)).toThrow(/different amount/);
    expect(() => c.parseQuote(quote({ action: { ...quote().action, fromAmount: "5000000000" } }), want)).toThrow(/different amount/);
    // Smaller, zero, and estimate and action disagreeing with each other.
    const est = (fromAmount: string) => ({ ...quote().estimate, fromAmount });
    expect(() => c.parseQuote(quote({ estimate: est("50000000"), action: { ...quote().action, fromAmount: "50000000" } }), want)).toThrow(/different amount/);
    expect(() => c.parseQuote(quote({ estimate: est("0"), action: { ...quote().action, fromAmount: "0" } }), want)).toThrow(/amount/);
    expect(() => c.parseQuote(quote({ estimate: est("100000000"), action: { ...quote().action, fromAmount: "100000001" } }), want)).toThrow(/different amount/);
  });
  it("refuses a transaction that moves more than the quote, or nothing", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000_000n };
    const tx = (min: bigint) => ({ transactionRequest: { ...quote().transactionRequest, data: bridgeCalldata(FROM, 1n, min) } });
    expect(c.parseQuote(quote(tx(99_500_000n)), want).fromAmount).toBe(100_000_000n); // fees taken before bridging: fine
    expect(() => c.parseQuote(quote(tx(500_000_000n)), want)).toThrow(/different amount than the quote/);
    expect(() => c.parseQuote(quote(tx(0n)), want)).toThrow(/different amount than the quote/);
    // After a swap to ETH on the source chain the bridged amount is in wei: not compared with USDT units.
    const viaEth = bridgeCalldata(FROM, 1n, 25_000_000_000_000_000n).replace(ARB.usdt.address.slice(2).toLowerCase(), "0".repeat(40));
    expect(c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, data: viaEth } }), want).fromAmount).toBe(100_000_000n);
  });
  it("refuses a route that loses too much, a missing dollar value, or a transaction asking for the chain's coin", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, toAmountUSD: "70" } }), want)).toThrow(/20%/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, fromAmountUSD: "0" } }), want)).toThrow(/dollar value/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, toAmountMin: "4000000000" } }), want)).toThrow(/floor/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, value: "0x1" } }), want)).toThrow(/coin/);
  });
  it("only ever calls LI.FI's own contract, and only lets that contract take the USDT", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    // A compromised server pointing the transaction at the USDT contract (transfer everything) or anywhere else is refused.
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, to: ARB.usdt.address } }), want)).toThrow(/LI.FI's contract/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, to: "0x8Efc8EBff262e006B71fE4993886B4139E04c861" } }), want)).toThrow(/LI.FI's contract/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, approvalAddress: "0x8Efc8EBff262e006B71fE4993886B4139E04c861" } }), want)).toThrow(/permission/);
    expect(() => c.parseQuote(quote({ estimate: { ...quote().estimate, approvalAddress: "1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" } }), want)).toThrow(/permission/);
    expect(c.parseQuote(quote(), want).tx.to.toLowerCase()).toBe(c.LIFI_DIAMOND.toLowerCase());
  });
  it("reads the recipient inside the transaction and refuses any other", () => {
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    const other = "0x8Efc8EBff262e006B71fE4993886B4139E04c861";
    // The quote's summary says "you", the calldata says the attacker: refused.
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, data: bridgeCalldata(other) } }), want)).toThrow(/another address/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, data: bridgeCalldata(FROM, 10n) } }), want)).toThrow(/another chain/);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, data: "0xabcdef" } }), want)).toThrow(/could not be read|too short/);
    const d = c.decodeBridgeData(bridgeCalldata(FROM));
    expect(d.receiver.toLowerCase()).toBe(FROM.toLowerCase());
    expect(d.destinationChainId).toBe(1n);
    expect(d.minAmount).toBe(100_000_000n);
    expect(d.hasDestinationCall).toBe(false);
  });
  it("refuses calls whose first argument is not really LI.FI's BridgeData", () => {
    const good = bridgeCalldata(FROM);
    // swapTokensSingleV3ERC20ToERC20(bytes32 transactionId, …): its first word is free, so it could point at a fake struct.
    expect(() => c.decodeBridgeData("0x4666fc80" + good.slice(10))).toThrow(/does not know/);
    // A known bridge function, but the struct is not where the ABI puts it.
    const moved = "0x14d53077" + (0x60).toString(16).padStart(64, "0") + good.slice(10 + 64);
    expect(() => c.decodeBridgeData(moved)).toThrow(/could not be read/);
    expect(Object.keys(c.LIFI_BRIDGE_CALLS).length).toBeGreaterThan(60);
  });
  it("refuses a route that ends with a step on Ethereum it cannot read", () => {
    // The receiver field says "you", but an instruction run after the bridge would decide who really gets the money.
    const want = { fromChainId: 42161n, fromToken: ARB.usdt.address, toToken: c.WPRL_CONTRACT, fromAddress: FROM, fromAmount: 100_000000n };
    expect(c.decodeBridgeData(bridgeCalldata(FROM, 1n, 100_000_000n, 1n)).hasDestinationCall).toBe(true);
    expect(() => c.parseQuote(quote({ transactionRequest: { ...quote().transactionRequest, data: bridgeCalldata(FROM, 1n, 100_000_000n, 1n) } }), want)).toThrow(/cannot check/);
  });
  it("keeps only a genuine LI.FI explorer link", () => {
    expect(c.parseStatus({ status: "DONE", lifiExplorerLink: "https://keshi-support.example/refund" }).explorer).toBeUndefined();
    expect(c.parseStatus({ status: "DONE", lifiExplorerLink: "https://scan.li.fi/tx/0x" + "ab".repeat(32) }).explorer).toBe("https://scan.li.fi/tx/0x" + "ab".repeat(32));
  });
  it("reads a status", () => {
    expect(c.parseStatus({ status: "DONE", substatus: "COMPLETED", receiving: { amount: "4547686600", txHash: "0xaa" }, lifiExplorerLink: "https://scan.li.fi/tx/0x" + "cd".repeat(32) })).toEqual({ status: "DONE", substatus: "COMPLETED", message: undefined, receivedAmount: 4547686600n, receivedToken: undefined, receivedChain: undefined, receivingTx: "0xaa", explorer: "https://scan.li.fi/tx/0x" + "cd".repeat(32) });
    expect(c.parseStatus({ status: "WEIRD" }).status).toBe("NOT_FOUND");
    expect(c.describeStatus({ status: "PENDING", substatus: "WAIT_SOURCE_CONFIRMATIONS" })).toMatch(/Confirming/);
  });
  it("asks LI.FI for exactly the chain, tokens, address and Keshi fee", async () => {
    let url = "";
    let headers: any = {};
    const lifi = new c.LiFi(async (u: any, init: any) => {
      url = String(u);
      headers = init.headers;
      return { ok: true, json: async () => quote({ action: { ...quote().action, toToken: { address: c.ETH_USDT, symbol: "USDT", decimals: 6 } } }) } as any;
    }, "test-key", { bips: 30n, recipient: FROM, label: "0.3%" });
    await lifi.quote(ARB, FROM, 100_000_000n, "usdt");
    const p = new URL(url).searchParams;
    expect(url.startsWith(c.LIFI_API + "/quote?")).toBe(true);
    expect(p.get("fromChain")).toBe("42161");
    expect(p.get("toChain")).toBe("1");
    expect(p.get("fromToken")).toBe(ARB.usdt.address);
    expect(p.get("toToken")).toBe(c.ETH_USDT);
    expect(p.get("toAddress")).toBe(FROM);
    expect(p.get("allowDestinationCall")).toBe("false");
    expect(p.get("fee")).toBe("0.003");
    expect(p.get("integrator")).toBe("keshi");
    expect(headers["x-lifi-api-key"]).toBe("test-key");
  });
});

describe("signing on another chain", () => {
  it("signs for Arbitrum so that the transaction can never be replayed on Ethereum", () => {
    const acct = c.ethAccountFromPhrase(ABANDON);
    const tx: c.EthTx = { nonce: 3n, maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 100_000_000n, gasLimit: 900_000n, to: ARB.usdt.address, value: 0n, data: c.callData.approve(c.WPRL_CONTRACT, 1n) };
    const { raw } = c.signEthTx(tx, acct.privateKey, ARB.chainId);
    const ref = RefTx.fromHex(raw);
    expect(ref.raw.chainId).toBe(42161n);
    expect(ref.sender).toBe(acct.address);
    expect(c.signEthTx(tx, acct.privateKey).raw).not.toBe(raw);
  });
  it("accepts a zero base fee only where the chain works that way", async () => {
    const answers: Record<string, unknown> = { eth_getTransactionCount: "0x1", eth_estimateGas: "0x5208", eth_maxPriorityFeePerGas: "0x0", eth_getBlockByNumber: { baseFeePerGas: "0x0" }, eth_gasPrice: "0x3b9aca00" };
    const rpc = new c.EthRpc(async (_u: any, init: any) => ({ ok: true, json: async () => ({ id: 1, result: answers[JSON.parse(init.body).method] }) }) as any, ["https://x"]);
    await expect(rpc.prepare(FROM, ARB.usdt.address, new Uint8Array(0))).rejects.toThrow(/fee/);
    const tx = await rpc.prepare(FROM, ARB.usdt.address, new Uint8Array(0), 0n, { zeroBaseFee: true });
    expect(tx.maxFeePerGas).toBe(1_200_000_000n);
  });
  it("refuses a gas price above the chain's ceiling, and a server's gas limit above the wallet's", async () => {
    const answers: Record<string, unknown> = { eth_getTransactionCount: "0x1", eth_estimateGas: "0x5208", eth_maxPriorityFeePerGas: "0x0", eth_getBlockByNumber: { baseFeePerGas: "0x0" }, eth_gasPrice: "0x22ecb25c00" };
    const rpc = new c.EthRpc(async (_u: any, init: any) => ({ ok: true, json: async () => ({ id: 1, result: answers[JSON.parse(init.body).method] }) }) as any, ["https://x"]);
    const bsc = c.sourceChain("bsc");
    await expect(rpc.prepare(FROM, bsc.usdt.address, new Uint8Array(0), 0n, bsc.limits)).rejects.toThrow(/far above normal/);
    answers.eth_gasPrice = "0x3b9aca00";
    const tx = await rpc.prepare(FROM, bsc.usdt.address, new Uint8Array(0), 0n, { ...bsc.limits, minGas: 30_000_000n });
    expect(tx.gasLimit).toBe(3_000_000n);
  });
  it("takes the lowest gas price the servers report", async () => {
    const prices = ["0x22ecb25c00", "0x3b9aca00"];
    let i = 0;
    const rpc = new c.EthRpc(async () => ({ ok: true, json: async () => ({ id: 1, result: prices[i++ % 2] }) }) as any, ["https://a", "https://b"]);
    expect(await rpc.gasPriceMin()).toBe(1_000_000_000n);
  });
});
