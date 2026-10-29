import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const fees = JSON.parse(readFileSync("fees.config.json", "utf8"));
if (process.env.KESHI_FEE_ADDRESS) fees.feeAddress = process.env.KESHI_FEE_ADDRESS;
if (process.env.KESHI_ETH_FEE_ADDRESS) fees.ethFeeAddress = process.env.KESHI_ETH_FEE_ADDRESS;
if (!/^0x[0-9a-fA-F]{40}$/.test(fees.ethFeeAddress ?? "")) console.warn("NOTE: no ethFeeAddress in fees.config.json — swaps on Uniswap charge NO commission.");
if (!/^prl1p[a-z0-9]{58}$/.test(fees.feeAddress)) console.warn("WARNING: no valid feeAddress in fees.config.json — this build charges NO commission.");
const base = JSON.parse(readFileSync("static/manifest.base.json", "utf8"));
// LI.FI key (fees.config.json): shipped in the extension unless a relay holds it.
// LI.FI API key: never in a tracked file. Read from lifi.key (ignored by git) or KESHI_LIFI_KEY; a relay build needs none.
const LIFI_PROXY = process.env.KESHI_LIFI_DIRECT ? "" : (process.env.KESHI_LIFI_PROXY ?? "https://lifi.keshiwallet.com");
const { lifiApiKey: _ignored, ...feesForBuild } = fees;
const lifiKey = LIFI_PROXY ? "" : (process.env.KESHI_LIFI_KEY ?? (existsSync("lifi.key") ? readFileSync("lifi.key", "utf8").trim() : ""));
if (!LIFI_PROXY && !lifiKey) console.warn("WARNING: no LI.FI key (lifi.key or KESHI_LIFI_KEY) and no relay: Buy with USDT will be rate-limited.");
// Pages on http://localhost may talk to the wallet only in test builds (KESHI_DEV=1): the store build asks for no more than it needs.
if (!process.env.KESHI_DEV) for (const cs of base.content_scripts ?? []) cs.matches = cs.matches.filter((m) => !m.startsWith("http://localhost"));
// Quotes for "Buy with USDT" go through Keshi's relay (relay/worker.js), which holds the LI.FI key: the
// extension itself carries no key, so anyone can rebuild it and get the Store's exact files.
// KESHI_LIFI_DIRECT=1 builds a variant that talks to li.quest itself, with a key from lifi.key / KESHI_LIFI_KEY.
if (LIFI_PROXY) {
  const relay = new URL(LIFI_PROXY).origin;
  base.host_permissions = base.host_permissions.map((h) => (h === "https://li.quest/*" ? `${relay}/*` : h));
  base.content_security_policy.extension_pages = base.content_security_policy.extension_pages.replace("https://li.quest", relay);
}
const targets = {
  chrome: { ...base, minimum_chrome_version: "111", background: { service_worker: "background.js" } },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "keshi-wallet@keshiwallet.io", strict_min_version: "140.0", data_collection_permissions: { required: ["financialAndPaymentInfo"] } }, gecko_android: { strict_min_version: "142.0" } },
  },
};

rmSync("dist", { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}`;
  mkdirSync(out, { recursive: true });
  await build({
    // Firefox adds a data consent screen in front of the same wallet (Mozilla policy); Chrome's files are unchanged.
    entryPoints:
      name === "firefox"
        ? { popup: "src/ui/main.firefox.tsx", background: "src/ext/background.firefox.ts", bridge: "src/ext/bridge.ts", inpage: "src/ext/inpage.ts" }
        : { popup: "src/ui/main.tsx", background: "src/ext/background.ts", bridge: "src/ext/bridge.ts", inpage: "src/ext/inpage.ts" },
    bundle: true,
    format: "iife",
    target: ["chrome111", "firefox128"],
    outdir: out,
    minify: true,
    banner: { js: "/*! Keshi wallet. Copyright (c) 2026 Keshi (contact@keshiwallet.com). All rights reserved. */" },
    legalComments: "none",
    loader: { ".woff2": "file", ".woff": "empty" },
    assetNames: "fonts/[name]",
    define: { "process.env.NODE_ENV": '"production"', __KESHI_FEES__: JSON.stringify(feesForBuild), __KESHI_UNLOCK__: JSON.stringify(process.env.KESHI_UNLOCK ?? "dial"), __KESHI_LIFI_PROXY__: JSON.stringify(LIFI_PROXY), __KESHI_LIFI_KEY__: JSON.stringify(lifiKey) },
    logLevel: "warning",
  });
  cpSync("static/popup.html", `${out}/popup.html`);
  cpSync("static/icon", `${out}/icon`, { recursive: true });
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}
console.log("Built dist/chrome and dist/firefox");
