// content-nooks.js
// Runs on the Nooks dialer. Watches for the current prospect's email and
// stores it so the scheduler tab can auto-fill it.
//
// Nooks is a React SPA, so the prospect email is rendered client-side and can
// change without a full page navigation. We therefore (1) re-scan on DOM
// mutations + SPA route changes, and (2) try several strategies to locate the
// email, from most precise to most heuristic.
//
// Two independent payloads come out of one scan, under two different keys:
//
//   "eb:currentProspect"  email + timezone. UNCHANGED since v0.2 on purpose —
//                         content-scheduler.js resets its fill state and
//                         resurrects its dismissed banner on *any* write to
//                         this key, so nothing new goes in it and its
//                         write cadence stays exactly as it was.
//   "eb:prospectContext"  identity + HubSpot record IDs for the side panel's
//                         CRM sections (Phase 3). New key, new signature, its
//                         own dedupe — churn here cannot disturb the booking
//                         tab.
//
// Anchors come from docs/nooks-dom-recon.md: Nooks ships stable `data-testid`
// attributes on every card we need, so those are the primary hook and the old
// label-text strategy is the fallback. (`data-testid` is an intentional,
// stable hook — unlike the generated `css-*` classes CONTRIBUTING forbids.)

(() => {
  "use strict";

  const STORAGE_KEY = "eb:currentProspect";
  const CONTEXT_KEY = "eb:prospectContext";
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const EMAIL_RE_G = new RegExp(EMAIL_RE.source, "g");

  // --- Configuration -------------------------------------------------------
  // PRECISE_SELECTORS is filled in after inspecting the live dialer DOM. The
  // first selector that matches an email-bearing element wins. Until then we
  // fall back to the heuristics below.
  const CONFIG = {
    // The Nooks contact card renders fields as label→value pairs. The prospect
    // email sits in the row labeled exactly "Email". Anchoring on that label is
    // durable; the MUI/emotion class names (css-14w7q5o, ...) are not.
    FIELD_LABELS: ["Email"],
    // Card labels whose value carries the prospect's timezone. Nooks surfaces
    // this in different builds as "Timezone", "Time Zone", or a "Local time"
    // row; we try each. Verify/extend against the live dialer.
    TIMEZONE_LABELS: ["Timezone", "Time Zone", "Local Time", "Local time"],
    FIELD_MAX_LEVELS_UP: 3, // how far to climb from the label to the row container
    // Optional precise CSS selectors (highest priority). Left empty because the
    // dialer's class names are build-generated and unstable.
    PRECISE_SELECTORS: [],
    // Emails to never treat as "the prospect" (e.g. the logged-in rep, support
    // addresses, the Nooks team). Lowercased substring match.
    IGNORE_SUBSTRINGS: ["@nooks.in", "@nooks.ai", "noreply", "no-reply", "support@"],
    DEBOUNCE_MS: 300,

    // --- Prospect context (Phase 3) ---------------------------------------
    // Primary anchors, from the live-DOM recon. Each value is a `data-testid`
    // on the expanded prospect view; scraping is scoped *inside* the matching
    // element so a label like "Record ID" can only ever resolve against the
    // card it belongs to.
    TESTID_ANCHORS: {
      PROSPECT_NAME: "prospectDataExpanded-prospectName",
      PROSPECT_FIELDS: "prospect-fields-prospect-view-card",
      ACCOUNT_FIELDS: "account-fields-prospect-view-card",
      HUBSPOT_CONTACT_PANE: "hubspot-contact-pane-prospect-view-card",
      HUBSPOT_ACCOUNT_PANE: "hubspot-account-pane-prospect-view-card",
    },
    // Label text used as the fallback (and, for "Record ID", the only) way to
    // pick a value row out of a card. Same label→climb→extract strategy as
    // FIELD_LABELS, just scoped to one card.
    CONTEXT_LABELS: {
      RECORD_ID: ["Record ID", "Record Id"],
      TITLE: ["Title", "Job Title"],
      COMPANY: ["Company", "Company Name", "Account", "Account Name"],
      PHONE: ["Phone", "Phone Number", "Mobile", "Mobile Phone"],
    },
    // How far to climb from the prospect-name element looking for the header's
    // "Company • Title" line and phone.
    HEADER_MAX_LEVELS_UP: 4,
    // HubSpot record IDs are long digit strings (e.g. 54934007447). The floor
    // keeps short numbers in neighbouring rows (employee counts, grades) from
    // being mistaken for an ID.
    RECORD_ID_MIN_DIGITS: 5,
  };

  // Matches an IANA zone like "America/New_York" or "Europe/London".
  const IANA_RE = /\b[A-Z][a-zA-Z]+(?:\/[A-Z][a-zA-Z_]+){1,2}\b/;
  // Nooks renders the prospect's "Time Zone" field as an abbreviation + the
  // prospect's current local time, e.g. "EDT (12:04 PM)" or "IST (9:34 PM)".
  // We capture both: the abbreviation AND the local clock time, from which we
  // derive the prospect's current UTC offset. The scheduler then resolves these
  // to one of Default's ~88 dropdown zones (abbreviation disambiguated by
  // offset — neither alone is unique, e.g. "CST" is US/China/Cuba).
  const TZ_FIELD_RE = /\b([A-Za-z]{2,5})\s*\(\s*(\d{1,2}:\d{2})\s*([AaPp][Mm])\s*\)/;

  let lastStored = null; // serialized last-written prospect, for change detection
  let lastContext = null; // same idea for "eb:prospectContext" (separate key, separate signature)

  const norm = (s) => (s || "").trim().toLowerCase();
  // Collapse the whitespace React sprinkles between inline nodes.
  const flat = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => flat(el && el.textContent);

  function isIgnored(email) {
    const e = norm(email);
    return CONFIG.IGNORE_SUBSTRINGS.some((sub) => e.includes(sub));
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // Strategy 1: precise, configured selectors.
  function fromPreciseSelectors() {
    for (const sel of CONFIG.PRECISE_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = `${el.textContent || ""} ${el.value || ""} ${el.getAttribute("href") || ""}`;
      const m = text.match(EMAIL_RE);
      if (m && !isIgnored(m[0])) return m[0];
    }
    return null;
  }

  // Every text-bearing leaf under `root` — the raw material for label anchoring.
  function leavesIn(root) {
    return [...root.querySelectorAll("p, span, div, label")].filter(
      (el) => el.children.length === 0
    );
  }

  // Find the value sitting next to a contact-card label. Locates a leaf element
  // whose text is exactly one of `labels`, climbs to the row container, strips
  // the label text, and runs `extract(text)` on the remainder. Returns the
  // first truthy extraction.
  //
  // `root` scopes the search (default: the whole document, which is what the
  // email/timezone capture has always done). Passing a card element instead is
  // what makes an ambiguous label like "Record ID" safe: it can only match
  // inside the HubSpot pane it was found in.
  function fromLabeledField(labels, extract, root) {
    const leaves = leavesIn(root || document);
    for (const labelText of labels) {
      for (const leaf of leaves) {
        if ((leaf.textContent || "").trim() !== labelText) continue;
        if (!isVisible(leaf)) continue;
        let container = leaf;
        for (let i = 0; i < CONFIG.FIELD_MAX_LEVELS_UP && container.parentElement; i++) {
          container = container.parentElement;
          const text = (container.textContent || "").replace(labelText, " ");
          const value = extract(text);
          if (value) return value;
        }
      }
    }
    return null;
  }

  // Strategy 2: the labeled "Email" field in the contact card.
  function fromLabeledEmail() {
    return fromLabeledField(CONFIG.FIELD_LABELS, (text) => {
      const m = text.match(EMAIL_RE);
      return m && !isIgnored(m[0]) ? m[0] : null;
    });
  }

  // Strategy 3: mailto links (often a reliable signal for a contact).
  function fromMailto() {
    const links = [...document.querySelectorAll('a[href^="mailto:"]')];
    for (const a of links) {
      if (!isVisible(a)) continue;
      const email = decodeURIComponent(a.getAttribute("href").slice(7).split("?")[0]);
      if (EMAIL_RE.test(email) && !isIgnored(email)) return email;
    }
    return null;
  }

  // Strategy 4: scan visible text for an email-looking string.
  // We prefer the email closest to the top of the call/contact panel by simply
  // taking the first non-ignored visible match in document order.
  function fromVisibleText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !EMAIL_RE.test(v)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!isVisible(parent)) continue;
      const matches = node.nodeValue.match(EMAIL_RE_G) || [];
      for (const email of matches) {
        if (!isIgnored(email)) return email;
      }
    }
    return null;
  }

  function detectEmail() {
    return (
      fromPreciseSelectors() ||
      fromLabeledEmail() ||
      fromMailto() ||
      fromVisibleText() ||
      null
    );
  }

  // --- Timezone detection --------------------------------------------------
  // Compute the prospect's current UTC offset (minutes, rounded to 15) from
  // their local clock time. `now` is the moment we read the field, so the
  // prospect's local time and our UTC clock refer to the same instant.
  function offsetFromLocalTime(hh, mm, ampm) {
    let h = parseInt(hh, 10) % 12;
    if (/p/i.test(ampm)) h += 12;
    const localMin = h * 60 + parseInt(mm, 10);
    const now = new Date();
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    let diff = localMin - utcMin;
    while (diff <= -720) diff += 1440;
    while (diff > 720) diff -= 1440;
    return Math.round(diff / 15) * 15;
  }

  // Parse "IST (10:14 PM)" → {abbr, offsetMin, raw}. Also accepts a bare IANA
  // zone if Nooks ever renders one. Returns null if nothing parseable.
  function normalizeTimezone(text) {
    if (!text) return null;
    const m = text.match(TZ_FIELD_RE);
    if (m) {
      const [time, mm] = m[2].split(":");
      return {
        abbr: m[1].toUpperCase(),
        offsetMin: offsetFromLocalTime(time, mm, m[3]),
        iana: null,
        raw: `${m[1].toUpperCase()} (${m[2]} ${m[3].toUpperCase()})`,
      };
    }
    const iana = text.match(IANA_RE);
    if (iana) return { abbr: null, offsetMin: null, iana: iana[0], raw: iana[0] };
    return null;
  }

  function detectTimezone() {
    // The labeled "Time Zone" / "Local time" row in the contact card.
    return fromLabeledField(CONFIG.TIMEZONE_LABELS, (text) => normalizeTimezone(text));
  }

  function detectProspect() {
    const email = detectEmail();
    const tz = detectTimezone();
    return {
      email,
      tzAbbr: tz ? tz.abbr : null,
      tzOffsetMin: tz ? tz.offsetMin : null,
      timezone: tz ? tz.iana : null, // only set if Nooks rendered a raw IANA zone
      timezoneRaw: tz ? tz.raw : null,
    };
  }

  // --- Prospect context (identity + HubSpot record IDs) --------------------
  // Everything below feeds "eb:prospectContext" only. It never touches the
  // payload the scheduler reads.

  // The header renders "Acme Mortgage • VP of Sales" as one line. Anchored on
  // the whole line (not a loose search) so a bulleted list elsewhere in the
  // header can't be misread as company + title.
  const COMPANY_TITLE_RE = /^([^•·\n]{1,80}?)\s*[•·]\s*([^•·\n]{1,80})$/;
  // Loose on punctuation, strict on digit count — "(703) 555-0142",
  // "+1 703-555-0142", "7035550142" all qualify; a grade or year does not.
  // The leading "(" is part of the match so an area code in parentheses keeps
  // its opening bracket.
  const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/;

  function parseCompanyTitle(text) {
    const m = flat(text).match(COMPANY_TITLE_RE);
    if (!m) return null;
    const company = flat(m[1]);
    const title = flat(m[2]);
    return company && title ? { company, title } : null;
  }

  function parsePhone(text) {
    const m = flat(text).match(PHONE_RE);
    if (!m) return null;
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return flat(m[0]);
  }

  function parseRecordId(text) {
    const m = flat(text).match(new RegExp(`\\b\\d{${CONFIG.RECORD_ID_MIN_DIGITS},}\\b`));
    return m ? m[0] : null;
  }

  // A short, non-empty scalar — used for label rows whose value is free text
  // (Title, Company). Rejects the run-together text of a whole card, which is
  // what a too-generous climb would otherwise hand back.
  function asShortText(text) {
    const v = flat(text);
    return v && v.length <= 120 ? v : null;
  }

  function byTestId(id) {
    return document.querySelector(`[data-testid="${id}"]`);
  }

  // "Record ID" lives inside both HubSpot panes, so the pane element is the
  // scope: the contact pane can only ever yield the contact ID.
  function recordIdIn(testId) {
    const pane = byTestId(testId);
    if (!pane) return null;
    return fromLabeledField(CONFIG.CONTEXT_LABELS.RECORD_ID, parseRecordId, pane);
  }

  // Walk up from the name element until an ancestor also contains the
  // "Company • Title" line and/or the phone. Climbing (rather than assuming a
  // fixed depth) keeps this working when Nooks re-nests the header.
  function fromHeader(nameEl, name) {
    let container = nameEl;
    for (let i = 0; i < CONFIG.HEADER_MAX_LEVELS_UP && container && container.parentElement; i++) {
      container = container.parentElement;
      let company = null;
      let title = null;
      let phone = null;
      for (const leaf of leavesIn(container)) {
        const t = textOf(leaf);
        if (!t || t === name) continue;
        if (!company) {
          const ct = parseCompanyTitle(t);
          if (ct) {
            company = ct.company;
            title = ct.title;
          }
        }
        if (!phone) phone = parsePhone(t);
      }
      if (company || phone) return { company, title, phone };
    }
    return { company: null, title: null, phone: null };
  }

  function detectContext() {
    const A = CONFIG.TESTID_ANCHORS;
    const nameEl = byTestId(A.PROSPECT_NAME);
    const name = textOf(nameEl) || null;

    const header = nameEl ? fromHeader(nameEl, name) : { company: null, title: null, phone: null };
    let { company, title, phone } = header;

    // Card rows fill whatever the header didn't carry. The prospect card's own
    // "Title" row is the recon-documented home for the job title.
    const fields = byTestId(A.PROSPECT_FIELDS);
    if (fields) {
      if (!title) title = fromLabeledField(CONFIG.CONTEXT_LABELS.TITLE, asShortText, fields);
      if (!phone) phone = fromLabeledField(CONFIG.CONTEXT_LABELS.PHONE, parsePhone, fields);
    }
    const account = byTestId(A.ACCOUNT_FIELDS);
    if (!company && account) {
      company = fromLabeledField(CONFIG.CONTEXT_LABELS.COMPANY, asShortText, account);
    }

    return {
      name,
      title: title || null,
      company: company || null,
      phone: phone || null,
      // The HubSpot panes hydrate later than the rest of the view, so these are
      // frequently null on the first scan and present on a later one — which is
      // exactly why storeContext() dedupes on a signature instead of writing once.
      hsContactId: recordIdIn(A.HUBSPOT_CONTACT_PANE),
      hsCompanyId: recordIdIn(A.HUBSPOT_ACCOUNT_PANE),
    };
  }

  function store(prospect) {
    // Email is required; timezone is a best-effort extra.
    if (!prospect.email) return;
    const signature = `${norm(prospect.email)}|${prospect.tzAbbr || ""}|${prospect.tzOffsetMin ?? ""}|${norm(prospect.timezone)}`;
    if (signature === lastStored) return;
    lastStored = signature;
    const payload = {
      email: prospect.email,
      tzAbbr: prospect.tzAbbr || null,
      tzOffsetMin: prospect.tzOffsetMin ?? null,
      timezone: prospect.timezone || null,
      timezoneRaw: prospect.timezoneRaw || null,
      source: "nooks",
      url: location.href,
      capturedAt: Date.now(),
    };
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] captured prospect:", payload.email, payload.timezoneRaw || payload.timezone || "(no tz)");
    });
  }

  // Writes "eb:prospectContext" — read by the side panel to look the prospect
  // up in HubSpot. Separate key, separate signature: the whole point is that
  // late-arriving record IDs can update this without nudging
  // "eb:currentProspect" (which would reset the scheduler's fill state).
  function storeContext(email, ctx) {
    if (!email) return; // the panel keys its CRM cache by email
    const payload = {
      email,
      name: ctx.name || null,
      title: ctx.title || null,
      company: ctx.company || null,
      phone: ctx.phone || null,
      hsContactId: ctx.hsContactId || null,
      hsCompanyId: ctx.hsCompanyId || null,
      capturedAt: Date.now(),
    };
    const signature = [
      norm(email),
      payload.name || "",
      payload.title || "",
      payload.company || "",
      payload.phone || "",
      payload.hsContactId || "",
      payload.hsCompanyId || "",
    ].join("|");
    // The observer fires on every keystroke pause; without this the panel would
    // refetch HubSpot on typing noise.
    if (signature === lastContext) return;
    lastContext = signature;
    chrome.storage.local.set({ [CONTEXT_KEY]: payload }, () => {
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] captured prospect context:",
        payload.email,
        payload.hsContactId ? `hs contact ${payload.hsContactId}` : "(no hs contact id)",
        payload.hsCompanyId ? `hs company ${payload.hsCompanyId}` : "(no hs company id)"
      );
    });
  }

  // One pass over the DOM, two independent writes. Exposed (below) so it can be
  // driven from the console or a test harness without waiting on the debounce.
  function scanNow() {
    const prospect = detectProspect();
    if (!prospect.email) return null;
    store(prospect);
    const context = detectContext();
    storeContext(prospect.email, context);
    return { prospect, context };
  }

  // --- Scan scheduling (debounced) ----------------------------------------
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scanNow, CONFIG.DEBOUNCE_MS);
  }

  // React to DOM changes (new prospect loaded, panel re-rendered).
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // React to SPA route changes (pushState/replaceState/popstate).
  const fireRouteChange = () => scheduleScan();
  ["pushState", "replaceState"].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      fireRouteChange();
      return r;
    };
  });
  window.addEventListener("popstate", fireRouteChange);

  // Initial scan.
  scheduleScan();

  // Allow the side panel / scheduler to ask for the latest detection on demand.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "EB_REQUEST_EMAIL") {
      sendResponse(detectProspect());
    }
    return true;
  });

  // Content scripts run in an isolated world, so this namespace is invisible to
  // Nooks itself. It exists so the scraper can be poked at from the extension's
  // own console (`EB.nooksCapture.detectContext()`) when the dialer's DOM
  // drifts, and so the parsing helpers are unit-testable outside a browser.
  const EB = (self.EB = self.EB || {});
  EB.nooksCapture = {
    CONFIG,
    scanNow,
    detectProspect,
    detectContext,
    parseCompanyTitle,
    parsePhone,
    parseRecordId,
    normalizeTimezone,
  };

  // =========================================================================
  // Notes capture (Phase 4) — self-contained; nothing above this line changes.
  //
  // Two things get captured, because reps produce notes in two places:
  //   (a) the LIVE DRAFT in the "Add note" dialog's <textarea> — what the rep is
  //       typing during the call, before Save. Typing a textarea mutates .value,
  //       not the DOM, so a MutationObserver never sees it: we listen for `input`
  //       events instead (cheap, and it's the only signal that exists).
  //   (b) the SAVED notes rendered in the notes card, per active tab (Prospect /
  //       Account — these map 1:1 onto HubSpot contact-/company-level notes).
  //
  // Everything is written to its OWN key ("eb:notes"). It must never go into
  // "eb:currentProspect": content-scheduler.js resets its fill state and
  // un-dismisses the on-page banner on ANY write to that key.
  //
  // The populated note-list DOM is UNVERIFIED (see docs/nooks-dom-recon.md — no
  // saved note existed at recon time), so the saved-note reader is deliberately
  // structure-agnostic: it takes any non-empty text under the card that isn't
  // header/tab/empty-state chrome, and returns null rather than guessing.
  // =========================================================================

  const NOTES_STORAGE_KEY = "eb:notes";

  const NOTES_CONFIG = {
    // Primary anchor for the notes card (data-testid, per recon — stable and
    // intentional, unlike the generated css-* classes).
    CARD_TESTID: "notes-prospect-view-card",
    // The "Add note" flow opens a MUI dialog with no testid; it's identified by
    // role plus the note textarea it contains.
    DIALOG_SELECTOR: '[role="dialog"]',
    // Exact placeholder of the note editor (a plain <textarea>, not rich text).
    TEXTAREA_PLACEHOLDER: "Enter your note here...",
    // Case-insensitive prefix used when the placeholder wording drifts.
    TEXTAREA_PLACEHOLDER_PREFIX: "enter your note",
    // Last resort: accept the dialog's only textarea even if the placeholder
    // changed completely. Set false to require a placeholder match.
    TEXTAREA_ANY_FALLBACK: true,
    // Note scopes, in the order they appear as tabs.
    TAB_LABELS: ["Prospect", "Account"],
    // Which tab to assume when the active one can't be determined.
    DEFAULT_TAB: "prospect",
    // Card chrome to exclude when harvesting saved-note text (exact, trimmed,
    // case-insensitive leaf matches only — note bodies are never these).
    EXCLUDE_TEXTS: [
      "Notes",
      "Note",
      "Add note",
      "Add Note",
      "No notes",
      "No Notes",
      "Prospect",
      "Account",
    ],
    // Debounce for note rescans. Deliberately longer than the prospect scan's
    // 300ms: this also runs on every keystroke in the note editor.
    DEBOUNCE_MS: 600,
    // Safety valve on how much note text we'll carry in storage.
    MAX_CHARS: 20000,
    // Whether closing the dialog drops the draft. Default false: after Save the
    // dialog unmounts, and the rep still needs that text in the side panel to
    // sync it. The draft is cleared when the prospect changes regardless.
    CLEAR_DRAFT_ON_CLOSE: false,
  };

  // --- Tiny DOM helpers (no querySelector inside the hot paths, so the readers
  // stay testable against plain object fixtures) ----------------------------
  const attr = (el, name) =>
    el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null;

  const tagOf = (el) => String((el && el.tagName) || "").toUpperCase();

  const noteTextOf = (el) => String((el && el.textContent) || "").trim();

  function childNodesOf(node) {
    const kids = node && node.childNodes;
    if (!kids) return [];
    return Array.prototype.slice.call(kids);
  }

  // Depth-first element walk. `visit` returns false to skip a subtree.
  function walkElements(root, visit) {
    for (const child of childNodesOf(root)) {
      if (child.nodeType !== 1) continue;
      if (visit(child) === false) continue;
      walkElements(child, visit);
    }
  }

  function collectElements(root, predicate) {
    const found = [];
    walkElements(root, (el) => {
      if (predicate(el)) found.push(el);
      return true;
    });
    return found;
  }

  const hasElementChild = (el) => childNodesOf(el).some((n) => n.nodeType === 1);

  function isExcludedChrome(text) {
    const n = text.toLowerCase();
    return NOTES_CONFIG.EXCLUDE_TEXTS.some((x) => x.toLowerCase() === n);
  }

  function clampNoteText(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    return t.length > NOTES_CONFIG.MAX_CHARS ? t.slice(0, NOTES_CONFIG.MAX_CHARS) : t;
  }

  // --- Readers -------------------------------------------------------------
  // The note editor inside an open dialog. Placeholder-anchored, with a
  // single-textarea fallback.
  function findNoteTextarea(root) {
    if (!root) return null;
    const areas = collectElements(root, (el) => tagOf(el) === "TEXTAREA");
    if (!areas.length) return null;
    const want = NOTES_CONFIG.TEXTAREA_PLACEHOLDER.toLowerCase();
    const prefix = NOTES_CONFIG.TEXTAREA_PLACEHOLDER_PREFIX.toLowerCase();
    for (const area of areas) {
      const placeholder = String(attr(area, "placeholder") || "").trim().toLowerCase();
      if (placeholder && (placeholder === want || placeholder.startsWith(prefix))) return area;
    }
    return NOTES_CONFIG.TEXTAREA_ANY_FALLBACK ? areas[0] : null;
  }

  // The rep's in-progress note. Read from .value — textContent can't see it.
  function extractDraft(dialog) {
    const area = findNoteTextarea(dialog);
    if (!area) return null;
    return clampNoteText(typeof area.value === "string" ? area.value : "");
  }

  // Which note scope the card is showing: "prospect" | "account" | null.
  function tabNameFrom(text) {
    const n = text.trim().toLowerCase();
    const match = NOTES_CONFIG.TAB_LABELS.find((l) => l.toLowerCase() === n);
    return match ? match.toLowerCase() : NOTES_CONFIG.DEFAULT_TAB;
  }

  function detectActiveTab(card) {
    if (!card) return null;
    const tabs = collectElements(card, (el) => attr(el, "role") === "tab");
    for (const tab of tabs) {
      if (attr(tab, "aria-selected") === "true") return tabNameFrom(noteTextOf(tab));
    }
    // Fallback for a tab strip that doesn't use role="tab": a leaf whose text is
    // exactly a tab label and which advertises selection some other way.
    const labeled = collectElements(
      card,
      (el) => !hasElementChild(el) && NOTES_CONFIG.TAB_LABELS.some((l) => l.toLowerCase() === noteTextOf(el).toLowerCase())
    );
    for (const el of labeled) {
      const selected = attr(el, "aria-selected") || attr(el, "aria-current") || attr(el, "data-selected");
      if (selected === "true" || selected === "page") return tabNameFrom(noteTextOf(el));
    }
    // Tabs exist but none is marked — assume the default rather than lying.
    return tabs.length || labeled.length ? NOTES_CONFIG.DEFAULT_TAB : null;
  }

  // Saved notes for the active tab, as plain text. Structure-agnostic by
  // design: exclude the tab strip and the known header/empty-state strings,
  // then keep whatever text remains under the card.
  function extractSavedNotes(card) {
    if (!card) return null;
    const skip = new Set();
    walkElements(card, (el) => {
      const role = attr(el, "role");
      if (role === "tab" || role === "tablist") {
        skip.add(el);
        return false;
      }
      // Only leaves are skipped by text, so a note body that happens to contain
      // the word "Notes" is never dropped wholesale.
      if (!hasElementChild(el) && isExcludedChrome(noteTextOf(el))) {
        skip.add(el);
        return false;
      }
      return true;
    });

    const parts = [];
    const gather = (node) => {
      for (const child of childNodesOf(node)) {
        if (skip.has(child)) continue;
        if (child.nodeType === 3) {
          const value = String(child.nodeValue || "").trim();
          // Drop chrome that sits in a bare text node, and collapse the
          // duplicates React's fragments tend to produce.
          if (!value || isExcludedChrome(value)) continue;
          if (parts[parts.length - 1] === value) continue;
          parts.push(value);
        } else if (child.nodeType === 1) {
          gather(child);
        }
      }
    };
    gather(card);
    return clampNoteText(parts.join("\n"));
  }

  // --- Locators (the only place selectors are used) ------------------------
  function findNotesCard() {
    return document.querySelector(`[data-testid="${NOTES_CONFIG.CARD_TESTID}"]`);
  }

  // Several dialogs can be mounted; the note dialog is the one with the editor.
  function findNoteDialog() {
    const dialogs = document.querySelectorAll(NOTES_CONFIG.DIALOG_SELECTOR);
    for (const dialog of dialogs) {
      if (!isVisible(dialog)) continue;
      if (findNoteTextarea(dialog)) return dialog;
    }
    return null;
  }

  // --- State + storage ----------------------------------------------------
  const notesState = {
    draft: null,
    savedProspectNotes: null,
    savedAccountNotes: null,
    activeTab: null,
    prospectEmail: null,
  };
  let lastNotesSignature = null;
  let notesEverStored = false;

  // The prospect email from the SAME scan pass that wrote eb:currentProspect
  // (lastStored is "email|tzAbbr|offset|iana"). Reusing it keeps notes tied to
  // the prospect they were taken for without re-running the expensive
  // whole-document email detection on every keystroke.
  function currentProspectEmail() {
    if (!lastStored) return null;
    return String(lastStored).split("|")[0] || null;
  }

  // Cross-prospect bleed guard: notes belong to exactly one prospect. When the
  // prospect changes, drop everything rather than re-attributing it.
  function resetNotesState(email) {
    notesState.draft = null;
    notesState.savedProspectNotes = null;
    notesState.savedAccountNotes = null;
    notesState.activeTab = null;
    notesState.prospectEmail = email || null;
    lastNotesSignature = null;
    return notesState;
  }

  // One scan pass. Roots and email can be injected (that's the unit-test seam);
  // by default they're located live.
  function scanNotes(input) {
    const opts = input || {};
    const email = "prospectEmail" in opts ? opts.prospectEmail || null : currentProspectEmail();
    let didReset = false;
    if (email && notesState.prospectEmail && email !== notesState.prospectEmail) {
      // A genuinely different prospect: nothing carries over.
      resetNotesState(email);
      didReset = true;
    } else if (email && !notesState.prospectEmail) {
      // The prospect was merely identified after the notes UI appeared (the
      // email scan and this one are debounced separately) — adopt it rather
      // than throwing away notes that do belong to this prospect.
      notesState.prospectEmail = email;
      lastNotesSignature = null;
    }
    // An email that goes missing (card re-rendering) never orphans notes: the
    // existing attribution stands until a different prospect shows up.

    const card = "card" in opts ? opts.card : findNotesCard();
    const dialog = "dialog" in opts ? opts.dialog : findNoteDialog();
    // Bail before doing any work when the notes UI isn't on screen at all —
    // unless the prospect just changed, in which case the cleared state still
    // has to be published so the panel stops showing the last prospect's notes.
    if (!card && !dialog && !didReset) return null;

    if (dialog) {
      // Dialog open: mirror the editor exactly, including "the rep cleared it".
      notesState.draft = extractDraft(dialog);
    } else if (NOTES_CONFIG.CLEAR_DRAFT_ON_CLOSE) {
      notesState.draft = null;
    }

    if (card) {
      const tab = detectActiveTab(card);
      if (tab) notesState.activeTab = tab;
      const saved = extractSavedNotes(card);
      const bucket =
        (notesState.activeTab || NOTES_CONFIG.DEFAULT_TAB) === "account"
          ? "savedAccountNotes"
          : "savedProspectNotes";
      notesState[bucket] = saved;
    }

    const payload = {
      draft: notesState.draft,
      savedProspectNotes: notesState.savedProspectNotes,
      savedAccountNotes: notesState.savedAccountNotes,
      activeTab: notesState.activeTab,
      prospectEmail: notesState.prospectEmail,
      capturedAt: Date.now(),
    };

    const signature = JSON.stringify([
      payload.draft,
      payload.savedProspectNotes,
      payload.savedAccountNotes,
      payload.activeTab,
      payload.prospectEmail,
    ]);
    if (signature === lastNotesSignature) return payload;
    lastNotesSignature = signature;

    const hasContent = !!(payload.draft || payload.savedProspectNotes || payload.savedAccountNotes);
    // Don't write an all-empty record before there's ever been anything to say;
    // do write it afterwards, so a reset actually clears the panel.
    if (!hasContent && !notesEverStored) return payload;
    notesEverStored = true;

    chrome.storage.local.set({ [NOTES_STORAGE_KEY]: payload }, () => {
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] captured notes:",
        payload.prospectEmail || "(no prospect)",
        `tab=${payload.activeTab || "?"}`,
        `draft=${payload.draft ? payload.draft.length + "ch" : "none"}`,
        `saved=${(payload.savedProspectNotes || payload.savedAccountNotes) ? "yes" : "none"}`
      );
    });
    return payload;
  }

  // --- Scheduling ---------------------------------------------------------
  let notesTimer = null;
  function scheduleNotesScan() {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      try {
        scanNotes();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] notes scan failed:", (e && e.message) || e);
      }
    }, NOTES_CONFIG.DEBOUNCE_MS);
  }

  // Card renders, dialog open/close, tab switches, saved notes appearing.
  const notesObserver = new MutationObserver(scheduleNotesScan);
  notesObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Typing in the note editor. A textarea's .value never shows up as a DOM
  // mutation, so this is the only way to see the draft as it's written.
  document.addEventListener(
    "input",
    (event) => {
      const target = event && event.target;
      if (tagOf(target) !== "TEXTAREA") return;
      scheduleNotesScan();
    },
    true
  );

  scheduleNotesScan();

  // Exposed for the throwaway DOM-fixture harness and for console debugging.
  // Content scripts get an isolated `window`, so this is not reachable from the
  // page's own JS.
  const ebGlobal = (window.EB = window.EB || {});
  ebGlobal.nooksNotes = {
    CONFIG: NOTES_CONFIG,
    STORAGE_KEY: NOTES_STORAGE_KEY,
    state: notesState,
    scanNotes,
    resetNotesState,
    extractDraft,
    extractSavedNotes,
    detectActiveTab,
    findNoteTextarea,
  };
})();
