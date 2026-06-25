// content-scheduler.js
// Runs on the booking site (scheduler.default.com). When the form appears it
// (1) auto-fills the prospect email captured from the Nooks dialer and
// (2) selects the prospect's timezone in the scheduling form.
//
// Works on both the public booking-link form and the internal queue/member
// pages (e.g. /21470/queue/10664). Those pages render different markup, so the
// email field is found by a placeholder OR a label/aria/association heuristic,
// not a single hard-coded selector.
//
// The form is a React (Next.js) app: inputs are controlled, so values are set
// via the native setter + dispatched input/change events, and the timezone
// react-select is driven by opening it, filtering, and clicking the option.

(() => {
  "use strict";

  const STORAGE_KEY = "eb:currentProspect";
  const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

  // Only auto-fill from a reasonably recent capture (avoid stale prospects from
  // a previous session). 30 minutes.
  const MAX_AGE_MS = 30 * 60 * 1000;

  // ---------------------------------------------------------------------------
  // Email field
  // ---------------------------------------------------------------------------
  // Most reliable first. The public booking form renders <input type="text">
  // with placeholder "name@company.com"; other pages differ, so we also fall
  // back to a label/aria/association scan below. (None of these match the
  // page's timezone combobox.)
  const EMAIL_SELECTORS = [
    'input[placeholder="name@company.com" i]',
    'input[type="email"]',
    'input[name="email" i]',
    'input[id*="email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="@" i]',
  ];

  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }

  // Resolve the human label associated with an input: <label for>, a wrapping
  // <label>, aria-label, aria-labelledby, or the nearest preceding text.
  function labelTextFor(input) {
    const bits = [];
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) bits.push(l.textContent);
    }
    const wrap = input.closest("label");
    if (wrap) bits.push(wrap.textContent);
    if (input.getAttribute("aria-label")) bits.push(input.getAttribute("aria-label"));
    const labelledby = input.getAttribute("aria-labelledby");
    if (labelledby) {
      labelledby.split(/\s+/).forEach((id) => {
        const el = document.getElementById(id);
        if (el) bits.push(el.textContent);
      });
    }
    bits.push(input.getAttribute("placeholder") || "");
    bits.push(input.getAttribute("name") || "");
    return bits.join(" ").toLowerCase();
  }

  function findEmailInput() {
    for (const sel of EMAIL_SELECTORS) {
      const el = document.querySelector(sel);
      if (isVisible(el)) return el;
    }
    // Fallback: any visible text/email input whose label/context says "email".
    const inputs = [...document.querySelectorAll('input:not([type="hidden"])')];
    for (const el of inputs) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "file"].includes(type)) continue;
      if (!isVisible(el)) continue;
      if (/\bemail\b|e-mail/.test(labelTextFor(el))) return el;
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

  let emailFilled = false;

  function tryFillEmail(email) {
    if (emailFilled || !email || !EMAIL_RE.test(email)) return;
    const input = findEmailInput();
    if (!input) return;
    // Don't clobber a value the rep already typed.
    if (input.value && input.value.trim().length > 0) {
      emailFilled = true;
      return;
    }
    input.focus();
    setReactInputValue(input, email);
    input.blur();
    emailFilled = true;
    console.debug("[EasyBooking] auto-filled booking email:", email);
    updatePanel();
  }

  // ---------------------------------------------------------------------------
  // Timezone selection
  // ---------------------------------------------------------------------------
  // Nooks gives us an abbreviation (e.g. "IST", "EDT") + the prospect's current
  // UTC offset (derived from their local clock). Neither is unique on its own —
  // "CST" is US Central, China, Cuba and Mexico City all at once — so we combine
  // them: a curated abbreviation→zone hint, disambiguated by offset, with a pure
  // offset match as the fallback for numeric forms ("GMT+8") and anything
  // unhinted. The candidate set is Default's own ~88 dropdown zones, read live
  // from the react-select (so it stays in sync), with a hardcoded backup.
  //
  // Each hint value is one of Default's exact option values (verified live);
  // multi-region abbreviations list every plausible zone and let the offset pick.
  const ABBR_HINTS = {
    EST: "America/New_York", EDT: "America/New_York",
    CST: ["America/Chicago", "America/Mexico_City", "Asia/Shanghai", "America/Havana"], CDT: "America/Chicago",
    MST: ["America/Denver", "America/Phoenix"], MDT: "America/Denver",
    PST: "America/Los_Angeles", PDT: "America/Los_Angeles",
    AKST: "America/Anchorage", AKDT: "America/Anchorage",
    HST: "Pacific/Honolulu", HAST: "America/Adak", HADT: "America/Adak",
    AST: ["America/Halifax", "Asia/Baghdad"], ADT: "America/Halifax",
    NST: "America/St_Johns", NDT: "America/St_Johns",
    BRT: "America/Sao_Paulo", BRST: "America/Sao_Paulo",
    ART: "America/Argentina/Buenos_Aires", CLT: "America/Santiago", CLST: "America/Santiago",
    COT: "America/Bogota", PET: "America/Bogota", VET: "America/Caracas", UYT: "America/Montevideo",
    GMT: "Europe/London", BST: ["Europe/London", "Asia/Dhaka"], WET: "Europe/London", WEST: "Europe/London",
    CET: "Europe/Berlin", CEST: "Europe/Berlin", MET: "Europe/Berlin",
    EET: "Europe/Bucharest", EEST: "Europe/Bucharest",
    MSK: "Europe/Moscow", TRT: "Europe/Istanbul",
    WAT: "Africa/Lagos", CAT: "Africa/Maputo", SAST: "Africa/Maputo", EAT: "Asia/Baghdad",
    GST: "Asia/Dubai", IST: ["Asia/Calcutta", "Asia/Jerusalem", "Europe/London"], IDT: "Asia/Jerusalem",
    PKT: "Asia/Karachi", NPT: "Asia/Kathmandu", AFT: "Asia/Kabul", IRST: "Asia/Tehran", IRDT: "Asia/Tehran",
    ICT: "Asia/Bangkok", WIB: "Asia/Bangkok", HKT: "Asia/Shanghai", SGT: "Asia/Shanghai", MMT: "Asia/Yangon",
    JST: "Asia/Tokyo", KST: "Asia/Tokyo",
    AEST: "Australia/Sydney", AEDT: "Australia/Sydney", ACST: "Australia/Adelaide", ACDT: "Australia/Adelaide",
    AWST: "Australia/Perth", NZST: "Pacific/Auckland", NZDT: "Pacific/Auckland", FJT: "Pacific/Fiji",
    UTC: "Etc/UTC",
  };

  // When two zones share an offset (and no abbreviation decides), prefer these —
  // the zones a US sales team is most likely to be booking.
  const PRIORITY = [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "America/Halifax", "America/St_Johns",
    "Europe/London", "Europe/Berlin", "Europe/Bucharest", "Asia/Calcutta", "Asia/Dubai",
    "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "America/Sao_Paulo",
  ];

  // If Nooks ever hands us a raw IANA zone, normalize legacy names Default uses.
  const IANA_ALIASES = { "Asia/Kolkata": "Asia/Calcutta", "Europe/Paris": "Europe/Berlin" };

  // Default's dropdown zones (value→shown if the live read fails). Captured live.
  const FALLBACK_ZONES = ["America/Los_Angeles","America/Denver","America/Chicago","America/New_York","America/Anchorage","America/Phoenix","America/St_Johns","Pacific/Honolulu","America/Adak","America/Argentina/Buenos_Aires","America/Asuncion","America/Bogota","America/Campo_Grande","America/Caracas","America/Godthab","America/Halifax","America/Regina","America/Havana","America/Mazatlan","America/Mexico_City","America/Montevideo","America/Miquelon","America/Noronha","America/Santiago","America/Santa_Isabel","America/Thule","America/Sao_Paulo","Africa/Cairo","Africa/Maputo","Africa/Lagos","Africa/Windhoek","Asia/Amman","Asia/Baghdad","Asia/Baku","Asia/Beirut","Asia/Damascus","Asia/Dhaka","Asia/Dubai","Asia/Gaza","Asia/Irkutsk","Asia/Bangkok","Asia/Jerusalem","Asia/Kabul","Pacific/Majuro","Asia/Karachi","Asia/Kathmandu","Asia/Calcutta","Asia/Krasnoyarsk","Asia/Omsk","Asia/Yangon","Asia/Shanghai","Asia/Tehran","Asia/Tokyo","Asia/Vladivostok","Asia/Yakutsk","Asia/Yekaterinburg","Asia/Yerevan","Atlantic/Azores","Atlantic/Cape_Verde","Australia/Adelaide","Australia/Brisbane","Australia/Darwin","Australia/Eucla","Australia/Lord_Howe","Australia/Perth","Australia/Sydney","Etc/UTC","Europe/Berlin","Europe/Bucharest","Europe/London","Europe/Minsk","Europe/Moscow","Europe/Istanbul","Pacific/Apia","Pacific/Auckland","Pacific/Chatham","Pacific/Easter","Pacific/Fiji","Pacific/Gambier","Pacific/Kiritimati","Pacific/Marquesas","Pacific/Norfolk","Pacific/Noumea","Pacific/Pago_Pago","Pacific/Pitcairn","Pacific/Tarawa","Pacific/Tongatapu"].map((v) => ({ value: v, label: v }));

  function looksLikeTzControl(text) {
    return /time\s*zone|timezone|gmt|utc|\b[A-Z][a-z]+\/[A-Z]/i.test(text || "");
  }

  // react-select combobox. Identify by an enabled react-select input, then
  // confirm its surrounding text looks timezone-ish so we don't grab an
  // unrelated combobox (e.g. a disabled phone-country select on the form step).
  function findReactSelectControl() {
    const combos = [
      ...document.querySelectorAll(
        'input[id^="react-select"][role="combobox"], input[role="combobox"], [role="combobox"] input'
      ),
    ];
    for (const combo of combos) {
      if (!isVisible(combo) || combo.disabled) continue;
      const container =
        combo.closest('[class*="-container"]') ||
        combo.closest('[class*="select"]') ||
        combo.parentElement?.parentElement?.parentElement ||
        combo;
      const ctx = `${container.textContent || ""} ${combo.getAttribute("aria-label") || ""}`;
      if (looksLikeTzControl(ctx)) return { combo, container };
    }
    return null;
  }

  // Read Default's actual option list from the react-select's React props, so we
  // resolve against the live zone set. Falls back to the captured snapshot.
  function getDefaultZones(combo) {
    try {
      const fk = Object.keys(combo).find((k) => k.startsWith("__reactFiber$"));
      let f = combo[fk];
      let depth = 0;
      while (f && depth < 40) {
        const p = f.memoizedProps;
        if (p && Array.isArray(p.options)) {
          const flat = [];
          for (const o of p.options) {
            if (o && Array.isArray(o.options)) o.options.forEach((c) => flat.push({ value: c.value, label: c.label }));
            else if (o && o.value) flat.push({ value: o.value, label: o.label });
          }
          if (flat.length) return flat;
        }
        f = f.return;
        depth += 1;
      }
    } catch (e) {
      /* fall through to the snapshot */
    }
    return FALLBACK_ZONES;
  }

  function zoneOffsetMin(tz, now) {
    try {
      const v = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
        .formatToParts(now)
        .find((x) => x.type === "timeZoneName").value;
      const m = v.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (!m) return 0; // GMT with no offset → UTC
      return (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
    } catch (e) {
      return null;
    }
  }

  function zoneAbbr(tz, now) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short", hour: "2-digit" })
        .formatToParts(now)
        .find((x) => x.type === "timeZoneName")
        .value.toUpperCase();
    } catch (e) {
      return "";
    }
  }

  // Resolve (abbreviation, current offset) — or a raw IANA zone — to one of
  // Default's option values. See ABBR_HINTS/PRIORITY above for the strategy.
  function resolveZone(zones, abbr, offsetMin, ianaDirect) {
    const now = new Date();
    const Z = zones.map((z) => ({ value: z.value, label: z.label || z.value, off: zoneOffsetMin(z.value, now), abbr: zoneAbbr(z.value, now) }));
    const byVal = (v) => Z.find((z) => z.value === v);
    // Nooks renders the prospect's clock time frozen at card-load, so by the
    // time we read it the derived offset can drift a little. Two tolerances:
    // a wide one for abbreviation tie-breaks (same-abbr regions are hours apart,
    // so this stays unambiguous) and a tight one for raw offset matching.
    const within = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
    const HINT_TOL = 90;
    const OFFSET_TOL = 20;

    // 0) Raw IANA zone from Nooks (rare), with legacy-name normalization.
    if (ianaDirect) {
      const direct = byVal(ianaDirect) || byVal(IANA_ALIASES[ianaDirect]);
      if (direct) return direct.value;
    }

    const rawAbbr = (abbr || "").toUpperCase();
    const isNumeric = /\d/.test(rawAbbr); // "GMT+8", "+05", "UTC+5:30" → use offset
    const letterAbbr = rawAbbr.replace(/[^A-Z]/g, "");

    // 1) Curated letter-abbreviation hint, disambiguated by offset.
    if (!isNumeric && letterAbbr && ABBR_HINTS[letterAbbr]) {
      const hintZones = [].concat(ABBR_HINTS[letterAbbr]).map(byVal).filter(Boolean);
      const hintOff = hintZones.filter((z) => within(z.off, offsetMin, HINT_TOL));
      if (hintOff.length) return hintOff[0].value;
      if (hintZones.length === 1) return hintZones[0].value;
      // multi-region hint with no offset match → fall through to offset resolution
    }

    // 2) Offset match (handles numeric abbreviations and the unhinted long tail).
    if (offsetMin != null) {
      const cands = Z.filter((z) => within(z.off, offsetMin, OFFSET_TOL));
      if (cands.length) {
        const abbrHit = cands.filter((z) => z.abbr === letterAbbr);
        const pool = abbrHit.length ? abbrHit : cands;
        pool.sort((a, b) => {
          const ra = PRIORITY.indexOf(a.value);
          const rb = PRIORITY.indexOf(b.value);
          const d = (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
          if (d) return d;
          return (a.label.includes("/") ? 1 : 0) - (b.label.includes("/") ? 1 : 0);
        });
        return pool[0].value;
      }
    }
    return null;
  }

  function fireMouse(el, type) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // Type one of Default's exact option values into the react-select (which
  // filters its list by that value) and click the resulting option. Verified
  // live: typing the value narrows the menu to the single right option.
  function selectReactSelectByValue({ combo }, value) {
    combo.focus();
    setReactInputValue(combo, value); // opens + filters the menu
    let waits = 0;
    const check = () => {
      const menuId = combo.getAttribute("aria-controls");
      const menu = (menuId && document.getElementById(menuId)) || document;
      const options = [...menu.querySelectorAll('[role="option"]')].filter(isVisible);
      if (options.length >= 1) {
        const opt = options[0];
        fireMouse(opt, "mousedown");
        fireMouse(opt, "mouseup");
        opt.click();
        tzLabel = opt.textContent.replace(/\d.*$/, "").trim(); // strip trailing clock time
        console.debug("[EasyBooking] selected timezone:", opt.textContent.trim(), `(${value})`);
        updatePanel();
        return;
      }
      if (waits < 6) {
        waits += 1; // menu may still be rendering
        setTimeout(check, 100);
        return;
      }
      console.debug("[EasyBooking] timezone option never rendered for", value);
      tzSelected = false; // allow a later retry
    };
    setTimeout(check, 80);
  }

  let tzSelected = false;
  let tzNeeded = true; // set per-capture in apply(); false when no tz was captured

  function trySelectTimezone(abbr, offsetMin, ianaDirect) {
    if (tzSelected) return;
    if (!abbr && offsetMin == null && !ianaDirect) return;

    const rs = findReactSelectControl();
    if (rs) {
      const value = resolveZone(getDefaultZones(rs.combo), abbr, offsetMin, ianaDirect);
      if (!value) {
        console.debug("[EasyBooking] could not resolve timezone:", abbr, offsetMin);
        return;
      }
      tzSelected = true; // optimistic; cleared inside selectReactSelectByValue if it can't render
      selectReactSelectByValue(rs, value);
      return;
    }

    // Native <select> fallback (not used by current Default, kept for resilience).
    for (const sel of document.querySelectorAll("select")) {
      if (!isVisible(sel)) continue;
      const ctx = `${labelTextFor(sel)} ${[...sel.options].slice(0, 5).map((o) => o.text).join(" ")}`;
      if (!looksLikeTzControl(ctx)) continue;
      const zones = [...sel.options].map((o) => ({ value: o.value, label: o.text }));
      const value = resolveZone(zones, abbr, offsetMin, ianaDirect);
      const opt = value && [...sel.options].find((o) => o.value === value);
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        tzSelected = true;
        console.debug("[EasyBooking] set timezone (native select):", value);
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // On-page panel — a slim banner above the booking form previewing the data
  // pulled from Nooks, so reps can see at a glance that it's connected and what
  // will be filled. Lives in a Shadow DOM, inserted before the React root so the
  // app never reconciles it away and the site's CSS can't distort it.
  // ---------------------------------------------------------------------------
  const PANEL_ID = "eb-nooks-panel";
  let panelHost = null;
  let panelDismissed = false;
  let currentPayload = null;
  let tzLabel = null;

  const PANEL_CSS = `
    .bar{box-sizing:border-box;display:flex;align-items:center;gap:14px;flex-wrap:wrap;
      width:100%;padding:8px 16px;background:#0d0d12;color:#fff;
      font-family:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif;font-size:13px;
      border-bottom:2px solid #9371F0;box-shadow:0 2px 10px rgba(0,0,0,.15);}
    .brand{display:flex;align-items:center;gap:7px;font-weight:700;white-space:nowrap;}
    .brand .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.25);}
    .brand .src{font-weight:500;opacity:.6;}
    .rows{display:flex;align-items:center;gap:18px;flex-wrap:wrap;flex:1;min-width:0;}
    .row{display:flex;align-items:center;gap:7px;min-width:0;}
    .ico{opacity:.65;flex:0 0 auto;}
    .val{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46ch;}
    .pill{flex:0 0 auto;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;
      background:rgba(255,255,255,.12);color:#cbd5e1;}
    .pill.ok{background:rgba(34,197,94,.18);color:#4ade80;}
    .meta{display:flex;align-items:center;gap:10px;margin-left:auto;white-space:nowrap;}
    .age{font-size:11px;opacity:.55;}
    .x{cursor:pointer;border:0;background:transparent;color:#fff;opacity:.5;font-size:16px;line-height:1;padding:2px 4px;}
    .x:hover{opacity:1;}
  `;
  const PANEL_HTML = `
    <div class="bar" role="status" aria-live="polite">
      <span class="brand"><span class="dot"></span>Easy Booking<span class="src">· from Nooks</span></span>
      <span class="rows">
        <span class="row"><span class="ico">✉</span><span id="eb-email" class="val"></span><span id="eb-email-pill" class="pill">Ready to fill</span></span>
        <span class="row" id="eb-tz-row"><span class="ico">🕑</span><span id="eb-tz" class="val"></span><span id="eb-tz-pill" class="pill">Ready to fill</span></span>
      </span>
      <span class="meta"><span id="eb-age" class="age"></span><button id="eb-close" class="x" title="Hide">×</button></span>
    </div>`;

  function fmtOffset(min) {
    if (min == null) return "";
    const sign = min < 0 ? "-" : "+";
    const a = Math.abs(min);
    const h = Math.floor(a / 60);
    const m = a % 60;
    return `UTC${sign}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
  }

  function panelFresh(p) {
    return !!(p && p.email && (!p.capturedAt || Date.now() - p.capturedAt < MAX_AGE_MS));
  }

  function removePanel() {
    if (panelHost) {
      panelHost.remove();
      panelHost = null;
    }
  }

  function ensurePanel() {
    if (panelHost && document.documentElement.contains(panelHost)) return panelHost.shadowRoot;
    panelHost = document.createElement("div");
    panelHost.id = PANEL_ID;
    panelHost.style.cssText = "all: initial; display: block;";
    const root = panelHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${PANEL_CSS}</style>${PANEL_HTML}`;
    document.body.insertBefore(panelHost, document.body.firstElementChild);
    root.getElementById("eb-close").addEventListener("click", () => {
      panelDismissed = true;
      removePanel();
    });
    return root;
  }

  function updatePanel() {
    if (panelDismissed) return;
    const p = currentPayload;
    if (!panelFresh(p)) {
      removePanel();
      return;
    }
    const root = ensurePanel();
    root.getElementById("eb-email").textContent = p.email;
    const emailPill = root.getElementById("eb-email-pill");
    emailPill.textContent = emailFilled ? "Filled ✓" : "Ready to fill";
    emailPill.className = emailFilled ? "pill ok" : "pill";

    const tzRow = root.getElementById("eb-tz-row");
    const hasTz = !!(p.tzAbbr || p.timezone || p.tzOffsetMin != null);
    tzRow.style.display = hasTz ? "" : "none";
    if (hasTz) {
      const off = fmtOffset(p.tzOffsetMin);
      const localTime = (p.timezoneRaw && (p.timezoneRaw.match(/\(([^)]+)\)/) || [])[1]) || "";
      const detail = [p.tzAbbr, off].filter(Boolean).join(", ");
      const name = tzLabel || p.timezone || "";
      let text = name ? (detail ? `${name} (${detail})` : name) : detail || "—";
      if (localTime) text += ` · ${localTime} their time`;
      root.getElementById("eb-tz").textContent = text;
      const tzPill = root.getElementById("eb-tz-pill");
      tzPill.textContent = tzSelected ? "Set ✓" : "Ready to fill";
      tzPill.className = tzSelected ? "pill ok" : "pill";
    }

    const ageMin = p.capturedAt ? Math.round((Date.now() - p.capturedAt) / 60000) : null;
    root.getElementById("eb-age").textContent =
      ageMin === null ? "" : ageMin <= 0 ? "just now" : `captured ${ageMin}m ago`;
  }

  // ---------------------------------------------------------------------------
  // Apply captured prospect
  // ---------------------------------------------------------------------------
  function apply() {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const payload = res && res[STORAGE_KEY];
      if (!payload || !payload.email) {
        currentPayload = null;
        updatePanel();
        return;
      }
      if (payload.capturedAt && Date.now() - payload.capturedAt > MAX_AGE_MS) {
        currentPayload = null;
        updatePanel();
        console.debug("[EasyBooking] capture is stale; skipping autofill");
        return;
      }
      currentPayload = payload;
      updatePanel();
      tzNeeded = !!(payload.tzAbbr || payload.tzOffsetMin != null || payload.timezone);
      tryFillEmail(payload.email);
      trySelectTimezone(payload.tzAbbr, payload.tzOffsetMin, payload.timezone);
    });
  }

  const allDone = () => emailFilled && (tzSelected || !tzNeeded);

  // The form renders async — watch the DOM until both fields are handled.
  const observer = new MutationObserver(() => {
    if (allDone()) {
      observer.disconnect();
      return;
    }
    apply();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Initial attempt + a couple of timed retries for slow first paints.
  apply();
  setTimeout(apply, 800);
  setTimeout(apply, 2500);

  // Safety: stop observing after 5 min. The email field only renders after the
  // rep picks a date/time and confirms, which can take a while mid-call, so we
  // keep watching well past the timezone step.
  setTimeout(() => observer.disconnect(), 5 * 60 * 1000);

  // If the prospect changes while the booking tab is already open, re-apply and
  // bring the panel back (a new prospect overrides an earlier dismissal).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue;
    if (next && next.email) {
      emailFilled = false;
      tzSelected = false;
      tzLabel = null;
      panelDismissed = false;
      apply();
    }
  });
})();
