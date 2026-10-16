import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createContract } from "micro-eth-signer/abi.js";
import * as c from "../src/core";
import { Transaction } from "@scure/btc-signer";

// Regression tests for an internal security review (not an independent audit): each one pins a protection in place.

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = c.accountFromPhrase(PHRASE, c.MAINNET);
const a0 = account.derive(false, 0), chg = account.derive(true, 0);
const dest = account.derive(false, 5).address;
const coin_ = (value: bigint, n = 1): c.Utxo => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, address: a0.address, confirmations: 10, coinbase: false }) as c.Utxo;
const coin = (value: bigint, n = 1): c.Utxo => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, address: a0.address, confirmations: 10, coinbase: false }) as c.Utxo;
const snapOf = (utxos: c.Utxo[]): c.Snapshot =>
  ({ utxos, addresses: [{ address: a0.address, change: false, index: 0, used: true }], changeAddr: chg, receive: a0, balance: 0n, pending: 0n, immature: 0n, activity: [], updated: 0 }) as unknown as c.Snapshot;

describe("network fee ceilings (Pearl)", () => {
  it("never plans more than the ceiling, whatever rate a server gives", () => {
    const snap = snapOf([coin(1000_00000000n)]);
    const p = c.plan(snap, c.MAINNET, dest, 1_00000000n, 500_000_000);
    expect(p.fee).toBeLessThanOrEqual(BigInt(p.vsize) * BigInt(c.MAX_FEE_RATE));
    expect(p.fee).toBeLessThan(5_000_000n); // under 0.05 PRL instead of 770 PRL
    const all = c.plan(snap, c.MAINNET, dest, "max", Number.POSITIVE_INFINITY);
    expect(all.amount).toBeGreaterThan(999_00000000n);
  });

  it("refuses to sign a plan whose fee is abnormal or whose figures do not add up", () => {
    const snap = snapOf([coin(1000_00000000n)]);
    const p = c.plan(snap, c.MAINNET, dest, 1_00000000n, 10);
    expect(() => c.sign({ ...p, fee: p.fee + 500_00000000n, change: p.change - 500_00000000n }, snap, account, c.MAINNET)).toThrow(/abnormally high/);
    expect(() => c.sign({ ...p, change: p.change - 1n }, snap, account, c.MAINNET)).toThrow(/add up/);
    expect(c.sign(p, snap, account, c.MAINNET).txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the indexer's fee rate is clamped", async () => {
    const idx = new c.Indexer(c.MAINNET, (async () => new Response(JSON.stringify({ result: "50" }))) as typeof fetch);
    expect(await idx.feeRate(1)).toBe(c.MAX_FEE_RATE);
  });

  it("estimates the size of very large payments exactly (253 inputs and more)", () => {
    const coins = Array.from({ length: 300 }, (_, i) => coin(1_00000000n, i + 1));
    const snap = snapOf(coins);
    const p = c.plan(snap, c.MAINNET, dest, "max", 1);
    const { hex } = c.sign(p, snap, account, c.MAINNET);
    const real = Math.ceil((hex.length / 2 - (2 + 300 * 66) + (2 + 300 * 66) / 4)); // strip witness, add it back at a quarter weight
    expect(p.vsize).toBeGreaterThanOrEqual(real);
    expect(p.vsize - real).toBeLessThanOrEqual(1);
  });

  it("finds a way to pay when the leftover is too small for change", () => {
    // 50 grains/vB: a leftover between dust and the cost of a change output used to be refused.
    const snap = snapOf([coin(1_00000000n + 111n * 50n + 2000n)]);
    const p = c.plan(snap, c.MAINNET, dest, 1_00000000n, 50);
    expect(p.change).toBe(0n);
    expect(p.amount).toBe(1_00000000n);
  });
});

describe("amounts typed by people or sent by sites", () => {
  it("refuses 1,000 rather than guessing between one and one thousand", () => {
    expect(c.parsePrl("1,000")).toBe(null);
    expect(c.parsePrl("12,345,678")).toBe(null);
    expect(c.parsePrl("1,5")).toBe(150_000_000n);
    expect(c.parsePrl("0,125")).toBe(12_500_000n);
    expect(c.parsePrl("1000")).toBe(1000_00000000n);
    expect(c.parseUnits("1,000", 6)).toBe(null);
    expect(c.parseUnits("1.5", 6)).toBe(1_500_000n);
  });

  it("only charges a percentage fee that has a ceiling, and a swap fee that is real", () => {
    const feeAddress = a0.address;
    const base = { feeAddress, sendPercent: 0.2, sendCapPrl: 0, combinePercent: 0.1, combineCapPrl: 2 };
    expect(c.serviceFor(c.MAINNET, "send", base)).toBeUndefined();
    expect(c.serviceFor(c.MAINNET, "combine", base)).toBeDefined();
    expect(c.swapFee({ ...base, ethFeeAddress: "0x8Efc8EBff262e006B71fE4993886B4139E04c861", swapPercent: 0.004 })).toBeUndefined();
    expect(c.swapFee({ ...base, ethFeeAddress: "0x8Efc8EBff262e006B71fE4993886B4139E04c861", swapPercent: 0.85 })!.bips).toBe(85n);
  });

  it("writes mint amounts exactly, or not at all", () => {
    expect(c.wholeAmount({ perMint: 1e19, perMintText: "10000000000000000001" })).toBe("10000000000000000001");
    expect(() => c.wholeAmount({ perMint: 1e19, perMintText: "" })).toThrow(/exactly/);
    expect(c.wholeAmount({ perMint: 1000, perMintText: "" })).toBe("1000");
  });

  it("exports payouts with nothing a spreadsheet could run", () => {
    const csv = c.payoutsCsv([{ txid: '=HYPERLINK("https://evil")', time: 0, confirmations: "=1+1" as unknown as number, net: 100n, fee: 0n, kind: "received" }]);
    expect(csv).not.toContain("=");
  });

  it("only accepts private keys exported for this kind of chain", () => {
    expect(() => c.parsePrivateKey("cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA")).toThrow(/not a private key/); // testnet WIF
    expect(c.parsePrivateKey("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn").length).toBe(32);
  });
});

describe("Ethereum fee ceilings and swap deadline", () => {
  const rpcWith = (over: Record<string, unknown>) =>
    new c.EthRpc((async (_u: unknown, init: { body: string }) => {
      const q = JSON.parse(init.body);
      const table: Record<string, unknown> = { eth_getTransactionCount: "0x1", eth_estimateGas: "0x30d40", eth_maxPriorityFeePerGas: "0x3b9aca00", eth_getBlockByNumber: { baseFeePerGas: "0x2540be400" }, ...over };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: table[q.method] }));
    }) as unknown as typeof fetch, ["https://rpc.test"]);
  const me = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

  it("caps the tip a server can make the wallet sign", async () => {
    const tx = await rpcWith({ eth_maxPriorityFeePerGas: "0x" + (10n ** 21n).toString(16) }).prepare(me, c.USDT, new Uint8Array(4));
    expect(tx.maxPriorityFeePerGas).toBe(c.MAX_TIP);
    expect(c.maxEthCost(tx)).toBeLessThan(10n ** 17n); // under 0.1 ETH
  });

  it("refuses absurd gas or base fee", async () => {
    await expect(rpcWith({ eth_estimateGas: "0x" + (50_000_000n).toString(16) }).prepare(me, c.USDT, new Uint8Array(4))).rejects.toThrow(/abnormal amount of gas/);
    await expect(rpcWith({ eth_getBlockByNumber: { baseFeePerGas: "0x" + (10n ** 13n).toString(16) } }).prepare(me, c.USDT, new Uint8Array(4))).rejects.toThrow(/extremely high/);
  });

  it("treats 'already known' as sent instead of inviting a second swap", async () => {
    const rpc = new c.EthRpc((async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "already known" } }))) as unknown as typeof fetch, ["https://rpc.test"]);
    expect(await rpc.send("0x00", "0xabc")).toBe("0xabc");
    await expect(rpc.send("0x00")).rejects.toThrow(/already known/);
  });

  it("encodes the deadline batch exactly as the router expects", () => {
    const ABI = [{ type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "deadline", type: "uint256" }, { name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }] }] as const;
    const ref: any = createContract(ABI as any);
    const calls = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array(68).fill(7)];
    expect(bytesToHex(c.routeData.multicallBy(1_800_000_000n, calls))).toBe(bytesToHex(ref.multicall.encodeInput({ deadline: 1_800_000_000n, data: calls })));
    expect(bytesToHex(c.routeData.multicallBy(1n, calls)).slice(0, 8)).toBe("5ae401dc");
  });
});

describe("change stays home", () => {
  it("refuses to sign a plan whose change would go to a stranger", () => {
    const snap = snapOf([coin(1000_00000000n)]);
    const p = c.plan(snap, c.MAINNET, dest, 1_00000000n, 10);
    const stranger = c.accountFromPhrase(c.newPhrase(), c.MAINNET).derive(false, 0).address;
    expect(() => c.sign({ ...p, changeAddress: stranger }, snap, account, c.MAINNET)).toThrow(/change would leave the wallet/);
    expect(() => c.sign(p, snap, account, c.MAINNET)).not.toThrow();
  });
});

describe("Pearl address types", () => {
  const prog = new Uint8Array(32).fill(7);
  const { bech32m } = require("@scure/base") as typeof import("@scure/base");
  const v1 = bech32m.encode("prl", [1, ...bech32m.toWords(prog)]);
  const v2 = bech32m.encode("prl", [2, ...bech32m.toWords(prog)]);
  const v3 = bech32m.encode("prl", [3, ...bech32m.toWords(prog)]);
  const v2short = bech32m.encode("prl", [2, ...bech32m.toWords(prog.slice(0, 20))]);
  it("accepts taproot (prl1p) and P2MR (prl1z) addresses, nothing else", () => {
    expect(v1.startsWith("prl1p")).toBe(true);
    expect(v2.startsWith("prl1z")).toBe(true);
    expect(c.isValidAddress(v1, c.MAINNET)).toBe(true);
    expect(c.isValidAddress(v2, c.MAINNET)).toBe(true);
    expect(c.isValidAddress(v3, c.MAINNET)).toBe(false);
    expect(c.isValidAddress(v2short, c.MAINNET)).toBe(false);
    expect(c.isValidAddress(v2.toUpperCase(), c.MAINNET)).toBe(true);
    expect(c.isValidAddress(v2.slice(0, -1) + "q", c.MAINNET)).toBe(false); // broken checksum
    expect(c.isValidAddress(v2.replace("prl1", "tprl1"), c.MAINNET)).toBe(false); // wrong network
  });
  it("encodes a P2MR output as OP_2 <32 bytes>, and a payment to it signs", () => {
    const script = c.addressScript(v2, c.MAINNET);
    expect(script.length).toBe(34);
    expect(script[0]).toBe(0x52);
    expect(script[1]).toBe(0x20);
    expect(c.addressScript(v1, c.MAINNET)[0]).toBe(0x51);
    const snap = snapOf([coin(1000_00000000n)]);
    const p = c.plan(snap, c.MAINNET, v2, 1_00000000n, 10);
    const { hex } = c.sign(p, snap, account, c.MAINNET);
    expect(hex).toContain(bytesToHex(script));
  });
});

describe("sending one particular coin (inscriptions, token transfers)", () => {
  const ins = (value: bigint): c.Utxo => ({ txid: "ab".repeat(32), vout: 0, value, address: a0.address, confirmations: 5, coinbase: false }) as c.Utxo;
  const withProtected = (extra: c.Utxo[], prot: c.Utxo) => {
    const s = snapOf([prot, ...extra]);
    s.protectedOutpoints = [`${prot.txid}:${prot.vout}`];
    return s;
  };

  it("puts the chosen coin first and the recipient first, and pays the fee from ordinary coins", () => {
    const coin = ins(50_000n);
    const snap = withProtected([coin_(10_00000000n, 2)], coin);
    const p = c.planCoin(snap, c.MAINNET, coin, dest, 10);
    expect(p.inputs[0]).toBe(coin);
    expect(p.inputs.length).toBe(2);
    expect(p.to).toBe(dest);
    expect(p.amount).toBe(50_000n);
    expect(p.serviceFee).toBe(0n);
    expect(p.inputs.reduce((s, u) => s + u.value, 0n)).toBe(p.amount + p.fee + p.change);
    const { hex } = c.sign(p, snap, account, c.MAINNET);
    const tx = Transaction.fromRaw(Buffer.from(hex, "hex"), { allowUnknownOutputs: true });
    expect(Buffer.from(tx.getInput(0).txid!).toString("hex")).toBe(coin.txid);
    expect(tx.getOutput(0).amount).toBe(50_000n);
    expect(Buffer.from(tx.getOutput(0).script!).toString("hex")).toBe(Buffer.from(c.addressScript(dest, c.MAINNET)).toString("hex"));
  });

  it("never spends a second protected coin alongside, which would lose what it carries", () => {
    const coin = ins(50_000n);
    const other = { ...ins(60_000n), txid: "cd".repeat(32) };
    const snap = snapOf([coin, other, coin_(10_00000000n, 3)]);
    snap.protectedOutpoints = [`${coin.txid}:0`, `${other.txid}:0`];
    const p = c.planCoin(snap, c.MAINNET, coin, dest, 10);
    expect(p.inputs.some((u) => u.txid === other.txid)).toBe(false);
  });

  it("sends a large coin as a small one and brings the rest back as change", () => {
    const big = ins(5_00000000n);
    const snap = withProtected([], big);
    const p = c.planCoin(snap, c.MAINNET, big, dest, 10);
    expect(p.inputs.length).toBe(1);
    expect(p.amount).toBe(50_000n);
    expect(p.change).toBe(5_00000000n - 50_000n - p.fee);
  });

  it("with no other coin, the coin pays its own fee; with too little, nothing is sent", () => {
    const coin = ins(50_000n);
    const p = c.planCoin(withProtected([], coin), c.MAINNET, coin, dest, 10);
    expect(p.inputs).toEqual([coin]);
    expect(p.amount + p.fee).toBe(50_000n);
    expect(p.change).toBe(0n);
    expect(() => c.planCoin(withProtected([], ins(1_000n)), c.MAINNET, ins(1_000n), dest, 10)).toThrow();
  });

  it("refuses to plan while the token index could not be checked", () => {
    const coin = ins(50_000n);
    const snap = withProtected([coin_(10_00000000n, 2)], coin);
    snap.protectionChecked = false;
    expect(() => c.planCoin(snap, c.MAINNET, coin, dest, 10)).toThrow(/token index is unreachable/);
  });

  it("writes a canonical PRL-20 transfer note", () => {
    expect(c.transferBody("PRLS", "100000")).toBe('{"p":"prl-20","op":"transfer","tick":"prls","amt":"100000"}');
    expect(() => c.transferBody("prls", "0")).toThrow();
    expect(() => c.transferBody("prls", "012")).toThrow();
    expect(() => c.transferBody("prls", "1.5")).toThrow();
    expect(() => c.transferBody("bad tick", "1")).toThrow();
  });
});

describe("Ethereum recipients", () => {
  const own = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
  it("explains every address that must not receive", () => {
    expect(c.ethRecipientProblem("prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp", own)).toMatch(/Pearl address/);
    expect(c.ethRecipientProblem("0x123", own)).toMatch(/not an Ethereum address/);
    expect(c.ethRecipientProblem("0x8efC8EBff262e006B71fE4993886B4139E04c861", own)).toMatch(/typo/);
    expect(c.ethRecipientProblem(own.toLowerCase(), own)).toMatch(/your own/);
    expect(c.ethRecipientProblem(c.WPRL_CONTRACT, own)).toMatch(/wPRL token contract/);
    expect(c.ethRecipientProblem("0x" + "0".repeat(40), own)).toMatch(/zero address/);
    expect(c.ethRecipientProblem("0x8Efc8EBff262e006B71fE4993886B4139E04c861", own)).toBeNull();
    expect(c.ethRecipientProblem("0x8efc8ebff262e006b71fe4993886b4139e04c861", own)).toBeNull();
    expect(c.ethRecipientProblem(c.BRIDGE_CONTROLLER, own)).toMatch(/PearlBridge/);
    expect(c.ethRecipientProblem("0x6B175474E89094C44Da98b954EedeAC495271d0F", own, [{ address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI" }])).toMatch(/DAI token contract/);
  });
});

describe("Ethereum sends", () => {
  const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", TO = "0x8Efc8EBff262e006B71fE4993886B4139E04c861";
  const rpc = (gas = 21_000n) => ({ prepare: async (_f: string, to: string, data: Uint8Array, value = 0n) => ({ nonce: 1n, gasLimit: gas, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1n, to, value, data }) }) as unknown as c.EthRpc;
  it("Max on ETH leaves exactly the fee", async () => {
    const p = await c.planEthSend(rpc(), ME, TO, "max", { eth: 10n ** 16n });
    expect(p.fee).toBe(21_000n * 10_000_000_000n);
    expect(p.amount).toBe(10n ** 16n - p.fee);
    expect(p.tx.value).toBe(p.amount);
    expect(p.tx.data.length).toBe(0);
  });
  it("refuses an ETH send that leaves nothing for the fee", async () => {
    await expect(c.planEthSend(rpc(), ME, TO, 10n ** 16n, { eth: 10n ** 16n })).rejects.toThrow("NO_ETH_FOR_FEE");
    await expect(c.planEthSend(rpc(), ME, TO, 2n * 10n ** 16n, { eth: 10n ** 16n })).rejects.toThrow(/do not hold that much/);
  });
  it("sends wPRL as a token transfer to the recipient, with no ETH value", async () => {
    const p = await c.planEthSend(rpc(60_000n), ME, TO, 25_00000000n, { eth: 10n ** 16n, token: 100_00000000n }, c.WPRL_CONTRACT);
    expect(p.tx.to).toBe(c.WPRL_CONTRACT);
    expect(p.tx.value).toBe(0n);
    expect(Buffer.from(p.tx.data).toString("hex")).toBe("a9059cbb" + TO.slice(2).toLowerCase().padStart(64, "0") + (25_00000000n).toString(16).padStart(64, "0"));
    await expect(c.planEthSend(rpc(60_000n), ME, TO, 25_00000000n, { eth: 0n, token: 100_00000000n }, c.WPRL_CONTRACT)).rejects.toThrow("NO_ETH_FOR_FEE");
    await expect(c.planEthSend(rpc(60_000n), ME, TO, 200_00000000n, { eth: 10n ** 16n, token: 100_00000000n }, c.WPRL_CONTRACT)).rejects.toThrow(/do not hold that much/);
  });
});
