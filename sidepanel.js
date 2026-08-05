// sidepanel.js — the side panel replaces the old toolbar popup.
//
// Differences from popup.js that matter: the panel document stays open while the
// rep moves between the Nooks and scheduler tabs, so it cannot read storage once
// and be done. It reads storage at load (the source of truth — anything that
// happened while the panel was closed is only visible there), then subscribes to
// chrome.storage.onChanged and re-renders live, and ticks a timer so the capture
// age line stays honest without a user action.
//
// Plain script (no import/export) on purpose: CI syntax-checks .js with
// `node --check`, which parses them as CommonJS. Shared ES modules land in a
// later phase as .mjs.

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

  fillBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !SCHEDULER_URL_RE.test(tab.url || "")) {
      setNotice("Open the booking tab first, then click again.");
      return;
    }
    // Re-trigger the scheduler content script by nudging storage (its onChanged
    // listener will re-attempt the fill).
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
})();

// ===========================================================================
// Notes → HubSpot sync (Phase 4). Its own IIFE so it shares nothing with the
// prospect card above except the document.
//
// Reads two capture keys and writes one: "eb:notes" (draft + saved notes,
// written by content-nooks.js) and "eb:prospectContext" (HubSpot record IDs,
// written by content-nooks.js from the CRM panes) in; "eb:notes:lastSynced"
// (idempotency record) out. Never touches "eb:currentProspect".
//
// Note text is untrusted scraped input: it only ever reaches the DOM through
// .value / .textContent, never innerHTML.
// ===========================================================================
(() => {
  "use strict";

  const NOTES_KEY = "eb:notes";
  const CONTEXT_KEY = "eb:prospectContext";
  const SYNCED_KEY = "eb:notes:lastSynced";
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

  // The section is optional: if the markup isn't there, do nothing at all.
  if (!textEl || !syncBtn) return;

  const notesApi = () => (window.EB && window.EB.hubspotNotes) || null;

  const state = {
    notes: null, // eb:notes payload
    ctx: null, // eb:prospectContext payload
    lastSynced: null, // eb:notes:lastSynced record
    auth: { signedIn: false, ownerId: null, available: false },
    text: "",
    userEdited: false, // the rep has typed: don't clobber their text
    syncing: false,
    confirmArmed: false, // re-sync confirmation is one click in
    result: null, // { kind: "ok"|"err", message, url }
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
        ? `${bodyLen.toLocaleString()} / ${api.MAX_BODY_CHARS.toLocaleString()} characters as HubSpot HTML — too long`
        : `${trimmed.length.toLocaleString()} characters`;
    } else {
      countEl.classList.remove("over");
      countEl.textContent = "";
    }

    // Where the text came from, and whether the dialer has since moved on.
    const capture = captureText(state.notes);
    if (state.userEdited && capture && capture !== text) {
      sourceEl.textContent = "your edits · dialer draft has changed";
    } else if (state.userEdited && trimmed) {
      sourceEl.textContent = "your edits";
    } else if (capture) {
      sourceEl.textContent = `draft from the dialer · ${ago(state.notes && state.notes.capturedAt)}`;
    } else {
      sourceEl.textContent = "";
    }

    // Hint: the most useful thing to say about the current state.
    if (!state.ctx) {
      hintEl.textContent =
        "Prospect not matched yet — open the prospect in the dialer so Dialer Helper Pro can read its HubSpot records.";
    } else if (!capture && !trimmed) {
      hintEl.textContent = "No note captured yet — write one in the dialer, or type it here.";
    } else {
      hintEl.textContent = "Call notes from the dialer, ready to sync to HubSpot.";
    }

    renderSaved();

    // Pill + button state machine.
    pillEl.hidden = !synced;
    pillEl.className = "pill synced";
    if (synced) pillEl.textContent = "Already synced ✓";

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

    // A standing "already synced" line when there's no fresher result to show.
    let display = state.result;
    if (!display && synced && state.lastSynced) {
      const targets = state.lastSynced.targets || "HubSpot";
      display = {
        kind: "ok",
        message: `Already synced to ${targets} ${ago(state.lastSynced.syncedAt)} ✓`,
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
      state.auth = { signedIn: false, ownerId: null, available: false };
      render();
      return;
    }
    try {
      const info = (await Promise.resolve(auth.getAuthState())) || {};
      const signedIn =
        info.signedIn !== undefined
          ? !!info.signedIn
          : !!(info.connected || info.ownerId || info.email || info.accessToken);
      state.auth = { signedIn, ownerId: info.ownerId || null, available: true };
    } catch (e) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes: could not read HubSpot auth state:", (e && e.message) || e);
      state.auth = { signedIn: false, ownerId: null, available: true };
    }
    render();
  }

  // --- Sync ---------------------------------------------------------------
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

    state.syncing = true;
    state.result = null;
    render();

    const targets = api.targetSummary(contactId(), companyId());
    try {
      const res = await api.createNote({
        text: state.text,
        contactId: contactId(),
        companyId: companyId(),
        ownerId: state.auth.ownerId,
      });
      const record = {
        hash: api.syncHash(state.text, prospectEmail()),
        noteId: res.noteId,
        url: res.url,
        prospectEmail: prospectEmail(),
        targets,
        syncedAt: Date.now(),
      };
      await chrome.storage.local.set({ [SYNCED_KEY]: record });
      state.lastSynced = record;
      state.result = {
        kind: "ok",
        message: `Note added to ${targets || "HubSpot"} ✓`,
        url: res.url,
      };
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes synced:", record.noteId, `-> ${targets}`);
    } catch (e) {
      state.result = { kind: "err", message: errorMessage(e), url: null };
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] notes sync failed:", (e && e.code) || "?", (e && e.message) || e);
    } finally {
      state.syncing = false;
      state.confirmArmed = false;
      render();
    }
  }

  // Typed errors carry their own rep-readable message; this only adds the bits
  // that depend on panel state.
  function errorMessage(e) {
    const base = (e && e.message) || "Sync failed. Try again.";
    switch (e && e.code) {
      case "MISSING_SCOPES":
        return `${base} (Nothing was written to HubSpot.)`;
      case "TRANSIENT":
        return `${base} Your note text is still here.`;
      default:
        return base;
    }
  }

  // --- Wiring -------------------------------------------------------------
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
    if (Object.keys(changes).some((k) => k.indexOf(AUTH_KEY_PREFIX) === 0)) refreshAuth();
  });

  // Sign-in happens elsewhere in this document (and in a popup window); re-read
  // the auth state whenever the panel comes back into view.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAuth();
  });

  // Storage first — captures that happened while the panel was closed only
  // exist there.
  (async () => {
    const res = (await chrome.storage.local.get([NOTES_KEY, CONTEXT_KEY, SYNCED_KEY])) || {};
    state.lastSynced = res[SYNCED_KEY] || null;
    state.ctx = res[CONTEXT_KEY] || null;
    applyNotes(res[NOTES_KEY]);
    await refreshAuth();
  })();
})();
