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

  // The banner is its own document (a shadow root), so it cannot share the side
  // panel's tokens — it carries the same brand values, declared once each on
  // `.bar`, which every element below is inside of. Same palette, same rules:
  // white ground, ink text, the accent violet as the only fill, and the two
  // "Ready to fill" / "Filled" badges on semantic tones because they are states.
  // The old opacity-based dimming is gone: it computed to 2:1 or worse.
  const PANEL_CSS = `
    .bar{--bg:#ffffff;--ink:#26114a;--muted:#615e6e;--line:#dfe1e6;
      --accent:#7e43ff;--accent-wash:#f5f0ff;
      --positive:#1e7f5c;--positive-fg:#1d7b59;--positive-bg:#e3f4ec;
      --halo:rgba(30,127,92,.18);--shadow:rgba(38,17,74,.12);
      box-sizing:border-box;display:flex;align-items:center;gap:14px;flex-wrap:wrap;
      width:100%;padding:8px 16px;background:var(--bg);color:var(--ink);
      font-family:Inter,-apple-system,system-ui,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      font-size:13px;font-weight:400;
      border-bottom:2px solid var(--accent);box-shadow:0 2px 10px var(--shadow);}
    .brand{display:flex;align-items:center;gap:7px;font-weight:700;white-space:nowrap;}
    .brand .dot{width:8px;height:8px;border-radius:50%;background:var(--positive);box-shadow:0 0 0 3px var(--halo);}
    .brand .src{font-weight:500;color:var(--muted);}
    .rows{display:flex;align-items:center;gap:18px;flex-wrap:wrap;flex:1;min-width:0;}
    .row{display:flex;align-items:center;gap:7px;min-width:0;}
    .ico{color:var(--muted);flex:0 0 auto;}
    .val{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46ch;}
    .pill{flex:0 0 auto;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;
      background:transparent;border:1px solid var(--line);color:var(--muted);}
    .pill.ok{background:var(--positive-bg);border-color:transparent;color:var(--positive-fg);}
    .meta{display:flex;align-items:center;gap:10px;margin-left:auto;white-space:nowrap;}
    .age{font-size:11px;color:var(--muted);}
    .x{cursor:pointer;border:0;border-radius:6px;background:transparent;color:var(--muted);
      font-size:16px;line-height:1;padding:2px 4px;}
    .x:hover{background:var(--accent-wash);color:var(--ink);}
    .x:focus-visible{outline:2px solid var(--accent);outline-offset:1px;}
  `;
  const PANEL_HTML = `
    <div class="bar" role="status" aria-live="polite">
      <span class="brand"><span class="dot"></span>Dialer Helper Pro</span>
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
  //
  // Only a *different* prospect resets fill state. The same key is also written
  // for same-prospect nudges (the panel's "Fill now" re-stamps capturedAt), and
  // a blanket reset there re-drove the timezone dropdown: unlike the email
  // field, trySelectTimezone has no "rep already typed here" guard, so a rep who
  // hand-corrected an ambiguously-abbreviated zone (CST/IST/AST resolve to
  // several regions) would silently lose that correction — and a dismissed
  // banner would reappear. Re-applying for the same prospect is still useful for
  // a late-rendering form, so we re-run apply() either way and only clear state
  // when the email actually changed.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue;
    if (!next || !next.email) return;
    const lower = (s) => String(s || "").trim().toLowerCase();
    const prevEmail = (changes[STORAGE_KEY].oldValue || {}).email || null;
    const isNewProspect = lower(next.email) !== lower(prevEmail);
    if (isNewProspect) {
      emailFilled = false;
      tzSelected = false;
      tzLabel = null;
      panelDismissed = false;
      // A new prospect is a new booking: drop the old watch and its baseline so
      // the next confirmation is measured against this prospect's page, and let
      // a second booking in the same tab publish its own signal.
      bookingReset();
      stopBookingWatch();
      bookedPublished = false;
    }
    apply();
  });

  // ===========================================================================
  // Booking confirmation — the "meeting booked" signal (Phase 13)
  //
  // The side panel celebrates a booked meeting, so this has to be a fact. A
  // filled form is NOT a booking: the rep can fill it and the prospect can
  // still walk, and a celebration for a meeting that never happened is the
  // same broken promise as a false red flag. So the signal is published only
  // when a submission is followed by evidence it landed — the same two-step,
  // fail-silent shape the dialer's note-save detection uses:
  //
  //   1. ARM     — a click inside this page lands on a control whose label
  //                classifies as "submit the booking", and we had already
  //                filled this form for a known prospect (so the click belongs
  //                to a booking we recognize, not some unrelated Confirm).
  //                The visible confirmation-ish phrases on screen are snapshot
  //                at that instant.
  //   2. CONFIRM — within CONFIRM_WINDOW_MS, one of:
  //                  a) the URL takes on a confirmation shape (?confirmed,
  //                     /booked, /success …), which Next.js booking flows do;
  //                  b) a confirmation phrase appears that was NOT on screen
  //                     when the click happened (the page's own static copy
  //                     mentions "booked" in its description, so only a NEW
  //                     phrase counts, never one that was always there);
  //                  c) the email field we filled is gone and the form did not
  //                     come back — the flow moved on past the form it was on.
  //
  // No evidence, no signal: an armed booking expires silently. Everything here
  // is scoped to its own storage key ("eb:booked") and never touches
  // "eb:currentProspect", whose write cadence resets the fill state above.
  //
  // UNVERIFIED (2026-08-06): the real confirmation markup has not been captured
  // — see docs/diagnostics/booking-disposition-probe.js, which prints exactly
  // what to paste back here. Both the phrase list and the URL hints are
  // deliberately broad and only ever used as *new* evidence after a click.
  // ===========================================================================
  const BOOKED_KEY = "eb:booked";

  const BOOKING = {
    // Matched against a control's whole trimmed label, case-insensitive — never
    // as a substring, so "Cancel booking" can never read as "book".
    SUBMIT_TEXTS: [
      "schedule",
      "schedule event",
      "schedule meeting",
      "confirm",
      "confirm booking",
      "confirm meeting",
      "book",
      "book it",
      "book meeting",
      "book the meeting",
      "submit",
      "finish",
      "confirm & book",
      "confirm and book",
    ],
    // A control that must never arm a booking, however it is styled.
    CANCEL_TEXTS: ["cancel", "back", "close", "reschedule", "cancel booking"],
    // Confirmation copy. CONFIRMED live 2026-08-06 (Jack): the booking page
    // says exactly "Your meeting has been scheduled!" — which the first
    // version of this matcher would have MISSED twice over, because it only
    // matched a phrase at the START of a line and had no entry for
    // "meeting has been scheduled". Hence both changes here:
    //
    //   ANYWHERE — each of these contains a subject and a verb, so it cannot
    //   collide with a stray word, and is matched anywhere in a short visible
    //   line. The live string is the first entry.
    CONFIRM_PHRASES: [
      "meeting has been scheduled",
      "meeting has been booked",
      "meeting is scheduled",
      "meeting is booked",
      "meeting scheduled",
      "meeting confirmed",
      "booking confirmed",
      "booking is confirmed",
      "successfully scheduled",
      "successfully booked",
      "you're booked",
      "you are booked",
      "you're all set",
      "you are all set",
      "you're scheduled",
      "on the calendar",
      "added to your calendar",
      "invitation sent",
      "invite sent",
      "thanks for booking",
      "thank you for booking",
    ],
    //   WHOLE LINE ONLY — bare words that are evidence when they ARE the line
    //   (a confirmation headline) and noise inside a sentence ("not confirmed",
    //   "confirmed?" on a button).
    CONFIRM_PHRASES_EXACT: ["confirmed", "booked", "scheduled", "all set", "you're all set!"],
    CONFIRM_URL_HINTS: ["confirmed", "confirmation", "booked", "success", "thank-you", "thankyou"],
    CONFIRM_WINDOW_MS: 25000,
    // How long the form has to stay gone before its absence counts as evidence
    // (a React re-render blanks the tree for a frame or two).
    FORM_GONE_MS: 1800,
    POLL_MS: 400,
    // Debounce on the confirmation check: the page mutates constantly while the
    // rep picks a slot, and the check walks the copy elements.
    CHECK_DEBOUNCE_MS: 250,
    // A booking mid-call can take a while; a tab left open should not hold an
    // observer forever. 30 minutes matches the capture freshness window.
    WATCH_MAX_MS: 30 * 60 * 1000,
  };

  let pendingBooking = null; // { email, armedAt, urlBefore, goneSince } — a recognized submit click
  let bookingWatch = null; // { email, urlBefore, phrasesBefore:Set, observer, timer } — from fill onward
  let bookedPublished = false; // one signal per booking, per page life
  let bookingSeq = 0;
  let bookingPoll = null;

  function bookingReset() {
    pendingBooking = null;
    if (bookingPoll) {
      clearInterval(bookingPoll);
      bookingPoll = null;
    }
  }

  const collapseText = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // Short visible lines of copy, scanned for a confirmation.
  //
  // Two deliberate bounds keep the page's own text from lying to us. Only the
  // element types that hold copy are queried, so this can never see the Next.js
  // bootstrap JSON (that lives in <script>, which is not in the selector list
  // and holds the word "booked"). And a line over 120 characters is skipped,
  // which excludes the wrappers that contain the whole page as well as the
  // event description ("A 30-minute demo … booked through an SDR").
  //
  // Leaves are NOT required: a headline is often split by markup
  // (`<h2>Your meeting has been <b>scheduled</b>!</h2>`), and reading only
  // childless elements would see "scheduled" alone and miss the sentence.
  function visibleConfirmPhrases() {
    const found = new Set();
    for (const el of document.querySelectorAll("h1, h2, h3, h4, p, span, div, strong, li, section")) {
      const text = collapseText(el.textContent).toLowerCase();
      if (!text || text.length > 120) continue;
      if (!isVisible(el)) continue;
      for (const phrase of BOOKING.CONFIRM_PHRASES) {
        if (text.indexOf(phrase) !== -1) found.add(phrase);
      }
      // Bare words count only as the entire line, punctuation aside.
      const bare = text.replace(/[!.…\s]+$/, "");
      for (const phrase of BOOKING.CONFIRM_PHRASES_EXACT) {
        if (bare === phrase) found.add(phrase);
      }
    }
    return found;
  }

  function urlLooksConfirmed(href) {
    const url = String(href || "").toLowerCase();
    return BOOKING.CONFIRM_URL_HINTS.some((hint) => url.indexOf(hint) !== -1);
  }

  // The clickable ancestor of whatever the rep actually hit (the label is often
  // a <span> inside the button).
  function clickedControl(target) {
    for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
      const tag = String(n.tagName || "").toUpperCase();
      if (tag === "BUTTON" || tag === "A" || n.getAttribute("role") === "button") return n;
      if (tag === "FORM" || tag === "BODY") return null;
    }
    return null;
  }

  function classifyBookingControl(el) {
    if (!el) return null;
    const labels = [collapseText(el.textContent), collapseText(el.getAttribute("aria-label"))];
    const matches = (list) =>
      labels.some((label) => !!label && list.some((want) => want === label.toLowerCase()));
    if (matches(BOOKING.CANCEL_TEXTS)) return "cancel";
    if (matches(BOOKING.SUBMIT_TEXTS)) return "submit";
    return null;
  }

  function publishBooked(email, how) {
    bookingSeq += 1;
    const payload = {
      id: `booked-${Date.now()}-${bookingSeq}`,
      email: email || null,
      bookedAt: Date.now(),
      source: "scheduler",
      how,
      url: location.href,
    };
    bookedPublished = true;
    bookingReset();
    stopBookingWatch();
    chrome.storage.local.set({ [BOOKED_KEY]: payload }, () => {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] meeting booked:", payload.email || "(no email)", `(${how})`);
    });
  }

  // The page saying so is enough. This runs whether or not a submit click was
  // recognized, because a recognized click cannot be relied on: the button's
  // label is a guess, and gating the whole feature on guessing it right is the
  // exact mistake that kept note auto-sync from ever firing (see the layered
  // detection in content-nooks.js and CHANGELOG 0.5.2). What IS reliable is
  // that this extension filled this form for a known prospect and the page has
  // since started saying a meeting is scheduled.
  //
  // Returns true when it published.
  function checkConfirmation() {
    if (!bookingWatch || bookedPublished) return false;
    // The form must have been filled for a prospect we know, or this is not our
    // booking to take credit for.
    if (!emailFilled || !currentPayload || !currentPayload.email) return false;
    const w = bookingWatch;

    if (location.href !== w.urlBefore && urlLooksConfirmed(location.href)) {
      publishBooked(currentPayload.email, "confirmation url");
      return true;
    }
    // Only copy that was NOT already on screen when the form was filled: the
    // page's own description mentions bookings, and a confirmation left over
    // from a previous booking in the same tab must not fire a second time.
    for (const phrase of visibleConfirmPhrases()) {
      if (!w.phrasesBefore.has(phrase)) {
        publishBooked(currentPayload.email, `page said "${phrase}"`);
        return true;
      }
    }
    return false;
  }

  // Weaker evidence, allowed only after a positively-classified submit click:
  // the form we filled is gone and has stayed gone. On its own this would fire
  // on any route change, which is why it needs the click behind it.
  function settleBooking() {
    if (checkConfirmation()) return;
    if (!pendingBooking) return;
    const p = pendingBooking;
    if (Date.now() - p.armedAt > BOOKING.CONFIRM_WINDOW_MS) {
      // eslint-disable-next-line no-console
      console.debug("[EasyBooking] a booking submit was never confirmed on the page; ignoring it");
      bookingReset();
      return;
    }
    if (!findEmailInput()) {
      if (p.goneSince == null) p.goneSince = Date.now();
      else if (Date.now() - p.goneSince >= BOOKING.FORM_GONE_MS) {
        publishBooked(p.email, "booking form completed and closed");
      }
    } else {
      p.goneSince = null;
    }
  }

  // Starts watching as soon as the email lands in the form — long before any
  // submit — so the "before" snapshot is genuinely the pre-booking page. The
  // confirmation arrives as a DOM change, so an observer costs nothing while
  // the rep is still picking a time.
  function startBookingWatch() {
    if (bookingWatch || bookedPublished) return;
    if (!currentPayload || !currentPayload.email) return;
    bookingWatch = {
      email: currentPayload.email,
      startedAt: Date.now(),
      urlBefore: location.href,
      phrasesBefore: visibleConfirmPhrases(),
      observer: null,
      timer: null,
    };
    const check = () => {
      clearTimeout(bookingWatch && bookingWatch.timer);
      if (!bookingWatch) return;
      bookingWatch.timer = setTimeout(() => {
        try {
          checkConfirmation();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.debug("[EasyBooking] booking confirmation check failed:", (e && e.message) || e);
        }
      }, BOOKING.CHECK_DEBOUNCE_MS);
    };
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    bookingWatch.observer = observer;
    window.addEventListener("popstate", check);
    // A booking can take a while mid-call, but not all day: stop watching after
    // the window so a tab left open overnight isn't holding an observer.
    setTimeout(() => {
      if (bookingWatch && !bookedPublished) stopBookingWatch();
    }, BOOKING.WATCH_MAX_MS);
    check();
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] watching this booking form for its confirmation");
  }

  function stopBookingWatch() {
    if (!bookingWatch) return;
    if (bookingWatch.observer) bookingWatch.observer.disconnect();
    clearTimeout(bookingWatch.timer);
    bookingWatch = null;
  }

  document.addEventListener(
    "click",
    (event) => {
      try {
        const kind = classifyBookingControl(clickedControl(event && event.target));
        if (kind === "cancel") {
          bookingReset();
          return;
        }
        if (kind !== "submit") return;
        // Only a form this extension recognized and filled for a known prospect
        // can arm a booking — otherwise an unrelated "Confirm" elsewhere on the
        // site could take credit for a meeting.
        if (!emailFilled || !currentPayload || !currentPayload.email) return;
        pendingBooking = {
          email: currentPayload.email,
          armedAt: Date.now(),
          phrasesBefore: visibleConfirmPhrases(),
          urlBefore: location.href,
          goneSince: null,
        };
        if (bookingPoll) clearInterval(bookingPoll);
        bookingPoll = setInterval(settleBooking, BOOKING.POLL_MS);
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] booking submitted; watching for the confirmation");
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] booking detection failed:", (e && e.message) || e);
      }
    },
    true
  );

  // Begin watching once the form has been filled. Driven from here rather than
  // called out of tryFillEmail on purpose: that function runs during the very
  // first apply(), which happens BEFORE this block's `const BOOKING` is
  // initialized, so calling into here from there would throw on the temporal
  // dead zone. A half-second poll that cancels itself the moment the form is
  // filled costs nothing and cannot be ordered wrongly.
  let fillPoll = setInterval(() => {
    if (bookedPublished || bookingWatch) {
      clearInterval(fillPoll);
      return;
    }
    if (emailFilled && currentPayload && currentPayload.email) {
      clearInterval(fillPoll);
      try {
        startBookingWatch();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] could not start the booking watch:", (e && e.message) || e);
      }
    }
  }, 500);
  setTimeout(() => clearInterval(fillPoll), BOOKING.WATCH_MAX_MS);

  // Exposed for the fixture harness and console debugging (isolated world, so
  // the page's own JS cannot see it).
  const EB = (window.EB = window.EB || {});
  EB.schedulerBooking = {
    CONFIG: BOOKING,
    STORAGE_KEY: BOOKED_KEY,
    classifyBookingControl,
    visibleConfirmPhrases,
    urlLooksConfirmed,
    settleBooking,
    checkConfirmation,
    startBookingWatch,
    stopBookingWatch,
    pendingBookingState: () => pendingBooking,
    bookingWatchState: () => bookingWatch,
    publishedState: () => bookedPublished,
    reset: () => {
      bookingReset();
      stopBookingWatch();
      bookedPublished = false;
    },
    // Test seam: arm without a real click (the click path needs a live document).
    armBooking: (email) => {
      pendingBooking = {
        email,
        armedAt: Date.now(),
        urlBefore: location.href,
        goneSince: null,
      };
      return pendingBooking;
    },
  };
})();
