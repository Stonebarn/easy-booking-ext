#!/usr/bin/env node
// Validates manifest.json: well-formed JSON, required fields, and that every
// file it references actually exists — plus the side panel's own <script src>
// list, because a renamed panel script breaks the panel silently (the manifest
// never mentions it, so nothing else would notice). Run locally or in CI (no
// deps).

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

// toolbar action. There is no default_popup any more — clicking the icon opens
// the side panel (see background.js) — but the action itself must still exist
// with an icon, or there is nothing to click.
need(manifest.action && typeof manifest.action === "object",
  `"action" is required (the toolbar button that opens the side panel)`);
need(!!manifest.action?.default_icon, "action.default_icon is required");

// permissions. The panel *is* the UI and per-SDR OAuth is how it gets data, so
// both of these are load-bearing rather than optional extras.
const permissions = manifest.permissions ?? [];
for (const perm of ["sidePanel", "identity"]) {
  need(permissions.includes(perm), `"${perm}" permission is required`);
}
// chrome.sidePanel landed in Chrome 114.
need(typeof manifest.minimum_chrome_version === "string" && manifest.minimum_chrome_version,
  "minimum_chrome_version is required (side panel needs Chrome 114+)");

// side panel
need(manifest.side_panel && typeof manifest.side_panel === "object",
  `"side_panel" is required (the panel is the extension's UI)`);
const panelPath = manifest.side_panel?.default_path;
need(typeof panelPath === "string" && panelPath, "side_panel.default_path is required");
if (panelPath) need(fileExists(panelPath), `side_panel.default_path missing: ${panelPath}`);

// Scripts the side panel document loads. These are invisible to the manifest, so
// a rename here fails at runtime with nothing but a console error — validate them
// the same way as manifest-referenced files.
if (panelPath && panelPath.endsWith(".html") && fileExists(panelPath)) {
  const html = readFileSync(join(root, panelPath), "utf8");
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  need(srcs.length > 0, `${panelPath} loads no scripts — the panel would render inert`);
  for (const src of srcs) {
    // MV3's CSP forbids remote code; a CDN <script> would be silently blocked.
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src)) {
      errors.push(`${panelPath} loads a remote script (blocked by MV3 CSP): ${src}`);
      continue;
    }
    const rel = src.replace(/^\.?\//, "").split(/[?#]/)[0];
    need(fileExists(rel), `${panelPath} references a missing script: ${src}`);
  }

  // Images the panel document loads. Same reasoning as the scripts: the manifest
  // never mentions them, so a renamed icon is a broken tile in the header with
  // nothing but a 404 in the console to say so. Remote images ARE allowed (the
  // company favicon service is fetched at runtime from JS, and a page-level
  // <img> to https is permitted by MV3's default CSP), so only local paths are
  // checked for existence.
  const imgs = [...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const src of imgs) {
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src) || /^data:/i.test(src)) continue;
    const rel = src.replace(/^\.?\//, "").split(/[?#]/)[0];
    need(fileExists(rel), `${panelPath} references a missing image: ${src}`);
  }
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
