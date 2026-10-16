import { describe, it, expect } from "vitest";
import { Transaction } from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as c from "../src/core";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BTC: c.Network = { ...c.MAINNET, hrp: "bc", coinType: 0 };

describe("keys", () => {
  it("matches the official BIP-86 test vectors", () => {
    const a = c.accountFromPhrase(ABANDON, BTC);
    expect(a.derive(false, 0).address).toBe("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
    expect(a.derive(false, 1).address).toBe("bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh");
    expect(a.derive(true, 0).address).toBe("bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7");
  });
  it("produces prl1p addresses on Pearl and validates them", () => {
    const a = c.accountFromPhrase(ABANDON, c.MAINNET);
    const addr = a.derive(false, 0).address;
    expect(addr.startsWith("prl1p")).toBe(true);
    expect(c.isValidAddress(addr, c.MAINNET)).toBe(true);
    expect(c.isValidAddress(addr, c.TESTNET)).toBe(false);
    expect(c.isValidAddress(addr.slice(0, -1) + (addr.endsWith("q") ? "p" : "q"), c.MAINNET)).toBe(false);
    expect(c.isValidAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr", c.MAINNET)).toBe(false);
  });
  it("creates valid 24-word phrases", () => {
    const p = c.newPhrase();
    expect(p.split(" ").length).toBe(24);
    expect(c.isValidPhrase(p)).toBe(true);
    expect(c.isValidPhrase("abandon abandon")).toBe(false);
  });
});

describe("amounts", () => {
  it("parses and formats", () => {
    expect(c.parsePrl("1.5")).toBe(150_000_000n);
    expect(c.parsePrl("0,00000001")).toBe(1n);
    expect(c.parsePrl("1.123456789")).toBe(null);
    expect(c.parsePrl("abc")).toBe(null);
    expect(c.formatPrl(123_456_789_012n)).toBe("1,234.56789012");
    expect(c.formatPrl(100_000_000n)).toBe("1.00");
  });
});

describe("vault", () => {
  it("round-trips and rejects a wrong password", async () => {
    const v = await c.lockVault({ phrase: ABANDON }, "hunter22", 1024);
    expect(JSON.stringify(v)).not.toContain("abandon");
    expect((await c.openVault(v, "hunter22")).phrase).toBe(ABANDON);
    await expect(c.openVault(v, "nope")).rejects.toThrow("Wrong password");
  });
});

function fakeSnap(values: bigint[], opts: { coinbaseYoung?: number[] } = {}): { snap: c.Snapshot; account: c.Account } {
  const account = c.accountFromPhrase(ABANDON, c.MAINNET);
  const d0 = account.derive(false, 0);
  const d1 = account.derive(false, 1);
  const utxos: c.Utxo[] = values.map((value, i) => ({
    txid: (i + 1).toString(16).padStart(64, "0"),
    vout: 0,
    value,
    address: i % 2 ? d1.address : d0.address,
    confirmations: opts.coinbaseYoung?.includes(i) ? 5 : 500,
    coinbase: !!opts.coinbaseYoung?.includes(i),
  }));
  const snap: c.Snapshot = {
    updated: 0, height: 1000, balance: values.reduce((s, v) => s + v, 0n), pending: 0n, immature: 0n,
    addresses: [
      { address: d0.address, change: false, index: 0, used: true },
      { address: d1.address, change: false, index: 1, used: true },
    ],
    receive: account.derive(false, 2), changeAddr: account.derive(true, 0), utxos, activity: [],
  };
  return { snap, account };
}

describe("payments", () => {
  const dest = c.accountFromPhrase(c.newPhrase(), c.MAINNET).derive(false, 0).address;

  it("builds a payment whose numbers add up and whose signatures verify", () => {
    const { snap, account } = fakeSnap([300_000_000n, 200_000_000n, 50_000_000n]);
    const p = c.plan(snap, c.MAINNET, dest, 400_000_000n, 800);
    const inTotal = p.inputs.reduce((s, u) => s + u.value, 0n);
    expect(inTotal).toBe(p.amount + p.fee + p.change);
    expect(p.inputs.length).toBe(2);
    const { hex, txid } = c.sign(p, snap, account, c.MAINNET);
    const tx = Transaction.fromRaw(hexToBytes(hex), { allowUnknownOutputs: true });
    expect(tx.id).toBe(txid);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(400_000_000n);
    expect(tx.getOutput(1).amount).toBe(p.change);
    // Real size must not exceed the estimate, so the fee rate is honoured.
    expect(tx.vsize).toBeLessThanOrEqual(p.vsize);
    expect(Number(p.fee) / tx.vsize).toBeGreaterThanOrEqual(800);
    // Each input carries one 64-byte Schnorr signature.
    for (let i = 0; i < tx.inputsLength; i++) expect(tx.getInput(i).finalScriptWitness![0]!.length).toBe(64);
  });

  it("send max empties the wallet with no change", () => {
    const { snap, account } = fakeSnap([300_000_000n, 200_000_000n]);
    const p = c.plan(snap, c.MAINNET, dest, "max", 10);
    expect(p.change).toBe(0n);
    expect(p.amount + p.fee).toBe(500_000_000n);
    expect(() => c.sign(p, snap, account, c.MAINNET)).not.toThrow();
  });

  it("never spends immature mining rewards", () => {
    const { snap } = fakeSnap([300_000_000n, 200_000_000n], { coinbaseYoung: [0] });
    expect(c.spendableTotal(snap)).toBe(200_000_000n);
    expect(() => c.plan(snap, c.MAINNET, dest, 250_000_000n, 10)).toThrow(/Not enough/);
  });

  it("refuses bad input in plain language", () => {
    const { snap } = fakeSnap([100_000_000n]);
    expect(() => c.plan(snap, c.MAINNET, "prl1notanaddress", 1000n, 10)).toThrow(/valid/);
    expect(() => c.plan(snap, c.MAINNET, dest, 100n, 10)).toThrow(/too small/);
    expect(() => c.plan(snap, c.MAINNET, dest, 100_000_000n, 10)).toThrow(/Not enough/);
  });

  it("never creates a dust change output", () => {
    const { snap } = fakeSnap([100_000_000n]);
    const p = c.plan(snap, c.MAINNET, dest, 100_000_000n - 1200n, 10);
    expect(p.change).toBe(0n);
    expect(p.amount + p.fee).toBe(100_000_000n);
  });
});

describe("history and mining", () => {
  it("classifies transactions", () => {
    const mine = new Set(["A", "B"]);
    const base = { txid: "t", confirmations: 3, blockTime: 1000 };
    expect(c.describe({ ...base, vin: [{ addresses: ["X"], value: "500" }], vout: [{ n: 0, addresses: ["A"], value: "400" }] }, mine)).toMatchObject({ kind: "received", net: 400n, counterparty: "X" });
    expect(c.describe({ ...base, fees: "10", vin: [{ addresses: ["A"], value: "500" }], vout: [{ n: 0, addresses: ["X"], value: "300" }, { n: 1, addresses: ["B"], value: "190" }] }, mine)).toMatchObject({ kind: "sent", net: -310n, counterparty: "X" });
    expect(c.describe({ ...base, vin: [{ coinbase: "00", isAddress: false }], vout: [{ n: 0, addresses: ["A"], value: "900" }] }, mine)).toMatchObject({ kind: "mined", net: 900n });
    expect(c.describe({ ...base, fees: "10", vin: [{ addresses: ["A"], value: "500" }], vout: [{ n: 0, addresses: ["B"], value: "490" }] }, mine)).toMatchObject({ kind: "moved", net: -10n });
  });
  it("totals payouts per day", () => {
    const now = new Date(2026, 9, 1, 15).getTime();
    const at = (d: number, h: number) => Math.floor(new Date(2026, 9, d, h).getTime() / 1000);
    const act = (time: number, net: bigint, kind: c.Activity["kind"] = "received"): c.Activity => ({ txid: "x" + time, time, confirmations: 1, net, fee: 0n, kind });
    const s = c.miningStats([act(at(1, 9), 100n), act(at(1, 1), 50n), act(at(-1 + 1, 23), 30n), act(at(-10, 5), 999n), act(at(1, 2), -40n, "sent")], now);
    expect(s.today).toBe(150n);
    expect(s.days[5]!.total).toBe(30n);
    expect(s.last).toBe(180n);
    expect(s.payouts.length).toBe(4);
    expect(c.payoutsCsv(s.payouts).split("\n").length).toBe(5);
  });
});

describe("message signing (BIP-322)", () => {
  it("matches the BIP-322 reference to_spend txids", () => {
    const script = hexToBytes("00142b05d564e6a7a33c087f16e0f730d1440123799d");
    expect(bytesToHex(c.toSpendTxid("", script))).toBe("c5680aa69bb8d860bf82d4e9cd3504b55dde018de765a91bb566283c545a99a7");
    expect(bytesToHex(c.toSpendTxid("Hello World", script))).toBe("b79d196740ad5217771c1098fc4a4b51e0535c32236c71f1ea4d61a2d603352b");
  });
  it("produces a 64-byte Schnorr signature in a one-item witness", () => {
    const a = c.accountFromPhrase(ABANDON, c.MAINNET);
    const d = a.derive(false, 0);
    const sig = c.signMessage("Sign in to example", d.address, a.privateKey(false, 0), d.pubkey, c.MAINNET);
    const raw = Uint8Array.from(atob(sig), (ch) => ch.charCodeAt(0));
    expect(raw[0]).toBe(1);
    expect(raw[1]).toBe(64);
    expect(raw.length).toBe(66);
    void schnorr;
  });
});

describe("wallet commission", () => {
  const dest = c.accountFromPhrase(c.newPhrase(), c.MAINNET).derive(false, 0).address;
  const feeAddr = c.accountFromPhrase(c.newPhrase(), c.MAINNET).derive(false, 0).address;
  const cfg = { feeAddress: feeAddr, sendPercent: 0.2, sendCapPrl: 5, combinePercent: 0.1, combineCapPrl: 2 };
  const svc = c.serviceFor(c.MAINNET, "send", cfg)!;

  it("is off on testnet, without an address, or with an absurd rate", () => {
    expect(c.serviceFor(c.TESTNET, "send", cfg)).toBeUndefined();
    expect(c.serviceFor(c.MAINNET, "send", { ...cfg, feeAddress: "" })).toBeUndefined();
    expect(c.serviceFor(c.MAINNET, "send", { ...cfg, feeAddress: "prl1pnope" })).toBeUndefined();
    expect(c.serviceFor(c.MAINNET, "send", { ...cfg, sendPercent: 20 })).toBeUndefined();
    expect(c.serviceFor(c.MAINNET, "combine", cfg)!.bps).toBe(10);
  });

  it("adds 0.2% as a third output and every grain is accounted for", () => {
    const { snap, account } = fakeSnap([300_000_000_00n, 200_000_000_00n]);
    const p = c.plan(snap, c.MAINNET, dest, 100_00000000n, 800, svc);
    expect(p.serviceFee).toBe(20_000_000n); // 0.2 PRL
    const inTotal = p.inputs.reduce((s, u) => s + u.value, 0n);
    expect(inTotal).toBe(p.amount + p.fee + p.serviceFee + p.change);
    const tx = Transaction.fromRaw(hexToBytes(c.sign(p, snap, account, c.MAINNET).hex), { allowUnknownOutputs: true });
    expect(tx.outputsLength).toBe(3);
    expect(tx.getOutput(0).amount).toBe(100_00000000n);
    expect(tx.getOutput(1).amount).toBe(20_000_000n);
    expect(bytesToHex(tx.getOutput(1).script!)).toBe(bytesToHex(c.addressScript(feeAddr, c.MAINNET)));
    expect(tx.vsize).toBeLessThanOrEqual(p.vsize);
  });

  it("is capped", () => {
    const { snap } = fakeSnap([900_000_00000000n]);
    expect(c.plan(snap, c.MAINNET, dest, 100_000_00000000n, 10, svc).serviceFee).toBe(5_00000000n);
  });

  it("is skipped when it would be dust, and when paying the fee address itself", () => {
    const { snap } = fakeSnap([300_000_000n]);
    expect(c.plan(snap, c.MAINNET, dest, 100_000n, 10, svc).serviceFee).toBe(0n);
    expect(c.plan(snap, c.MAINNET, feeAddr, 100_000_000n, 10, svc).serviceFee).toBe(0n);
  });

  it("send max: recipient + commission + network fee equals the whole balance", () => {
    const { snap, account } = fakeSnap([300_000_000n, 200_000_000n]);
    const p = c.plan(snap, c.MAINNET, dest, "max", 10, svc);
    expect(p.serviceFee).toBeGreaterThan(0n);
    expect(p.amount + p.serviceFee + p.fee).toBe(500_000_000n);
    expect(p.change).toBe(0n);
    expect(() => c.sign(p, snap, account, c.MAINNET)).not.toThrow();
  });

  it("refuses when the balance cannot cover amount plus commission", () => {
    const { snap } = fakeSnap([100_10000000n]);
    expect(() => c.plan(snap, c.MAINNET, dest, 100_00000000n, 10, svc)).toThrow(/fees/);
  });
});

describe("small coins that may carry tokens", () => {
  it("are never spent, even by send max", () => {
    const dest = c.accountFromPhrase(c.newPhrase(), c.MAINNET).derive(false, 0).address;
    const { snap } = fakeSnap([300_000_000n, 546n, 10_000n]);
    expect(c.spendable(snap).length).toBe(1);
    const p = c.plan(snap, c.MAINNET, dest, "max", 10);
    expect(p.inputs.length).toBe(1);
    expect(p.amount + p.fee).toBe(300_000_000n);
  });
});

describe("token index", () => {
  it("computes the floor price per token from active listings", async () => {
    const fake = (async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("/listings")
          ? { listings: [
              { assetType: "prl-20", status: "active", valid: true, unitPriceGrain: "3800", asset: { ticker: "prls" } },
              { assetType: "prl-20", status: "active", valid: true, unitPriceGrain: "2300", asset: { ticker: "prls" } },
              { assetType: "prl-20", status: "sold", valid: true, unitPriceGrain: "100", asset: { ticker: "prls" } },
              { assetType: "collectible", status: "active", valid: true, unitPriceGrain: "1", asset: { ticker: "prls" } },
            ] }
          : { tokens: [
              { ticker: "doge", displayTicker: "DOGE", maxSupply: "21000000", mintedSupply: "600000", holderCount: 1, mintProgress: 2.85 },
              { ticker: "prls", displayTicker: "PRLS", maxSupply: "2100000000", mintedSupply: "2100000000", holderCount: 346, mintProgress: 100 },
            ] },
    })) as unknown as typeof fetch;
    const list = await new c.TokenIndex(fake).tokens();
    expect(list[0]!.name).toBe("PRLS");
    expect(list[0]!.floorGrains).toBe(2300);
    expect(list[0]!.listings).toBe(2);
    expect(c.tokenCapPrl(list[0]!)).toBeCloseTo(48300, 5);
    expect(list[1]!.floorGrains).toBeUndefined();
  });
});

describe("12 or 24 words", () => {
  it("creates valid phrases of both lengths", () => {
    expect(c.newPhrase(12).split(" ").length).toBe(12);
    expect(c.newPhrase(24).split(" ").length).toBe(24);
    expect(c.isValidPhrase(c.newPhrase(12))).toBe(true);
  });
});

describe("two-step codes (RFC 6238)", () => {
  // Reference secret "12345678901234567890" from the RFC, as base32.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it("matches the RFC test vectors", () => {
    expect(c.totpCode(SECRET, 59_000)).toBe("287082");
    expect(c.totpCode(SECRET, 1111111109_000)).toBe("081804");
    expect(c.totpCode(SECRET, 1234567890_000)).toBe("005924");
    expect(c.totpCode(SECRET, 20000000000_000)).toBe("353130");
  });
  it("accepts a code one step early or late, rejects others", () => {
    const now = 1234567890_000;
    expect(c.verifyTotp(SECRET, "005924", now)).toBe(true);
    expect(c.verifyTotp(SECRET, c.totpCode(SECRET, now - 30_000), now)).toBe(true);
    expect(c.verifyTotp(SECRET, c.totpCode(SECRET, now - 90_000), now)).toBe(false);
    expect(c.verifyTotp(SECRET, "12345", now)).toBe(false);
  });
  it("creates secrets an authenticator app can read", () => {
    const s = c.newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(c.totpUri(s)).toContain("secret=" + s);
  });
});

describe("bridge", () => {
  it("recognises Ethereum addresses and their checksum", () => {
    expect(c.isEthAddress("0x07696DcaB55E62cfef953666b29Fe1970518cB00")).toBe(true);
    expect(c.isEthAddress("0x07696dcab55e62cfef953666b29fe1970518cb00")).toBe(true);
    expect(c.isEthAddress("0x07696DcaB55E62cfef953666b29Fe1970518cB01")).toBe(false); // last digit changed
    expect(c.isEthAddress("0x07696dcaB55E62cfef953666b29Fe1970518cB00")).toBe(false); // wrong capital
    expect(c.isEthAddress("0x1234")).toBe(false);
    expect(c.isEthAddress("prl1p4zsh2ewyvm842353hj6tefeasfq8gxmjvyl60hhukgqeaguum74qfqtvnp")).toBe(false);
  });
  const api = (over: Record<string, any> = {}) =>
    (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/quote/mint")
          ? { amountGrains: "10000000000", feeGrains: "0", netGrains: "10000000000", lane: "fast", confirmationsRequired: 6, paused: false, withinDailyCap: true, ...over.quote }
          : url.includes("/status")
            ? { paused: false, contracts: { wprl: "0x07696DcaB55E62cfef953666b29Fe1970518cB00" }, ...over.status }
            : url.includes("/deposit-address")
              ? { pearlAddress: "prl1ppfzefk0pf7ax8vd3l89qrwmz97crrsnxrqmr0lqtpc7uzce4tl5q77y4hw", ethAddress: "0x000000000000000000000000000000000000dead", ...over.deposit }
              : { state: "minted", mintTxHash: "0x" + "ab".repeat(32), ...over.mint },
    })) as unknown as typeof fetch;
  it("reads a quote and refuses an unexpected token contract", async () => {
    const q = await new c.Bridge(api()).quote(10_000_000_000n);
    expect(q.net).toBe(10_000_000_000n);
    expect(q.confirmations).toBe(6);
    await expect(new c.Bridge(api({ status: { contracts: { wprl: "0x" + "11".repeat(20) } } })).quote(1n)).rejects.toThrow(/unexpected/);
  });
  it("only accepts a deposit address issued for the address asked", async () => {
    const eth = "0x000000000000000000000000000000000000dEaD";
    expect(await new c.Bridge(api()).depositAddress(eth)).toMatch(/^prl1p/);
    await expect(new c.Bridge(api({ deposit: { ethAddress: "0x" + "22".repeat(20) } })).depositAddress(eth)).rejects.toThrow();
    await expect(new c.Bridge(api()).depositAddress("0x12")).rejects.toThrow(/valid Ethereum/);
  });
  it("reports crossing status in plain phases", async () => {
    const tx = "ab".repeat(32);
    expect((await new c.Bridge(api()).status(tx)).phase).toBe("done");
    expect((await new c.Bridge(api({ mint: { state: "queued" } })).status(tx)).phase).toBe("pending");
    expect((await new c.Bridge(api({ mint: { state: "under_review" } })).status(tx)).phase).toBe("review");
    expect((await new c.Bridge(api({ mint: { state: "failed", refundedAt: 1 } })).status(tx)).phase).toBe("refunded");
    await expect(new c.Bridge(api()).status("../status")).rejects.toThrow();
  });
});
