// Content script: passes messages between the page and the wallet.
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.data?.target !== "keshi-bridge") return;
  const { id, method, params } = ev.data;
  if (typeof id !== "string" || typeof method !== "string") return;
  // Whether the person just clicked or typed on the page. Read here, out of the page's reach: a page cannot fake it.
  const active = navigator.userActivation ? navigator.userActivation.isActive : true;
  chrome.runtime.sendMessage({ keshi: "request", id, method, params, active }, (reply) => {
    if (chrome.runtime.lastError) return respond(id, undefined, "Wallet unavailable");
    if (reply?.pending) return; // the answer arrives later, once the user decides
    respond(id, reply?.result, reply?.error);
  });
});
chrome.runtime.onMessage.addListener((msg) => {
  // An answer is only for the site that asked. If this tab has moved to another site meanwhile, drop it.
  if (msg?.keshi === "response" && msg.origin === window.location.origin) respond(msg.id, msg.result, msg.error);
});
function respond(id: string, result: unknown, error?: string) {
  window.postMessage({ target: "keshi-inpage", id, result, error }, window.location.origin);
}
