import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as c from "../src/core";

// The prices Keshi ships with. Checked against the competition as of October 2026:
// Another Pearl wallet asks 0.1% with a 1 PRL minimum on bridging; the main custodial competitor takes 0.88% to 1.25% on swaps.
const shipped = JSON.parse(readFileSync("fees.config.json", "utf8"));
const PRL = 100_000_000n;

describe("shipped prices", () => {
  const bridge = c.serviceFor(c.MAINNET, "bridge", shipped)!;

  it("charges 0.1% on the bridge, never more than 3 PRL", () => {
    expect(c.commission(100n * PRL, bridge)).toBe(PRL / 10n); // 0.10 PRL
    expect(c.commission(2000n * PRL, bridge)).toBe(2n * PRL);
    expect(c.commission(100_000n * PRL, bridge)).toBe(3n * PRL);
  });

  it("is never more expensive than the other wallet's bridge tip (0.1%, at least 1 PRL)", () => {
    for (const amount of [1n, 10n, 100n, 500n, 999n, 1000n, 2500n, 3000n, 5000n, 1_000_000n]) {
      const theirs = (amount * PRL) / 1000n > PRL ? (amount * PRL) / 1000n : PRL;
      expect(c.commission(amount * PRL, bridge)).toBeLessThanOrEqual(theirs);
    }
  });

  it("charges 0.30% on swaps, well below the 0.88% charged elsewhere", () => {
    expect(c.swapFee(shipped)!.bips).toBe(30n);
    expect(Number(c.swapFee(shipped)!.bips)).toBeLessThan(88);
  });

  it("keeps simple sends free", () => {
    expect(c.serviceFor(c.MAINNET, "send", shipped)).toBeUndefined();
  });
});
