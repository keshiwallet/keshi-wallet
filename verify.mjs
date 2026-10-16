// Checks Keshi's files against the published list of SHA-256 hashes in
// verify/chrome-<version>.sha256. That list was made from the package uploaded
// to the Chrome Web Store, so a match means "these files are the Store files".
//
//   node verify.mjs                  checks your own build (dist/chrome): proves this code makes the Store files
//   node verify.mjs "<folder>"       checks any folder, for example the copy Chrome installed on your computer
//
// Run `npm ci && npm run build` first if you want to check your own build.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const listFile = `verify/chrome-${version}.sha256`;
const folder = process.argv[2] ?? "dist/chrome";

if (!existsSync(listFile)) {
  console.error(`No hash list for version ${version} (${listFile}).`);
  process.exit(2);
}
if (!existsSync(folder) || !statSync(folder).isDirectory()) {
  console.error(`Folder not found: ${folder}`);
  if (!process.argv[2]) console.error("Build first:  npm ci && npm run build");
  process.exit(2);
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = new Map(
  readFileSync(listFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split("  ");
      return [rest.join("  "), hash];
    }),
);

// Every file under the folder, with "/" in the path. Chrome adds a _metadata folder to installed extensions: it is not part of the package.
const found = new Map();
const walk = (dir, prefix = "") => {
  for (const name of readdirSync(dir)) {
    const rel = prefix + name;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (prefix === "" && name === "_metadata") continue;
      walk(full, rel + "/");
    } else found.set(rel, readFileSync(full));
  }
};
walk(folder);

let bad = 0;
const rows = [];
for (const [path, want] of expected) {
  const bytes = found.get(path);
  if (!bytes) {
    rows.push(["MISSING  ", path]);
    bad++;
  } else if (sha(bytes) === want) {
    rows.push(["OK       ", path]);
  } else if (path === "manifest.json" && manifestMatchesWithoutStoreKeys(bytes, want)) {
    rows.push(["OK       ", `${path} (Chrome added an update_url line, nothing else differs)`]);
  } else {
    rows.push(["DIFFERENT", path]);
    bad++;
  }
}
for (const path of found.keys()) {
  if (!expected.has(path)) {
    rows.push(["EXTRA    ", path]);
    bad++;
  }
}
rows.sort((a, b) => a[1].localeCompare(b[1]));
for (const [state, path] of rows) console.log(`${state} ${path}`);
console.log(bad === 0 ? `\nAll ${expected.size} files match Keshi ${version}.` : `\n${bad} problem(s). These files do not match the published list for Keshi ${version}.`);
process.exit(bad === 0 ? 0 : 1);

// The Chrome Web Store may add "update_url" to the installed manifest. Remove it (and "key"), write the manifest the way build.mjs does, and compare again.
function manifestMatchesWithoutStoreKeys(bytes, want) {
  try {
    const m = JSON.parse(bytes.toString("utf8"));
    delete m.update_url;
    delete m.key;
    return sha(Buffer.from(JSON.stringify(m, null, 2))) === want;
  } catch {
    return false;
  }
}
