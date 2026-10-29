import { guardNetwork, hasConsent } from "./consent";

// Firefox background, loaded before the rest: block the network first, then
// show the consent page right after install, and after an update to anyone
// who has not accepted yet.
guardNetwork();

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  if (await hasConsent()) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?consent=1") }).catch(() => {});
});
