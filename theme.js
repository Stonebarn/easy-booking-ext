// theme.js — the panel's light/dark choice.
//
// Loaded from <head>, before the panel's markup, so a saved theme is on the root
// element as early as this page can put it there. Extension pages ban inline
// script (MV3 CSP), so a <head> file is the earliest hook available; the storage
// read itself is async, so the first paint can still be the OS theme for a frame.
// Nothing else in the panel may write data-theme.
//
// One setting, three values: "system" (the default — no data-theme attribute at
// all, so the stylesheet's prefers-color-scheme rules decide), "light", "dark".
// Stored inside the shared "eb:settings" object next to autoSyncNotes, read and
// merged the same way, and mirrored across panel windows through
// chrome.storage.onChanged.
//
// No modules anywhere in this extension: plain IIFE, loaded with a <script src>.
(() => {
  "use strict";

  const SETTINGS_KEY = "eb:settings";
  const CHOICES = ["system", "light", "dark"];
  const DEFAULT = "system";

  let current = DEFAULT;

  // Absent, unknown, or a value from a newer version all mean "System": the
  // panel must never end up locked to a theme it cannot name.
  function readTheme(stored) {
    const raw = stored && typeof stored === "object" ? stored.theme : null;
    return CHOICES.indexOf(raw) === -1 ? DEFAULT : raw;
  }

  // "System" is the absence of the attribute, not a third value of it: that way
  // the OS preference is expressed by the media query alone and there is no
  // second source of truth to keep in step with it.
  function apply(theme) {
    current = theme;
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }

  // The radio group lives in the settings popover (see sidepanel.html). It may
  // not exist yet when a storage read lands, and in some contexts never will.
  function render() {
    const el = document.getElementById("setting-theme-" + current);
    if (el) el.checked = true;
  }

  async function setTheme(next) {
    const theme = CHOICES.indexOf(next) === -1 ? DEFAULT : next;
    apply(theme);
    render();
    try {
      // Read-modify-write, like the auto-sync toggle: "eb:settings" is shared,
      // so a theme change must not drop a preference this file knows nothing
      // about.
      const res = (await chrome.storage.local.get(SETTINGS_KEY)) || {};
      const merged = { ...(res[SETTINGS_KEY] || {}), theme };
      await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] theme: could not save the theme setting:", (e && e.message) || e);
    }
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] theme:", theme);
  }

  function wireControls() {
    for (const choice of CHOICES) {
      const el = document.getElementById("setting-theme-" + choice);
      if (!el) continue;
      el.addEventListener("change", () => {
        if (el.checked) setTheme(choice);
      });
    }
    render();
  }

  function subscribe() {
    // A second panel window (or the same panel in another Chrome window) may
    // have changed the theme; follow it rather than fighting it.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[SETTINGS_KEY]) return;
      const next = readTheme(changes[SETTINGS_KEY].newValue);
      if (next === current) return;
      apply(next);
      render();
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] theme: another window switched to", next);
    });
  }

  async function load() {
    try {
      const res = (await chrome.storage.local.get(SETTINGS_KEY)) || {};
      apply(readTheme(res[SETTINGS_KEY]));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] theme: could not read the theme setting:", (e && e.message) || e);
    }
    render();
  }

  function whenDomReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  // In the panel, chrome.storage is there before this file runs. Guard anyway:
  // this file is deliberately the first script on the page, and a context that
  // hasn't got the API yet must still end up with a working panel on the
  // default theme.
  if (self.chrome && chrome.storage && chrome.storage.local) {
    load();
    subscribe();
  }
  whenDomReady(wireControls);
})();
