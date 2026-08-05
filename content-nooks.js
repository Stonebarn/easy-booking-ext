// content-nooks.js
// Runs on the Nooks dialer. Watches for the current prospect's email and
// stores it so the scheduler tab can auto-fill it.
//
// Nooks is a React SPA, so the prospect email is rendered client-side and can
// change without a full page navigation. We therefore (1) re-scan on DOM
// mutations + SPA route changes, and (2) try several strategies to locate the
// email, from most precise to most heuristic.

(() => {
  "use strict";

  const STORAGE_KEY = "eb:currentProspect";
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

  const norm = (s) => (s || "").trim().toLowerCase();

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

  // Find the value sitting next to a contact-card label. Locates a leaf element
  // whose text is exactly one of `labels`, climbs to the row container, strips
  // the label text, and runs `extract(text)` on the remainder. Returns the
  // first truthy extraction.
  function fromLabeledField(labels, extract) {
    const leaves = [...document.querySelectorAll("p, span, div, label")].filter(
      (el) => el.children.length === 0
    );
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

  // --- Scan scheduling (debounced) ----------------------------------------
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const prospect = detectProspect();
      if (prospect.email) store(prospect);
    }, CONFIG.DEBOUNCE_MS);
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
})();
