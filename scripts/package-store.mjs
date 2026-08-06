// package-store.mjs — builds the Chrome Web Store upload zip.
//
//   node scripts/package-store.mjs
//
// The store zip differs from the repo in exactly one way: manifest.json's
// "key" field is stripped. The key pins the extension ID for local unpacked
// installs (the OAuth redirect URL derives from it), but the Web Store
// rejects manifests that carry it — the store manages identity itself, and
// assigns the listing's ID from its own key at first upload.
//
// Everything else ships byte-identical to the repo. Output:
//   dist/dialer-helper-pro-v<version>.zip
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

// --- Store validations we can catch before the dashboard does -------------
const problems = [];
if (!manifest.key) problems.push("manifest.json has no \"key\" — dev installs will get per-machine IDs; expected the pinned key in the repo copy");
if ((manifest.description || "").length > 132) {
  problems.push(`description is ${manifest.description.length} chars — the store caps it at 132`);
}
if ((manifest.name || "").length > 45) {
  problems.push(`name is ${manifest.name.length} chars — the store caps it at 45`);
}
if (problems.length) {
  console.error("Refusing to package:\n - " + problems.join("\n - "));
  process.exit(1);
}

// --- Stage exactly what the extension ships ------------------------------
// The runtime file set: manifest + everything it (and sidepanel.html)
// references. Keep this list in lockstep with manifest.json.
const FILES = [
  "background.js",
  "content-nooks.js",
  "content-scheduler.js",
  "sidepanel.html",
  "sidepanel.js",
  "hubspot-config.js",
  "hubspot-auth.js",
  "hubspot-data.js",
  "hubspot-notes.js",
  "hubspot-write.js",
];
const DIRS = ["icons"];

const stage = join(root, "dist", "store-pkg");
rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const f of FILES) {
  if (!existsSync(join(root, f))) {
    console.error(`Missing runtime file: ${f} — update FILES in this script if the set changed.`);
    process.exit(1);
  }
  cpSync(join(root, f), join(stage, f));
}
for (const d of DIRS) cpSync(join(root, d), join(stage, d), { recursive: true });

// The one transformation: strip the dev key.
const storeManifest = { ...manifest };
delete storeManifest.key;
writeFileSync(join(stage, "manifest.json"), JSON.stringify(storeManifest, null, 2) + "\n");

const zipName = `dialer-helper-pro-v${manifest.version}.zip`;
execFileSync("zip", ["-r", "-X", join("..", zipName), "."], { cwd: stage, stdio: "pipe" });
rmSync(stage, { recursive: true, force: true });

console.log(`dist/${zipName} ready (key stripped, description ${storeManifest.description.length}/132 chars).`);
console.log("Upload it at https://chrome.google.com/webstore/devconsole — after the first upload,");
console.log("copy the listing's extension ID and hand it to Claude so the HubSpot app's OAuth");
console.log("redirect URL can be registered for store installs.");
