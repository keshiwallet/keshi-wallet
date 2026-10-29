import { describe, expect, it } from "vitest";
import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import * as c from "../src/core";

const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const account = c.accountFromPhrase(PHRASE, c.MAINNET, 0, "standard");
const a0 = account.derive(false, 0), chg = account.derive(true, 0);
const dest = account.derive(false, 5).address;
const FEE_TO = c.accountFromPhrase(PHRASE, c.MAINNET, 7, "standard").derive(false, 0).address;
const snap: c.Snapshot = {
  updated: 0, height: 1000, balance: 0n, pending: 0n, immature: 0n,
  addresses: [{ address: a0.address, change: false, index: 0, used: true }, { address: chg.address, change: true, index: 0, used: false }],
  receive: account.derive(false, 1), changeAddr: chg,
  utxos: [{ txid: "11".repeat(32), vout: 0, value: 100_00000000n, address: a0.address, confirmations: 10, coinbase: false }],
  activity: [],
};


describe("speed up a waiting payment", () => {
  const svc = { address: FEE_TO, bps: 10, cap: 3_00000000n, label: "0.1%" };
  const p = c.plan(snap, c.MAINNET, dest, 10_00000000n, 2, svc);
  const signed = c.sign(p, snap, account, c.MAINNET);
  const tx = Transaction.fromRaw(hexToBytes(signed.hex));
  const addrs = [dest, FEE_TO, chg.address];
  const indexed = (sequence = tx.getInput(0).sequence!) => ({
    txid: signed.txid, confirmations: 0, vsize: p.vsize,
    vin: [{ txid: "11".repeat(32), vout: 0, sequence, addresses: [a0.address], value: String(100_00000000n) }],
    vout: Array.from({ length: tx.outputsLength }, (_, n) => ({ n, value: String(tx.getOutput(n).amount), addresses: [addrs[n]!] })),
  });

  const ok = { inputs: p.inputs.map((u) => `${u.txid}:${u.vout}=${u.value}`), change: p.change.toString(), changeAddress: p.changeAddress };

  it("new payments allow replace-by-fee", () => {
    expect(tx.getInput(0).sequence).toBe(c.RBF_SEQUENCE);
  });

  it("pays a higher fee from the change; the recipient and the commission get exactly the same", () => {
    const fast = c.speedUpPlan(indexed(), snap, 20, ok);
    expect(fast.amount).toBe(p.amount);
    expect(fast.to).toBe(dest);
    expect(fast.serviceFee).toBe(p.serviceFee);
    expect(fast.serviceAddress).toBe(FEE_TO);
    expect(fast.fee).toBe(BigInt(p.vsize) * 20n);
    expect(fast.change).toBe(p.change - (fast.fee - p.fee));
    const again = Transaction.fromRaw(hexToBytes(c.sign(fast, snap, account, c.MAINNET).hex));
    expect(again.getInput(0).txid).toEqual(tx.getInput(0).txid); // spends the same coin: it replaces the first payment
    expect(again.getOutput(0).amount).toBe(tx.getOutput(0).amount);
  });

  it("always pays at least the old fee plus the relay fee, even if asked for less", () => {
    const fast = c.speedUpPlan(indexed(), snap, 1, ok);
    expect(fast.fee).toBe(p.fee + BigInt(p.vsize));
  });

  it("refuses payments sent without replace-by-fee, confirmed ones, and foreign ones", () => {
    expect(() => c.speedUpPlan(indexed(0xffffffff), snap, 20, ok)).toThrow(/without the speed-up option/);
    expect(() => c.speedUpPlan({ ...indexed(), confirmations: 1 }, snap, 20, ok)).toThrow(/already confirmed/);
    const foreign = indexed();
    foreign.vin[0]!.addresses = [dest];
    expect(() => c.speedUpPlan(foreign, snap, 20, ok)).toThrow(/not made by this wallet/);
  });

  it("measures the payment's size itself: a server announcing a huge size cannot inflate the fee", () => {
    const honest = c.speedUpPlan(indexed(), snap, 20, ok);
    const lied = c.speedUpPlan({ ...indexed(), vsize: 1_000_000 }, snap, 20, ok);
    expect(lied.fee).toBe(honest.fee);
    expect(lied.change).toBe(honest.change);
    expect(lied.vsize).toBe(p.vsize);
  });

  it("refuses when a later payment already spends it", () => {
    const t = indexed();
    (t.vout[2] as { spent?: boolean }).spent = true;
    expect(() => c.speedUpPlan(t, snap, 20, ok)).toThrow(/later payment/);
  });

  it("refuses when the change cannot pay for it", () => {
    const tight = c.plan(snap, c.MAINNET, dest, 99_99000000n, 2); // about 0.01 PRL of change
    const t = Transaction.fromRaw(hexToBytes(c.sign(tight, snap, account, c.MAINNET).hex));
    const info = {
      txid: "aa".repeat(32), confirmations: 0, vsize: tight.vsize,
      vin: [{ txid: "11".repeat(32), vout: 0, sequence: c.RBF_SEQUENCE, addresses: [a0.address], value: String(100_00000000n) }],
      vout: Array.from({ length: t.outputsLength }, (_, n) => ({ n, value: String(t.getOutput(n).amount), addresses: [[dest, chg.address][n]!] })),
    };
    expect(tight.change).toBeGreaterThan(0n);
    expect(() => c.speedUpPlan(info, snap, 9_000, { inputs: tight.inputs.map((u) => `${u.txid}:${u.vout}=${u.value}`), change: tight.change.toString(), changeAddress: tight.changeAddress })).toThrow(/too small/);
  });
  it("rebuilds only from the coins this device approved: an indexer naming another coin of the wallet cannot make a second payment", () => {
    const approved = { inputs: p.inputs.map((u) => `${u.txid}:${u.vout}=${u.value}`), change: p.change.toString(), changeAddress: p.changeAddress };
    expect(c.speedUpPlan(indexed(), snap, 20, approved).to).toBe(dest);
    // Same outputs, but the input swapped for another real coin of the wallet: the "replacement" would not conflict, and the recipient would be paid twice.
    const swapped = { ...indexed(), vin: [{ ...indexed().vin[0]!, txid: "22".repeat(32) }] };
    expect(() => c.speedUpPlan(swapped, snap, 20, approved)).toThrow(/other coins/);
    // Change under-reported: the fee would be inflated.
    const under = indexed();
    under.vout = under.vout.map((o) => (o.addresses[0] === chg.address ? { ...o, value: String(BigInt(o.value) - 1_00000000n) } : o));
    expect(() => c.speedUpPlan(under, snap, 20, approved)).toThrow(/does not match/);
  });
  it("refuses a payment without the record of what was approved (sent by an older Keshi): the server's copy alone is never enough", () => {
    expect(() => c.speedUpPlan(indexed(), snap, 20, undefined)).toThrow(/older version/);
    expect(() => c.speedUpPlan(indexed(), snap, 20, { inputs: [], change: "1", changeAddress: chg.address })).toThrow(/older version/);
  });
});

describe("full history", () => {
  it("reads every page of a busy address, not just the first", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      const page = Number(new URL(String(url)).searchParams.get("page") ?? "1");
      const txs = Array.from({ length: page < 3 ? 1000 : 10 }, (_, i) => ({ txid: `${page}-${i}`, confirmations: 1, vin: [], vout: [] }));
      return new Response(JSON.stringify({ balance: "0", unconfirmedBalance: "0", txs: 2010, totalPages: 3, transactions: txs }));
    }) as unknown as typeof fetch;
    const info = await new c.Indexer(c.MAINNET, f).address("prl1pexample");
    expect(info.txs).toHaveLength(2010);
    expect(seen).toHaveLength(3);
  });

});
