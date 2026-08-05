// sidepanel.js — the side panel replaces the old toolbar popup.
//
// Three independent concerns live here, each with its own state object and
// render function: the captured-prospect card (ported from popup.js), the
// HubSpot connection (Phase 2), and the live CRM context — contact, company,
// deals, activity (Phase 3). They share the document and one signal: whether
// HubSpot is connected.
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
    if (!payload.capturedAt) return "captured from dialer";
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
      ? "Add CLIENT_ID and TOKEN_PROXY_URL to hubspot-config.js, then reload the extension."
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

  function hsErrorText(e) {
    const code = e && e.code;
    if (code === "CANCELLED") return "Connection cancelled.";
    if (code === "NOT_CONNECTED") return "HubSpot connection expired — connect again.";
    if (code === "STATE_MISMATCH") return "Connection failed a security check. Try again.";
    if (code === "CONFIG_MISSING") {
      return "CLIENT_ID / TOKEN_PROXY_URL missing in hubspot-config.js.";
    }
    // The token service refused us rather than HubSpot — a deployment problem,
    // so say so instead of implying the SDR did something wrong.
    if (code === "PROXY_ERROR") {
      return `HubSpot token service error (${(e && e.proxyError) || "unknown"}). Check TOKEN_PROXY_URL and that the function is deployed.`;
    }
    if (code === "REFRESH_FAILED") return "Couldn't reach the HubSpot token service. Try again.";
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

  // ==========================================================================
  // CRM context — identity block, Wiza product data, Deals, Activity.
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

  const crmEls = {
    refresh: document.getElementById("crm-refresh"),
    identity: document.getElementById("crm-identity"),
    identityPill: document.getElementById("crm-identity-pill"),
    wiza: document.getElementById("crm-wiza"),
    wizaPill: document.getElementById("crm-wiza-pill"),
    deals: document.getElementById("crm-deals"),
    dealsPill: document.getElementById("crm-deals-pill"),
    activity: document.getElementById("crm-activity"),
    activityPill: document.getElementById("crm-activity-pill"),
    activityTabs: document.getElementById("crm-activity-tabs"),
  };
  const crmBodies = [crmEls.identity, crmEls.wiza, crmEls.deals, crmEls.activity];

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

  // Monochrome glyphs (not emoji) so the row reads the same on every OS.
  const ACT_ICON = { calls: "☎", emails: "✉", meetings: "◷", notes: "✎", tasks: "✓" };

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

  // Returns null for an empty value so callers can skip the row entirely
  // rather than rendering a label with a dash under it. This is the whole
  // null-safety strategy for the Wiza section: build every possible row, let the
  // empty ones evaporate.
  function kv(label, value, hoverTitle) {
    if (value == null || value === "") return null;
    const row = el("div", "kv");
    row.appendChild(el("span", "kv-label", label));
    row.appendChild(el("span", "kv-value", value));
    if (hoverTitle) row.title = hoverTitle;
    return row;
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

  // `variant` picks the colour (see the .pill rules in sidepanel.html); it is a
  // class name we choose, never a value from HubSpot. Omit it for the default
  // muted outline; pass "" for the plain (green) pill.
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

  function crmKeyOf(ctx) {
    if (!ctx) return null;
    return `${ctx.email}|${ctx.hsContactId || ""}|${ctx.hsCompanyId || ""}`;
  }

  function crmErrorText(err) {
    const code = err && err.code;
    if (code === "RATE_LIMITED") {
      const secs = crm.retrySecs == null ? "a few" : crm.retrySecs;
      return `HubSpot rate limit — retrying in ${secs}s`;
    }
    if (code === "AUTH") return "HubSpot sign-in expired — connect again above.";
    if (code === "NOT_FOUND") return "Nothing to look up for this prospect.";
    return "Couldn't reach HubSpot. Click Refresh to try again.";
  }

  // Deals and activity can fail on their own without sinking the bundle.
  function sectionErrorText(code, retryAfterMs) {
    if (code === "RATE_LIMITED") {
      const secs = Math.max(1, Math.round((Number(retryAfterMs) || 10000) / 1000));
      return `HubSpot rate limit — retrying in ${secs}s`;
    }
    if (code === "AUTH") return "HubSpot sign-in expired — connect again above.";
    return "Couldn't load this section. Click Refresh to try again.";
  }

  // --- section renderers ---------------------------------------------------
  // One block for both records, three lines deep:
  //   1  Name · lifecycle stage
  //   2  Title @ Company        (both linked to their HubSpot records)
  //   3  Owner · phone · lead status
  // The company's domain, industry and headcount ride along as the company
  // link's hover text — kept, but not spending a row each.
  function renderIdentitySection(bundle) {
    const body = crmEls.identity;
    const c = bundle.contact;
    const co = bundle.company;

    if (!c && !co) {
      setPill(crmEls.identityPill, "Not in HubSpot");
      setNote(body, `No HubSpot contact for ${bundle.email}`);
      return;
    }
    // A company matched by email domain with no contact record is a real state:
    // say so rather than pretending the identity is complete.
    setPill(crmEls.identityPill, c ? null : "No contact record");
    clearNode(body);

    const block = el("div", "ident");

    const line1 = el("div", "ident-line");
    line1.appendChild(recordLink(c ? c.name : bundle.email, c && c.url, "rec-name"));
    if (c && c.lifecycleStage) {
      line1.appendChild(el("span", "pill stage tiny", c.lifecycleStage));
    }
    block.appendChild(line1);

    const role = el("div", "ident-role");
    if (c && c.title) role.appendChild(el("span", null, c.title));
    if (co) {
      if (c && c.title) role.appendChild(el("span", "at", " @ "));
      const link = recordLink(co.name, co.url, "link");
      const about = [co.domain, co.industry, co.employees != null ? `${fmt.number(co.employees)} employees` : null]
        .filter(Boolean)
        .join(" · ");
      if (about) link.title = about;
      role.appendChild(link);
    }
    if (role.childElementCount) block.appendChild(role);

    const meta = el("div", "ident-meta");
    const owner = (c && c.ownerName) || (co && co.ownerName) || null;
    appendAll(meta, [
      owner ? el("span", null, owner) : null,
      c && c.phone ? el("span", null, c.phone) : null,
      c && c.leadStatus ? el("span", null, c.leadStatus) : null,
    ]);
    if (meta.childElementCount) block.appendChild(meta);

    body.appendChild(block);
  }

  // active → green (the default pill), closed → muted outline, anything else a
  // portal admin adds later → the neutral "info" treatment.
  function wizaStatusVariant(status) {
    if (status === "active") return "";
    if (status === "closed") return "closed";
    return "info";
  }

  // Wiza product data. Absence is the normal case — most prospects have never
  // signed up — so the empty path is a single muted line, and inside each
  // subsection every row that has no value is simply not built.
  function renderWizaSection(bundle) {
    const body = crmEls.wiza;
    const wiza = bundle.wiza || {};
    const user = wiza.user || {};
    const account = wiza.account || {};

    if (!user.isUser && !account.hasData) {
      setPill(crmEls.wizaPill, null);
      setNote(body, "Not a Wiza user yet");
      return;
    }
    // Status at section level so it's readable without opening anything.
    const variant = wizaStatusVariant(user.status);
    setPill(crmEls.wizaPill, user.statusLabel, variant);
    clearNode(body);

    if (user.isUser) {
      const sub = el("div", "wiza-sub");
      const head = el("div", "wiza-head");
      head.appendChild(el("span", "wiza-label", "User"));
      if (user.statusLabel) {
        head.appendChild(el("span", ("pill tiny " + variant).trim(), user.statusLabel));
      }
      // Only worth saying when it's false — an unconfirmed email explains a lot
      // of "signed up but never used it" records.
      if (user.emailConfirmed === false) {
        head.appendChild(el("span", "pill info tiny", "Email unconfirmed"));
      }
      sub.appendChild(head);

      const plan = [
        user.planStatus,
        user.planCredits != null ? `${fmt.number(user.planCredits)} credits` : null,
        user.planFrequency,
      ]
        .filter(Boolean)
        .join(" · ");

      const grid = el("div", "kv-grid");
      appendAll(grid, [
        kv("Signed up", user.signedUpAt ? fmt.date(user.signedUpAt) : null),
        kv("Plan", plan),
        kv("Credits (30d)", user.creditsUsed30d != null ? fmt.number(user.creditsUsed30d) : null),
        kv(
          "Last used",
          user.lastUsageAt ? fmt.relativeTime(user.lastUsageAt) : null,
          user.lastUsageAt ? fmt.dateTime(user.lastUsageAt) : null
        ),
        kv("Wiza ID", user.wizaId),
      ]);
      if (grid.childElementCount) sub.appendChild(grid);

      // Both links come from URL properties and are only rendered when set.
      const links = el("div", "wiza-links");
      appendAll(links, [
        extLink("Open in Wiza Admin", user.adminUrl),
        extLink("Usage logs", user.usageLogsUrl),
      ]);
      if (links.childElementCount) sub.appendChild(links);

      body.appendChild(sub);
    } else if (account.hasData) {
      // Account data but nobody signed up: the company is known to us, this
      // person isn't.
      body.appendChild(el("p", "crm-note", "Not a Wiza user yet"));
    }

    if (account.hasData) {
      const sub = el("div", "wiza-sub");
      const head = el("div", "wiza-head");
      head.appendChild(el("span", "wiza-label", "Account"));
      if (account.isTargetAccount) {
        head.appendChild(el("span", "pill stage tiny", "Target account"));
      }
      sub.appendChild(head);

      const accounts =
        account.subscribedAccounts != null && account.associatedAccounts != null
          ? `${fmt.number(account.subscribedAccounts)} of ${fmt.number(account.associatedAccounts)}`
          : account.subscribedAccounts != null
            ? fmt.number(account.subscribedAccounts)
            : null;
      const purchase = [
        account.lastPurchaseAt ? fmt.date(account.lastPurchaseAt) : null,
        account.timesPurchased != null ? `${fmt.number(account.timesPurchased)}×` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const grid = el("div", "kv-grid");
      appendAll(grid, [
        kv("Account ID", account.accountId || account.primaryAccountId),
        kv("Subscribed", accounts),
        kv(
          "API credits",
          account.apiCreditBalance != null ? fmt.number(account.apiCreditBalance) : null
        ),
        kv("Credits (30d)", account.creditsUsed30d != null ? fmt.number(account.creditsUsed30d) : null),
        kv("Last purchase", purchase),
        kv("ICP", account.icp),
        kv("Industry", account.industry),
        kv("Use case", account.useCase),
      ]);
      if (grid.childElementCount) sub.appendChild(grid);
      body.appendChild(sub);
    }
  }

  function renderDealsSection(bundle) {
    const body = crmEls.deals;
    const errors = bundle.errors || {};
    if (errors.deals) {
      setPill(crmEls.dealsPill, null);
      setNote(body, sectionErrorText(errors.deals, errors.dealsRetryAfterMs), true);
      return;
    }
    const deals = bundle.deals || [];
    setPill(crmEls.dealsPill, deals.length ? String(deals.length) : null);
    if (!deals.length) {
      setNote(body, "No open deals");
      return;
    }
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

      body.appendChild(row);
    }
  }

  // One activity row. Everything type-specific (disposition · duration, meeting
  // outcome, task status, note preview) arrives pre-composed in item.detail from
  // hubspot-data.js; this is layout plus attribution.
  function activityRow(item) {
    const row = el("div", "act");
    row.appendChild(el("span", "act-icon", ACT_ICON[item.type] || "·"));

    const main = el("div", "act-main");
    const top = el("div", "act-top");
    top.appendChild(el("span", "act-type", item.label));
    if (item.direction) {
      const arrow = el("span", null, item.direction === "out" ? "↑" : "↓");
      arrow.title = item.direction === "out" ? "Outbound" : "Inbound";
      top.appendChild(arrow);
    }
    // Only ever a resolved name. An engagement whose owner (or creator) we
    // couldn't resolve renders with no attribution rather than a raw ID.
    if (item.ownerName) top.appendChild(el("span", "act-owner", `by ${item.ownerName}`));
    const when = fmt.relativeTime(item.timestamp);
    if (when) {
      const stamp = el("span", "act-when", when);
      const exact = fmt.dateTime(item.timestamp);
      if (exact) stamp.title = exact; // relative in the row, absolute on hover
      top.appendChild(stamp);
    }
    main.appendChild(top);

    main.appendChild(el("div", "act-summary", item.summary || item.label));
    if (item.detail) main.appendChild(el("div", "act-detail", item.detail));

    row.appendChild(main);
    return row;
  }

  // The tab bar. Rebuilt on every render because the counts are per prospect;
  // the click/keyboard handlers are bound once to the container below.
  function renderActivityTabs(items) {
    const bar = crmEls.activityTabs;
    clearNode(bar);
    bar.style.display = "";
    for (const tab of data.activity.tabs(items)) {
      const btn = el("button", "tab");
      btn.type = "button";
      btn.id = `crm-tab-${tab.key}`;
      btn.dataset.tab = tab.key;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-controls", "crm-activity");
      btn.setAttribute("aria-selected", tab.key === crm.activeTab ? "true" : "false");
      // aria-disabled rather than the disabled attribute: an empty tab stays
      // discoverable to a screen reader (it reports "Meetings 0, dimmed")
      // instead of vanishing from the bar. Clicks and arrow keys skip it.
      if (tab.disabled) btn.setAttribute("aria-disabled", "true");
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
    if (errors.activity) {
      setPill(crmEls.activityPill, null);
      setNote(body, sectionErrorText(errors.activity, errors.activityRetryAfterMs), true);
      return;
    }
    const items = bundle.activity || [];
    setPill(crmEls.activityPill, items.length ? String(items.length) : null);
    if (!items.length) {
      setNote(body, "No activity logged yet");
      return;
    }
    // Keep the rep's tab if it still has rows for this prospect, else "All".
    crm.activeTab = data.activity.resolveTab(items, crm.activeTab);
    renderActivityTabs(items);

    clearNode(body);
    for (const item of data.activity.filter(items, crm.activeTab)) {
      body.appendChild(activityRow(item));
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

  function crmRender() {
    const email = crmEmail();
    crmEls.refresh.disabled = !(data && crm.connected && email && crm.status !== "loading");
    setPill(crmEls.identityPill, null);
    setPill(crmEls.wizaPill, null);
    setPill(crmEls.dealsPill, null);
    setPill(crmEls.activityPill, null);
    // Nothing below this point shows tabs unless a bundle is actually rendered.
    hideActivityTabs();

    if (!data) {
      for (const body of crmBodies) setNote(body, "hubspot-data.js failed to load.", true);
      return;
    }
    if (!crm.connected) {
      for (const body of crmBodies) setNote(body, "Connect HubSpot to see CRM data");
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
        (bundle.activity || []).length
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

  crmEls.refresh.addEventListener("click", () => {
    const email = crmEmail();
    if (!data || !email) return;
    data.clearCache(email);
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] CRM refresh requested for", email);
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
