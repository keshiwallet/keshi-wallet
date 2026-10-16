import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const fees = JSON.parse(readFileSync("fees.config.json", "utf8"));
if (process.env.KESHI_FEE_ADDRESS) fees.feeAddress = process.env.KESHI_FEE_ADDRESS;
if (process.env.KESHI_ETH_FEE_ADDRESS) fees.ethFeeAddress = process.env.KESHI_ETH_FEE_ADDRESS;
if (!/^0x[0-9a-fA-F]{40}$/.test(fees.ethFeeAddress ?? "")) console.warn("NOTE: no ethFeeAddress in fees.config.json — swaps on Uniswap charge NO commission.");
if (!/^prl1p[a-z0-9]{58}$/.test(fees.feeAddress)) console.warn("WARNING: no valid feeAddress in fees.config.json — this build charges NO commission.");
const base = JSON.parse(readFileSync("static/manifest.base.json", "utf8"));
// Pages on http://localhost may talk to the wallet only in test builds (KESHI_DEV=1): the store build asks for no more than it needs.
if (!process.env.KESHI_DEV) for (const cs of base.content_scripts ?? []) cs.matches = cs.matches.filter((m) => !m.startsWith("http://localhost"));
const targets = {
  chrome: { ...base, minimum_chrome_version: "111", background: { service_worker: "background.js" } },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: { gecko: { id: "keshi-wallet@keshiwallet.io", strict_min_version: "140.0", data_collection_permissions: { required: ["financialAndPaymentInfo"], optional: ["authenticationInfo"] } }, gecko_android: { strict_min_version: "142.0" } },
  },
};

rmSync("dist", { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}`;
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: { popup: "src/ui/main.tsx", background: "src/ext/background.ts", bridge: "src/ext/bridge.ts", inpage: "src/ext/inpage.ts" },
    bundle: true,
    format: "iife",
    target: ["chrome111", "firefox128"],
    outdir: out,
    minify: true,
    banner: { js: "/*! Keshi wallet. Copyright (c) 2026 Keshi (contact@keshiwallet.com). All rights reserved. */" },
    legalComments: "none",
    loader: { ".woff2": "file", ".woff": "empty" },
    assetNames: "fonts/[name]",
    define: { "process.env.NODE_ENV": '"production"', __KESHI_FEES__: JSON.stringify(fees), __KESHI_UNLOCK__: JSON.stringify(process.env.KESHI_UNLOCK ?? "dial") },
    logLevel: "warning",
  });
  cpSync("static/popup.html", `${out}/popup.html`);
  cpSync("static/icon", `${out}/icon`, { recursive: true });
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
}
console.log("Built dist/chrome and dist/firefox");
