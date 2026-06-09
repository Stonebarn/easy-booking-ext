// content-scheduler.js
// Runs on the booking site (scheduler.default.com). When the booking form's
// email field appears, auto-fills it with the prospect email captured from the
// Nooks dialer.
//
// The form is a React (Next.js) app, so the email <input> renders async and is
// controlled — we must set its value via the native setter and dispatch
// input/change events, otherwise React ignores the change.

(() => {
  "use strict";

  const STORAGE_KEY = "eb:currentProspect";
  const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  // Email-field selectors, most reliable first. Verified live: the Default
  // booking form renders the email field as <input type="text"> (NOT "email")
  // with placeholder "name@company.com" and no id/name — so the placeholder is
  // the dependable anchor. The rest are resilience fallbacks for future form
  // variants. (None of these match the page's separate react-select combobox.)
  const EMAIL_SELECTORS = [
    'input[placeholder="name@company.com" i]',
    'input[type="email"]',
    'input[name="email" i]',
    'input[id*="email" i]',
    'input[aria-label*="email" i]',
  ];

  // Only auto-fill from a reasonably recent capture (avoid stale prospects from
  // a previous session). 30 minutes.
  const MAX_AGE_MS = 30 * 60 * 1000;

  function findEmailInput() {
    for (const sel of EMAIL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el; // visible
    }
    return null;
  }

  // Set a React-controlled input's value so React's onChange fires.
  function setReactInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const nativeSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (desc && desc.set) {
      nativeSetter ? nativeSetter.call(input, value) : desc.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  let filled = false;

  function tryFill(email) {
    if (filled || !email || !EMAIL_RE.test(email)) return;
    const input = findEmailInput();
    if (!input) return;
    // Don't clobber a value the rep already typed.
    if (input.value && input.value.trim().length > 0) {
      filled = true;
      return;
    }
    input.focus();
    setReactInputValue(input, email);
    input.blur();
    filled = true;
    console.debug("[EasyBooking] auto-filled booking email:", email);
  }

  function getProspectAndFill() {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const payload = res && res[STORAGE_KEY];
      if (!payload || !payload.email) return;
      if (payload.capturedAt && Date.now() - payload.capturedAt > MAX_AGE_MS) {
        console.debug("[EasyBooking] captured email is stale; skipping autofill");
        return;
      }
      tryFill(payload.email);
    });
  }

  // The input may not exist yet — watch the DOM until it does (then stop).
  const observer = new MutationObserver(() => {
    if (filled) {
      observer.disconnect();
      return;
    }
    getProspectAndFill();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial attempt + a couple of timed retries for slow first paints.
  getProspectAndFill();
  setTimeout(getProspectAndFill, 800);
  setTimeout(getProspectAndFill, 2500);

  // Safety: stop observing after 60s regardless.
  setTimeout(() => observer.disconnect(), 60000);

  // If the prospect changes while the booking tab is already open, re-fill
  // (only if the field is still empty).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue;
    if (next && next.email) {
      filled = false;
      tryFill(next.email);
    }
  });
})();
