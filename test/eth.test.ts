import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { Transaction as RefTx } from "micro-eth-signer";
import * as c from "../src/core";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("ethereum account", () => {
  it("derives the same address as every Ethereum wallet for the reference phrase", () => {
    expect(c.ethAccountFromPhrase(ABANDON).address).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
  });
  it("writes checksummed addresses", () => {
    expect(c.checksumAddress("0x07696dcab55e62cfef953666b29fe1970518cb00")).toBe("0x07696DcaB55E62cfef953666b29Fe1970518cB00");
    expect(c.isEthAddress(c.ethAccountFromPhrase(ABANDON).address)).toBe(true);
  });
});

describe("rlp", () => {
  const t = (s: string) => new TextEncoder().encode(s);
  it("matches the reference examples", () => {
    expect(bytesToHex(c.rlp(t("dog")))).toBe("83646f67");
    expect(bytesToHex(c.rlp([t("cat"), t("dog")]))).toBe("c88363617483646f67");
    expect(bytesToHex(c.rlp(new Uint8Array(0)))).toBe("80");
    expect(bytesToHex(c.rlp([]))).toBe("c0");
    expect(bytesToHex(c.rlp(hexToBytes("0400")))).toBe("820400");
    expect(bytesToHex(c.rlp(t("Lorem ipsum dolor sit amet, consectetur adipisicing elit"))).startsWith("b838")).toBe(true);
  });
});

describe("contract calls", () => {
  it("encodes approve and requestBurn exactly as the standard encoding", () => {
    expect(bytesToHex(c.callData.approve(c.BRIDGE_CONTROLLER, 10_000_000_000n))).toBe(
      "095ea7b3" + "000000000000000000000000a6571b73489d4ebfa269a107208665df7c80aef5" + "00000000000000000000000000000000000000000000000000000002540be400",
    );
    const addr = "prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp";
    const data = bytesToHex(c.callData.requestBurn(10_000_000_000n, addr));
    const sel = bytesToHex(keccak_256(new TextEncoder().encode("requestBurn(uint256,string)")).slice(0, 4));
    expect(data.slice(0, 8)).toBe(sel);
    expect(data.slice(8, 72)).toBe("00000000000000000000000000000000000000000000000000000002540be400");
    expect(BigInt("0x" + data.slice(72, 136))).toBe(64n);
    expect(BigInt("0x" + data.slice(136, 200))).toBe(BigInt(addr.length));
    expect(new TextDecoder().decode(hexToBytes(data.slice(200, 200 + addr.length * 2)))).toBe(addr);
    expect((data.length - 8) % 64).toBe(0);
    expect(bytesToHex(c.callData.balanceOf("0x9858EfFD232B4033E47d90003D41EC34EcaEda94"))).toBe("70a08231" + "0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94");
  });
});

describe("signing", () => {
  const acct = c.ethAccountFromPhrase(ABANDON);
  const tx: c.EthTx = { nonce: 7n, maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 42_000_000_000n, gasLimit: 85_000n, to: c.WPRL_CONTRACT, value: 0n, data: c.callData.approve(c.BRIDGE_CONTROLLER, 10_000_000_000n) };

  it("produces a transaction an independent library reads back identically, signed by our address", () => {
    const { raw, hash } = c.signEthTx(tx, acct.privateKey);
    const ref = RefTx.fromHex(raw);
    expect(ref.sender).toBe(acct.address);
    expect(ref.type).toBe("eip1559");
    expect(ref.raw.chainId).toBe(1n);
    expect(ref.raw.nonce).toBe(7n);
    expect(ref.raw.to.toLowerCase()).toBe(c.WPRL_CONTRACT.toLowerCase());
    expect(ref.raw.gasLimit).toBe(85_000n);
    expect((ref.raw as any).maxFeePerGas).toBe(42_000_000_000n);
    expect(ref.raw.value).toBe(0n);
    expect(ref.raw.data.replace(/^0x/, "")).toBe(bytesToHex(tx.data));
    expect("0x" + ref.hash.replace(/^0x/, "")).toBe(hash);
  });

  it("matches the independent library byte for byte when it signs the same transaction", () => {
    const mine = c.signEthTx(tx, acct.privateKey).raw;
    const ref = RefTx.prepare({ type: "eip1559", chainId: 1n, nonce: 7n, maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 42_000_000_000n, gasLimit: 85_000n, to: c.WPRL_CONTRACT, value: 0n, data: "0x" + bytesToHex(tx.data), accessList: [] } as any, false).signBy(acct.privateKey, false);
    expect(mine).toBe(ref.toHex());
  });

  it("recovers to our own public key", () => {
    const { raw } = c.signEthTx(tx, acct.privateKey);
    void secp256k1; void concatBytes;
    expect(RefTx.fromHex(raw).verifySignature()).toBe(true);
  });
});

describe("return-trip quote", () => {
  const ok = { amountGrains: "100", feeGrains: "1", netGrains: "99", paused: false, withinDailyCap: true, addressCheck: { valid: true }, transaction: { chainId: 1, steps: [{ to: c.WPRL_CONTRACT, args: [c.BRIDGE_CONTROLLER, "100"] }, { to: c.BRIDGE_CONTROLLER }] } };
  const api = (body: any) => (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
  it("accepts the expected contracts and refuses any other", async () => {
    expect((await new c.Bridge(api(ok)).quoteBack(100n, "prl1x")).net).toBe(99n);
    const evil = JSON.parse(JSON.stringify(ok));
    evil.transaction.steps[1].to = "0x" + "66".repeat(20);
    await expect(new c.Bridge(api(evil)).quoteBack(100n, "prl1x")).rejects.toThrow(/unexpected/);
    const evil2 = JSON.parse(JSON.stringify(ok));
    evil2.transaction.steps[0].args[0] = "0x" + "66".repeat(20);
    await expect(new c.Bridge(api(evil2)).quoteBack(100n, "prl1x")).rejects.toThrow(/unexpected/);
  });
});

describe("uniswap calls", () => {
  it("uses the published function selectors", () => {
    const me = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    expect(bytesToHex(c.uniData.swapIn(c.WPRL_CONTRACT, c.USDT, 3000, me, 1n, 1n)).slice(0, 8)).toBe("04e45aaf");
    expect(bytesToHex(c.uniData.swapOut(c.USDT, c.WPRL_CONTRACT, 3000, me, 1n, 1n)).slice(0, 8)).toBe("5023b4df");
    expect(bytesToHex(c.uniData.quoteIn(c.WPRL_CONTRACT, c.USDT, 1n, 3000)).slice(0, 8)).toBe("c6a5026a");
    expect(bytesToHex(c.uniData.quoteOut(c.USDT, c.WPRL_CONTRACT, 1n, 3000)).slice(0, 8)).toBe("bd21704a");
  });
  it("lays out a sell so the minimum received protects against a bad price", () => {
    const me = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    const d = bytesToHex(c.uniData.swapIn(c.WPRL_CONTRACT, c.USDT, 3000, me, 100_00000000n, 120_000000n)).slice(8);
    const w = (i: number) => d.slice(i * 64, (i + 1) * 64);
    expect(w(0).endsWith(c.WPRL_CONTRACT.slice(2).toLowerCase())).toBe(true);
    expect(w(1).endsWith(c.USDT.slice(2).toLowerCase())).toBe(true);
    expect(BigInt("0x" + w(2))).toBe(3000n);
    expect(w(3).endsWith(me.slice(2).toLowerCase())).toBe(true);
    expect(BigInt("0x" + w(4))).toBe(100_00000000n);
    expect(BigInt("0x" + w(5))).toBe(120_000000n);
    expect(BigInt("0x" + w(6))).toBe(0n);
    expect(d.length).toBe(7 * 64);
  });
  it("picks the best pool and computes a price", async () => {
    const rpc = { raw: async (_to: string, data: Uint8Array) => {
      const fee = Number(BigInt("0x" + bytesToHex(data).slice(8 + 64 * 3, 8 + 64 * 4)));
      if (fee === 500) throw new Error("no pool");
      return "0x" + (fee === 3000 ? 121_500000n : 119_000000n).toString(16).padStart(64, "0") + "00".repeat(96);
    } } as unknown as c.EthRpc;
    const q = await c.uniQuote(rpc, "sell", 100_00000000n);
    expect(q.fee).toBe(3000);
    expect(c.uniPrice(q)).toBeCloseTo(1.215, 6);
    const b = await c.uniQuote(rpc, "buy", 100_00000000n);
    expect(b.usdt).toBe(119_000000n);
  });
});

describe("bigone pass", () => {
  it("is a correctly signed HS256 token carrying the key", () => {
    const tok = c.bigoneToken("my-key", "my-secret", 1_700_000_000_000);
    const [h, p, s] = tok.split(".");
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, "+").replace(/_/g, "/")));
    expect(dec(h!)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(dec(p!)).toEqual({ type: "OpenAPIV2", sub: "my-key", nonce: "1700000000000000000" });
    expect(s!.length).toBe(43);
    expect(tok).not.toContain("my-secret");
  });
});

describe("bigone account", () => {
  const reply = (data: unknown) => (async () => new Response(JSON.stringify({ code: 0, data }))) as unknown as typeof fetch;
  it("counts only what open orders do not hold", async () => {
    const b = await new c.BigOne(reply([{ asset_symbol: "PRL", balance: "120.5", locked_balance: "20.5" }, { asset_symbol: "USDT", balance: "50", locked_balance: "0" }]), { key: "k", secret: "s" }).balances();
    expect(b).toEqual({ prl: 100, usdt: 50, usdc: 0 });
  });
  it("picks the Pearl deposit address among the chains listed", async () => {
    const prl = "prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp";
    const a = await new c.BigOne(reply([{ chain: "Ethereum", value: "0x8Efc8EBff262e006B71fE4993886B4139E04c861", memo: "" }, { chain: "Pearl", value: prl, memo: "" }]), { key: "k", secret: "s" }).depositAddress();
    expect(a).toBe(prl);
    expect(await new c.BigOne(reply([]), { key: "k", secret: "s" }).depositAddress()).toBe("");
  });
  it("sends orders that fill at once or are cancelled", async () => {
    let sent: any;
    const f = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ code: 0, data: { id: 7, state: "FILLED" } }));
    }) as unknown as typeof fetch;
    await new c.BigOne(f, { key: "k", secret: "s" }).order("buy", "10", "1.2500");
    expect(sent).toEqual({ asset_pair_name: "PRL-USDT", side: "BID", price: "1.2500", amount: "10", type: "LIMIT", immediate_or_cancel: true });
  });
});

describe("bridge limits", () => {
  const f = (v: bigint) => (Number(v) / 1e8).toFixed(2);
  it("refuses amounts the bridge contract would not process", () => {
    const bounds = { min: 10_00000000n, max: 1000_00000000n };
    expect(() => c.checkBridgeBounds(5_00000000n, 4_97500000n, bounds, f)).toThrow(/10.00 PRL or more/);
    expect(() => c.checkBridgeBounds(2000_00000000n, 1990_00000000n, bounds, f)).toThrow(/at most 1000.00 PRL/);
    expect(() => c.checkBridgeBounds(100_00000000n, 99_50000000n, bounds, f)).not.toThrow();
    expect(() => c.checkBridgeBounds(10n ** 14n, 10n ** 14n, { min: 0n, max: 0n }, f)).not.toThrow();
  });
});

describe("Ethereum resend safety", () => {
  it("a send answered with an error counts as sent when the network already has that transaction", async () => {
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body));
      calls.push(q.method);
      if (q.method === "eth_sendRawTransaction") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nonce too low" } }));
      if (q.method === "eth_getTransactionByHash") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hash: "0xabc" } }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    }) as unknown as typeof fetch;
    const rpc = new c.EthRpc(f, ["https://a.example"]);
    expect(await rpc.send("0x02", "0xabc")).toBe("0xabc");
    expect(calls).toContain("eth_getTransactionByHash");
    const g = (async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body));
      if (q.method === "eth_sendRawTransaction") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nonce too low" } }));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
    }) as unknown as typeof fetch;
    await expect(new c.EthRpc(g, ["https://a.example"]).send("0x02", "0xabc")).rejects.toThrow(/nonce too low/);
  });
});
