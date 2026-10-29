import { afterEach, describe, expect, it } from "vitest";
import { EthRpc, PRIVATE_RPC, PRIVATE_STATUS, setPrivateEthSend, signEthTx, nonceOfRaw, keepPrivatePending } from "../src/core";

const HASH = "0x" + "ab".repeat(32);

/** A fake network: records which server got each call and answers from `on`. */
function net(on: (url: string, method: string) => unknown) {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = init?.body ? JSON.parse(String(init.body)).method : "GET";
    calls.push(`${url} ${method}`);
    const r = on(url, method);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r));
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

afterEach(() => setPrivateEthSend(true));

describe("private Ethereum sending (Flashbots Protect)", () => {
  it("sends a swap through Flashbots and nowhere else", async () => {
    const n = net(() => ({ jsonrpc: "2.0", id: 1, result: HASH }));
    expect(await new EthRpc(n.fetcher).send("0x02", HASH, true)).toBe(HASH);
    expect(n.calls).toEqual([`${PRIVATE_RPC} eth_sendRawTransaction`]);
  });

  it("sends plain transfers, permissions and bridge returns the usual way", async () => {
    const n = net(() => ({ jsonrpc: "2.0", id: 1, result: HASH }));
    expect(await new EthRpc(n.fetcher).send("0x02", HASH)).toBe(HASH);
    expect(n.calls).toEqual(["https://ethereum-rpc.publicnode.com eth_sendRawTransaction"]);
  });

  it("never sends a swap publicly when Flashbots does not answer", async () => {
    const n = net((url) => (url === PRIVATE_RPC ? new Error("offline") : url.startsWith(PRIVATE_STATUS) ? { status: "UNKNOWN" } : { jsonrpc: "2.0", id: 1, result: null }));
    await expect(new EthRpc(n.fetcher).send("0x02", HASH, true)).rejects.toThrow(/Nothing was swapped/);
    expect(n.calls.filter((c) => c.includes("eth_sendRawTransaction"))).toEqual([`${PRIVATE_RPC} eth_sendRawTransaction`]);
  });

  it("does not retry publicly when the swap itself is refused", async () => {
    const n = net(() => ({ jsonrpc: "2.0", id: 1, error: { message: "insufficient funds for gas * price + value" } }));
    await expect(new EthRpc(n.fetcher).send("0x02", HASH, true)).rejects.toThrow(/insufficient/);
    expect(n.calls.filter((c) => c.includes("eth_sendRawTransaction"))).toHaveLength(1);
  });

  it("goes public when the setting is off", async () => {
    setPrivateEthSend(false);
    const n = net(() => ({ jsonrpc: "2.0", id: 1, result: HASH }));
    await new EthRpc(n.fetcher).send("0x02", HASH, true);
    expect(n.calls[0]).toMatch(/publicnode/);
  });

  it("never uses Flashbots for other chains", async () => {
    const n = net(() => ({ jsonrpc: "2.0", id: 1, result: HASH }));
    await new EthRpc(n.fetcher, ["https://bsc-rpc.publicnode.com"]).send("0x02", HASH, true);
    expect(n.calls).toEqual(["https://bsc-rpc.publicnode.com eth_sendRawTransaction"]);
  });

  it("sees a transaction that is still private as sent, so the wallet warns before paying twice", async () => {
    const n = net((url) => (url.startsWith(PRIVATE_STATUS) ? { status: "PENDING" } : { jsonrpc: "2.0", id: 1, result: null }));
    expect(await new EthRpc(n.fetcher).knows(HASH)).toBe(true);
    const dropped = net((url) => (url.startsWith(PRIVATE_STATUS) ? { status: "FAILED" } : { jsonrpc: "2.0", id: 1, result: null }));
    expect(await new EthRpc(dropped.fetcher).knows(HASH)).toBe(false);
  });

  it("tips at least 0.01 gwei on Ethereum (Flashbots drops zero-tip transactions)", async () => {
    const n = net((_u, m) => ({
      jsonrpc: "2.0",
      id: 1,
      result: m === "eth_getTransactionCount" ? "0x1" : m === "eth_estimateGas" ? "0x5208" : m === "eth_maxPriorityFeePerGas" ? "0x0" : { baseFeePerGas: "0x3b9aca00" },
    }));
    const tx = await new EthRpc(n.fetcher).prepare("0x" + "11".repeat(20), "0x" + "22".repeat(20), new Uint8Array(0), 1n);
    expect(tx.maxPriorityFeePerGas).toBe(10_000_000n);
  });

  it("never signs a gas limit above the wallet's ceiling, even with the 20% margin", async () => {
    const n = net((_u, m) => ({
      jsonrpc: "2.0",
      id: 1,
      result: m === "eth_getTransactionCount" ? "0x1" : m === "eth_estimateGas" ? "0x" + (900_000).toString(16) : m === "eth_maxPriorityFeePerGas" ? "0x3b9aca00" : { baseFeePerGas: "0x3b9aca00" },
    }));
    const tx = await new EthRpc(n.fetcher).prepare("0x" + "11".repeat(20), "0x" + "22".repeat(20), new Uint8Array(0), 1n);
    expect(tx.gasLimit).toBe(900_000n);
  });

  it("reads the nonce back from a signed transaction", () => {
    const tx = { nonce: 7n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21000n, to: "0x" + "22".repeat(20), value: 1n, data: new Uint8Array(0) };
    expect(nonceOfRaw(signEthTx(tx, new Uint8Array(32).fill(7)).raw)).toBe(7n);
    expect(nonceOfRaw(signEthTx({ ...tx, nonce: 0n }, new Uint8Array(32).fill(7)).raw)).toBe(0n);
    expect(nonceOfRaw(signEthTx({ ...tx, nonce: 300n }, new Uint8Array(32).fill(7)).raw)).toBe(300n);
  });

  it("gives the next transaction the next number while a private swap is still waiting", async () => {
    const from = "0x" + "11".repeat(20);
    const tx = { nonce: 5n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21000n, to: "0x" + "22".repeat(20), value: 1n, data: new Uint8Array(0) };
    const signed = signEthTx(tx, new Uint8Array(32).fill(7));
    const n = net((url, m) => {
      if (url === PRIVATE_RPC) return { jsonrpc: "2.0", id: 1, result: signed.hash };
      // Public servers do not see the private swap: they still say 5.
      return { jsonrpc: "2.0", id: 1, result: m === "eth_getTransactionCount" ? "0x5" : m === "eth_estimateGas" ? "0x5208" : m === "eth_maxPriorityFeePerGas" ? "0x3b9aca00" : { baseFeePerGas: "0x3b9aca00" } };
    });
    const rpc = new EthRpc(n.fetcher);
    await rpc.send(signed.raw, signed.hash, true, from);
    expect((await rpc.prepare(from, "0x" + "33".repeat(20), new Uint8Array(0), 1n)).nonce).toBe(6n);
    expect((await rpc.prepare("0x" + "44".repeat(20), "0x" + "33".repeat(20), new Uint8Array(0), 1n)).nonce).toBe(5n);
  });

  it("remembers a waiting private swap after Keshi is closed and reopened", async () => {
    const from = "0x" + "55".repeat(20);
    const saved = JSON.stringify({ [from]: { hash: "0x" + "cd".repeat(32), nonce: "9", at: Date.now() } });
    let copy = "";
    keepPrivatePending(saved, (j) => (copy = j));
    expect(copy).toContain('"nonce":"9"');
    const n = net((url, m) => (url.startsWith(PRIVATE_STATUS) ? { status: "PENDING" } : { jsonrpc: "2.0", id: 1, result: m === "eth_getTransactionCount" ? "0x9" : m === "eth_estimateGas" ? "0x5208" : m === "eth_maxPriorityFeePerGas" ? "0x3b9aca00" : { baseFeePerGas: "0x3b9aca00" } }));
    expect((await new EthRpc(n.fetcher).prepare(from, "0x" + "33".repeat(20), new Uint8Array(0), 1n)).nonce).toBe(10n);
  });

  it("frees the number of a private swap Flashbots gave up on, so the next transaction does not wait behind a gap", async () => {
    const from = "0x" + "66".repeat(20);
    keepPrivatePending(JSON.stringify({ [from]: { hash: "0x" + "ef".repeat(32), nonce: "4", at: Date.now() } }), () => {});
    const n = net((url, m) => (url.startsWith(PRIVATE_STATUS) ? { status: "FAILED" } : { jsonrpc: "2.0", id: 1, result: m === "eth_getTransactionCount" ? "0x4" : m === "eth_estimateGas" ? "0x5208" : m === "eth_maxPriorityFeePerGas" ? "0x3b9aca00" : { baseFeePerGas: "0x3b9aca00" } }));
    expect((await new EthRpc(n.fetcher).prepare(from, "0x" + "33".repeat(20), new Uint8Array(0), 1n)).nonce).toBe(4n);
  });
});
