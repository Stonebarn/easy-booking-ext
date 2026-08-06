// hubspot-write.js — the one place this extension edits a customer record.
//
// Loaded by sidepanel.html (before sidepanel.js) and exposed as EB.hubspotWrite.
// Phase 10, the wrong-number workflow: a rep hears "that's not my number", and
// instead of tabbing out to LinkedIn → Wiza → Outreach they correct it here. The
// fix goes to HubSpot because HubSpot is the source of truth — data flows
// HubSpot → Outreach → the dialer, and Outreach cannot overwrite HubSpot.
//
// Everything network goes through EB.hubspotAuth.apiFetch, which owns the token,
// the refresh and the single 401 retry. This module owns:
//   - the field allowlist (three phone properties, nothing else, ever),
//   - phone validation and normalization (reject junk before spending a request,
//     and never silently mangle a number we aren't sure about),
//   - the confirm requirement (a mutation of a customer record is never a
//     one-click action, and that is enforced here as well as in the UI),
//   - turning HubSpot's error responses into typed errors the panel can render,
//   - a best-effort audit note on the timeline, so "who changed this number"
//     has an answer inside HubSpot itself.
//
// Same conventions as hubspot-notes.js, deliberately: typed errors, digit-only
// record IDs, no HTTP status or HubSpot response text in rep-facing copy (the
// console gets all of it).
//
// Plain script (no import/export) on purpose: CI syntax-checks .js with
// `node --check`, which parses them as CommonJS.

(() => {
  "use strict";

  const ebGlobal = (window.EB = window.EB || {});

  // --- Configuration -------------------------------------------------------
  const CONFIG = {
    CONTACTS_PATH: "/crm/v3/objects/contacts",
    // The allowlist. `updateContactPhone` will write nothing else — not
    // `email`, not `hs_lead_status`, not a property name that arrives from
    // somewhere unexpected. A write path with an open property parameter is one
    // bug away from overwriting a field nobody meant to touch, and CRM writes
    // are not undoable from here.
    FIELDS: [
      { key: "phone", label: "Phone" },
      { key: "mobilephone", label: "Mobile phone" },
      { key: "phone_number_2", label: "Phone 2" },
    ],
    // Portal 40063500 is a US/Eastern portal and the reps dial US numbers all
    // day, so a bare 10-digit number is assumed North American. Anything that
    // does not fit that assumption is passed through untouched rather than
    // guessed at.
    DEFAULT_COUNTRY_CODE: "1",
    // A local 7-digit number is the shortest thing that can still be a phone
    // number; E.164 caps the total at 15 digits.
    MIN_DIGITS: 7,
    MAX_DIGITS: 15,
    // Generous for "+44 (0)20 7123 4567 ext 1234", short enough that a pasted
    // paragraph is rejected before it becomes a request.
    MAX_INPUT_CHARS: 40,
  };

  const FIELD_KEYS = CONFIG.FIELDS.map((f) => f.key);

  const ERROR_CODES = [
    "INVALID_INPUT", // nothing typed, junk typed, unchanged, or not confirmed
    "NO_TARGET", // no HubSpot contact to write to (or it no longer exists)
    "AUTH", // not signed in / token rejected (401)
    "FORBIDDEN", // 403 — allowed in, not allowed to do this. NOT a sign-in problem.
    "RATE_LIMITED", // 429, honor Retry-After
    "TRANSIENT", // 5xx / network / timeout — safe to retry
    "API", // anything else HubSpot rejected
  ];

  function writeError(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
  }

  const log = (...args) => console.debug("[EasyBooking]", ...args);

  // --- Field allowlist -----------------------------------------------------
  // indexOf over a fixed array, not a lookup on an object: a property-bag
  // lookup would answer "yes" for "__proto__", "constructor" and friends.
  function fieldKey(field) {
    if (typeof field !== "string") return null;
    const key = field.trim().toLowerCase();
    return FIELD_KEYS.indexOf(key) === -1 ? null : key;
  }

  function fieldLabel(field) {
    const key = fieldKey(field);
    if (!key) return null;
    for (let i = 0; i < CONFIG.FIELDS.length; i++) {
      if (CONFIG.FIELDS[i].key === key) return CONFIG.FIELDS[i].label;
    }
    return null;
  }

  // Same rule as hubspot-notes.js: HubSpot object IDs are digit strings, and a
  // write aimed at the wrong record is not something a rep can undo.
  function idString(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return /^\d+$/.test(s) ? s : null;
  }

  // --- Phone validation & normalization ------------------------------------
  // The rule, in one sentence: normalize to E.164 only when the shape leaves no
  // room for doubt, otherwise send exactly what the rep typed and say so.
  //
  // Confident (normalized):
  //   +44 20 7123 4567   -> +442071234567   (explicit country code)
  //   (415) 555-0134     -> +14155550134    (10 digits, valid NANP shape)
  //   1-415-555-0134     -> +14155550134    (11 digits starting with 1, ditto)
  // Passed through as typed (never mangled):
  //   4155550134 x204    (an extension has no place in E.164)
  //   0044 20 7123 4567  (a trunk/IDD prefix we would have to guess at)
  //   415555013          (9 digits — country/area code unknowable)
  // Rejected before any request:
  //   555-CALL-NOW       (letters)
  //   1234               (too few digits)
  //   ""                 (nothing typed)
  const EXT_RE = /[\s.,\-]*(?:x|ext\.?|extension|#)\s*(\d{1,7})\s*$/i;
  const ALLOWED_RE = /^[0-9+().\-/\s]+$/;
  const LETTERS_RE = /[a-z]/i;
  // NANP: area code and exchange code both start 2-9. This is what stops
  // "0123456789" from being confidently relabelled as the US number +10123456789.
  const NANP_RE = /^[2-9]\d{2}[2-9]\d{6}$/;

  const digitsOf = (value) => String(value == null ? "" : value).replace(/\D/g, "");

  function badInput(message, extra) {
    return { ok: false, code: "INVALID_INPUT", message, ...(extra || {}) };
  }

  // Never throws — the UI calls this on every keystroke to decide whether the
  // button may light up, and what to say when it may not.
  function analyzePhone(raw) {
    const typed = String(raw == null ? "" : raw)
      .replace(/\s+/g, " ")
      .trim();
    if (!typed) return badInput("Type the corrected number first.");
    if (typed.length > CONFIG.MAX_INPUT_CHARS) {
      return badInput(
        `That's too long for a phone number — ${CONFIG.MAX_INPUT_CHARS} characters is the ceiling.`
      );
    }

    // Split a trailing extension off first: "x204" is legitimate, but it also
    // means the value can never be E.164, so it decides the outcome early.
    const extMatch = typed.match(EXT_RE);
    const ext = extMatch ? extMatch[1] : null;
    const main = ext ? typed.slice(0, typed.length - extMatch[0].length).trim() : typed;

    if (!main) return badInput("That's an extension with no phone number in front of it.");
    if (LETTERS_RE.test(main) || !ALLOWED_RE.test(main)) {
      return badInput(
        "Use digits and + ( ) - . only — letters and other characters can't be dialled."
      );
    }
    const plusAt = main.indexOf("+");
    if (plusAt > 0 || main.lastIndexOf("+") !== plusAt) {
      return badInput("A + belongs at the very start of the number, once.");
    }

    const digits = digitsOf(main);
    if (digits.length < CONFIG.MIN_DIGITS) {
      return badInput(
        `That's only ${digits.length} digit${digits.length === 1 ? "" : "s"} — a full number needs at least ${CONFIG.MIN_DIGITS}.`
      );
    }
    if (digits.length > CONFIG.MAX_DIGITS) {
      return badInput(
        `That's ${digits.length} digits — longer than any real phone number (${CONFIG.MAX_DIGITS} is the maximum).`
      );
    }

    const passthrough = (why) => ({
      ok: true,
      value: typed,
      typed,
      digits,
      ext,
      normalized: false,
      kind: "passthrough",
      why,
      // Shown in the panel *before* the write, so "we saved it as you typed it"
      // is never a surprise after the fact.
      note: "Dialer Helper Pro will save this exactly as you typed it.",
    });

    if (ext) return passthrough("extension");

    const hasPlus = plusAt === 0;
    if (hasPlus) {
      // A leading + is the rep telling us the country code. Reformatting is then
      // lossless: strip the punctuation, keep every digit.
      return {
        ok: true,
        value: `+${digits}`,
        typed,
        digits,
        ext: null,
        normalized: `+${digits}` !== typed,
        kind: "e164",
        why: "explicit country code",
        note: null,
      };
    }
    if (digits.length === 10 && NANP_RE.test(digits)) {
      return {
        ok: true,
        value: `+${CONFIG.DEFAULT_COUNTRY_CODE}${digits}`,
        typed,
        digits,
        ext: null,
        normalized: true,
        kind: "us10",
        why: "10-digit US number",
        note: null,
      };
    }
    if (
      digits.length === 11 &&
      digits.charAt(0) === CONFIG.DEFAULT_COUNTRY_CODE &&
      NANP_RE.test(digits.slice(1))
    ) {
      return {
        ok: true,
        value: `+${digits}`,
        typed,
        digits,
        ext: null,
        normalized: true,
        kind: "us11",
        why: "US number with country code",
        note: null,
      };
    }
    return passthrough(`${digits.length} digits, no country code`);
  }

  // Two values are "the same number" when they normalize to the same digits.
  // Both sides go through the same analysis first, so "(415) 555-0134" and
  // "+14155550134" are recognised as one number even though only one of them
  // carries the country code.
  //
  // Formatting is deliberately not a correction: a rep who opens the editor and
  // presses the button without editing is told nothing changed, rather than
  // having the record rewritten — and an audit note filed — for a reformat
  // nobody asked for.
  function canonicalDigits(value) {
    const analysis = analyzePhone(value);
    return digitsOf(analysis.ok ? analysis.value : value);
  }

  function sameNumber(a, b) {
    const da = canonicalDigits(a);
    const db = canonicalDigits(b);
    if (!da && !db) return true;
    return da === db;
  }

  // Throws the typed INVALID_INPUT the panel renders. `currentValue` is optional
  // — when given, an unchanged number is refused here as well as in the UI.
  function preparePhone(field, value, currentValue) {
    const key = fieldKey(field);
    if (!key) {
      // The field name is a programming input, never something a rep typed, so
      // the offending value goes to the console and the rep gets plain English.
      log("refusing to write a property outside the phone allowlist:", String(field));
      throw writeError(
        "INVALID_INPUT",
        "Dialer Helper Pro can only update the phone, mobile phone and phone 2 fields.",
        { field: field == null ? null : String(field) }
      );
    }
    const analysis = analyzePhone(value);
    if (!analysis.ok) throw writeError("INVALID_INPUT", analysis.message);
    if (currentValue !== undefined && currentValue !== null && sameNumber(currentValue, analysis.value)) {
      throw writeError(
        "INVALID_INPUT",
        "That's the number already on the record — change it before updating."
      );
    }
    return {
      field: key,
      label: fieldLabel(key),
      value: analysis.value,
      analysis,
    };
  }

  // --- The button's gate ---------------------------------------------------
  // Whether "Update in HubSpot" may fire, and if not, exactly what's missing.
  // Ordered most-actionable-first: the panel renders these as the hint under
  // the button, and a disabled control is never left unexplained.
  function updateGate(input) {
    const s = input || {};
    const reasons = [];
    if (!s.signedIn) reasons.push("Connect HubSpot in Settings to update numbers.");
    if (!idString(s.contactId)) {
      reasons.push("This prospect isn't matched to a HubSpot contact yet, so there's nothing to update.");
    }
    const key = fieldKey(s.field);
    if (!key) reasons.push("Pick which number to update.");
    const analysis = analyzePhone(s.value);
    if (!analysis.ok) reasons.push(analysis.message);
    const unchanged = !!(analysis.ok && sameNumber(s.current, analysis.value));
    if (unchanged) {
      reasons.push("That's the number already on the record — change it before updating.");
    }
    return {
      enabled: reasons.length === 0 && !s.saving,
      reasons,
      analysis: analysis.ok ? analysis : null,
      unchanged,
      // Only worth surfacing once the value is otherwise good.
      note: analysis.ok && !unchanged ? analysis.note : null,
    };
  }

  // --- Response handling ---------------------------------------------------
  // Same tolerance as hubspot-notes.js: apiFetch resolves to a Response, but a
  // caller (or a test double) handing back a parsed body must not break this.
  async function readResponse(res) {
    if (res && typeof res.json === "function" && typeof res.status === "number") {
      let body = null;
      try {
        body = await res.json();
      } catch (_e) {
        body = null;
      }
      const ok = typeof res.ok === "boolean" ? res.ok : res.status >= 200 && res.status < 300;
      const headers = res.headers;
      const retryAfter =
        headers && typeof headers.get === "function" ? headers.get("Retry-After") : null;
      return { ok, status: res.status, body, retryAfter };
    }
    if (res && typeof res === "object") {
      if (res.status === "error" || res.category || res.errors) {
        return { ok: false, status: Number(res.statusCode) || 400, body: res, retryAfter: null };
      }
      return { ok: true, status: 200, body: res, retryAfter: null };
    }
    throw writeError("TRANSIENT", "HubSpot sent back something unexpected. Try again.");
  }

  function retryAfterSeconds(parsed) {
    const raw = parsed.retryAfter != null ? parsed.retryAfter : parsed.body && parsed.body.retryAfter;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  }

  // Rep-facing message per failure shape. HubSpot's own status, category and
  // correlation IDs ride along on the error object for the console and never
  // become panel copy.
  //
  // The 401/403 split is the rule Phase 7 established the hard way: a 403 is
  // "your HubSpot permissions don't cover this", which reconnecting does not
  // fix, so it must never be reported as an expired sign-in.
  function errorFromResponse(parsed) {
    const body = parsed.body || {};
    const category = String(body.category || "").toUpperCase();
    const message = typeof body.message === "string" && body.message ? body.message : null;
    const status = parsed.status;

    if (status === 429 || category === "RATE_LIMITS") {
      const seconds = retryAfterSeconds(parsed);
      return writeError(
        "RATE_LIMITED",
        seconds
          ? `HubSpot rate limit — try again in ${seconds}s. The number wasn't changed.`
          : "HubSpot rate limit — wait a moment and try again. The number wasn't changed.",
        { retryAfterSec: seconds, status, hubspotMessage: message }
      );
    }

    if (status === 401 || category === "EXPIRED_AUTHENTICATION" || category === "INVALID_AUTHENTICATION") {
      return writeError("AUTH", "HubSpot sign-in expired — connect again in Settings, then try again.", {
        status,
        hubspotMessage: message,
      });
    }

    if (status === 403 || category === "MISSING_SCOPES") {
      return writeError(
        "FORBIDDEN",
        "Your HubSpot permissions don't cover editing this contact, so the number wasn't changed. Tell the team if you need it here.",
        { status, hubspotMessage: message, category: category || null }
      );
    }

    if (status === 404) {
      return writeError(
        "NO_TARGET",
        "That HubSpot contact isn't there any more. Refresh in Settings and try again.",
        { status, hubspotMessage: message }
      );
    }

    if (status === 408 || status >= 500) {
      return writeError("TRANSIENT", "HubSpot had a problem saving that. Try again in a moment.", {
        status,
        hubspotMessage: message,
      });
    }

    return writeError(
      "API",
      "HubSpot wouldn't accept that number. Check it, and update it in HubSpot directly if it keeps failing.",
      { status, hubspotMessage: message, category: category || null }
    );
  }

  // --- Audit note ----------------------------------------------------------
  // Reps and managers ask "who changed this?" inside HubSpot, not in a console
  // log, so a successful correction also files a note on the timeline. Pure and
  // exported so the wording is testable.
  function auditText(input) {
    const o = input || {};
    const label = o.label || "Phone";
    const previous = String(o.previous == null ? "" : o.previous).trim() || "(empty)";
    const next = String(o.value == null ? "" : o.value).trim();
    const actor = String(o.actor == null ? "" : o.actor).trim();
    const head = actor ? `Phone corrected by ${actor}` : "Phone corrected";
    return `${head}: ${label} ${previous} → ${next} (via Dialer Helper Pro)`;
  }

  // Best effort, and that is a deliberate contract: the phone number is the
  // thing the rep needs changed. A note that fails to attach must never make a
  // successful write look failed — it is reported as a footnote, not an error.
  async function writeAuditNote(input) {
    const notes = ebGlobal.hubspotNotes;
    if (!notes || typeof notes.createNote !== "function") {
      log("no notes module available — phone change not recorded on the timeline");
      return { ok: false, reason: "unavailable" };
    }
    try {
      const res = await notes.createNote({
        text: auditText(input),
        contactId: input.contactId,
        companyId: input.companyId,
        ownerId: input.ownerId,
        userId: input.userId,
      });
      log("phone change recorded on the HubSpot timeline as note", (res && res.noteId) || "?");
      return { ok: true, noteId: (res && res.noteId) || null, url: (res && res.url) || null };
    } catch (e) {
      log(
        "phone updated but the audit note failed:",
        (e && e.code) || "?",
        (e && e.message) || e
      );
      return { ok: false, reason: (e && e.code) || "error" };
    }
  }

  // --- Public API ----------------------------------------------------------
  // updateContactPhone({ contactId, field, value, currentValue, confirmed,
  //                      companyId, ownerId, userId, actor, email, audit })
  //   -> { contactId, field, label, value, previous, normalized, kind, note,
  //        auditNoteId, auditNoteUrl, auditFailed }
  //
  // `confirmed` is required. The UI arms a confirmation step before it calls
  // this, and the requirement is repeated here so that no future caller can
  // turn a customer-record mutation into a one-click action by accident.
  async function updateContactPhone(input) {
    const opts = input || {};
    const auth = ebGlobal.hubspotAuth;
    if (!auth || typeof auth.apiFetch !== "function") {
      throw writeError("AUTH", "HubSpot isn't connected yet — connect it in Settings, then try again.");
    }

    const contactId = idString(opts.contactId);
    if (!contactId) {
      throw writeError(
        "NO_TARGET",
        "No HubSpot contact matched for this prospect, so there's nothing to update."
      );
    }

    // Validation (and the allowlist) before anything is spent: a rejected
    // number should cost zero requests against a rate limit the whole team
    // shares.
    const prepared = preparePhone(opts.field, opts.value, opts.currentValue);

    if (!opts.confirmed) {
      throw writeError(
        "INVALID_INPUT",
        "Confirm the change before it's written to HubSpot."
      );
    }

    const payload = { properties: { [prepared.field]: prepared.value } };
    const path = `${CONFIG.CONTACTS_PATH}/${contactId}`;

    let res;
    try {
      res = await auth.apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      if (e && e.code && ERROR_CODES.indexOf(e.code) !== -1) throw e;
      log("phone update failed before a response:", (e && e.message) || e);
      throw writeError("TRANSIENT", "Couldn't reach HubSpot. Check your connection and try again.", {
        cause: e || null,
      });
    }
    const parsed = await readResponse(res);
    if (!parsed.ok) throw errorFromResponse(parsed);

    const previous = String(opts.currentValue == null ? "" : opts.currentValue).trim();
    log(
      "phone updated in HubSpot:",
      `contact ${contactId}`,
      `${prepared.field}:`,
      previous || "(empty)",
      "->",
      prepared.value,
      prepared.analysis.normalized ? `(normalized: ${prepared.analysis.why})` : "(as typed)"
    );

    // The panel's read cache would otherwise serve the old number for up to
    // five minutes — including to a rep who hits Refresh. Busting it here means
    // every reader gets it right, not just the one that happened to call this.
    const dataApi = ebGlobal.hubspotData;
    if (opts.email && dataApi && typeof dataApi.clearCache === "function") {
      try {
        dataApi.clearCache(opts.email);
        log("cleared the cached HubSpot bundle for", opts.email, "after the phone update");
      } catch (e) {
        log("could not clear the cached bundle after the phone update:", (e && e.message) || e);
      }
    }

    let audit = { ok: false, reason: "skipped" };
    if (opts.audit !== false) {
      audit = await writeAuditNote({
        label: prepared.label,
        actor: opts.actor,
        previous,
        value: prepared.value,
        contactId,
        companyId: opts.companyId,
        ownerId: opts.ownerId,
        userId: opts.userId,
      });
    }

    return {
      contactId,
      field: prepared.field,
      label: prepared.label,
      value: prepared.value,
      previous: previous || null,
      normalized: prepared.analysis.normalized,
      kind: prepared.analysis.kind,
      note: prepared.analysis.note,
      auditNoteId: audit.ok ? audit.noteId : null,
      auditNoteUrl: audit.ok ? audit.url : null,
      auditFailed: opts.audit === false ? false : !audit.ok,
    };
  }

  ebGlobal.hubspotWrite = {
    CONFIG,
    ERROR_CODES,
    FIELDS: CONFIG.FIELDS,
    FIELD_KEYS,
    fieldKey,
    fieldLabel,
    digitsOf,
    sameNumber,
    analyzePhone,
    preparePhone,
    updateGate,
    auditText,
    updateContactPhone,
  };
})();
