#!/usr/bin/env node
// Validates manifest.json: well-formed JSON, required fields, and that every
// file it references actually exists. Run locally or in CI (no deps).

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
const fileExists = (rel) => existsSync(join(root, rel));

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
} catch (e) {
  console.error("✖ manifest.json is not valid JSON:", e.message);
  process.exit(1);
}

need(manifest.manifest_version === 3, "manifest_version must be 3");
need(typeof manifest.name === "string" && manifest.name, "name is required");
need(typeof manifest.version === "string" && manifest.version, "version is required");

// background service worker
if (manifest.background?.service_worker) {
  need(fileExists(manifest.background.service_worker),
    `background.service_worker missing: ${manifest.background.service_worker}`);
}

// content scripts
for (const cs of manifest.content_scripts ?? []) {
  for (const js of cs.js ?? []) {
    need(fileExists(js), `content script missing: ${js}`);
  }
  need(Array.isArray(cs.matches) && cs.matches.length > 0,
    `content_scripts entry has no "matches"`);
}

// action popup
if (manifest.action?.default_popup) {
  need(fileExists(manifest.action.default_popup),
    `action.default_popup missing: ${manifest.action.default_popup}`);
}

// icons (action + top-level). Each may be a single path string or a
// size→path map.
const iconSets = [manifest.action?.default_icon, manifest.icons].filter(Boolean);
for (const set of iconSets) {
  if (typeof set === "string") {
    need(fileExists(set), `icon missing: ${set}`);
  } else {
    for (const [size, path] of Object.entries(set)) {
      need(fileExists(path), `icon (${size}px) missing: ${path}`);
    }
  }
}

if (errors.length) {
  console.error("✖ manifest validation failed:");
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}

console.log(`✓ manifest.json valid — ${manifest.name} v${manifest.version}`);
