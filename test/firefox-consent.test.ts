import { beforeEach, describe, expect, it, vi } from "vitest";

// Firefox build: nothing may leave the browser before the user accepts.
describe("Firefox data consent", () => {
  let store: Record<string, unknown>;
  let realCalls: number;
  beforeEach(() => {
    vi.resetModules();
    store = {};
    realCalls = 0;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
          set: async (o: Record<string, unknown>) => void Object.assign(store, o),
        },
      },
    };
    globalThis.fetch = (async () => {
      realCalls++;
      return new Response("{}");
    }) as typeof fetch;
  });

  it("blocks every request until consent, then lets them through", async () => {
    const c = await import("../src/ext/consent");
    c.guardNetwork();
    await expect(fetch("https://blockbook.pearlresearch.ai/api/v2")).rejects.toThrow(/not been allowed/);
    expect(realCalls).toBe(0);
    await c.giveConsent();
    await fetch("https://blockbook.pearlresearch.ai/api/v2");
    expect(realCalls).toBe(1);
  });

  it("asks again after the wallet is erased (storage cleared)", async () => {
    const c = await import("../src/ext/consent");
    c.guardNetwork();
    await c.giveConsent();
    store = {};
    await expect(fetch("https://x.example/")).rejects.toThrow(/not been allowed/);
    expect(realCalls).toBe(0);
  });

  it("asks again when the consent version is older", async () => {
    const c = await import("../src/ext/consent");
    store[c.CONSENT_KEY] = { version: 0, at: 1 };
    expect(await c.hasConsent()).toBe(false);
    store[c.CONSENT_KEY] = { version: c.CONSENT_VERSION, at: 1 };
    expect(await c.hasConsent()).toBe(true);
  });
});
