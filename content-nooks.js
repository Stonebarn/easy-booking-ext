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
    FIELD_MAX_LEVELS_UP: 3, // how far to climb from the label to the row container
    // Optional precise CSS selectors (highest priority). Left empty because the
    // dialer's class names are build-generated and unstable.
    PRECISE_SELECTORS: [],
    // Emails to never treat as "the prospect" (e.g. the logged-in rep, support
    // addresses, the Nooks team). Lowercased substring match.
    IGNORE_SUBSTRINGS: ["@nooks.in", "@nooks.ai", "noreply", "no-reply", "support@"],
    DEBOUNCE_MS: 300,
  };

  let lastStoredEmail = null;

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

  // Strategy 2: the labeled "Email" field in the contact card.
  // Find a leaf element whose text is exactly the label, climb to the row
  // container, and extract the email from that container's text.
  function fromLabeledField() {
    const leaves = [...document.querySelectorAll("p, span, div, label")].filter(
      (el) => el.children.length === 0
    );
    for (const labelText of CONFIG.FIELD_LABELS) {
      for (const leaf of leaves) {
        if ((leaf.textContent || "").trim() !== labelText) continue;
        if (!isVisible(leaf)) continue;
        let container = leaf;
        for (let i = 0; i < CONFIG.FIELD_MAX_LEVELS_UP && container.parentElement; i++) {
          container = container.parentElement;
          // Strip the label text before matching so "Emailx@y.com" → x@y.com.
          const text = (container.textContent || "").replace(labelText, " ");
          const m = text.match(EMAIL_RE);
          if (m && !isIgnored(m[0])) return m[0];
        }
      }
    }
    return null;
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
      fromLabeledField() ||
      fromMailto() ||
      fromVisibleText() ||
      null
    );
  }

  function store(email) {
    if (!email || norm(email) === norm(lastStoredEmail)) return;
    lastStoredEmail = email;
    const payload = {
      email,
      source: "nooks",
      url: location.href,
      capturedAt: Date.now(),
    };
    chrome.storage.local.set({ [STORAGE_KEY]: payload }, () => {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] captured prospect email:", email);
    });
  }

  // --- Scan scheduling (debounced) ----------------------------------------
  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const email = detectEmail();
      if (email) store(email);
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

  // Allow the popup / scheduler to ask for the latest detection on demand.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "EB_REQUEST_EMAIL") {
      sendResponse({ email: detectEmail() });
    }
    return true;
  });
})();
