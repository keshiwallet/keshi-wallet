// Builds the packages that go to the stores, and refuses to package anything
// that is not a clean production build: no test settings, no test fee address,
// no localhost access, no source maps, no code built at run time, fees within
// their ceilings, the right version everywhere. Run: npm run release
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fail = (why) => {
  console.error(`\nRELEASE STOPPED: ${why}\n`);
  process.exit(1);
};
for (const k of ["KESHI_DEV", "KESHI_FEE_ADDRESS", "KESHI_ETH_FEE_ADDRESS"]) if (process.env[k]) fail(`${k} is set. Test settings must never reach users.`);

const fees = JSON.parse(readFileSync("fees.config.json", "utf8"));
const base = JSON.parse(readFileSync("static/manifest.base.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = base.version;
if (pkg.version !== version) fail(`package.json says ${pkg.version}, the manifest says ${version}.`);
if (!/^prl1p[a-z0-9]{58}$/.test(fees.feeAddress)) fail("fees.config.json has no valid Pearl fee address.");
if (!/^0x[0-9a-fA-F]{40}$/.test(fees.ethFeeAddress)) fail("fees.config.json has no valid Ethereum fee address.");
if (!(fees.swapPercent <= 1)) fail("the swap fee is above 1%.");
if (!((fees.usdtBuyPercent ?? 0) <= 1)) fail("the USDT purchase fee is above 1%.");
if (fees.lifiApiKey) fail("fees.config.json must not contain the LI.FI key: put it in lifi.key (ignored by git).");
if (process.env.KESHI_LIFI_DIRECT && !process.env.KESHI_LIFI_KEY && !existsSync("lifi.key")) fail("a direct build needs a LI.FI key (lifi.key or KESHI_LIFI_KEY).");
for (const k of ["sendPercent", "combinePercent", "bridgePercent"]) if (!((fees[k] ?? 0) <= 3)) fail(`${k} is above 3%.`);

execFileSync(process.execPath, ["build.mjs"], { stdio: "inherit" });

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const TEST_ETH_FEE = "0x1111111111111111111111111111111111111111";
for (const target of ["chrome", "firefox"]) {
  const dir = `dist/${target}`;
  const manifest = readFileSync(`${dir}/manifest.json`, "utf8");
  if (JSON.parse(manifest).version !== version) fail(`${target}: wrong version in the manifest.`);
  if (/localhost|http:\/\//.test(manifest)) fail(`${target}: the manifest still allows localhost or plain http.`);
  for (const f of files(dir)) {
    if (f.endsWith(".map")) fail(`${f}: source maps must not ship.`);
    if (!f.endsWith(".js")) continue;
    const js = readFileSync(f, "utf8");
    if (/\beval\(|new Function\(/.test(js)) fail(`${f}: code built at run time is not allowed by the store.`);
    if (js.includes(TEST_ETH_FEE)) fail(`${f}: contains the test fee address.`);
  }
  const popup = readFileSync(`${dir}/popup.js`, "utf8");
  if (!popup.includes(fees.feeAddress) || !popup.includes(fees.ethFeeAddress)) fail(`${target}: the fee addresses from fees.config.json are not in the build.`);
}

rmSync("release", { recursive: true, force: true });
mkdirSync("release");
const sums = [];
for (const target of ["chrome", "firefox"]) {
  const name = `keshi-${target}-${version}.zip`;
  // Reproducible zip: every file dated 1 January 2026, listed in a fixed order, no folder entries and no
  // extra attributes. The same code then gives the same zip, byte for byte, with Info-ZIP's zip.
  const files = [];
  const walk = (d, rel = "") => {
    for (const n of readdirSync(join(`dist/${target}`, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(`dist/${target}`, r)).isDirectory()) walk(d, r);
      else files.push(r);
    }
  };
  walk(`dist/${target}`);
  const when = new Date("2026-01-01T00:00:00Z");
  for (const f of files) utimesSync(join(`dist/${target}`, f), when, when);
  try {
    execFileSync("zip", ["-q", "-X", "-D", join("..", "..", "release", name), ...files.sort()], { cwd: `dist/${target}`, env: { ...process.env, TZ: "UTC" } });
  } catch (e) {
    if (e.code === "ENOENT") fail("the zip program is missing. Install it first (Debian/Ubuntu: sudo apt install zip; macOS has it; Windows: use WSL or Git Bash with zip).");
    throw e;
  }
  sums.push(`${createHash("sha256").update(readFileSync(`release/${name}`)).digest("hex")}  ${name}`);
}
writeFileSync("release/SHA256SUMS.txt", sums.join("\n") + "\n");
console.log(`\nRelease ${version} ready in release/:\n${sums.join("\n")}\nFees: swap ${fees.swapPercent}%, USDT buy ${fees.usdtBuyPercent ?? fees.swapPercent}%, bridge ${fees.bridgePercent}% (max ${fees.bridgeCapPrl} PRL), combine ${fees.combinePercent}% (max ${fees.combineCapPrl} PRL), mint ${fees.mintFlatPrl} PRL.`);
