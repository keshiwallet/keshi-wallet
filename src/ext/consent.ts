// Firefox only. Mozilla asks that nothing leaves the browser before the user
// has agreed to it on a clear screen inside the add-on. Firefox 140+ also
// shows its own built-in consent at install; this screen covers every case.
//
// Every request Keshi makes goes through fetch(), so holding fetch() back
// until the user accepts is enough: before that, nothing is sent at all.

export const CONSENT_KEY = "dataConsent";
/** Raise when Keshi starts sending a new kind of data: users are asked again. */
export const CONSENT_VERSION = 1;

let given = false;

export async function hasConsent(): Promise<boolean> {
  if (given) return true;
  try {
    const v = (await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY] as { version?: unknown } | undefined;
    given = !!v && typeof v.version === "number" && v.version >= CONSENT_VERSION;
  } catch {
    given = false;
  }
  return given;
}

export async function giveConsent(): Promise<void> {
  await chrome.storage.local.set({ [CONSENT_KEY]: { version: CONSENT_VERSION, at: Date.now() } });
  given = true;
}

/** From now on, fetch() refuses to send anything until the user has accepted. */
export function guardNetwork(): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    // Erasing the wallet clears storage, consent included: look again rather than trust memory alone.
    given = false;
    if (!(await hasConsent())) throw new TypeError("Keshi has not been allowed to send data yet. Open Keshi and accept.");
    return real(...args);
  }) as typeof fetch;
}
