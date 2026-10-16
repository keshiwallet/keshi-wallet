import { describe, expect, it } from "vitest";
import { ethActivityOf, loadEthActivity } from "../src/core/ethActivity";

const ME = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OTHER = "0x3f1aB2C3d4E5F60718293A4b5C6d7E8F9A0b9a2c";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const WPRL = "0x07696DcaB55E62cfef953666b29Fe1970518cB00";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ZERO = "0x0000000000000000000000000000000000000000";
const t = (h: number) => new Date(1_760_000_000_000 - h * 3600_000).toISOString();
const tok = (hash: string, from: string, to: string, value: string, hours: number, address = WPRL, symbol = "wPRL", decimals = "8") => ({ transaction_hash: hash, timestamp: t(hours), from: { hash: from }, to: { hash: to }, token: { address, symbol, decimals }, total: { value, decimals } });

describe("Ethereum activity", () => {
  it("reads ETH in and out from plain transactions, newest first", () => {
    const a = ethActivityOf(
      ME,
      [
        { hash: "0x1", timestamp: t(5), from: { hash: OTHER }, to: { hash: ME }, value: "2500000000000000", status: "ok" },
        { hash: "0x2", timestamp: t(1), from: { hash: ME }, to: { hash: OTHER }, value: "1000000000000000", status: "ok" },
      ],
      [],
      [],
    );
    expect(a.map((x) => [x.hash, x.kind, x.main.asset, x.main.amount])).toEqual([
      ["0x2", "sent", "ETH", -1000000000000000n],
      ["0x1", "received", "ETH", 2500000000000000n],
    ]);
    expect(a[1]!.counterparty).toBe(OTHER.toLowerCase());
  });

  it("reads a Uniswap swap as one line with both sides: wPRL out, ETH in through an internal transfer", () => {
    const a = ethActivityOf(
      ME,
      [{ hash: "0x9", timestamp: t(2), from: { hash: ME }, to: { hash: ROUTER }, value: "0", status: "ok" }],
      [tok("0x9", ME, ROUTER, "10000000000", 2)],
      [{ transaction_hash: "0x9", timestamp: t(2), from: { hash: ROUTER }, to: { hash: ME }, value: "41500000000000000", success: true }],
    );
    expect(a.length).toBe(1);
    expect(a[0]!.kind).toBe("swap");
    expect(a[0]!.main).toEqual({ asset: "wPRL", amount: -10000000000n, decimals: 8 });
    expect(a[0]!.other).toEqual({ asset: "ETH", amount: 41500000000000000n, decimals: 18 });
  });

  it("reads ETH paid into a swap as the main side and the token received as the other", () => {
    const a = ethActivityOf(ME, [{ hash: "0x8", timestamp: t(2), from: { hash: ME }, to: { hash: ROUTER }, value: "10000000000000000", status: "ok" }], [tok("0x8", ROUTER, ME, "2392000000", 2)], []);
    expect(a[0]!.kind).toBe("swap");
    expect(a[0]!.main.asset).toBe("ETH");
    expect(a[0]!.main.amount).toBe(-10000000000000000n);
    expect(a[0]!.other?.asset).toBe("wPRL");
  });

  it("tells bridge arrivals (minted from nobody) and bridge returns (burned) apart", () => {
    const a = ethActivityOf(ME, [], [tok("0xb1", ZERO, ME, "25000000000", 10), tok("0xb2", ME, ZERO, "5000000000", 4)], []);
    expect(a.map((x) => [x.kind, x.main.amount])).toEqual([
      ["bridge-out", -5000000000n],
      ["bridge-in", 25000000000n],
    ]);
  });

  it("reads WETH turned into ETH, and names WETH by its contract", () => {
    const a = ethActivityOf(ME, [{ hash: "0xw", timestamp: t(1), from: { hash: ME }, to: { hash: WETH }, value: "0", status: "ok" }], [], [{ transaction_hash: "0xw", timestamp: t(1), from: { hash: WETH }, to: { hash: ME }, value: "5000000000000000", success: true }]);
    expect(a[0]!.kind).toBe("unwrap");
    expect(a[0]!.main.amount).toBe(5000000000000000n);
    const b = ethActivityOf(ME, [], [tok("0xt", OTHER, ME, "7000000000000000", 1, WETH, "WETH", "18")], []);
    expect(b[0]!.main.asset).toBe("WETH");
    expect(b[0]!.kind).toBe("received");
  });

  it("leaves plain permissions out, keeps failed attempts, and ignores transfers between the address and itself", () => {
    const a = ethActivityOf(
      ME,
      [
        { hash: "0xapprove", timestamp: t(3), from: { hash: ME }, to: { hash: WPRL }, value: "0", status: "ok" },
        { hash: "0xfail", timestamp: t(2), from: { hash: ME }, to: { hash: ROUTER }, value: "0", status: "error" },
        { hash: "0xself", timestamp: t(1), from: { hash: ME }, to: { hash: ME }, value: "1000", status: "ok" },
      ],
      [],
      [],
    );
    expect(a.map((x) => x.hash)).toEqual(["0xfail"]);
    expect(a[0]!.kind).toBe("contract");
    expect(a[0]!.failed).toBe(true);
  });

  it("reads Blockscout page by page and treats an unknown address as empty", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/transactions")) {
        if (!String(url).includes("page=2")) return new Response(JSON.stringify({ items: [{ hash: "0x1", timestamp: t(1), from: { hash: OTHER }, to: { hash: ME }, value: "1", status: "ok" }], next_page_params: { page: 2 } }));
        return new Response(JSON.stringify({ items: [{ hash: "0x2", timestamp: t(2), from: { hash: OTHER }, to: { hash: ME }, value: "2", status: "ok" }], next_page_params: null }));
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }) as unknown as typeof fetch;
    const a = await loadEthActivity(ME, fetcher);
    expect(a.map((x) => x.hash)).toEqual(["0x1", "0x2"]);
    expect(calls.filter((c) => c.includes("/transactions")).length).toBe(2);
    expect(calls.every((c) => c.startsWith("https://eth.blockscout.com/api/v2/addresses/" + ME))).toBe(true);
  });

  it("flags an unknown token that arrives uninvited as an airdrop, but not one the user asked for", () => {
    const SEND = "0x91d6Cf4Af9697Ec95d9e1754e84D2B31C67a5aB7";
    const a = ethActivityOf(
      ME,
      [{ hash: "0xmine", timestamp: t(1), from: { hash: ME }, to: { hash: SEND }, value: "0", status: "ok" }],
      [tok("0xdrop", "0x35Fd4fa6a18087B7F5E1142C1755149599F34d6a", ME, "15000000000000000000", 2, SEND, "SEND", "18"), tok("0xmine", OTHER, ME, "1000", 1, SEND, "SEND", "18"), tok("0xok", ZERO, ME, "100", 3)],
      [],
    );
    const by = Object.fromEntries(a.map((x) => [x.hash, x]));
    expect(by["0xdrop"]!.flag).toBe("airdrop");
    expect(by["0xdrop"]!.main.asset).toBe("SEND");
    expect(by["0xmine"]!.flag).toBeUndefined(); // our own transaction brought it in
    expect(by["0xok"]!.flag).toBeUndefined(); // wPRL is known
  });
});
