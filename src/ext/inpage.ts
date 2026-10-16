// Runs inside web pages. Gives Pearl apps a small `window.keshi` object to
// talk to the wallet. It holds no keys: every request goes to the wallet,
// which asks the user before anything is shared or signed.
(() => {
  let seq = 0;
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.target !== "keshi-inpage") return;
    if (typeof ev.data.id !== "string") return;
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    if (ev.data.error) w.reject(new Error(ev.data.error));
    else w.resolve(ev.data.result);
  });
  const request = (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      // Request ids come from the browser's cryptographic generator, never Math.random: a page must not be able to guess another request's id.
      const rnd = crypto.getRandomValues(new Uint8Array(16));
      const id = `${Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("")}-${++seq}`;
      waiting.set(id, { resolve, reject });
      window.postMessage({ target: "keshi-bridge", id, method, params }, window.location.origin);
    });
  const provider = Object.freeze({
    isKeshi: true,
    connect: () => request("connect"),
    disconnect: () => request("disconnect"),
    getAccounts: () => request("getAccounts"),
    getNetwork: () => request("getNetwork"),
    signMessage: (message: string) => request("signMessage", { message }),
    sendPayment: (to: string, amount: string) => request("sendPayment", { to, amount }),
  });
  Object.defineProperty(window, "keshi", { value: provider, writable: false, configurable: false });
  window.dispatchEvent(new Event("keshi#ready"));
})();
