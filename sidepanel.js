// sidepanel.js — the side panel replaces the old toolbar popup.
//
// Four concerns live here, each with its own state object and render function:
// the captured-prospect card (ported from popup.js), the settings popover, the
// HubSpot connection (Phase 2), and the live CRM context — contact, company,
// deals, activity (Phase 3). They share the document and one signal: whether
// HubSpot is connected.
//
// The settings popover owns both chrome-level actions: Refresh, and the whole
// HubSpot connection UI. Nothing about the connection lives in the panel body
// any more — the header's second dot is the only always-visible signal.
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
  const CONTEXT_KEY = "eb:prospectContext"; // written by content-nooks.js (Phase 3)
  const MAX_AGE_MS = 30 * 60 * 1000; // keep in sync with background.js / content-scheduler.js
  const TICK_MS = 30 * 1000; // how often the capture-age line is refreshed
  const NOTICE_MS = 4000; // how long a transient status message replaces the age line
  // A prospect change can write eb:prospectContext several times in a row as the
  // Nooks HubSpot panes hydrate; coalesce those into one CRM fetch.
  const CRM_DEBOUNCE_MS = 500;
  const SCHEDULER_URL_RE = /^https:\/\/scheduler\.default\.com\//;

  const headerEl = document.getElementById("header");
  const capturedEl = document.getElementById("captured");
  const emptyEl = document.getElementById("empty");
  // The booking cluster's fallback home and the rule under it. Both are hidden
  // while the cluster lives in the Contact column — see mountBooking.
  const prospectSectionEl = document.getElementById("prospect");
  const bookingDividerEl = document.getElementById("booking-divider");
  const emailEl = document.getElementById("email");
  const tzEl = document.getElementById("tz");
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
    if (!payload.capturedAt) return "captured from dialer";
    const ageMin = Math.round((Date.now() - payload.capturedAt) / 60000);
    if (Date.now() - payload.capturedAt > MAX_AGE_MS) return `captured ${ageMin}m ago — may be stale`;
    return ageMin <= 0 ? "captured just now" : `captured ${ageMin}m ago`;
  }

  // The booking cluster is ONE node with two homes: the Contact column of
  // Contact & company when there is a matched record to sit inside, and its own
  // #prospect section above the sections otherwise. It is moved, never rebuilt —
  // so the fill behaviour, the disabled/stale states, #meta's live region and
  // the capture-age tooltip are the same DOM wherever it is showing.
  //
  // Load-order note, and the reason this is a move rather than a second
  // renderer: the cluster is driven by eb:currentProspect and must keep working
  // when the CRM bundle is stale, absent, or the rep is signed out entirely —
  // email, their-time and Fill are the original v0.2 workflow and they do not
  // depend on HubSpot.
  function mountBooking(host, before) {
    const target = host || prospectSectionEl;
    // In its fallback home it always sits above the "no prospect" empty state.
    const anchor = target === prospectSectionEl ? emptyEl : before || null;
    if (capturedEl.parentElement !== target || (anchor && capturedEl.nextSibling !== anchor)) {
      target.insertBefore(capturedEl, anchor);
    }
    syncProspectShell();
  }

  // Nothing left in the fallback block → no block, and no rule under it. (The
  // "no prospect captured" empty state lives there too, and keeps it.)
  function syncProspectShell() {
    const atHome = capturedEl.parentElement === prospectSectionEl;
    const shows =
      (atHome && capturedEl.style.display !== "none") || emptyEl.style.display !== "none";
    prospectSectionEl.hidden = !shows;
    if (bookingDividerEl) bookingDividerEl.hidden = !shows;
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
    if (!hasProspect) {
      capturedEl.removeAttribute("title");
      syncProspectShell();
      return;
    }

    emailEl.textContent = payload.email;

    // The zone: its abbreviation, the UTC offset, then the prospect's own clock
    // — the number a dialer actually acts on. Three discrete facts, so three
    // spans spaced by the row's gap: no separator glyph, nothing in the
    // accessibility tree that isn't a value. The full zone name and the capture
    // age are the block's hover detail, because neither changes a decision.
    const localTime = payload.timezoneRaw && (payload.timezoneRaw.match(/\(([^)]+)\)/) || [])[1];
    const zone = [payload.tzAbbr || payload.timezone, fmtOffset(payload.tzOffsetMin)].filter(Boolean);
    // clearNode/el are the shared builders declared further down this IIFE
    // (hoisted function declarations), so the same textContent-only rule that
    // covers every CRM value covers the captured payload too.
    clearNode(tzEl);
    for (const part of zone) tzEl.appendChild(el("span", null, part));
    if (localTime) tzEl.appendChild(el("span", "bk-local", `${localTime} their time`));
    if (!zone.length && !localTime) tzEl.textContent = "Timezone unknown";

    // The standing "captured Nm ago" line is hover detail; it only comes back
    // as a line when it is a warning (a stale capture) or a fill result.
    const stale = view === "stale";
    capturedEl.title = [
      payload.timezone && payload.timezone !== payload.tzAbbr ? payload.timezone : null,
      ageText(payload),
    ]
      .filter(Boolean)
      .join(" — ");
    metaEl.classList.toggle("stale", !s.notice && stale);
    metaEl.hidden = !(s.notice || stale);
    metaEl.textContent = s.notice || (stale ? ageText(payload) : "");
    syncProspectShell();
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
  // Settings popover
  //
  // Holds the two things that aren't per-prospect context: Refresh, and the
  // HubSpot connection controls. One open/closed boolean, expressed as the
  // dialog's `hidden` attribute so there is no second source of truth.
  //
  // Dismissal: Escape from anywhere in the document, or a pointer-down outside
  // the dialog. Focus is kept inside while it's open (Tab wraps) and handed back
  // to the gear on close, so a keyboard rep is never dropped somewhere random.
  // ==========================================================================
  const settingsBtn = document.getElementById("settings-btn");
  const settingsPop = document.getElementById("settings-pop");
  const settingsCloseBtn = document.getElementById("settings-close");

  const FOCUSABLE_SEL =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  // Deliberately not offsetParent/getBoundingClientRect: this has to give the
  // same answer under a test harness with no layout engine as it does in Chrome,
  // and everything in the popover is hidden by `hidden` or `display: none`.
  function isReachable(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden) return false;
      if (n.style && n.style.display === "none") return false;
    }
    return true;
  }

  function settingsFocusables() {
    return Array.prototype.filter.call(
      settingsPop.querySelectorAll(FOCUSABLE_SEL),
      (n) => !n.disabled && isReachable(n)
    );
  }

  const settingsIsOpen = () => !settingsPop.hidden;

  function openSettings() {
    if (settingsIsOpen()) return;
    settingsPop.hidden = false;
    settingsBtn.setAttribute("aria-expanded", "true");
    const first = settingsFocusables()[0];
    if (first) first.focus();
  }

  // restoreFocus is skipped for outside clicks: the rep is already reaching for
  // something else, and yanking focus back to the gear would fight them.
  function closeSettings(restoreFocus) {
    if (!settingsIsOpen()) return;
    settingsPop.hidden = true;
    settingsBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus !== false) settingsBtn.focus();
  }

  function toggleSettings() {
    if (settingsIsOpen()) closeSettings();
    else openSettings();
  }

  settingsBtn.addEventListener("click", toggleSettings);
  settingsCloseBtn.addEventListener("click", () => closeSettings());

  document.addEventListener("keydown", (ev) => {
    if (!settingsIsOpen()) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeSettings();
      return;
    }
    if (ev.key !== "Tab") return;
    // Focus trap. The stops change as the connection state does (Connect vs
    // Disconnect, Refresh enabled or not), so the list is rebuilt per keypress
    // rather than cached at open time.
    const items = settingsFocusables();
    if (!items.length) return;
    ev.preventDefault();
    const at = items.indexOf(document.activeElement);
    let next;
    if (ev.shiftKey) next = at <= 0 ? items.length - 1 : at - 1;
    else next = at === -1 || at === items.length - 1 ? 0 : at + 1;
    items[next].focus();
  });

  // mousedown rather than click: a press outside should dismiss even if the
  // button is released elsewhere (a drag, a text selection). The gear is excluded
  // so its own click still toggles instead of closing-then-reopening.
  document.addEventListener("mousedown", (ev) => {
    if (!settingsIsOpen()) return;
    const target = ev.target;
    if (settingsPop.contains(target) || settingsBtn.contains(target)) return;
    closeSettings(false);
  });

  // ==========================================================================
  // HubSpot connection (Phase 2)
  //
  // States: "setup-needed" (client id / token service URL never filled in) →
  // "signed-out" → "connecting" → "connected". `error` is an overlay on
  // whichever state we're in, not a state of its own, so a failed attempt leaves
  // the SDR looking at a usable "Connect" button.
  //
  // All four render inside the settings popover. The header dot is their
  // summary: green connected, amber anything else, with the detail in its
  // tooltip.
  //
  // Copy rule for every message below: say what happened and what to do about
  // it, in the rep's words. Error codes, HTTP statuses, file names and HubSpot's
  // own error bodies go to console.debug, never to the panel.
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

  // The tone each connection state carries. Semantic, not decorative: connected
  // is the only good outcome, "connecting" is in-flight, and both of the other
  // two mean the CRM sections below have nothing to show — so neither may read
  // as neutral.
  const HS_PILL_TONE = {
    "setup-needed": "tone-negative",
    "signed-out": "tone-caution",
    connecting: "tone-info",
    connected: "tone-positive",
  };

  function renderHubSpot() {
    const connected = hs.status === "connected";
    const connecting = hs.status === "connecting";
    const setupNeeded = hs.status === "setup-needed";

    // The header's connection dot is gone (it was a 7px signal nobody read), so
    // this badge is the panel's explicit statement of connection state: a tone
    // and a dot of its own, on a line that names what it is about.
    hsPillEl.textContent = HS_PILL_TEXT[hs.status] || HS_PILL_TEXT["signed-out"];
    hsPillEl.className =
      "pill conn " + (HS_PILL_TONE[hs.status] || HS_PILL_TONE["signed-out"]);
    hsPillEl.title = connected
      ? hs.email
        ? `HubSpot connected as ${hs.email}`
        : "HubSpot connected"
      : connecting
        ? "Connecting to HubSpot…"
        : setupNeeded
          ? "HubSpot isn't set up in this build"
          : "HubSpot not connected — connect below to see CRM context";

    hsHintEl.style.display = connected ? "none" : "";
    hsHintEl.textContent = setupNeeded
      ? "HubSpot isn't set up in this build yet. Reload the extension, and tell the team if it stays like this."
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
    // The CRM sections below need to know whether they can fetch. This is the
    // only coupling between the two concerns. (crmOnAuth is a hoisted function
    // declaration; every call path reaches it after the CRM block has run.)
    crmOnAuth(hs.status === "connected");
  }

  function statusFor(authState) {
    if (!authState.configured) return "setup-needed";
    return authState.connected ? "connected" : "signed-out";
  }

  // Rep-facing text for a typed HubSpotAuthError. The raw code, HTTP status and
  // the token service's own error slug are logged by the caller — none of them
  // belong on screen, where they only ever read as "something broke, unclear
  // whose fault".
  function hsErrorText(e) {
    const code = e && e.code;
    if (code === "CANCELLED") return "Connection cancelled.";
    if (code === "NOT_CONNECTED") return "HubSpot connection expired — connect again.";
    if (code === "STATE_MISMATCH") return "Connection failed a security check. Try again.";
    if (code === "CONFIG_MISSING") {
      return "HubSpot isn't set up in this build. Reload the extension, and tell the team if it stays like this.";
    }
    // The token service refused us rather than HubSpot — nothing the rep did, and
    // nothing they can fix, so point them at the team instead of at a setting.
    if (code === "PROXY_ERROR") {
      return "Couldn't sign in to HubSpot — the connection service turned us away. Try again in a moment, and tell the team if it keeps happening.";
    }
    if (code === "REFRESH_FAILED" || code === "EXCHANGE_FAILED") {
      return "Couldn't reach HubSpot to finish signing in. Try again in a moment.";
    }
    if (code === "DENIED") return "HubSpot didn't approve the connection. Try again.";
    return "Couldn't connect to HubSpot. Try again in a moment.";
  }

  // One place that turns an auth failure into console detail + panel copy, so the
  // two can't drift apart.
  function logHsError(where, e) {
    // eslint-disable-next-line no-console
    console.debug(
      "[EasyBooking] HubSpot " + where + " failed:",
      (e && e.code) || "?",
      (e && e.proxyError) || "",
      (e && e.message) || e
    );
  }

  async function refreshHubSpotState() {
    if (!auth) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] hubspot-auth.js did not load — HubSpot is unavailable.");
      setHubSpot({
        status: "setup-needed",
        error: "HubSpot isn't available in this build. Reload the extension, and tell the team if it stays like this.",
      });
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
      logHsError("state check", e);
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
        logHsError("connect", e);
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
        // Local token removal is best-effort; the panel signs out regardless, so
        // there is nothing for the rep to act on here.
        logHsError("disconnect", e);
      }
      setHubSpot({ status: "signed-out", email: null, error: null });
    });

    // A second window has its own panel document; keep them in agreement.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[auth.AUTH_KEY]) refreshHubSpotState();
    });
  }

  // ==========================================================================
  // CRM context — identity block, Account context, Others at this account, Wiza
  // product data, Deals, Activity.
  //
  // Phase 8 added the dialing-decision bits: labelled ownership (outbound owner
  // first — see the owner rows in renderIdentitySection), one-click LinkedIn, sequence state, the account
  // context section, and the closed-deal outcome line. Phase 9 added the
  // colleague list ("who else are we touching here"). All of it renders from
  // view-models on the same bundle; nothing here fetches.
  //
  // Input is "eb:prospectContext" (email + identity + the HubSpot record IDs
  // content-nooks.js scraped from the Nooks panes), with "eb:currentProspect"'s
  // email as a fallback for captures made before this phase shipped. Fetching
  // and caching live in hubspot-data.js; this is rendering and state.
  //
  // Every value written here goes through textContent. HubSpot property values
  // are user-authored and untrusted — no innerHTML, ever.
  // ==========================================================================
  const data = self.EB && self.EB.hubspotData;
  const fmt = data && data.format;

  if (!data) {
    // Logged once here rather than from crmRender, which runs on every change.
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] hubspot-data.js did not load — CRM sections are unavailable.");
  }

  const crmEls = {
    refresh: document.getElementById("crm-refresh"),
    refreshNote: document.getElementById("crm-refresh-note"),
    identity: document.getElementById("crm-identity"),
    identityPill: document.getElementById("crm-identity-pill"),
    // Account context (Phase 8). The section element itself is held because this
    // is the one section that hides entirely when the company has nothing worth
    // a card.
    accountSection: document.getElementById("crm-account-section"),
    account: document.getElementById("crm-account"),
    accountPill: document.getElementById("crm-account-pill"),
    // Others at this account (Phase 9). Like Account context this section hides
    // itself outright — here when the prospect has no company at all — and its
    // count lives in the title rather than a pill, because "Others at this
    // account (4)" is the whole headline.
    colleaguesSection: document.getElementById("crm-colleagues-section"),
    colleaguesTitle: document.getElementById("crm-colleagues-title"),
    colleaguesOwner: document.getElementById("crm-colleagues-owner"),
    colleagues: document.getElementById("crm-colleagues"),
    // Wiza and Deals join Account context and Others-at-this-account in hiding
    // outright when they have nothing to say (the density pass): a "No
    // open deals" card is 55px of the panel spent on a non-answer.
    wizaSection: document.getElementById("crm-wiza-section"),
    wiza: document.getElementById("crm-wiza"),
    wizaPill: document.getElementById("crm-wiza-pill"),
    dealsSection: document.getElementById("crm-deals-section"),
    deals: document.getElementById("crm-deals"),
    dealsPill: document.getElementById("crm-deals-pill"),
    activity: document.getElementById("crm-activity"),
    activityPill: document.getElementById("crm-activity-pill"),
    activityTabs: document.getElementById("crm-activity-tabs"),
  };
  const crmBodies = [
    crmEls.identity,
    crmEls.account,
    crmEls.colleagues,
    crmEls.wiza,
    crmEls.deals,
    crmEls.activity,
  ];

  // status: "idle" (nothing to show) | "loading" | "ready" | "error"
  const crm = {
    ctx: null, // eb:prospectContext
    fallbackEmail: null, // eb:currentProspect
    connected: false,
    status: "idle",
    bundle: null,
    error: null, // { code, message, retryAfterMs }
    retrySecs: null, // counts down while rate limited
    lastKey: null, // email|contactId|companyId of the last fetch we started
    // Which Activity tab is open. Lives for the life of the panel document, so a
    // rep who works the Calls tab keeps it as they move between prospects; it
    // falls back to "All" whenever the chosen type has no rows for the prospect
    // in front of them (see EB.hubspotData.activity.resolveTab).
    activeTab: "all",
  };

  // One outline icon per engagement type, as SVG path data. Our own constants —
  // never a value from a record — drawn at 2px stroke in an 18px tinted disc (see
  // .act-icon). They replace the old text glyphs (☎ ✉ ◷ ✎ ✓), which rendered at a
  // different size and weight on every platform. The fallback is a plain dot, for
  // an engagement type a portal admin adds after this ships.
  const ACT_ICON = {
    calls: ["M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2 4.6 1v3.4a2 2 0 0 1-2.2 2A19 19 0 0 1 3.4 5.2 2 2 0 0 1 5.4 3h3.4l1 4.6z"],
    emails: ["M3 6h18v12H3z", "M3.6 6.6 12 13l8.4-6.4"],
    meetings: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18", "M12 7.5V12l3 2"],
    notes: ["M4.5 19.5h3.5L18 9a2 2 0 0 0-2.8-2.8L4.5 16.5z", "M13.6 5.4 18.6 10.4"],
    tasks: ["M20 6.5 9.5 17 4.5 12"],
    fallback: ["M12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8"],
  };

  // Inline SVG, built node by node: the panel's no-innerHTML rule is absolute,
  // so createElementNS is the only way an icon gets into the document from JS.
  // The static section-head glyphs are markup in sidepanel.html for the same
  // reason. Always decorative — whatever the icon sits next to is the label.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(paths) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  // --- tiny DOM builders ---------------------------------------------------
  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null && text !== "") node.textContent = String(text);
    return node;
  }

  // A HubSpot deep link when we have an ID to link to, plain text otherwise.
  // href is built from a digits-only record ID in hubspot-data.js, never from a
  // property value.
  function recordLink(text, href, className) {
    if (!href) return el("span", className, text);
    const a = el("a", className, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // --- record tiles --------------------------------------------------------
  // A 20px tile in front of a company or a person. It exists because a column of
  // names is the hardest thing on this screen to scan, and a logo (or two
  // initials in a coloured square) is recognised before a word is read.
  //
  // Companies get their favicon from Google's favicon service — the ONE
  // third-party request this panel makes, and it sends nothing but the company's
  // domain. Documented in the README's privacy section. Everything else, and any
  // failure, falls back to initials: a broken-image glyph must never appear.
  const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

  // Only a bare hostname is ever interpolated, and it is escaped even then: this
  // is a CRM property, so it is untrusted like every other one.
  function faviconUrl(domain) {
    const d = String(domain == null ? "" : domain)
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");
    if (!d || d.length > 253 || !DOMAIN_RE.test(d)) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`;
  }

  // Two letters for a person, one for a company: enough to tell four colleagues
  // apart, and it can never wrap inside the tile.
  function initialsOf(name, kind) {
    const words = String(name == null ? "" : name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    if (kind === "company") return words[0].charAt(0).toUpperCase();
    const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
    return (words[0].charAt(0) + last).toUpperCase();
  }

  // Deterministic, so the same person keeps the same tile across renders and
  // across prospects. Three purples from the scale, each with a label colour
  // that passes AA at 9px — the classes carry the values (see .tile-* in
  // sidepanel.html); nothing here knows a colour.
  const TILE_CLASSES = ["tile-a", "tile-b", "tile-c"];
  function tileClassFor(name) {
    const s = String(name == null ? "" : name);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003;
    return TILE_CLASSES[h % TILE_CLASSES.length];
  }

  // `extra` carries the size/shape modifiers (see .tile-lg / .tile-md /
  // .tile-round in sidepanel.html); the fill class is always chosen from the name.
  function initialsTile(name, kind, extra) {
    const cls = ["tile"].concat(extra || []).concat(tileClassFor(name)).join(" ");
    const node = el("span", cls, initialsOf(name, kind));
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  // https only, and only ever assigned to img.src / a.href. LinkedIn photo URLs
  // arrive from the dialer page (content-nooks.js scraped them), so they are
  // untrusted input like every CRM property.
  function httpsUrl(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s || !/^https:\/\//i.test(s)) return null;
    try {
      return new URL(s).protocol === "https:" ? new URL(s).href : null;
    } catch (_) {
      return null;
    }
  }

  // `size` is the tile's class modifier: the contact's photo is the biggest thing
  // in the card (a 36px circle), the company logo a 28px rounded square, and a
  // colleague row keeps the base 20px.
  // Initials are what gets RENDERED; a remote image only ever replaces them once
  // it has actually decoded. That ordering is the whole trick:
  //   - a pending request paints initials, not an empty box (a favicon or a
  //     LinkedIn CDN photo can take a second, or hang);
  //   - a failed one paints initials and stays that way — there is no
  //     broken-image glyph and no error state to recover from;
  //   - a response that arrives after the section re-rendered is dropped, so a
  //     photo can never land on the next prospect's card.
  // Both are decorative either way: the name is right beside them.
  function tileNode(name, kind, url, size) {
    const mods = [size, kind === "person" ? "tile-round" : null].filter(Boolean);
    const tile = initialsTile(name, kind, mods);
    if (!url) return tile;
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    // No inline handler: MV3's CSP forbids them.
    img.addEventListener("load", () => {
      if (!tile.parentNode) return; // re-rendered while the image was in flight
      const shown = el("span", ["tile"].concat(mods).concat("tile-logo").join(" "));
      shown.setAttribute("aria-hidden", "true");
      shown.appendChild(img);
      tile.parentNode.replaceChild(shown, tile);
    });
    img.src = url;
    return tile;
  }

  // The two tile sources are deliberately separate functions with separate
  // inputs, and they must stay that way: company imagery is only ever valid on a
  // company row. A person's tile is their photo or their initials — never a
  // logo, never a favicon, never a stand-in image of any kind.

  // Company: the favicon service, from the company's own domain.
  function companyTile(name, domain) {
    return tileNode(name, "company", faviconUrl(domain), "tile-md");
  }

  // Contact: the photo the dialer captured from the LinkedIn card, and otherwise
  // their initials. content-nooks.js only sets photoUrl when the image is
  // positively a person's photo (it rejects the card's company logos and ghost
  // placeholders), so initials are the COMMON case here, not a failure state —
  // which is why they get the largest tile in the panel and a real colour rather
  // than a grey placeholder. The favicon host is rejected outright as a
  // belt-and-braces guard: a company logo must never end up on a person.
  function contactTile(name, photoUrl) {
    const url = httpsUrl(photoUrl);
    const person = url && !/^https:\/\/www\.google\.com\/s2\/favicons/.test(url) ? url : null;
    return tileNode(name, "person", person, "tile-lg");
  }

  // The LinkedIn glyph, as a link. Outline style at the same 2px stroke as every
  // other icon in the panel rather than the brand lockup — it sits inside a
  // sentence-sized row and has to read at 14px.
  const LINKEDIN_PATHS = [
    "M4.5 3.5h15a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z",
    "M8 10.6v6",
    "M8 7.7v0.01",
    "M12 16.6v-6",
    "M12 13.2a2.6 2.6 0 0 1 5.2 0v3.4",
  ];
  function linkedInGlyphLink(url, label) {
    const href = httpsUrl(url);
    if (!href) return null;
    const a = el("a", "li-glyph");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = label || "LinkedIn profile";
    a.setAttribute("aria-label", label || "LinkedIn profile");
    a.appendChild(svgIcon(LINKEDIN_PATHS));
    return a;
  }

  // An external link built from a CRM URL property. hubspot-data.js has already
  // rejected anything that isn't http(s), so href can never be a javascript:
  // URL — but the value is still only ever set through .href, never markup.
  function extLink(text, href) {
    if (!href) return null;
    const a = el("a", "link", text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  // --- stat chips ----------------------------------------------------------
  // The panel's one labelled-datapoint idiom: a muted ALL-CAPS label over a
  // bold value, in a rounded box of page white on the card's grey fill. It
  // replaced the label-left inline rows because a rep scanning for "how big is
  // their sales team" finds a labelled box faster than a word in a sentence.
  //
  // A datapoint with no value renders NO chip — never an empty box. `tone` puts
  // a semantic tone on the VALUE only (the label is always muted), which is how
  // a status keeps its meaning without becoming a second pill.
  function chip(label, value, opts) {
    const o = opts || {};
    const text = value == null ? "" : String(value);
    if (!text) return null;
    const node = el("div", "chip");
    node.appendChild(el("span", "chip-label", label));
    node.appendChild(el("span", o.tone ? `chip-value tone-${o.tone}` : "chip-value", text));
    if (o.title) node.title = o.title;
    return node;
  }

  // Chips flow in a wrapping row and size to their content. Null chips (the
  // datapoints this record doesn't have) are dropped here, so a caller can list
  // every possible chip and let the record decide which ones exist.
  function chipRow(chips) {
    const kept = (chips || []).filter(Boolean);
    if (!kept.length) return null;
    const row = el("div", "chips");
    for (const c of kept) row.appendChild(c);
    return row;
  }

  // hubspot-data.js composes a few multi-part values with an interpunct
  // ("Connected · 3:34", "Lost: price · Competitor"). The panel prints
  // structure, never a separator glyph, so the parts are split back apart here:
  // `factParts` for a row of spans, `joinParts` for the one place a single value
  // has to stay a string (a title attribute).
  const PART_SPLIT = /\s*·\s*/;
  const factParts = (text) =>
    String(text == null ? "" : text)
      .split(PART_SPLIT)
      .map((s) => s.trim())
      .filter(Boolean);
  const joinParts = (text) => factParts(text).join(", ");

  // Running prose, clamped to two lines with a toggle for the rest. The full
  // text is always in the DOM — the clamp is CSS — so nothing truncates
  // mid-sentence on screen and nothing is lost to a rep who wants it all.
  //
  // `label` names what is being expanded, for the button's accessible name.
  function proseBlock(fullText, className, label) {
    const value = String(fullText == null ? "" : fullText).trim();
    if (!value) return null;
    const wrap = el("div");
    const p = el("p", className ? `prose ${className}` : "prose", value);
    wrap.appendChild(p);
    const btn = el("button", "prose-more", "More");
    btn.type = "button";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", `Show all of ${label}`);
    btn.addEventListener("click", () => {
      const open = p.classList.toggle("open");
      btn.textContent = open ? "Less" : "More";
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? `Show less of ${label}` : `Show all of ${label}`);
    });
    // The button is only worth a row when the text is actually being clipped.
    // scrollHeight/clientHeight is only meaningful once the node is laid out, so
    // this runs after the caller has appended it (see attachProseToggles).
    wrap.__ebProseToggle = () => {
      if (p.scrollHeight - p.clientHeight > 1) wrap.appendChild(btn);
    };
    return wrap;
  }

  // Second pass over the prose blocks a section just appended: a clamp is only
  // measurable after layout, and a "More" button on unclipped text is a lie.
  function attachProseToggles(root) {
    for (const node of root.children) {
      if (typeof node.__ebProseToggle === "function") node.__ebProseToggle();
    }
  }

  // Out-links live in a row of their own, which is what gives them the compact
  // bordered treatment (see .ident-links in sidepanel.html) — the same shape as
  // the colleague "in" chip, so every out-link in the panel reads as one control
  // type rather than a bare underlined word. Null links evaporate; no links, no
  // row.
  function linkRow(links) {
    const kept = (links || []).filter(Boolean);
    if (!kept.length) return null;
    const row = el("div", "ident-links");
    for (const link of kept) row.appendChild(link);
    return row;
  }

  function appendAll(parent, nodes) {
    let added = 0;
    for (const node of nodes) {
      if (!node) continue;
      parent.appendChild(node);
      added++;
    }
    return added;
  }

  function setNote(body, text, bad) {
    clearNode(body);
    body.appendChild(el("p", bad ? "crm-note bad" : "crm-note", text));
  }

  // The signed-out empty state. Now that the connection UI lives behind a gear,
  // the sections that are empty *because* of it carry the way in — otherwise
  // "Connect HubSpot to see CRM data" names an action with nothing to click.
  function setConnectNote(body) {
    clearNode(body);
    const note = el("p", "crm-note", "Connect HubSpot to see CRM data. ");
    const link = el("button", "linkish inline", "Connect");
    link.type = "button";
    link.addEventListener("click", () => openSettings());
    note.appendChild(link);
    body.appendChild(note);
  }

  // `variant` picks the pill's tone (see the .pill rules in sidepanel.html); it
  // is a class name we choose, never a value from HubSpot. Omit it for the
  // neutral outline — which is what a count gets, because a count is not a
  // state — or pass "" for the bare pill, i.e. the positive tone.
  function setPill(pillEl, text, variant) {
    pillEl.style.display = text ? "" : "none";
    pillEl.className = ("pill " + (variant === undefined ? "info" : variant)).trim();
    pillEl.textContent = text || "";
  }

  function skeleton(body, rows) {
    clearNode(body);
    body.appendChild(el("div", "skel tall mid"));
    for (let i = 1; i < rows; i++) {
      body.appendChild(el("div", "skel " + (i % 2 ? "wide" : "narrow")));
    }
  }

  // --- state helpers -------------------------------------------------------
  const lower = (s) => String(s || "").trim().toLowerCase();

  function crmEmail() {
    return lower((crm.ctx && crm.ctx.email) || crm.fallbackEmail) || null;
  }

  // Record IDs belong to the prospect they were scraped alongside, so they are
  // only used when the context's own email is the one we're looking up.
  function crmCtx() {
    const email = crmEmail();
    if (!email) return null;
    if (crm.ctx && lower(crm.ctx.email) === email) return { ...crm.ctx, email };
    return { email };
  }

  // What the dialer captured from the Nooks LinkedIn card: { photoUrl,
  // profileUrl, headline }, any of them null, the whole object null when Nooks
  // showed no card — and missing outright on a context stored before it shipped.
  // It rides on eb:prospectContext, NOT on the CRM bundle, so it is read straight
  // off the live context here: a late-hydrating LinkedIn card rewrites that key,
  // which re-renders this section even when the bundle is unchanged.
  //
  // Guarded by the email, exactly like the record IDs in crmCtx: a photo belongs
  // to the prospect it was scraped alongside and must never follow the rep onto
  // someone else's record.
  function prospectLinkedIn() {
    const email = crmEmail();
    if (!email || !crm.ctx || lower(crm.ctx.email) !== email) return {};
    return crm.ctx.linkedin || {};
  }

  function crmKeyOf(ctx) {
    if (!ctx) return null;
    return `${ctx.email}|${ctx.hsContactId || ""}|${ctx.hsCompanyId || ""}`;
  }

  // Same copy rule as the connection block: no codes, no HTTP statuses, and the
  // next action named. "Settings" is where both Connect and Refresh now live, so
  // that's where every recovery points.
  function crmErrorText(err) {
    const code = err && err.code;
    if (code === "RATE_LIMITED") {
      const secs = crm.retrySecs == null ? "a few" : crm.retrySecs;
      return `HubSpot rate limit — retrying in ${secs}s`;
    }
    if (code === "AUTH") return "HubSpot sign-in expired — connect again in Settings.";
    // Connected fine, just not allowed to read it. Reconnecting would not help,
    // so the copy must not send the rep round that loop — and the reason is a
    // portal/app permission, which only the team can change.
    if (code === "FORBIDDEN") {
      return "Your HubSpot permissions don't cover this. Tell the team if you need it here.";
    }
    if (code === "NOT_FOUND") return "Nothing to look up for this prospect.";
    return "Couldn't reach HubSpot. Use Refresh in Settings to try again.";
  }

  // Deals and activity can fail on their own without sinking the bundle. `what`
  // names the section, so a permissions message can say what it is the rep can't
  // see instead of leaving them to guess.
  function sectionErrorText(code, retryAfterMs, what) {
    if (code === "RATE_LIMITED") {
      const secs = Math.max(1, Math.round((Number(retryAfterMs) || 10000) / 1000));
      return `HubSpot rate limit — retrying in ${secs}s`;
    }
    if (code === "AUTH") return "HubSpot sign-in expired — connect again in Settings.";
    if (code === "FORBIDDEN") {
      return `Can't read ${what || "this"} — your HubSpot permissions don't cover it.`;
    }
    return "Couldn't load this section. Use Refresh in Settings to try again.";
  }

  // --- section renderers ---------------------------------------------------

  // Ownership (Phase 8). Separately-labelled names, each rendered only when the
  // record has it, with the *outbound* owner prominent: HubSpot's own
  // description of `sdr_company_owner` says to use it for outbound ownership
  // rather than `hubspot_owner_id`, and "who owns prospecting here" is the
  // question this block exists to answer before a rep dials.
  //
  // Every name arrives already resolved from hubspot-data.js (ID-shaped values
  // are looked up, unresolvable ones dropped), so nothing here can print a bare
  // owner ID.
  //
  // Density: on these records one person usually holds every role, so the block
  // was the same name on three lines. Roles are grouped by name now — one name
  // for everything collapses to a single "Owner <name>" line whose title spells
  // out the roles it covers, and only genuinely different names get a line.
  // Sequence context (Phase 8): whether this contact is already being worked,
  // and when anyone last touched them. `line` is null when the portal doesn't
  // say — no line is better than a guess.
  //
  // Density note: the enrolment date used to run on the end of the line ("since
  // Jul 27, 2026") and pushed the whole thing onto a second row at 320px. It is
  // hover detail now — "are they being worked, and when did anyone last touch
  // them" is answered by the name and the relative time alone.
  function sequenceLine(seq) {
    if (!seq || !seq.hasData) return null;
    const row = el("div", "ident-seq");
    if (seq.line) {
      // seq.line already carries "since <date>" when the portal has one; strip
      // it back to the state and keep the date in the title.
      const enrolled = seq.enrolled === true;
      const label = enrolled ? (seq.name ? `In sequence: ${seq.name}` : "In sequence") : seq.line;
      const span = el("span", enrolled ? "seq-on" : null, label);
      if (enrolled && seq.enrolledAt) span.title = `Enrolled ${fmt.date(seq.enrolledAt)}`;
      row.appendChild(span);
    }
    if (seq.lastSequence) {
      const span = el("span", null, `Last sequence: ${seq.lastSequence}`);
      if (seq.lastSequenceAt) span.title = fmt.date(seq.lastSequenceAt);
      row.appendChild(span);
    }
    if (seq.lastContactedAt) {
      const when = el("span", null, `contacted ${fmt.relativeTime(seq.lastContactedAt)}`);
      const exact = fmt.dateTime(seq.lastContactedAt);
      if (exact) when.title = `Last contacted ${exact}`;
      row.appendChild(when);
    }
    return row.childElementCount ? row : null;
  }

  // ==== Wrong-number workflow (Phase 10) ===================================
  // The panel's only write path, and it edits a customer record — so it is
  // deliberately the most cautious control in here.
  //
  // Why it exists: a rep hears "that's not my number" 100+ times a quarter, and
  // the old fix was four tabs (LinkedIn → Wiza thumbs-down → new number →
  // Outreach). HubSpot is the source of truth — data flows HubSpot → Outreach →
  // the dialer, and Outreach cannot write back — so correcting it here is both
  // faster and the *right* place.
  //
  // Rules this UI holds to:
  //   - nothing is written until the rep confirms a second time, with the exact
  //     before → after change spelled out;
  //   - the button is dead unless HubSpot is connected, a real contact ID is
  //     matched, and the number is valid *and* actually different;
  //   - the success line sets honest expectations about propagation delay;
  //   - all validation and the field allowlist live in hubspot-write.js, so this
  //     file only renders decisions it doesn't make.
  //
  // State is per-contact and lives for as long as the panel shows that contact:
  // a prospect change resets it (see renderIdentitySection), and every render
  // rebuilds the editor from it.
  const writeApi = () => (self.EB && self.EB.hubspotWrite) || null;
  const authApiFor = () => (self.EB && self.EB.hubspotAuth) || null;

  const wn = {
    open: false,
    contactId: null, // which contact this state belongs to
    field: null, // allowlisted property key
    value: "", // what's in the input
    touched: false, // the rep has typed: don't refill on a field switch
    armed: false, // one click in; the next one writes
    saving: false,
    result: null, // { kind: "ok" | "err", message, sub }
    host: null, // the container the editor is painted into
    els: null, // the editor's own elements, while it exists
  };

  function wnResetFor(contactId) {
    wn.open = false;
    wn.contactId = contactId || null;
    wn.field = null;
    wn.value = "";
    wn.touched = false;
    wn.armed = false;
    wn.saving = false;
    wn.result = null;
    wn.els = null;
  }

  // The record's current value for one of the three writable fields. Raw, as the
  // portal stores it — a phone number is never reformatted for display.
  function wnCurrent(contact, field) {
    const api = writeApi();
    const key = api ? api.fieldKey(field) : null;
    if (!contact || !key) return "";
    if (key === "phone") return contact.phone || "";
    if (key === "mobilephone") return contact.mobilePhone || "";
    if (key === "phone_number_2") return contact.phone2 || "";
    return "";
  }

  // Default to the number the rep is looking at in the phone row, then to
  // whichever field actually has something, then to the primary.
  function wnDefaultField(contact) {
    if (contact && contact.phone) return "phone";
    if (contact && contact.mobilePhone) return "mobilephone";
    if (contact && contact.phone2) return "phone_number_2";
    return "phone";
  }

  function wnGate(contact) {
    const api = writeApi();
    if (!api) {
      return {
        enabled: false,
        reasons: ["Updating numbers isn't available in this build. Reload the extension."],
        analysis: null,
        note: null,
      };
    }
    return api.updateGate({
      signedIn: crm.connected,
      contactId: contact && contact.id,
      field: wn.field,
      value: wn.value,
      current: wnCurrent(contact, wn.field),
      saving: wn.saving,
    });
  }

  function wnRenderResult(node, result) {
    clearNode(node);
    node.className = "wn-result";
    node.hidden = !result;
    if (!result) return;
    node.className = "wn-result " + (result.kind === "ok" ? "ok" : "err");
    node.appendChild(document.createTextNode(result.message));
    // The expectation-setting half of the success state, muted on its own line.
    if (result.sub) node.appendChild(el("span", "wn-sub", result.sub));
  }

  // Everything that changes as the rep types, switches field, arms the confirm
  // or waits on the request. Deliberately does not rebuild the input or the
  // select, so typing keeps its caret.
  function wnSync(contact) {
    const els = wn.els;
    if (!els) return;
    const api = writeApi();
    const gate = wnGate(contact);
    const current = wnCurrent(contact, wn.field);
    const label = (api && api.fieldLabel(wn.field)) || "Phone";

    clearNode(els.current);
    els.current.appendChild(document.createTextNode("On the record now: "));
    els.current.appendChild(el("span", "wn-was", current || "not set"));

    els.select.disabled = wn.saving;
    els.input.disabled = wn.saving;
    els.cancel.disabled = wn.saving;

    const armed = wn.armed && gate.enabled;
    els.save.disabled = !gate.enabled;
    els.save.classList.toggle("armed", armed);
    els.save.textContent = wn.saving
      ? "Updating…"
      : armed
        ? "Confirm update"
        : "Update in HubSpot";
    els.save.title = gate.enabled
      ? `Writes ${label} on this contact in HubSpot.`
      : gate.reasons.join(" ");

    // One line under the button, in priority order: the confirm sentence, then
    // why the button is dead, then what we're about to do to the number.
    const next = gate.analysis ? gate.analysis.value : String(wn.value || "").trim();
    const justWrote = !!(wn.result && wn.result.kind === "ok");
    // After a successful write the editor holds what the record holds, so the
    // button is off for the right reason — saying "change it before updating"
    // under a success line would only read as a contradiction.
    els.cancel.textContent = justWrote ? "Close" : "Cancel";
    let note = "";
    if (wn.saving) {
      note = "Writing this to HubSpot…";
    } else if (justWrote && gate.unchanged) {
      note = "";
    } else if (armed) {
      note = `Change ${label} from ${current || "empty"} to ${next} on this contact in HubSpot? Click Confirm update to write it.`;
    } else if (gate.reasons.length) {
      note = gate.reasons.join(" ");
    } else if (gate.note) {
      note = gate.note;
    } else if (gate.analysis && gate.analysis.normalized) {
      note = `Will be saved as ${next}.`;
    }
    els.note.textContent = note;

    wnRenderResult(els.result, wn.result);
  }

  // Built once per open (and once per identity re-render), from state.
  function wnEditor(contact) {
    const api = writeApi();
    const panel = el("div", "wn");
    panel.appendChild(el("div", "wn-title", "Update the number in HubSpot"));

    const fieldRow = el("div", "wn-row");
    const fieldLabel = el("label", null, "Which number");
    fieldLabel.htmlFor = "wn-field";
    const select = document.createElement("select");
    select.id = "wn-field";
    const fields = (api && api.FIELDS) || [];
    for (const f of fields) {
      const opt = document.createElement("option");
      opt.value = f.key;
      const cur = wnCurrent(contact, f.key);
      // Every option carries what's on that field, so "which one is wrong" is
      // answerable without closing the editor. CRM values, so textContent.
      opt.textContent = cur ? `${f.label} — ${cur}` : `${f.label} — not set`;
      if (f.key === wn.field) opt.selected = true;
      select.appendChild(opt);
    }
    fieldRow.appendChild(fieldLabel);
    fieldRow.appendChild(select);
    panel.appendChild(fieldRow);

    const currentLine = el("div", "wn-current");
    panel.appendChild(currentLine);

    const valueRow = el("div", "wn-row");
    const valueLabel = el("label", null, "Corrected number");
    valueLabel.htmlFor = "wn-value";
    const input = document.createElement("input");
    input.type = "tel";
    input.id = "wn-value";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "e.g. (415) 555-0134";
    input.value = wn.value;
    valueRow.appendChild(valueLabel);
    valueRow.appendChild(input);
    panel.appendChild(valueRow);

    const note = el("p", "wn-note");
    panel.appendChild(note);

    const actions = el("div", "wn-actions");
    const cancel = el("button", "wn-cancel", "Cancel");
    cancel.type = "button";
    const save = el("button", "wn-save", "Update in HubSpot");
    save.type = "button";
    actions.appendChild(cancel);
    actions.appendChild(save);
    panel.appendChild(actions);

    const result = el("p", "wn-result");
    result.hidden = true;
    // The write's outcome arrives asynchronously, so announce it rather than
    // leaving a screen-reader user to go looking for it.
    result.setAttribute("aria-live", "polite");
    panel.appendChild(result);

    wn.els = { panel, select, input, current: currentLine, note, cancel, save, result };

    select.addEventListener("change", () => {
      wn.field = select.value;
      wn.armed = false;
      wn.result = null;
      // Switching field re-prefills only while the rep hasn't typed their own
      // correction — never clobber what they wrote.
      if (!wn.touched) {
        wn.value = wnCurrent(contact, wn.field);
        input.value = wn.value;
      }
      wnSync(contact);
    });

    input.addEventListener("input", () => {
      wn.value = input.value;
      wn.touched = true;
      // Any edit disarms: the confirm step must always describe the change the
      // rep is actually looking at.
      wn.armed = false;
      wn.result = null;
      wnSync(contact);
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      // Enter arms, exactly like the first click does. It can never write on its
      // own — wnSubmit refuses until the confirm step is armed.
      wnSubmit(contact);
    });

    cancel.addEventListener("click", () => {
      wnResetFor(contact && contact.id);
      wnPaint(contact);
    });

    save.addEventListener("click", () => {
      wnSubmit(contact);
    });

    return panel;
  }

  function wnPaint(contact) {
    const host = wn.host;
    if (!host) return;
    clearNode(host);
    wn.els = null;
    if (!wn.open || !contact) return;
    // Belt and braces: the select and the gate must agree on which field is
    // being edited, even if state arrived here without one.
    if (!wn.field) wn.field = wnDefaultField(contact);
    host.appendChild(wnEditor(contact));
    wnSync(contact);
  }

  // The affordance in the phone row. Hidden while the editor is open (the editor
  // owns Cancel), and absent entirely when there's no contact record to write
  // to or the write module didn't load.
  function wnOpenButton(contact) {
    if (!contact || !writeApi()) return null;
    if (wn.open && wn.contactId === contact.id) return null;
    const has = !!(contact.phone || contact.mobilePhone || contact.phone2);
    const btn = el("button", "wn-open", has ? "Wrong number?" : "Add a number");
    btn.type = "button";
    btn.title = has
      ? "Correct this number in HubSpot — it syncs on to Outreach and the dialer."
      : "Add a number to this contact in HubSpot.";
    btn.addEventListener("click", () => {
      wn.open = true;
      wn.contactId = contact.id;
      wn.field = wnDefaultField(contact);
      wn.value = wnCurrent(contact, wn.field);
      wn.touched = false;
      wn.armed = false;
      wn.result = null;
      wnPaint(contact);
      if (wn.els && wn.els.input) {
        wn.els.input.focus();
        wn.els.input.select();
      }
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] wrong-number editor opened for contact", contact.id);
    });
    return btn;
  }

  // Mounts (and repaints) the editor's container inside the identity block.
  function wnMount(contact) {
    if (!contact || !writeApi()) {
      wn.host = null;
      return null;
    }
    const host = el("div");
    wn.host = host;
    wnPaint(contact);
    return host;
  }

  function wnSubmit(contact) {
    const api = writeApi();
    if (!api || wn.saving) return;
    const gate = wnGate(contact);
    if (!gate.enabled) {
      wnSync(contact); // re-state why it can't go
      return;
    }
    // The confirm step. A customer record is never mutated on one click, and
    // hubspot-write.js refuses an unconfirmed call too — this is the UI half of
    // that rule, not the whole of it.
    if (!wn.armed) {
      wn.armed = true;
      wn.result = null;
      wnSync(contact);
      return;
    }
    wnWrite(contact);
  }

  // What the rep is told after a successful write. The propagation delay is
  // stated honestly rather than implying the dialer updates immediately, and the
  // two footnotes (saved as typed / audit note missing) never contradict the
  // success.
  function wnSuccessSub(res) {
    const parts = [
      "Outreach usually picks it up within ~10 minutes; the dialer shows it after that.",
    ];
    if (!res.normalized) parts.push("Saved exactly as you typed it.");
    if (res.auditFailed) parts.push("The number changed, but the timeline note couldn't be added.");
    return parts.join(" ");
  }

  function wnErrorText(e) {
    const api = writeApi();
    const codes = (api && api.ERROR_CODES) || [];
    const typed = !!(e && e.code && codes.indexOf(e.code) !== -1 && e.message);
    if (!typed) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] phone update failed with an untyped error:", e);
      return "Couldn't update the number. Try again, and change it in HubSpot directly if it keeps failing.";
    }
    return e.message;
  }

  // Show the new number immediately. The cached bundle is busted inside
  // hubspot-write.js, so a Refresh refetches rather than serving the old value;
  // this is only about the panel in front of the rep right now.
  function wnApplyLocally(contact, field, value) {
    if (!contact) return;
    if (field === "phone") contact.phone = value;
    else if (field === "mobilephone") contact.mobilePhone = value;
    else if (field === "phone_number_2") contact.phone2 = value;
  }

  async function wnWrite(contact) {
    const api = writeApi();
    if (!api || !contact) return;
    const field = api.fieldKey(wn.field);
    const previous = wnCurrent(contact, field);

    wn.saving = true;
    wn.armed = false;
    wn.result = null;
    wnSync(contact);

    // Attribution for the audit note, all best-effort: a missing owner ID costs
    // the note its assignee, never the phone update.
    let actor = null;
    let ownerId = null;
    let userId = null;
    try {
      const auth = authApiFor();
      if (auth && typeof auth.getAuthState === "function") {
        const info = (await Promise.resolve(auth.getAuthState())) || {};
        actor = info.userEmail || null;
        userId = info.userId || null;
        ownerId = info.ownerId || null;
      }
      if (!ownerId && auth && typeof auth.ensureOwnerId === "function") {
        ownerId = await auth.ensureOwnerId();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] couldn't read HubSpot identity for the phone audit note:",
        (e && e.message) || e
      );
    }

    try {
      const res = await api.updateContactPhone({
        contactId: contact.id,
        field,
        value: wn.value,
        currentValue: previous,
        confirmed: true, // the rep armed and confirmed above
        companyId: (crm.bundle && crm.bundle.company && crm.bundle.company.id) || null,
        email: (crm.bundle && crm.bundle.email) || crmEmail(),
        ownerId,
        userId,
        actor,
      });
      wnApplyLocally(contact, res.field, res.value);
      // The editor now holds what the record holds, which also means the button
      // goes back to disabled ("that's the number already on the record").
      wn.value = res.value;
      wn.touched = false;
      wn.result = {
        kind: "ok",
        message: `${res.label} updated in HubSpot ✓`,
        sub: wnSuccessSub(res),
      };
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] phone corrected:",
        `contact ${res.contactId}`,
        `${res.field}:`,
        res.previous || "(empty)",
        "->",
        res.value,
        res.auditNoteId ? `audit note ${res.auditNoteId}` : "(no audit note)"
      );
    } catch (e) {
      wn.result = { kind: "err", message: wnErrorText(e), sub: null };
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] phone update failed:",
        (e && e.code) || "?",
        (e && e.message) || e
      );
    } finally {
      wn.saving = false;
      // Re-render the identity block: the phone row above the editor has to show
      // the new number, and the editor is rebuilt from the state set above.
      crmRender();
    }
  }
  // ==== end wrong-number workflow ==========================================

  // The phone row. `phone` and `mobilephone` very often hold the *same* number
  // — an import wrote both — and the row used to print it twice
  // ("+447445522695   Mobile: +447445522695"), which reads as two numbers and
  // wraps onto a second line at 320px. Numbers are compared on digits only
  // (formatting differs between the two fields all the time) and a repeat is
  // rendered once, with the fields it appears on in its hover title.
  //
  // Nothing here touches the wrong-number editor's field picker: hubspot-write's
  // allowlist still offers all three fields, and the editor still shows what is
  // on each one. This is display only.
  const phoneDigits = (v) => String(v == null ? "" : v).replace(/\D+/g, "");

  function phoneSpans(contact) {
    if (!contact) return [];
    const fields = [
      { label: null, value: contact.phone, name: "Phone" },
      { label: "Mobile", value: contact.mobilePhone, name: "Mobile phone" },
      { label: "Phone 2", value: contact.phone2, name: "Phone 2" },
    ];
    const rows = [];
    for (const f of fields) {
      if (!f.value) continue;
      const digits = phoneDigits(f.value);
      // No digits at all (a stray "n/a") can't be compared, so it stands alone.
      const dup = digits ? rows.find((r) => r.digits === digits) : null;
      if (dup) {
        dup.names.push(f.name);
        continue;
      }
      rows.push({ digits, value: f.value, label: f.label, names: [f.name] });
    }
    return rows.map((r) => {
      const span = el("span", null, r.label ? `${r.label}: ${r.value}` : r.value);
      // Always say which field(s) this number is on when it isn't just "Phone" —
      // the duplicate that used to be a second visible row is preserved here.
      if (r.names.length > 1) span.title = `On ${r.names.join(" and ")}`;
      else if (!r.label) span.title = r.names[0];
      return span;
    });
  }

  // One block for both records, in two columns.
  //   Contact  name + lifecycle stage / the booking cluster (email, their time,
  //            Fill) / title / phone + lead status / owner / LinkedIn / sequence
  //   Company  name / domain, industry, headcount / the owner rows / LinkedIn
  //
  // The booking cluster sits directly under the name because that is what it is:
  // the captured email is this contact's identity and the clock is what a rep
  // books against. It is the same node the #prospect section declares — moved,
  // not rebuilt (see mountBooking) — and it goes back there in the states this
  // function returns early from, so email/their-time/Fill are reachable even
  // with no HubSpot match at all.
  function renderIdentitySection(bundle) {
    const body = crmEls.identity;
    const c = bundle.contact;
    const co = bundle.company;

    // Phase 10: the wrong-number editor's state belongs to one contact. A
    // different contact (or no contact at all) starts clean — a half-typed
    // correction must never follow the rep onto someone else's record.
    if (!c || wn.contactId !== c.id) wnResetFor(c && c.id);

    if (!c && !co) {
      setPill(crmEls.identityPill, "Not in HubSpot");
      setNote(body, `No HubSpot contact for ${bundle.email}`);
      wn.host = null; // nothing to write to, and the old host just went away
      return;
    }
    // A company matched by email domain with no contact record is a real state:
    // say so rather than pretending the identity is complete.
    setPill(crmEls.identityPill, c ? null : "No contact record");
    clearNode(body);

    // Two columns, contact | company, separated by a hairline. Owners are the
    // load-bearing rows: all three are ALWAYS drawn (missing/unresolved states
    // say so honestly). isMine === null (can't tell) is never flagged: falsely
    // telling a rep an account isn't theirs is worse than silence.
    //
    // Ownership tone fix (P1, design critique "Neutral chip, red retired"):
    // another rep's name is a routine, benign state on a shared account, not
    // an error — red is retired from ownership entirely, here and on the
    // colleague rows below. The one fact a rep needs — "this isn't yours" —
    // is stated ONCE per card, in plain visible text (never title-only, so a
    // screen reader gets it too), on whichever role is most prominent:
    // outbound first (HubSpot's own field for outbound ownership), contact
    // otherwise. Company ownership was never flaggable and still isn't.
    const roles = (bundle.ownership && bundle.ownership.byKey) || {};
    const flagRole =
      roles.outbound && roles.outbound.isMine === false
        ? roles.outbound
        : roles.contact && roles.contact.isMine === false
          ? roles.contact
          : null;
    const ownChanged =
      bundle.ownership && bundle.ownership.changedAt
        ? `Outbound ownership changed ${fmt.date(bundle.ownership.changedAt)}`
        : null;
    const ownerRow = (role, isFlagRow) => {
      if (!role) return null;
      const row = el("div", "own-row");
      row.appendChild(el("span", "own-label", role.label));
      if (role.name) {
        row.appendChild(el("span", "own-name", role.name));
        if (isFlagRow) row.appendChild(el("span", "own-suffix", "(not you)"));
      } else {
        row.appendChild(
          el("span", "own-name own-unset", role.missing ? "Not set" : "Unknown")
        );
      }
      // When ownership last moved: context for "why haven't they been called",
      // kept as hover detail on the outbound row it belongs to.
      if (role.key === "outbound" && ownChanged) row.title = ownChanged;
      return row;
    };
    // The promised collapse (old comment above this code, now made real):
    // outbound, company and contact owner are the same person more often than
    // not, and three rows saying one thing is noise. Only a fully resolved,
    // identical trio collapses; a divergent, missing or unresolved name keeps
    // the split rows — so "Not set"/"Unknown" states stay honest.
    const ownerTriple = [roles.contact, roles.outbound, roles.company];
    const sharedOwnerName =
      ownerTriple.every((r) => r && r.name) &&
      ownerTriple.every((r) => r.name === ownerTriple[0].name)
        ? ownerTriple[0].name
        : null;
    const sharedOwnerRow = (name, isFlagRow) => {
      const row = el("div", "own-row");
      row.appendChild(el("span", "own-label", "Owner"));
      row.appendChild(el("span", "own-name", name));
      const clauses = isFlagRow ? "all roles, not you" : "all roles";
      row.appendChild(el("span", "own-suffix", `(${clauses})`));
      if (ownChanged) row.title = ownChanged;
      return row;
    };

    const cols = el("div", "ident-cols");

    // --- Contact column ---
    const colC = el("div", "ident-col");
    colC.appendChild(el("div", "col-head", "Contact"));
    // The contact's own header: photo (or initials) at 36px, with the name, the
    // LinkedIn glyph and the stage pill wrapping in the space beside it.
    //
    // The photo comes from the dialer, not HubSpot: content-nooks.js scrapes the
    // Nooks LinkedIn card and puts { photoUrl, profileUrl, headline } on
    // eb:prospectContext. Any of them can be absent, the whole object can be
    // null (and simply isn't there on a context stored before this shipped), and
    // the photo URL is signed and WILL expire — so the initials fallback in
    // tileNode is the normal path, not the error path.
    const li = prospectLinkedIn();
    const head = el("div", "ident-head");
    const line1 = el("div", "ident-line");
    // A tile only for a matched contact: an email address makes meaningless
    // initials, and there is nothing to put a photo next to.
    if (c && c.name) head.appendChild(contactTile(c.name, li.photoUrl));
    head.appendChild(line1);
    line1.appendChild(recordLink(c ? c.name : bundle.email, c && c.url, "rec-name"));
    // The headline ("VP Sales at Powtoon | ex-Gong") is hover detail on the
    // glyph: it is long, it repeats the title row, and this panel is 320px wide.
    const liGlyph = linkedInGlyphLink(
      li.profileUrl,
      li.headline ? `LinkedIn — ${li.headline}` : c ? `${c.name} on LinkedIn` : "LinkedIn profile"
    );
    if (liGlyph) line1.appendChild(liGlyph);
    if (c && c.lifecycleStage) {
      line1.appendChild(
        el(
          "span",
          data && data.status
            ? `pill tiny tone-${data.status.tone("lifecyclestage", c.lifecycleStage)}`
            : "pill stage tiny",
          c.lifecycleStage
        )
      );
    }
    colC.appendChild(head);
    // The live capture, right under the name. Appended after the column is in
    // the document (below), because a move is cheaper than a reparent-then-move.
    if (c && c.title) colC.appendChild(el("div", "ident-role", c.title));

    // Phase 10 phone row + wrong-number editor, unchanged behavior.
    const meta = el("div", "ident-meta");
    const hasAnyPhone = !!(c && (c.phone || c.mobilePhone || c.phone2));
    appendAll(meta, [
      ...phoneSpans(c),
      c && !hasAnyPhone ? el("span", null, "No phone number") : null,
      c && c.leadStatus ? el("span", null, c.leadStatus) : null,
      wnOpenButton(c),
    ]);
    if (meta.childElementCount) colC.appendChild(meta);
    const wnHost = wnMount(c);
    if (wnHost) colC.appendChild(wnHost);

    appendAll(colC, [
      // Suppressed here entirely when the trio collapses — the merged
      // "Owner" row lands once, in the Company column, below.
      sharedOwnerName ? null : ownerRow(roles.contact, roles.contact === flagRole),
      // The row link is suppressed when the glyph beside the name is already
      // showing: two links to the same person's profile is one row of the panel
      // spent twice. HubSpot's own hs_linkedin_url still carries it when the
      // dialer captured nothing.
      linkRow([liGlyph ? null : extLink("LinkedIn", c && c.linkedinUrl)]),
      sequenceLine(bundle.sequence),
    ]);

    // --- Company column ---
    const colCo = el("div", "ident-col ident-col-co");
    colCo.appendChild(el("div", "col-head", "Company"));
    if (co) {
      const coHead = el("div", "ident-head");
      const coLine = el("div", "ident-line");
      colCo.appendChild(coHead);
      coHead.appendChild(companyTile(co.name, co.domain));
      coHead.appendChild(coLine);
      coLine.appendChild(recordLink(co.name, co.url, "rec-name"));
      // Domain, industry and headcount: three discrete facts on one wrapping
      // line, spaced by the row's gap rather than strung together with a glyph.
      const about = [
        co.domain,
        co.industry,
        co.employees != null ? `${fmt.number(co.employees)} employees` : null,
      ].filter(Boolean);
      if (about.length) {
        const facts = el("div", "ident-role ident-facts");
        for (const fact of about) facts.appendChild(el("span", null, fact));
        colCo.appendChild(facts);
      }
    } else {
      colCo.appendChild(el("div", "ident-role", "No company record"));
    }
    appendAll(colCo, [
      sharedOwnerName
        ? sharedOwnerRow(sharedOwnerName, !!flagRole)
        : ownerRow(roles.outbound, roles.outbound === flagRole),
      sharedOwnerName ? null : ownerRow(roles.company, false),
      bundle.ownership && bundle.ownership.csmRole && bundle.ownership.csmRole.name
        ? ownerRow(bundle.ownership.csmRole, false)
        : null,
      linkRow([extLink("Company LinkedIn", co && co.linkedinUrl)]),
    ]);

    cols.appendChild(colC);
    cols.appendChild(colCo);
    body.appendChild(cols);
    // The booking cluster moves in now the column is in the document, and lands
    // directly under the contact's header row — before the title, the phone and
    // the owners. (The anchor is the header, not the name line inside it.)
    mountBooking(colC, head.nextSibling);
  }

  // --- Account context (Phase 8) -------------------------------------------
  // "Worth calling?" up top (grade in the section pill, then the team sizes and
  // company status), then "what do I open with" (the company's own blurb, ICP,
  // tech stack). Empty rows are never built — most prospects have most of these
  // blank — and if the whole thing is empty the section is hidden rather than
  // drawn as a card that says nothing.
  function renderAccountSection(bundle) {
    const body = crmEls.account;
    const ctx = bundle.accountContext || {};
    if (!ctx.hasData) {
      setPill(crmEls.accountPill, null);
      crmEls.accountSection.hidden = true;
      clearNode(body);
      return;
    }
    crmEls.accountSection.hidden = false;
    // The grade is the single most scannable "worth calling" signal, so it goes
    // in the section head where a rep sees it without reading the card.
    setPill(
      crmEls.accountPill,
      ctx.grade ? `Grade ${ctx.grade}` : null,
      // Grade is a status, so it carries a semantic tone (A/B positive,
      // C caution, D/F negative) via the data layer's mapping.
      ctx.grade && data && data.status ? `tone-${data.status.tone("account_grade_v1", ctx.grade)}` : undefined
    );
    clearNode(body);

    // Every labelled datapoint on this record, as stat chips in one wrapping
    // grid: the classification first (what kind of account is this), then the
    // team sizes (how big is the motion). A chip is only built when the record
    // has the value, so a thin company shows two chips rather than eight boxes
    // of nothing.
    //
    // ICP and industry live HERE, and only here. They are company data; the
    // Wiza section is Wiza PRODUCT data and no longer shows them at all — which
    // is the inverse of the old rule, where Account context suppressed them
    // whenever the Wiza section happened to have account data to print.
    const chips = chipRow([
      // Company status is a status → the tone rides on the chip's value text.
      chip("Status", ctx.status, {
        title: "Company status",
        tone: data && data.status ? data.status.tone("company_lifecycle_stage", ctx.status) : null,
      }),
      chip("ICP fit", ctx.icpFit, { title: "ICP fit" }),
      chip("ICP", ctx.icp, { title: "Ideal customer profile" }),
      chip("Industry", ctx.industry, { title: "Industry" }),
      // The Wiza-data caveat on the first number is straight from the property's
      // own description, and stays as the chip's hover.
      chip("Sales team", ctx.salesTeamSize != null ? fmt.number(ctx.salesTeamSize) : null, {
        title: "Size of the sales team using Wiza data",
      }),
      chip("AE", ctx.aeTeamSize != null ? fmt.number(ctx.aeTeamSize) : null, { title: "AE team" }),
      chip("Outbound", ctx.obTeamSize != null ? fmt.number(ctx.obTeamSize) : null, {
        title: "Outbound team",
      }),
      chip("Leadership", ctx.leadershipTeamSize != null ? fmt.number(ctx.leadershipTeamSize) : null, {
        title: "Sales leadership team",
      }),
    ]);
    if (chips) body.appendChild(chips);

    // The company's own blurb: two lines, then a toggle. The full text (not the
    // 200-char snippet) goes in, so expanding shows all of it and the collapsed
    // state never ends in a mid-sentence "…".
    const blurb = proseBlock(ctx.snippetFull || ctx.snippet, null, "the company description");
    if (blurb) body.appendChild(blurb);

    // Tech stack: comma-separated, competitors highlighted, MORE/LESS toggle.
    // Prefers the rich techStack view-model (labels cleaned of underscores,
    // competitors partitioned to the front so they can never hide behind MORE);
    // falls back to the legacy string list for a stale cached bundle.
    const stack = ctx.techStack;
    if (stack && stack.items && stack.items.length) {
      const row = el("div", "fact-line tech-line");
      const value = el("span");
      value.appendChild(el("span", null, "Tech: "));

      // Rebuilt on every toggle: item spans joined by plain ", " text nodes,
      // competitor names in the accent style (decoration = purple scale).
      const list = el("span");
      const renderItems = (expanded) => {
        while (list.firstChild) list.removeChild(list.firstChild);
        const shown = expanded ? stack.items : stack.items.slice(0, stack.visibleCount);
        shown.forEach((item, i) => {
          if (i > 0) list.appendChild(document.createTextNode(", "));
          const piece = el("span", item.isCompetitor ? "tech-comp" : null, item.label);
          if (item.isCompetitor) piece.title = "Wiza competitor";
          list.appendChild(piece);
        });
      };
      renderItems(false);
      value.appendChild(list);

      if (stack.hiddenCount > 0) {
        let expanded = false;
        const toggle = el("button", "prose-more", `More (${stack.hiddenCount})`);
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", `Show ${stack.hiddenCount} more technologies`);
        toggle.addEventListener("click", () => {
          expanded = !expanded;
          renderItems(expanded);
          toggle.textContent = expanded ? "Less" : `More (${stack.hiddenCount})`;
          toggle.setAttribute("aria-expanded", String(expanded));
        });
        value.appendChild(document.createTextNode(" "));
        value.appendChild(toggle);
      }
      row.appendChild(value);
      body.appendChild(row);
    } else if (ctx.tech) {
      // Legacy shape (pre-v11 cached bundle): plain strings, no competitor info.
      const row = el("div", "fact-line");
      const value = el("span", null, `Tech: ${ctx.tech.items.join(", ")}`);
      if (ctx.tech.more > 0) {
        value.appendChild(el("span", "ctx-more", ` +${ctx.tech.more} more`));
        value.title = ctx.tech.all.join(", ");
      }
      row.appendChild(value);
      body.appendChild(row);
    }

    // Why the ICP call was made. Model-written, runs to paragraphs, and the
    // least scannable thing in the panel: two muted lines and a toggle.
    const reasoning = ctx.icpReasoningFull || ctx.icpReasoning;
    const why = proseBlock(
      reasoning ? `Why: ${reasoning}` : null,
      "why",
      "why this account is graded this way"
    );
    if (why) body.appendChild(why);

    attachProseToggles(body);
  }

  // --- Others at this account (Phase 9) -------------------------------------
  // The SDR ask, in their words: "who else has been sequenced from that account —
  // currently visible on the full dialer tab filtered by account, but not during
  // an active call". Same section answers "wrong person" — the names reps
  // currently get by opening the company's LinkedIn page mid-call.
  //
  // Ordering is EB.hubspotData.view.accountContacts' job (in-sequence first, then
  // most recently contacted); this is layout. Every string is a CRM value going
  // through textContent, and both links are already-validated hrefs: the record
  // link is built from a digits-only ID, the LinkedIn one from a safeUrl'd
  // property.
  const COLLEAGUES_TITLE = "Others at this account";

  // The count belongs in the title ("Others at this account (4)"), and there is
  // no count to show in any state but a rendered list.
  function setColleaguesCount(n) {
    if (!crmEls.colleaguesTitle) return;
    crmEls.colleaguesTitle.textContent =
      typeof n === "number" && n > 0 ? `${COLLEAGUES_TITLE} (${n})` : COLLEAGUES_TITLE;
  }

  // The shared-owner note in the section head ("all Jasper Guilaran"). Every row
  // on an account is usually owned by the same rep, and four rows each reading
  // "Owner: Jasper Guilaran" is four lines saying one thing. The section head's
  // own gap separates it from the title — no glyph.
  function setColleaguesOwnerNote(text) {
    if (!crmEls.colleaguesOwner) return;
    crmEls.colleaguesOwner.textContent = text || "";
  }

  // What a row would display as its owner: "You" for the connected rep, the
  // teammate's name when we resolved one, null when the portal didn't say.
  const colleagueOwnerLabel = (row) =>
    row.isMine === true ? "You" : row.ownerName || null;

  // The one owner every row shares, or null when they differ (or any row's owner
  // is unknown — an unknown can't be folded into a claim about all of them).
  function sharedColleagueOwner(rows) {
    if (!rows || rows.length < 2) return null;
    const first = colleagueOwnerLabel(rows[0]);
    if (!first) return null;
    return rows.every((r) => colleagueOwnerLabel(r) === first) ? first : null;
  }

  function colleagueRow(row, hideOwner) {
    // Ownership tone fix (P1): no per-row alert outline/tint, even for a
    // colleague owned by a named someone else — that's a routine, benign
    // state on a shared account, not an error. The shared-owner note in the
    // section head already carries the fact when every row matches; when
    // owners differ, the quiet "Owned by {name}" text below (line two) is the
    // only signal, and it is plain visible text, not a hover-only title.
    const node = el("div", "peer");

    const top = el("div", "peer-top");
    // A row keeps the base 20px, and initials only: there is no captured photo
    // for anyone but the prospect in front of the rep.
    top.appendChild(initialsTile(row.name, "person", "tile-round"));
    top.appendChild(recordLink(row.name, row.url, "peer-name"));

    // Compact sequence state. Enrolled is the signal the rep is scanning for, so
    // it gets the positive tone; a definite "no" is the neutral tone; an unknown
    // gets no badge at all rather than a placeholder — the portal simply didn't
    // say. Tones, not decoration: this is state.
    if (row.inSequence === true) {
      const badge = el("span", "pill tone-positive tiny", "In sequence");
      // The sequence name and start date are useful but not row-worthy at 320px.
      const which = [
        row.sequenceName ? `In sequence: ${row.sequenceName}` : "In sequence",
        row.sequenceEnrolledAt ? `since ${fmt.date(row.sequenceEnrolledAt)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      if (which) badge.title = which;
      top.appendChild(badge);
    } else if (row.inSequence === false) {
      top.appendChild(el("span", "pill tone-neutral tiny", "Not sequenced"));
    }

    // One-click LinkedIn per colleague: this is the tab-out the section exists to
    // kill, so it belongs on the row and not behind a hover.
    if (row.linkedinUrl) {
      const li = el("a", "peer-li", "in");
      li.href = row.linkedinUrl;
      li.target = "_blank";
      li.rel = "noopener noreferrer";
      li.title = `${row.name} on LinkedIn`;
      li.setAttribute("aria-label", `${row.name} on LinkedIn`);
      top.appendChild(li);
    }
    node.appendChild(top);

    const meta = el("div", "peer-meta");
    // Owner: "You" when the ID matches the connected rep (that comparison is on
    // IDs, so it holds even when the name didn't resolve), a teammate's name when
    // we have it, and nothing at all otherwise. Never a bare owner ID.
    //
    // Suppressed entirely when the section head has already said every row is
    // this person's — then it is only ever the exceptions that carry a name.
    const ownerLabel = colleagueOwnerLabel(row);
    let owner = null;
    if (!hideOwner && ownerLabel) {
      // "You" stays as-is (it's not an ownership fact worth flagging); a
      // named teammate gets the quiet "Owned by {name}" idiom — plain text,
      // no alert styling, on the one row it applies to.
      owner = el(
        "span",
        "peer-owner",
        row.isMine === true ? "You" : `Owned by ${ownerLabel}`
      );
    }
    // "contacted 4d ago" rather than "Last contacted 4d ago": in a list of
    // colleagues there is nothing else the time could be about, and the two
    // dropped words are what kept this row on one line at 320px. The absolute
    // stamp — and the word — stay in the title.
    const contacted = row.lastContactedAt
      ? el("span", "peer-when", `contacted ${fmt.relativeTime(row.lastContactedAt)}`)
      : null;
    if (contacted) {
      const exact = fmt.dateTime(row.lastContactedAt);
      contacted.title = exact ? `Last contacted ${exact}` : "Last contacted";
    }
    // Line two, as structure rather than a strung-together sentence: the title
    // on the leading edge, the owner next to it when owners are mixed, and the
    // relative time pushed to the trailing edge (see .peer-when).
    appendAll(meta, [
      row.title ? el("span", "peer-title", row.title) : null,
      owner,
      contacted,
    ]);
    if (meta.childElementCount) node.appendChild(meta);

    return node;
  }

  function renderColleaguesSection(bundle) {
    const body = crmEls.colleagues;
    if (!body) return;
    // No company → there is no account to be "others at", and no request was
    // made either. Hide it rather than explaining an absence.
    if (!bundle.company) {
      setColleaguesCount(null);
      crmEls.colleaguesSection.hidden = true;
      clearNode(body);
      return;
    }
    crmEls.colleaguesSection.hidden = false;

    const rows = bundle.colleagues || [];
    const errors = bundle.errors || {};
    // Same precedence as Deals and Activity: rows — or a clean empty result —
    // always beat an error line, so "nobody else here" can never read as
    // "something's broken".
    if (errors.colleagues && !rows.length) {
      setColleaguesCount(null);
      crmEls.colleaguesSection.hidden = false;
      setNote(
        body,
        sectionErrorText(errors.colleagues, errors.colleaguesRetryAfterMs, "other contacts on this account"),
        true
      );
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] account contacts unavailable:", errors.colleagues);
      return;
    }
    // Nobody else on the account is not news a rep needs a card for. The old
    // "No other contacts on this account" line cost a section head plus a card
    // to say nothing actionable, so the section goes away instead.
    if (!rows.length) {
      setColleaguesCount(null);
      crmEls.colleaguesSection.hidden = true;
      clearNode(body);
      return;
    }
    crmEls.colleaguesSection.hidden = false;
    setColleaguesCount(rows.length);
    const shared = sharedColleagueOwner(rows);
    setColleaguesOwnerNote(shared ? `all owned by ${shared}` : null);
    clearNode(body);
    for (const row of rows) body.appendChild(colleagueRow(row, !!shared));
  }

  // active → the positive tone (the bare pill), closed → the neutral outline,
  // anything else a portal admin adds later → the same neutral treatment: an
  // unrecognised status must not be coloured as if we understood it.
  function wizaStatusVariant(status) {
    if (data && data.status) return `tone-${data.status.tone("wiza_status", status)}`;
    if (status === "active") return "";
    if (status === "closed") return "closed";
    return "info";
  }

  // A metric worth a row. Zero is not: an account with 0 API credits, 0 credits
  // used and 0 purchases has told a rep nothing, and it used to tell them so
  // across five labelled cells. Null and 0 are treated the same here on
  // purpose — "no credits" and "we don't know" lead to the same call.
  const metric = (n) => (n != null && Number(n) > 0 ? fmt.number(n) : null);

  // Wiza USER and ACCOUNT information — Wiza product data, and nothing else.
  // Who this person is to us (status, ID, plan, credits, last usage, the admin
  // links) and what their Wiza account looks like (account ID, subscriptions,
  // API credits, purchases). Company classification — ICP, industry — is
  // company data and belongs to Account context, which owns it outright; this
  // section does not print it at all.
  //
  // Absence is the normal case — most prospects have never signed up — so a
  // prospect with no user and no account data gets no section at all, and inside
  // each subsection every datapoint with no value (or a zero) is simply not
  // built.
  function renderWizaSection(bundle) {
    const body = crmEls.wiza;
    const wiza = bundle.wiza || {};
    const user = wiza.user || {};
    const account = wiza.account || {};

    // Status at section level so it's readable without opening anything.
    const variant = wizaStatusVariant(user.status);

    // --- Account: the Wiza account's own identity and its metrics, as chips.
    // Zero-suppression happens before the chip is built, so a zeroed account
    // contributes no chips rather than a row of boxes reading "0".
    const accountChips = account.hasData
      ? [
          chip("Account ID", account.accountId || account.primaryAccountId, {
            title: "Wiza account ID",
          }),
          chip(
            "Subscribed",
            // "0 of 1" is a zero; only a real subscription is worth the words.
            metric(account.subscribedAccounts) && account.associatedAccounts != null
              ? `${fmt.number(account.subscribedAccounts)} of ${fmt.number(account.associatedAccounts)}`
              : metric(account.subscribedAccounts),
            { title: "Subscribed accounts of associated accounts" }
          ),
          chip("API credits", metric(account.apiCreditBalance), { title: "API credit balance" }),
          chip("Credits 30d", metric(account.creditsUsed30d), {
            title: "API credits used in the last 30 days",
          }),
          chip(
            "Purchases",
            metric(account.timesPurchased) ? `${fmt.number(account.timesPurchased)}×` : null,
            { title: "Times API credits purchased" }
          ),
          chip(
            "Last purchase",
            account.lastPurchaseAt ? fmt.relativeTime(account.lastPurchaseAt) : null,
            {
              title: account.lastPurchaseAt ? `Last purchase ${fmt.date(account.lastPurchaseAt)}` : null,
            }
          ),
          chip("Use case", account.useCase, { title: "Use case" }),
        ].filter(Boolean)
      : [];
    const hasAccount = !!(accountChips.length || account.isTargetAccount);

    // Nothing to say, or nothing left after the zeros went: no section.
    if (!user.isUser && !hasAccount) {
      setPill(crmEls.wizaPill, null);
      crmEls.wizaSection.hidden = true;
      clearNode(body);
      return;
    }
    crmEls.wizaSection.hidden = false;
    setPill(crmEls.wizaPill, user.statusLabel, variant);
    clearNode(body);

    // The "User"/"Account" sub-labels only earn their line when both halves are
    // on screen and a reader could otherwise mix them up.
    const labelSubs = user.isUser && hasAccount;

    if (user.isUser) {
      const sub = el("div", "wiza-sub");
      const head = el("div", "wiza-head");
      if (labelSubs) head.appendChild(el("span", "wiza-label", "User"));
      if (user.statusLabel) {
        head.appendChild(el("span", ("pill tiny " + variant).trim(), user.statusLabel));
      }
      // Only worth saying when it's false — an unconfirmed email explains a lot
      // of "signed up but never used it" records.
      if (user.emailConfirmed === false) {
        head.appendChild(el("span", "pill info tiny", "Email unconfirmed"));
      }
      if (head.childElementCount) sub.appendChild(head);

      // Plan status and billing frequency read as one value ("Paid monthly");
      // the credit allowance is its own datapoint, and so is everything else.
      const plan = [user.planStatus, user.planFrequency ? user.planFrequency.toLowerCase() : null]
        .filter(Boolean)
        .join(" ");
      const chips = chipRow([
        chip("Plan", plan, { title: "Plan status and billing frequency" }),
        chip(
          "Plan credits",
          user.planCredits != null ? `${fmt.number(user.planCredits)} credits` : null,
          { title: "Credits included in the plan" }
        ),
        chip("Credits 30d", metric(user.creditsUsed30d), {
          title: "Credits used in the last 30 days",
        }),
        chip("Last used", user.lastUsageAt ? fmt.relativeTime(user.lastUsageAt) : null, {
          title: user.lastUsageAt ? `Last used ${fmt.dateTime(user.lastUsageAt)}` : null,
        }),
        chip("Signed up", user.signedUpAt ? fmt.date(user.signedUpAt) : null, {
          title: "Signed up",
        }),
        chip("Wiza ID", user.wizaId, { title: "Wiza user ID" }),
      ]);
      if (chips) sub.appendChild(chips);

      // Both links come from URL properties and are only rendered when set.
      const links = el("div", "wiza-links");
      appendAll(links, [
        extLink("Open in Wiza Admin", user.adminUrl),
        extLink("Usage logs", user.usageLogsUrl),
      ]);
      if (links.childElementCount) sub.appendChild(links);

      if (sub.childElementCount) body.appendChild(sub);
    }

    if (hasAccount) {
      const sub = el("div", "wiza-sub");
      if (account.isTargetAccount || labelSubs) {
        const head = el("div", "wiza-head");
        if (labelSubs) head.appendChild(el("span", "wiza-label", "Account"));
        if (account.isTargetAccount) {
          head.appendChild(el("span", "pill stage tiny", "Target account"));
        }
        sub.appendChild(head);
      }
      // Account data but nobody signed up: the company is known to us, this
      // person isn't. One muted line above the chips — it is a statement about
      // the contact, not a datapoint about the account, so it isn't a chip.
      if (!user.isUser) sub.appendChild(el("p", "crm-note", "Not a Wiza user"));
      const chips = chipRow(accountChips);
      if (chips) sub.appendChild(chips);
      if (sub.childElementCount) body.appendChild(sub);
    }
  }

  function renderDealsSection(bundle) {
    const body = crmEls.deals;
    const errors = bundle.errors || {};
    // Same rule as Activity: rows (or a clean empty result) win over an error
    // line, so "no deals" never reads as "something's broken".
    if (errors.deals && !(bundle.deals || []).length) {
      setPill(crmEls.dealsPill, null);
      crmEls.dealsSection.hidden = false;
      setNote(body, sectionErrorText(errors.deals, errors.dealsRetryAfterMs, "deals"), true);
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] deals section unavailable:", errors.deals);
      return;
    }
    const deals = bundle.deals || [];
    setPill(crmEls.dealsPill, deals.length ? String(deals.length) : null);
    // "No open deals" is not a thing a rep does anything with, and it cost a
    // section head plus a card to say. No deals, no section.
    if (!deals.length) {
      crmEls.dealsSection.hidden = true;
      clearNode(body);
      return;
    }
    crmEls.dealsSection.hidden = false;
    clearNode(body);
    for (const d of deals) {
      const row = el("div", "deal");
      const head = el("div", "rec-head");
      head.appendChild(recordLink(d.name, d.url, "rec-name"));
      if (d.stage) {
        const cls = d.won ? "pill won" : d.closed ? "pill closed" : "pill stage";
        head.appendChild(el("span", cls, d.stage));
      }
      row.appendChild(head);

      const meta = el("div", "deal-meta");
      const amount = d.amount != null ? fmt.currency(d.amount) : "";
      if (amount) meta.appendChild(el("span", "deal-amount", amount));
      const close = d.closeDate ? fmt.date(d.closeDate) : "";
      if (close) meta.appendChild(el("span", null, `Closes ${close}`));
      if (d.ownerName) meta.appendChild(el("span", null, d.ownerName));
      if (meta.childElementCount) row.appendChild(meta);

      // Why it ended (Phase 8) — closed rows only, and only when the portal
      // actually says. Open deals get nothing; a closed deal with no reason on
      // file gets nothing either, rather than a "Lost:" with nothing after it.
      // The data layer composes the reason and its categories into one string
      // with an interpunct between them; split it back into spans so the row is
      // spaced by its own gap. The title keeps the untruncated text, comma-joined.
      const outcome = data.view.dealOutcome(d);
      if (outcome) {
        const line = el("div", "deal-outcome" + (outcome.lost ? " lost" : ""));
        for (const part of factParts(outcome.text)) line.appendChild(el("span", null, part));
        const title = joinParts(outcome.title);
        if (title !== joinParts(outcome.text)) line.title = title;
        row.appendChild(line);
      }

      body.appendChild(row);
    }
  }

  // One activity row, two lines instead of three:
  //   1  type icon, title, relative time (pushed to the trailing edge)
  //   2  outcome/status/disposition, and the owner only when it just changed
  //
  // The type word ("TASK") is gone from line 1: the icon carries it, with the
  // word itself on the icon's title. Everything type-specific (disposition and
  // duration, meeting outcome, task status, note preview) still arrives
  // pre-composed in item.detail from hubspot-data.js — which joins its parts
  // with an interpunct, so the row splits them back into spans.
  //
  // `prevOwner` is the previous rendered row's owner name. Attribution is
  // run-length suppressed: on a list where one rep made every touch, the name
  // appeared on all 13 rows and told a rep nothing after the first. It is shown
  // on the first row and then only when it changes — which makes a change
  // genuinely visible instead of hiding it in a column of identical names.
  function activityRow(item, prevOwner) {
    const row = el("div", "act");
    const icon = el("span", "act-icon");
    icon.appendChild(svgIcon(ACT_ICON[item.type] || ACT_ICON.fallback));
    // The type word lives on the disc's title (and on the timestamp's, for a
    // screen-reader user who lands there) — the disc itself is decoration.
    icon.title = item.label;
    icon.setAttribute("aria-hidden", "true");
    row.appendChild(icon);

    const main = el("div", "act-main");
    const top = el("div", "act-top");
    const summary = el("span", "act-summary", item.summary || item.label);
    if (item.direction) {
      const arrow = el("span", null, item.direction === "out" ? " ↑" : " ↓");
      arrow.title = item.direction === "out" ? "Outbound" : "Inbound";
      summary.appendChild(arrow);
    }
    top.appendChild(summary);
    const when = fmt.relativeTime(item.timestamp);
    if (when) {
      const stamp = el("span", "act-when", when);
      const exact = fmt.dateTime(item.timestamp);
      // The row's own type is in the stamp's title too, so a screen-reader user
      // who lands on it gets what the glyph was carrying.
      stamp.title = [item.label, exact].filter(Boolean).join(" — ");
      top.appendChild(stamp);
    }
    main.appendChild(top);

    // Line 2 is built only when it has something to add.
    const detail = el("div", "act-detail");
    for (const part of factParts(item.detail)) detail.appendChild(el("span", null, part));
    if (item.ownerName && item.ownerName !== prevOwner) {
      detail.appendChild(el("span", "act-owner", `by ${item.ownerName}`));
    }
    if (detail.childElementCount) main.appendChild(detail);

    row.appendChild(main);
    return row;
  }

  // The tab bar. Rebuilt on every render because the counts are per prospect;
  // the click/keyboard handlers are bound once to the container below.
  //
  // Only tabs that have rows are rendered. A row of dimmed "Emails 0",
  // "Meetings 0", "Notes 0" used to take ~40% of the bar to report three
  // absences, and if only one type has rows the bar is hidden entirely — a tab
  // bar with one real choice in it is not a choice.
  function renderActivityTabs(items) {
    const bar = crmEls.activityTabs;
    const tabs = data.activity.tabs(items).filter((t) => !t.disabled);
    // "All" plus exactly one type means both tabs show the same list.
    if (tabs.length < 3) {
      crm.activeTab = "all";
      hideActivityTabs();
      return;
    }
    clearNode(bar);
    bar.style.display = "";
    for (const tab of tabs) {
      const btn = el("button", "tab");
      btn.type = "button";
      btn.id = `crm-tab-${tab.key}`;
      btn.dataset.tab = tab.key;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-controls", "crm-activity");
      btn.setAttribute("aria-selected", tab.key === crm.activeTab ? "true" : "false");
      // Roving tabindex: one stop for the whole bar, arrows move within it.
      btn.tabIndex = tab.key === crm.activeTab ? 0 : -1;
      btn.appendChild(el("span", null, tab.label));
      // Leading space so the accessible name reads "Calls 12", not "Calls12";
      // CSS collapses it and adds the visual gap.
      btn.appendChild(el("span", "tab-count", ` ${tab.count}`));
      bar.appendChild(btn);
    }
    crmEls.activity.setAttribute("aria-labelledby", `crm-tab-${crm.activeTab}`);
  }

  // No tabs → nothing for the list to be labelled by; leaving a stale
  // aria-labelledby pointing at a removed button is worse than no label.
  function hideActivityTabs() {
    crmEls.activityTabs.style.display = "none";
    crmEls.activity.removeAttribute("aria-labelledby");
  }

  function renderActivitySection(bundle) {
    const body = crmEls.activity;
    const errors = bundle.errors || {};
    hideActivityTabs();
    const items = bundle.activity || [];
    // Order matters: a fetch that came back with nothing is an EMPTY result, not
    // a failure, and it says so even if a stale error code is hanging around. An
    // error line only ever appears when the fetch produced no rows *and* failed.
    if (errors.activity && !items.length) {
      setPill(crmEls.activityPill, null);
      setNote(body, sectionErrorText(errors.activity, errors.activityRetryAfterMs, "activity"), true);
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] activity section unavailable:", errors.activity);
      return;
    }
    setPill(crmEls.activityPill, items.length ? String(items.length) : null);
    if (!items.length) {
      setNote(body, "No activity found");
      return;
    }
    // Keep the rep's tab if it still has rows for this prospect, else "All".
    // renderActivityTabs may force it back to "all" when there is no real
    // choice to make, so it runs before the list is filtered.
    crm.activeTab = data.activity.resolveTab(items, crm.activeTab);
    renderActivityTabs(items);

    clearNode(body);
    let prevOwner = null;
    for (const item of data.activity.filter(items, crm.activeTab)) {
      body.appendChild(activityRow(item, prevOwner));
      // Only a row that *had* an owner moves the run along; an unattributed row
      // in the middle must not make the next identical name look like a change.
      if (item.ownerName) prevOwner = item.ownerName;
    }
  }

  // Tab interaction lives on the container so it survives the rebuild above.
  function selectActivityTab(key, moveFocus) {
    if (!key || key === crm.activeTab) return;
    crm.activeTab = key;
    if (crm.bundle) renderActivitySection(crm.bundle);
    crmEls.activity.scrollTop = 0; // a different list, not a scrolled one
    if (moveFocus) {
      const next = crmEls.activityTabs.querySelector(`[data-tab="${key}"]`);
      if (next) next.focus();
    }
  }

  const isEnabledTab = (btn) => btn && btn.getAttribute("aria-disabled") !== "true";

  crmEls.activityTabs.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[role="tab"]') : null;
    if (!isEnabledTab(btn)) return;
    selectActivityTab(btn.dataset.tab, false);
  });

  // Arrow/Home/End move between tabs (skipping empty ones); Enter/Space activate
  // the focused tab, for the case where focus and selection have drifted apart.
  crmEls.activityTabs.addEventListener("keydown", (ev) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "];
    if (keys.indexOf(ev.key) === -1) return;
    const tabs = Array.prototype.filter.call(
      crmEls.activityTabs.querySelectorAll('[role="tab"]'),
      isEnabledTab
    );
    if (!tabs.length) return;
    if (ev.key === "Enter" || ev.key === " ") {
      const focused = tabs.indexOf(document.activeElement);
      if (focused === -1) return;
      ev.preventDefault();
      selectActivityTab(tabs[focused].dataset.tab, true);
      return;
    }
    ev.preventDefault();
    const at = Math.max(0, tabs.findIndex((t) => t.dataset.tab === crm.activeTab));
    let next = at;
    if (ev.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (ev.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = tabs.length - 1;
    selectActivityTab(tabs[next].dataset.tab, true);
  });

  // Why the Refresh button is disabled, in the popover's own words. Same rule as
  // everywhere else: never a dead control with no explanation.
  function refreshNoteText() {
    if (!data) return "CRM data isn't available in this build. Reload the extension.";
    if (!crm.connected) return "Connect HubSpot below to load CRM data.";
    if (!crmEmail()) return "No prospect captured yet — open one in the dialer.";
    if (crm.status === "loading") return "Loading this prospect from HubSpot…";
    return "Reloads this prospect from HubSpot. Otherwise their data is cached for 5 minutes.";
  }

  function crmRender() {
    const email = crmEmail();
    // Park the booking cluster in its own section BEFORE anything clears the
    // identity card it may be sitting in — every branch below either leaves it
    // parked (no match, signed out, no prospect, loading, error) or hands it to
    // renderIdentitySection, which moves it into the Contact column. Doing it
    // first is what keeps email/their-time/Fill on screen in the states where
    // there is no CRM data at all.
    mountBooking(null);
    crmEls.refresh.disabled = !(data && crm.connected && email && crm.status !== "loading");
    if (crmEls.refreshNote) crmEls.refreshNote.textContent = refreshNoteText();
    setPill(crmEls.identityPill, null);
    setPill(crmEls.accountPill, null);
    setPill(crmEls.wizaPill, null);
    setPill(crmEls.dealsPill, null);
    setPill(crmEls.activityPill, null);
    // Four sections hide themselves when the record has nothing for them
    // (Account context, Others at this account, Wiza, Deals); every other state
    // — loading, error, signed out — has something to say, so they all come
    // back here. The colleagues count and its shared-owner note are only ever a
    // rendered list's.
    crmEls.accountSection.hidden = false;
    crmEls.colleaguesSection.hidden = false;
    crmEls.wizaSection.hidden = false;
    crmEls.dealsSection.hidden = false;
    setColleaguesCount(null);
    setColleaguesOwnerNote(null);
    // Nothing below this point shows tabs unless a bundle is actually rendered.
    hideActivityTabs();

    if (!data) {
      for (const body of crmBodies) {
        setNote(body, "CRM data isn't available in this build. Reload the extension.", true);
      }
      return;
    }
    if (!crm.connected) {
      for (const body of crmBodies) setConnectNote(body);
      return;
    }
    if (!email) {
      for (const body of crmBodies) {
        setNote(body, "No prospect captured yet — open one in the dialer.");
      }
      return;
    }
    if (crm.status === "loading") {
      skeleton(crmEls.identity, 3);
      skeleton(crmEls.account, 3);
      skeleton(crmEls.colleagues, 3);
      skeleton(crmEls.wiza, 3);
      skeleton(crmEls.deals, 2);
      skeleton(crmEls.activity, 4);
      return;
    }
    if (crm.status === "error") {
      const text = crmErrorText(crm.error);
      for (const body of crmBodies) setNote(body, text, true);
      return;
    }
    if (!crm.bundle) {
      for (const body of crmBodies) setNote(body, "Nothing loaded yet.");
      return;
    }
    renderIdentitySection(crm.bundle);
    renderAccountSection(crm.bundle);
    renderColleaguesSection(crm.bundle);
    renderWizaSection(crm.bundle);
    renderDealsSection(crm.bundle);
    renderActivitySection(crm.bundle);
  }

  // --- fetching ------------------------------------------------------------
  // Guards against the panel racing itself: a prospect change while a fetch is
  // in flight bumps crmSeq, and the older response is dropped on arrival.
  let crmSeq = 0;
  let crmDebounceTimer = null;
  let retryTimer = null;
  let retryTicker = null;

  function cancelRetry() {
    clearInterval(retryTicker);
    clearTimeout(retryTimer);
    retryTicker = null;
    retryTimer = null;
    crm.retrySecs = null;
  }

  // Honor Retry-After: count the wait down in the UI, then try once more. The
  // search pool is shared by the whole team, so retrying early is antisocial.
  function startRateLimitRetry() {
    const ms = Math.max(1000, Number(crm.error && crm.error.retryAfterMs) || 10000);
    crm.retrySecs = Math.ceil(ms / 1000);
    retryTicker = setInterval(() => {
      crm.retrySecs = Math.max(0, crm.retrySecs - 1);
      crmRender();
    }, 1000);
    retryTimer = setTimeout(() => {
      cancelRetry();
      crmFetch({ force: false });
    }, ms);
  }

  async function crmFetch(options) {
    const opts = options || {};
    cancelRetry();
    if (!data || !crm.connected) {
      crmRender();
      return;
    }
    const ctx = crmCtx();
    if (!ctx) {
      crm.status = "idle";
      crm.bundle = null;
      crm.error = null;
      crmRender();
      return;
    }
    const seq = ++crmSeq;
    crm.lastKey = crmKeyOf(ctx);
    crm.status = "loading";
    crm.error = null;
    crmRender();
    try {
      const bundle = await data.getBundle(ctx, { force: !!opts.force });
      if (seq !== crmSeq) return; // a newer prospect landed while we waited
      crm.bundle = bundle;
      crm.status = "ready";
      crm.error = null;
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] CRM bundle for",
        bundle.email,
        "— contact:",
        bundle.contact ? bundle.contact.id : "none",
        "company:",
        bundle.company ? bundle.company.id : "none",
        "wiza user:",
        bundle.wiza && bundle.wiza.user && bundle.wiza.user.isUser ? "yes" : "no",
        "deals:",
        (bundle.deals || []).length,
        "activity:",
        (bundle.activity || []).length,
        "others at account:",
        (bundle.colleagues || []).length,
        // Which sections came back short, and why — the first thing to look at
        // when a rep says a section is empty or complaining.
        "section errors:",
        JSON.stringify(bundle.errors || {})
      );
    } catch (e) {
      if (seq !== crmSeq) return;
      crm.bundle = null;
      crm.status = "error";
      crm.error = {
        code: (e && e.code) || "TRANSIENT",
        message: e && e.message,
        retryAfterMs: e && e.retryAfterMs,
      };
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] CRM fetch failed:", crm.error.code, crm.error.message);
      if (crm.error.code === "RATE_LIMITED") startRateLimitRetry();
    }
    crmRender();
  }

  function scheduleCrmFetch(options) {
    clearTimeout(crmDebounceTimer);
    crmDebounceTimer = setTimeout(() => crmFetch(options), CRM_DEBOUNCE_MS);
  }

  // Called whenever either storage key or the connection state changes. Only a
  // change in what we would look up triggers a fetch.
  function crmSync(options) {
    const opts = options || {};
    const ctx = crmCtx();
    const key = crmKeyOf(ctx);
    if (!crm.connected || !ctx) {
      crm.status = "idle";
      crm.bundle = null;
      crm.error = null;
      crm.lastKey = null;
      cancelRetry();
      crmRender();
      return;
    }
    if (key === crm.lastKey && !opts.force && crm.status !== "idle") {
      crmRender();
      return;
    }
    // Record IDs arrive after the email (the Nooks HubSpot panes hydrate late).
    // If we already looked this prospect up and found nothing, the new IDs are
    // worth a fresh attempt — otherwise the cached miss would stand for 5 min.
    const idsAppeared =
      key !== crm.lastKey &&
      crm.bundle &&
      lower(crm.bundle.email) === ctx.email &&
      !crm.bundle.contact;
    scheduleCrmFetch({ force: !!opts.force || idsAppeared });
  }

  // Refresh lives in the settings popover; close it on click so the sections it
  // just reloaded are what the rep is looking at.
  crmEls.refresh.addEventListener("click", () => {
    const email = crmEmail();
    if (!data || !email) return;
    data.clearCache(email);
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] CRM refresh requested for", email);
    closeSettings();
    crmFetch({ force: true });
  });

  // The connection state is owned by the HubSpot section above; this is the one
  // signal the two share.
  function crmOnAuth(connected) {
    if (connected === crm.connected) return;
    crm.connected = connected;
    if (!connected && data) data.clearAll(); // caches belong to the token's portal
    // A fresh connection should show current data, not a bundle cached from
    // before the reconnect.
    crmSync({ force: connected });
  }

  // 1) Storage first — a capture may have happened while the panel was closed.
  chrome.storage.local.get([STORAGE_KEY, CONTEXT_KEY], (res) => {
    crm.fallbackEmail = (res && res[STORAGE_KEY] && res[STORAGE_KEY].email) || null;
    crm.ctx = (res && res[CONTEXT_KEY]) || null;
    crmSync();
  });

  // 2) Then live updates. eb:prospectContext is the interesting one;
  //    eb:currentProspect only contributes a fallback email.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    if (changes[CONTEXT_KEY]) {
      crm.ctx = changes[CONTEXT_KEY].newValue || null;
      touched = true;
    }
    if (changes[STORAGE_KEY]) {
      crm.fallbackEmail = (changes[STORAGE_KEY].newValue || {}).email || null;
      touched = true;
    }
    if (touched) crmSync();
  });

  renderHubSpot();
  crmRender();
  refreshHubSpotState();
})();

// ===========================================================================
// Notes → HubSpot sync (Phase 4). Its own IIFE so it shares nothing with the
// prospect card above except the document.
//
// Reads two capture keys and writes one: "eb:notes" (draft + saved notes + the
// last positively-saved note, written by content-nooks.js) and
// "eb:prospectContext" (HubSpot record IDs, written by content-nooks.js from the
// CRM panes) in; "eb:notes:lastSynced" (idempotency record) out. It also owns the
// "eb:settings" auto-sync preference, whose checkbox lives in the settings
// popover. Never touches "eb:currentProspect".
//
// Two ways a note reaches HubSpot, one code path (runSync):
//   - the Sync button, for anything in the editor including a draft, and
//   - auto-sync, only ever for a note the scraper saw the rep SAVE.
// Both write the same idempotency record, so a save that follows a manual sync of
// the same text — or a repeated save signal — cannot post twice.
//
// Note text is untrusted scraped input: it only ever reaches the DOM through
// .value / .textContent, never innerHTML.
// ===========================================================================
(() => {
  "use strict";

  const NOTES_KEY = "eb:notes";
  const CONTEXT_KEY = "eb:prospectContext";
  const SYNCED_KEY = "eb:notes:lastSynced";
  const SETTINGS_KEY = "eb:settings";
  // Auth state lives under the OAuth module's own keys; any change there means
  // the sign-in state may have flipped.
  const AUTH_KEY_PREFIX = "eb:hs";
  const HUBSPOT_URL_PREFIX = "https://app.hubspot.com/";

  const pillEl = document.getElementById("notes-pill");
  const hintEl = document.getElementById("notes-hint");
  const textEl = document.getElementById("notes-text");
  const countEl = document.getElementById("notes-count");
  const sourceEl = document.getElementById("notes-source");
  const savedEl = document.getElementById("notes-saved");
  const savedBodyEl = document.getElementById("notes-saved-body");
  const syncBtn = document.getElementById("notes-sync");
  const blockersEl = document.getElementById("notes-blockers");
  const resultEl = document.getElementById("notes-result");
  // Lives in the settings popover (see sidepanel.html); owned here because this
  // is the only place the preference means anything.
  const autoSyncEl = document.getElementById("setting-autosync");

  // The section is optional: if the markup isn't there, do nothing at all.
  if (!textEl || !syncBtn) return;

  const notesApi = () => (window.EB && window.EB.hubspotNotes) || null;

  const state = {
    notes: null, // eb:notes payload
    ctx: null, // eb:prospectContext payload
    lastSynced: null, // eb:notes:lastSynced record
    auth: { signedIn: false, ownerId: null, userId: null, available: false },
    settings: { autoSyncNotes: true }, // default ON until storage says otherwise
    text: "",
    userEdited: false, // the rep has typed: don't clobber their text
    syncing: false,
    confirmArmed: false, // re-sync confirmation is one click in
    result: null, // { kind: "ok"|"err", message, url }
    // The id of the last save signal this panel acted on (or deliberately
    // skipped). Set before any await, so one save can never start two syncs.
    autoHandledId: null,
  };

  // --- Derived values ------------------------------------------------------
  // The draft is what the rep just wrote, so that's what the editor is seeded
  // with. Saved notes are shown read-only below: auto-loading a whole note
  // history into the editor would make it far too easy to sync it by accident.
  const captureText = (notes) => (notes && notes.draft) || "";

  const prospectEmail = () =>
    (state.notes && state.notes.prospectEmail) || (state.ctx && state.ctx.email) || null;

  const contactId = () => (state.ctx && state.ctx.hsContactId) || null;
  const companyId = () => (state.ctx && state.ctx.hsCompanyId) || null;

  function currentHash() {
    const api = notesApi();
    return api ? api.syncHash(state.text, prospectEmail()) : null;
  }

  function alreadySynced() {
    const hash = currentHash();
    const last = state.lastSynced;
    return !!(hash && last && last.hash && last.hash === hash);
  }

  function ago(ts) {
    if (!ts) return "";
    const min = Math.round((Date.now() - ts) / 60000);
    if (min <= 0) return "just now";
    if (min < 60) return `${min}m ago`;
    return `${Math.round(min / 60)}h ago`;
  }

  // --- Rendering ----------------------------------------------------------
  function renderSaved() {
    const notes = state.notes;
    const blocks = [
      ["Prospect notes", notes && notes.savedProspectNotes],
      ["Account notes", notes && notes.savedAccountNotes],
    ].filter((entry) => !!entry[1]);

    savedBodyEl.textContent = "";
    savedEl.hidden = blocks.length === 0;
    if (!blocks.length) return;

    for (const [label, body] of blocks) {
      const wrap = document.createElement("div");
      wrap.className = "saved-block";
      const head = document.createElement("span");
      head.className = "saved-label";
      head.textContent = label;
      const text = document.createElement("span");
      text.textContent = body; // scraped input — textContent only, never innerHTML
      wrap.appendChild(head);
      wrap.appendChild(text);
      savedBodyEl.appendChild(wrap);
    }
  }

  function renderResult(display) {
    resultEl.textContent = "";
    resultEl.className = "";
    resultEl.hidden = !display;
    if (!display) return;
    resultEl.className = display.kind === "ok" ? "ok" : "err";
    resultEl.appendChild(document.createTextNode(display.message));
    // Only ever link to a URL this extension built from HubSpot record IDs.
    if (display.url && String(display.url).indexOf(HUBSPOT_URL_PREFIX) === 0) {
      resultEl.appendChild(document.createTextNode(" "));
      const link = document.createElement("a");
      link.href = display.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open in HubSpot";
      resultEl.appendChild(link);
    }
  }

  function render() {
    const api = notesApi();
    const text = state.text;
    const trimmed = text.trim();
    const synced = alreadySynced();

    if (textEl.value !== text) textEl.value = text;
    textEl.disabled = state.syncing;

    // Character count. The real ceiling is on the HTML HubSpot stores, so that's
    // what gets shown once it matters.
    if (api && trimmed) {
      const bodyLen = api.buildNoteBody(trimmed).length;
      const over = bodyLen > api.MAX_BODY_CHARS;
      countEl.classList.toggle("over", over);
      countEl.textContent = over
        ? `${bodyLen.toLocaleString()} / ${api.MAX_BODY_CHARS.toLocaleString()} characters once formatted — too long`
        : `${trimmed.length.toLocaleString()} characters`;
    } else {
      countEl.classList.remove("over");
      countEl.textContent = "";
    }

    // Where the text came from, and whether the dialer has since moved on.
    const capture = captureText(state.notes);
    if (state.userEdited && capture && capture !== text) {
      sourceEl.textContent = "your edits (dialer draft has changed)";
    } else if (state.userEdited && trimmed) {
      sourceEl.textContent = "your edits";
    } else if (capture) {
      sourceEl.textContent = `draft from the dialer, ${ago(state.notes && state.notes.capturedAt)}`;
    } else {
      sourceEl.textContent = "";
    }

    // Hint: only rendered when it has direction to give. In the normal state —
    // a note is here and the prospect is matched — it restated the textarea's
    // own placeholder, so it is hidden rather than spending two lines at 320px.
    if (!state.ctx) {
      hintEl.hidden = false;
      hintEl.textContent =
        "Prospect not matched yet — open the prospect in the dialer so Dialer Helper Pro can read its HubSpot records.";
    } else if (!capture && !trimmed) {
      hintEl.hidden = false;
      hintEl.textContent = "No note captured yet — write one in the dialer, or type it here.";
    } else {
      hintEl.hidden = true;
      hintEl.textContent = "";
    }

    renderSaved();

    // Pill + button state machine.
    const autoSynced = !!(synced && state.lastSynced && state.lastSynced.auto);
    pillEl.hidden = !synced;
    pillEl.className = "pill synced";
    if (synced) pillEl.textContent = autoSynced ? "Auto-synced ✓" : "Already synced ✓";

    const gate = api
      ? api.syncGate({
          signedIn: state.auth.signedIn,
          text: text,
          contactId: contactId(),
          companyId: companyId(),
          syncing: state.syncing,
        })
      : { enabled: false, reasons: ["Notes sync isn't available in this build."], tooLong: false };

    syncBtn.disabled = !gate.enabled;
    if (state.syncing) syncBtn.textContent = "Syncing…";
    else if (synced && state.confirmArmed) syncBtn.textContent = "Click again to confirm re-sync";
    else if (synced) syncBtn.textContent = "Sync again";
    else syncBtn.textContent = "Sync to HubSpot";

    blockersEl.textContent = gate.reasons.join(" ");
    syncBtn.title = gate.enabled
      ? "Creates a HubSpot note on the matched contact and company, attributed to you."
      : gate.reasons.join(" ");

    // A standing synced line when there's no fresher result to show. An
    // auto-sync has no click behind it, so this passive, timestamped line *is*
    // how the rep learns it happened.
    let display = state.result;
    if (!display && synced && state.lastSynced) {
      const targets = state.lastSynced.targets || "HubSpot";
      const verb = autoSynced ? "Auto-synced" : "Already synced";
      display = {
        kind: "ok",
        message: `${verb} to ${targets} ${ago(state.lastSynced.syncedAt)} ✓`,
        url: state.lastSynced.url,
      };
    }
    if (state.confirmArmed && synced) {
      display = {
        kind: "err",
        message: "This exact note is already on the record. Click again to add a second copy.",
        url: null,
      };
    }
    renderResult(display);
  }

  // --- State transitions --------------------------------------------------
  function applyNotes(next) {
    const prevEmail = state.notes && state.notes.prospectEmail;
    const nextEmail = next && next.prospectEmail;
    state.notes = next || null;
    // Only a genuine prospect *change* discards the rep's work. A capture whose
    // email was still unknown a moment ago is the same prospect being
    // identified, not a new one.
    if (nextEmail && prevEmail && nextEmail !== prevEmail) {
      // New prospect: nothing carried over, including a half-typed edit.
      state.userEdited = false;
      state.result = null;
      state.confirmArmed = false;
      state.text = captureText(next);
    } else if (!state.userEdited) {
      state.text = captureText(next);
    }
    render();
    // A capture can carry a "the rep just saved this" signal; that's the only
    // thing auto-sync ever acts on.
    maybeAutoSync(next);
  }

  function applyContext(next) {
    const prevEmail = state.ctx && state.ctx.email;
    state.ctx = next || null;
    if ((next && next.email) !== prevEmail) {
      state.result = null;
      state.confirmArmed = false;
    }
    render();
  }

  async function refreshAuth() {
    const auth = window.EB && window.EB.hubspotAuth;
    if (!auth || typeof auth.getAuthState !== "function") {
      state.auth = { signedIn: false, ownerId: null, userId: null, available: false };
      render();
      return;
    }
    try {
      const info = (await Promise.resolve(auth.getAuthState())) || {};
      // `connected` is authoritative when present. It is checked before the loose
      // fallback because a *disconnected* state can still carry a cached ownerId
      // or email, and treating that as signed in would let auto-sync fire against
      // a connection that no longer exists.
      const signedIn =
        info.signedIn !== undefined
          ? !!info.signedIn
          : info.connected !== undefined
            ? !!info.connected
            : !!(info.ownerId || info.email || info.accessToken);
      state.auth = {
        signedIn,
        ownerId: info.ownerId || null,
        userId: info.userId || null,
        available: true,
      };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes: could not read HubSpot auth state:", (e && e.message) || e);
      state.auth = { signedIn: false, ownerId: null, userId: null, available: true };
    }
    render();
  }

  // The owner ID is what attributes the note ("Activity assigned to"). It can be
  // missing on a connection whose one-shot lookup failed at login, so ask the auth
  // module to resolve it on demand — that heals the stored record for good. A
  // failure here never blocks the sync: an unattributed note beats a lost one.
  async function resolveOwnerId() {
    if (state.auth.ownerId) return state.auth.ownerId;
    const auth = window.EB && window.EB.hubspotAuth;
    if (!auth || typeof auth.ensureOwnerId !== "function") return null;
    try {
      const ownerId = await auth.ensureOwnerId();
      if (ownerId) {
        state.auth.ownerId = ownerId;
        return ownerId;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes: owner lookup failed:", (e && e.message) || e);
      return null;
    }
    // eslint-disable-next-line no-console
    console.debug(
      "[EasyBooking] notes: no HubSpot owner id available — syncing the note unattributed"
    );
    return null;
  }

  // --- Sync ---------------------------------------------------------------
  // The one path to HubSpot. `source` is "manual" or "auto" and changes nothing
  // but the copy and the flag stored on the idempotency record — so an auto-sync
  // and a click are indistinguishable to HubSpot, and to the duplicate check.
  async function runSync(text, source) {
    const api = notesApi();
    if (!api) return false;
    const targets = api.targetSummary(contactId(), companyId());
    const auto = source === "auto";

    state.syncing = true;
    state.result = null;
    render();

    try {
      const ownerId = await resolveOwnerId();
      const res = await api.createNote({
        text,
        contactId: contactId(),
        companyId: companyId(),
        ownerId,
        // The SDR's HubSpot *user* id, which is not their owner id — it's what
        // hs_created_by ("Activity created by") wants.
        userId: state.auth.userId,
      });
      const record = {
        hash: api.syncHash(text, prospectEmail()),
        noteId: res.noteId,
        url: res.url,
        prospectEmail: prospectEmail(),
        targets,
        syncedAt: Date.now(),
        auto,
      };
      await chrome.storage.local.set({ [SYNCED_KEY]: record });
      state.lastSynced = record;
      // An auto-sync normally leaves `result` null so render()'s standing line
      // ("Auto-synced to … just now ✓") owns the message and keeps its timestamp
      // honest. That line only appears when the editor still holds the synced
      // text, though — if the rep has typed something else, say it explicitly
      // rather than let a successful sync go unmentioned.
      state.result =
        auto && alreadySynced()
          ? null
          : {
              kind: "ok",
              message: `${auto ? "Auto-synced" : "Note added"} to ${targets || "HubSpot"} ✓`,
              url: res.url,
            };
      // eslint-disable-next-line no-console
      console.debug(
        `[EasyBooking] notes ${auto ? "auto-" : ""}synced:`,
        record.noteId,
        `-> ${targets}`,
        `owner=${ownerId || "none"}`,
        res.createdByDowngraded ? "(created-by left to HubSpot)" : ""
      );
      return true;
    } catch (e) {
      // Never drop a note quietly: say so, and leave the manual button as the way
      // out. On an auto-sync the rep didn't ask for anything, so the message says
      // what failed before what to do.
      const detail = errorMessage(e);
      state.result = {
        kind: "err",
        message: auto ? `Couldn't auto-sync that note. ${detail}` : detail,
        url: null,
      };
      // eslint-disable-next-line no-console
      console.debug(
        `[EasyBooking] notes ${auto ? "auto-" : ""}sync failed:`,
        (e && e.code) || "?",
        (e && e.message) || e
      );
      return false;
    } finally {
      state.syncing = false;
      state.confirmArmed = false;
      render();
    }
  }

  async function doSync() {
    const api = notesApi();
    if (!api || state.syncing) return;

    const gate = api.syncGate({
      signedIn: state.auth.signedIn,
      text: state.text,
      contactId: contactId(),
      companyId: companyId(),
      syncing: false,
    });
    if (!gate.enabled) {
      render();
      return;
    }

    // Idempotency: the same text for the same prospect needs an explicit
    // second click before it goes in twice.
    if (alreadySynced() && !state.confirmArmed) {
      state.confirmArmed = true;
      render();
      return;
    }

    await runSync(state.text, "manual");
  }

  // --- Auto-sync on save --------------------------------------------------
  // Only ever driven by content-nooks.js's `lastSaved` signal, which is emitted
  // exclusively for a note the rep positively saved in the dialer. Everything
  // here is a reason NOT to sync; the sync itself is the same runSync() the
  // button uses, so the idempotency record covers both.
  //
  // A signal older than this is left to the button: it likely predates the panel
  // being open, and silently posting an hours-old note is worse than not.
  const AUTO_MAX_AGE_MS = 30 * 60 * 1000;

  function autoSkip(reason) {
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] notes: not auto-syncing —", reason);
  }

  function maybeAutoSync(notes) {
    const api = notesApi();
    const saved = notes && notes.lastSaved;
    const text = saved && typeof saved.text === "string" ? saved.text.trim() : "";
    if (!saved || !text) return;

    const id = saved.id || `${saved.savedAt || 0}-${text.length}`;
    // One signal, one attempt — set before anything can await, so a burst of
    // captures carrying the same save can't start a second sync.
    if (state.autoHandledId === id) return;
    state.autoHandledId = id;

    if (!state.settings.autoSyncNotes) return autoSkip("auto-sync is off in Settings");
    if (!api) return autoSkip("notes sync isn't available in this build");
    if (!state.auth.signedIn) return autoSkip("HubSpot isn't connected");
    if (state.syncing) return autoSkip("a sync is already in flight");
    if (saved.savedAt && Date.now() - saved.savedAt > AUTO_MAX_AGE_MS) {
      return autoSkip("that save is too old to sync on its own");
    }
    // Bleed guard: the note belongs to the prospect it was taken for. The scraper
    // clears its own state on a prospect change; this catches the window where
    // the capture and the CRM context disagree.
    const ctxEmail = state.ctx && state.ctx.email;
    if (notes.prospectEmail && ctxEmail && notes.prospectEmail !== ctxEmail) {
      return autoSkip("the prospect changed after that note was captured");
    }
    if (!contactId() && !companyId()) {
      return autoSkip("this prospect has no matched HubSpot record yet");
    }
    const hash = api.syncHash(text, prospectEmail());
    if (state.lastSynced && state.lastSynced.hash === hash) {
      return autoSkip("that exact note is already on the record");
    }
    const gate = api.syncGate({
      signedIn: state.auth.signedIn,
      text,
      contactId: contactId(),
      companyId: companyId(),
      syncing: false,
    });
    if (!gate.enabled) return autoSkip(gate.reasons.join(" "));

    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] notes: auto-syncing saved note", id, `(${text.length}ch)`);
    // Make sure the editor holds what we're about to send, so that if it fails
    // the Sync button is a real fallback rather than a different note.
    if (!state.userEdited && state.text.trim() !== text) {
      state.text = saved.text;
      render();
    }
    runSync(saved.text, "auto");
  }

  // Typed errors from hubspot-notes.js carry their own rep-readable message; this
  // only adds the bits that depend on panel state. Anything *untyped* reaching
  // here is a bug, and its raw message (a TypeError, a stack) is no use to a rep —
  // so it gets the generic line and the detail goes to the console.
  function errorMessage(e) {
    const api = notesApi();
    const codes = (api && api.ERROR_CODES) || [];
    const typed = !!(e && e.code && codes.indexOf(e.code) !== -1 && e.message);
    if (!typed) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes sync failed with an untyped error:", e);
      return "Sync failed. Try again — your note text is still here.";
    }
    switch (e.code) {
      case "MISSING_SCOPES":
        return `${e.message} (Nothing was written to HubSpot.)`;
      case "TRANSIENT":
        return `${e.message} Your note text is still here.`;
      default:
        return e.message;
    }
  }

  // --- Settings ------------------------------------------------------------
  // One object under "eb:settings" so later preferences don't each need a key.
  // Auto-sync defaults ON, which means "absent" and "true" must read the same.
  function readSettings(stored) {
    const raw = stored && typeof stored === "object" ? stored : {};
    return { autoSyncNotes: raw.autoSyncNotes !== false };
  }

  function renderSettings() {
    if (autoSyncEl) autoSyncEl.checked = !!state.settings.autoSyncNotes;
  }

  async function setAutoSync(on) {
    state.settings = { ...state.settings, autoSyncNotes: !!on };
    renderSettings();
    try {
      const res = (await chrome.storage.local.get(SETTINGS_KEY)) || {};
      const merged = { ...(res[SETTINGS_KEY] || {}), autoSyncNotes: !!on };
      await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes: could not save the auto-sync setting:", (e && e.message) || e);
    }
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] notes: auto-sync on save is", on ? "on" : "off");
  }

  // --- Wiring -------------------------------------------------------------
  if (autoSyncEl) {
    autoSyncEl.addEventListener("change", () => {
      setAutoSync(autoSyncEl.checked);
    });
  }

  textEl.addEventListener("input", () => {
    state.text = textEl.value;
    state.userEdited = true;
    state.confirmArmed = false;
    state.result = null;
    render();
  });

  syncBtn.addEventListener("click", () => {
    doSync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[NOTES_KEY]) {
      const next = changes[NOTES_KEY].newValue;
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] side panel: notes updated ->",
        (next && next.prospectEmail) || "(cleared)"
      );
      applyNotes(next);
    }
    if (changes[CONTEXT_KEY]) applyContext(changes[CONTEXT_KEY].newValue);
    if (changes[SYNCED_KEY]) {
      state.lastSynced = changes[SYNCED_KEY].newValue || null;
      render();
    }
    // A second panel document (another window) may have flipped the toggle.
    if (changes[SETTINGS_KEY]) {
      state.settings = readSettings(changes[SETTINGS_KEY].newValue);
      renderSettings();
    }
    if (Object.keys(changes).some((k) => k.indexOf(AUTH_KEY_PREFIX) === 0)) refreshAuth();
  });

  // Sign-in happens elsewhere in this document (and in a popup window); re-read
  // the auth state whenever the panel comes back into view.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAuth();
  });

  // Storage first — captures that happened while the panel was closed only
  // exist there. Auth and the settings are read BEFORE the notes: applyNotes can
  // trigger an auto-sync, and it must not skip one for "not connected" just
  // because we hadn't looked yet.
  (async () => {
    const res =
      (await chrome.storage.local.get([NOTES_KEY, CONTEXT_KEY, SYNCED_KEY, SETTINGS_KEY])) || {};
    state.lastSynced = res[SYNCED_KEY] || null;
    state.ctx = res[CONTEXT_KEY] || null;
    state.settings = readSettings(res[SETTINGS_KEY]);
    renderSettings();
    await refreshAuth();
    applyNotes(res[NOTES_KEY]);
  })();
})();
