import { describe, expect, it } from "vitest";
import * as core from "../src/core";

// The states below are the ones PearlBridge documents on its developers page.
function bridge(answer: unknown) {
  const b: any = Object.create((core as any).Bridge.prototype);
  b.get = async () => answer;
  return b;
}
const TX = "ab".repeat(32);

describe("bridge states named in PearlBridge's documentation", () => {
  it("shows a normal step (attested) as on its way, not as held for review", async () => {
    expect((await bridge({ state: "attested" }).status(TX)).phase).toBe("pending");
    expect((await bridge({ state: "submitted" }).status(TX)).phase).toBe("pending");
    expect((await bridge({ state: "queued" }).status(TX)).phase).toBe("pending");
  });
  it("still reports a real review, and the end of the trip", async () => {
    expect((await bridge({ state: "under_review", anomalyReason: "x" }).status(TX)).phase).toBe("review");
    expect((await bridge({ state: "minted", mintTxHash: "0x" + TX }).status(TX)).phase).toBe("done");
    expect((await bridge({ state: "cancelled" }).status(TX)).phase).toBe("failed");
  });
  it("shows a finished return trip (unlocked) as done", async () => {
    const s = await bridge({ state: "unlocked", pearlTxId: TX }).backStatus("0x" + TX);
    expect(s.phase).toBe("done");
    expect(s.pearlTx).toBe(TX);
    expect((await bridge({ state: null }).backStatus("0x" + TX)).phase).toBe("pending");
  });
});
