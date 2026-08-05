// sidepanel.js — the side panel replaces the old toolbar popup.
//
// Two independent concerns live here, each with its own state object and render
// function: the captured-prospect card (ported from popup.js) and the HubSpot
// connection (Phase 2). They share nothing but the document.
//
// Differences from popup.js that matter: the panel document stays open while the
// rep moves between the Nooks and scheduler tabs, so it cannot read storage once
// and be done. It reads storage at load (the source of truth — anything that
// happened while the panel was closed is only visible there), then subscribes to
// chrome.storage.onChanged and re-renders live, and ticks a timer so the capture
// age line stays honest without a user action.
//
// Plain script (no import/export) on purpose: CI syntax-checks .js with
// `node --check`, which parses them as CommonJS. hubspot-config.js and
// hubspot-auth.js load before this file and hand it `window.EB`.

(() => {
  "use strict";

  const STORAGE_KEY = "eb:currentProspect";
  const MAX_AGE_MS = 30 * 60 * 1000; // keep in sync with background.js / content-scheduler.js
  const TICK_MS = 30 * 1000; // how often the capture-age line is refreshed
  const NOTICE_MS = 4000; // how long a transient status message replaces the age line
  const SCHEDULER_URL_RE = /^https:\/\/scheduler\.default\.com\//;

  const headerEl = document.getElementById("header");
  const capturedEl = document.getElementById("captured");
  const emptyEl = document.getElementById("empty");
  const emailEl = document.getElementById("email");
  const tzFieldEl = document.getElementById("tz-field");
  const tzEl = document.getElementById("tz");
  const tzSubEl = document.getElementById("tz-sub");
  const metaEl = document.getElementById("meta");
  const fillBtn = document.getElementById("fill");

  // Single source of render truth: the stored payload plus an optional transient
  // notice (which the age ticker must not clobber mid-message).
  const state = { payload: null, notice: null };
  let noticeTimer = null;

  function fmtOffset(min) {
    if (min == null) return "";
    const sign = min < 0 ? "-" : "+";
    const a = Math.abs(min);
    const h = Math.floor(a / 60);
    const m = a % 60;
    return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
  }

  // View states: "no-prospect" | "live" | "stale".
  function viewOf(payload) {
    if (!payload || !payload.email) return "no-prospect";
    if (payload.capturedAt && Date.now() - payload.capturedAt > MAX_AGE_MS) return "stale";
    return "live";
  }

  function ageText(payload) {
    if (!payload.capturedAt) return "captured from Nooks";
    const ageMin = Math.round((Date.now() - payload.capturedAt) / 60000);
    if (Date.now() - payload.capturedAt > MAX_AGE_MS) return `captured ${ageMin}m ago — may be stale`;
    return ageMin <= 0 ? "captured just now" : `captured ${ageMin}m ago`;
  }

  function render(s) {
    const view = viewOf(s.payload);
    const hasProspect = view !== "no-prospect";
    const payload = s.payload;

    capturedEl.style.display = hasProspect ? "" : "none";
    emptyEl.style.display = hasProspect ? "none" : "";
    // A stale capture can still be filled — the nudge below re-stamps it — so
    // the button stays live whenever there is a prospect at all.
    fillBtn.disabled = !hasProspect;
    headerEl.classList.toggle("live", view === "live");
    if (!hasProspect) return;

    emailEl.textContent = payload.email;

    // Timezone: prefer a clear abbreviation + offset; show the prospect's local
    // clock as a secondary line. The scheduler resolves this to Default's zone.
    const hasTz = payload.tzAbbr || payload.timezone || payload.tzOffsetMin != null;
    tzFieldEl.style.display = hasTz ? "" : "none";
    if (hasTz) {
      const off = fmtOffset(payload.tzOffsetMin);
      const main = [payload.tzAbbr || payload.timezone, off].filter(Boolean).join(" · ");
      tzEl.textContent = main || "—";
      const localTime = payload.timezoneRaw && (payload.timezoneRaw.match(/\(([^)]+)\)/) || [])[1];
      tzSubEl.textContent = localTime ? `${localTime} their time` : "";
      tzSubEl.style.display = localTime ? "" : "none";
    }

    metaEl.classList.toggle("stale", !s.notice && view === "stale");
    metaEl.textContent = s.notice || ageText(payload);
  }

  function setNotice(text) {
    state.notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      state.notice = null;
      render(state);
    }, NOTICE_MS);
    render(state);
  }

  // A new prospect can land under an already-open panel; drop any stale notice
  // when that happens. A same-prospect write (our own "Fill now" nudge, which
  // only re-stamps capturedAt) must NOT clear the notice it just set — the
  // onChanged listener fires for our own writes too.
  function setPayload(payload) {
    const prevEmail = state.payload && state.payload.email;
    const nextEmail = payload && payload.email;
    state.payload = payload || null;
    if (nextEmail !== prevEmail) {
      state.notice = null;
      clearTimeout(noticeTimer);
    }
    render(state);
  }

  // 1) Storage first — the panel may have been closed when the capture happened.
  chrome.storage.local.get(STORAGE_KEY, (res) => setPayload(res && res[STORAGE_KEY]));

  // 2) Then live updates for as long as the panel is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue;
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] side panel: prospect updated ->", (next && next.email) || "(cleared)");
    setPayload(next);
  });

  // 3) Keep the age line (and the stale flip) honest without any interaction.
  setInterval(() => render(state), TICK_MS);

  // 4) Manual fill: nudge storage so the scheduler content script re-applies.
  fillBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !SCHEDULER_URL_RE.test(tab.url || "")) {
      setNotice("Open the booking tab first, then click again.");
      return;
    }
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const payload = res[STORAGE_KEY];
    if (payload) {
      await chrome.storage.local.set({
        [STORAGE_KEY]: { ...payload, capturedAt: Date.now() },
      });
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] side panel: fill nudge sent for", payload.email);
      setNotice("Fill triggered.");
    }
  });

  // ==========================================================================
  // HubSpot connection (Phase 2)
  //
  // States: "setup-needed" (client id/secret placeholders still in
  // hubspot-config.js) → "signed-out" → "connecting" → "connected". `error` is
  // an overlay on whichever state we're in, not a state of its own, so a failed
  // attempt leaves the SDR looking at a usable "Connect" button.
  // ==========================================================================
  const auth = self.EB && self.EB.hubspotAuth;

  const hsPillEl = document.getElementById("hs-pill");
  const hsHintEl = document.getElementById("hs-hint");
  const hsAccountEl = document.getElementById("hs-account");
  const hsEmailEl = document.getElementById("hs-email");
  const hsConnectBtn = document.getElementById("hs-connect");
  const hsDisconnectBtn = document.getElementById("hs-disconnect");
  const hsErrorEl = document.getElementById("hs-error");

  const hs = { status: "signed-out", email: null, error: null };

  const HS_PILL_TEXT = {
    "setup-needed": "Setup needed",
    "signed-out": "Not connected",
    connecting: "Connecting…",
    connected: "Connected",
  };

  function renderHubSpot() {
    const connected = hs.status === "connected";
    const connecting = hs.status === "connecting";
    const setupNeeded = hs.status === "setup-needed";

    hsPillEl.textContent = HS_PILL_TEXT[hs.status] || HS_PILL_TEXT["signed-out"];
    // Green (the default .pill) only when actually connected.
    hsPillEl.className = "pill" + (connected ? "" : setupNeeded ? " warn" : " off");

    hsHintEl.style.display = connected ? "none" : "";
    hsHintEl.textContent = setupNeeded
      ? "Add CLIENT_ID and CLIENT_SECRET to hubspot-config.js, then reload the extension."
      : "Connect your HubSpot account to see CRM context here.";

    hsAccountEl.style.display = connected ? "" : "none";
    // Identity comes from a best-effort introspect call, so a connection
    // without an email is possible and must still read sensibly.
    hsEmailEl.textContent = hs.email || "Connected to HubSpot";

    hsConnectBtn.style.display = connected ? "none" : "";
    hsConnectBtn.disabled = connecting || setupNeeded;
    hsConnectBtn.textContent = connecting ? "Connecting…" : "Connect HubSpot";
    hsDisconnectBtn.disabled = connecting;

    hsErrorEl.style.display = hs.error ? "" : "none";
    hsErrorEl.textContent = hs.error || "";
  }

  function setHubSpot(patch) {
    Object.assign(hs, patch);
    renderHubSpot();
  }

  function statusFor(authState) {
    if (!authState.configured) return "setup-needed";
    return authState.connected ? "connected" : "signed-out";
  }

  function hsErrorText(e) {
    const code = e && e.code;
    if (code === "CANCELLED") return "Connection cancelled.";
    if (code === "NOT_CONNECTED") return "HubSpot connection expired — connect again.";
    if (code === "STATE_MISMATCH") return "Connection failed a security check. Try again.";
    if (code === "CONFIG_MISSING") return "HubSpot client ID/secret missing in hubspot-config.js.";
    return (e && e.message) || "Something went wrong connecting to HubSpot.";
  }

  async function refreshHubSpotState() {
    if (!auth) {
      setHubSpot({ status: "setup-needed", error: "hubspot-auth.js failed to load." });
      return;
    }
    try {
      const authState = await auth.getAuthState();
      setHubSpot({
        status: statusFor(authState),
        email: authState.userEmail,
        error: null,
      });
    } catch (e) {
      setHubSpot({ error: hsErrorText(e) });
    }
  }

  if (auth) {
    hsConnectBtn.addEventListener("click", async () => {
      setHubSpot({ status: "connecting", error: null });
      try {
        const authState = await auth.login();
        setHubSpot({
          status: statusFor(authState),
          email: authState.userEmail,
          error: null,
        });
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] HubSpot connected as", authState.userEmail || "(email unknown)");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] HubSpot connect failed:", (e && e.code) || "", e && e.message);
        // Re-read rather than assuming signed-out: login() persists the refresh
        // token before the identity lookups, so a late failure can still leave
        // us genuinely connected.
        await refreshHubSpotState();
        setHubSpot({ error: hsErrorText(e) });
      }
    });

    hsDisconnectBtn.addEventListener("click", async () => {
      try {
        await auth.logout();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] HubSpot disconnect failed:", e && e.message);
      }
      setHubSpot({ status: "signed-out", email: null, error: null });
    });

    // A second window has its own panel document; keep them in agreement.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[auth.AUTH_KEY]) refreshHubSpotState();
    });
  }

  renderHubSpot();
  refreshHubSpotState();
})();
