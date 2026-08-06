// hubspot-notes.js — creates HubSpot note engagements from captured dialer notes.
//
// Loaded by sidepanel.html (before sidepanel.js) and exposed as EB.hubspotNotes.
// All network access goes through EB.hubspotAuth.apiFetch, which owns the access
// token, the on-demand refresh and the one-shot 401 retry. This module owns the
// note payload: HTML-safe body, the association shapes, the 65,536-char ceiling,
// and turning HubSpot's error responses into typed errors the panel can render.
//
// Plain script (no import/export) on purpose: CI syntax-checks .js with
// `node --check`, which parses them as CommonJS.

(() => {
  "use strict";

  const ebGlobal = (window.EB = window.EB || {});

  // --- Configuration -------------------------------------------------------
  const CONFIG = {
    // Wiza's portal. Only used to build human linkouts, never for API calls.
    PORTAL_ID: "40063500",
    NOTES_PATH: "/crm/v3/objects/notes",
    // HubSpot object type ids used in record URLs.
    OBJECT_TYPE_CONTACT: "0-1",
    OBJECT_TYPE_COMPANY: "0-2",
    // HUBSPOT_DEFINED association type ids for note → {contact, company}.
    // Verified current; confirmable per-portal via
    // GET /crm/v4/associations/notes/{contacts|companies}/labels.
    ASSOC_TYPE_ID_CONTACT: 202,
    ASSOC_TYPE_ID_COMPANY: 190,
    // HubSpot's documented ceiling for hs_note_body, enforced against the
    // rendered HTML (what HubSpot actually stores).
    MAX_BODY_CHARS: 65536,
  };

  const ERROR_CODES = [
    "EMPTY_TEXT", // nothing to sync
    "NO_TARGET", // neither contactId nor companyId
    "TOO_LONG", // body exceeds MAX_BODY_CHARS
    "AUTH", // not signed in / token rejected
    "MISSING_SCOPES", // the app's scopes don't cover notes writes
    "RATE_LIMITED", // 429, honor Retry-After
    "TRANSIENT", // 5xx / network / timeout — safe to retry
    "API", // anything else HubSpot rejected
  ];

  function noteError(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
  }

  // --- Note body -----------------------------------------------------------
  // hs_note_body is rendered as HTML by HubSpot, so scraped note text (untrusted
  // input) is escaped first and only then are newlines turned into <br>.
  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildNoteBody(text) {
    const normalized = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    return escapeHtml(normalized).replace(/\n/g, "<br>");
  }

  // --- Payload -------------------------------------------------------------
  // Record IDs are scraped out of the dialer's DOM, which means they are
  // attacker-influenced in the limited sense that whatever renders that page
  // decides what we read. HubSpot object IDs are always digit strings, so
  // anything else is rejected outright rather than sent as an association
  // target — a note landing on the wrong customer's record is not recoverable
  // by the rep.
  function idString(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    return /^\d+$/.test(s) ? s : null;
  }

  function associationsFor(contactId, companyId) {
    const associations = [];
    if (contactId) {
      associations.push({
        to: { id: contactId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: CONFIG.ASSOC_TYPE_ID_CONTACT,
          },
        ],
      });
    }
    if (companyId) {
      associations.push({
        to: { id: companyId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: CONFIG.ASSOC_TYPE_ID_COMPANY,
          },
        ],
      });
    }
    return associations;
  }

  // Builds (and validates) the POST body. Throws typed errors so the panel can
  // block the request before it costs a rate-limit slot.
  function buildCreatePayload(input) {
    const opts = input || {};
    const text = String(opts.text == null ? "" : opts.text).trim();
    if (!text) throw noteError("EMPTY_TEXT", "There's no note text to sync.");

    const contactId = idString(opts.contactId);
    const companyId = idString(opts.companyId);
    if (!contactId && !companyId) {
      throw noteError(
        "NO_TARGET",
        "Nothing to attach the note to — no HubSpot contact or company record was matched for this prospect."
      );
    }

    const body = buildNoteBody(text);
    if (body.length > CONFIG.MAX_BODY_CHARS) {
      throw noteError(
        "TOO_LONG",
        `Note is too long for HubSpot — ${body.length.toLocaleString()} characters once formatted, and the limit is ${CONFIG.MAX_BODY_CHARS.toLocaleString()}. Trim it and try again.`,
        { bodyLength: body.length, textLength: text.length, limit: CONFIG.MAX_BODY_CHARS }
      );
    }

    const properties = {
      hs_timestamp: new Date(opts.timestamp || Date.now()).toISOString(),
      hs_note_body: body,
    };
    // Attribution. Two different HubSpot IDs, and mixing them up silently
    // mis-attributes the note, so each is validated and set independently:
    //   hubspot_owner_id — the SDR's *owner* ID ("Activity assigned to")
    //   hs_created_by    — the SDR's *user* ID ("Activity created by"), which is
    //                      a different number entirely
    // hs_created_by_user_id is deliberately never sent: HubSpot sets it itself
    // and it stays "No user" for app writes.
    const ownerId = idString(opts.ownerId);
    if (ownerId) properties.hubspot_owner_id = ownerId;
    const userId = idString(opts.userId);
    if (userId && !opts.omitCreatedBy) properties.hs_created_by = userId;

    return { properties, associations: associationsFor(contactId, companyId) };
  }

  // --- Linkouts ------------------------------------------------------------
  function recordUrl(objectType, id) {
    return `https://app.hubspot.com/contacts/${CONFIG.PORTAL_ID}/record/${objectType}/${id}`;
  }

  // Where to send the rep after a successful sync: the contact timeline when we
  // have a contact, otherwise the company record (a contact URL with no contact
  // id would just 404).
  function timelineUrl(contactId, companyId) {
    const contact = idString(contactId);
    if (contact) return recordUrl(CONFIG.OBJECT_TYPE_CONTACT, contact);
    const company = idString(companyId);
    if (company) return recordUrl(CONFIG.OBJECT_TYPE_COMPANY, company);
    return null;
  }

  // --- Response handling ---------------------------------------------------
  // apiFetch is expected to resolve to a fetch Response. Tolerate an
  // implementation that resolves to the parsed JSON body instead, so this module
  // doesn't break on either shape.
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
    throw noteError("TRANSIENT", "HubSpot sent back something unexpected. Try again.");
  }

  // HubSpot surfaces missing scopes inconsistently (top-level context, per-error
  // context, or only in the message). Pull names from all three — the plan
  // expects scope gaps to be discovered empirically from these strings.
  function scopeNames(body) {
    const out = [];
    const push = (value) => {
      const s = String(value == null ? "" : value).trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    };
    const fromContext = (context) => {
      if (!context || typeof context !== "object") return;
      ["requiredScopes", "requiredGranularScopes", "missingScopes", "scopes"].forEach((key) => {
        const list = Array.isArray(context[key]) ? context[key] : [];
        list.forEach((entry) => String(entry).split(/[\s,]+/).forEach(push));
      });
    };
    fromContext(body && body.context);
    const errors = Array.isArray(body && body.errors) ? body.errors : [];
    errors.forEach((e) => fromContext(e && e.context));
    if (!out.length && body && typeof body.message === "string") {
      const matches = body.message.match(/\b(?:crm|sales|tickets|automation|content)\.[a-z0-9._-]+\b/gi);
      (matches || []).forEach(push);
    }
    return out;
  }

  function retryAfterSeconds(parsed) {
    const raw = parsed.retryAfter != null ? parsed.retryAfter : parsed.body && parsed.body.retryAfter;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  }

  // Rep-facing message per failure shape. HubSpot's own error body (status,
  // category, correlation IDs) rides along on the error object for the console —
  // it never becomes panel copy, where an HTTP number tells a rep nothing they
  // can act on. The one exception is missing scope *names*, which are exactly
  // what whoever fixes the app needs to hear.
  function errorFromResponse(parsed) {
    const body = parsed.body || {};
    const category = String(body.category || "").toUpperCase();
    const message = typeof body.message === "string" && body.message ? body.message : null;
    const status = parsed.status;

    if (status === 429 || category === "RATE_LIMITS") {
      const seconds = retryAfterSeconds(parsed);
      return noteError(
        "RATE_LIMITED",
        seconds
          ? `HubSpot rate limit — try again in ${seconds}s.`
          : "HubSpot rate limit — wait a moment and try again.",
        { retryAfterSec: seconds, status, hubspotMessage: message }
      );
    }

    const scopes = scopeNames(body);
    if (category === "MISSING_SCOPES" || (status === 403 && scopes.length)) {
      return noteError(
        "MISSING_SCOPES",
        scopes.length
          ? `HubSpot is missing the permission${scopes.length > 1 ? "s" : ""} ${scopes.join(", ")} for notes. Ask the team to add ${scopes.length > 1 ? "them" : "it"} to the app, then reconnect.`
          : "HubSpot refused the note for missing permissions. Ask the team to check the app's permissions, then reconnect.",
        { scopes, status, hubspotMessage: message }
      );
    }

    if (status === 401 || status === 403 || category === "EXPIRED_AUTHENTICATION" || category === "INVALID_AUTHENTICATION") {
      return noteError(
        "AUTH",
        "HubSpot sign-in expired — connect again in Settings, then sync.",
        { status, hubspotMessage: message }
      );
    }

    if (status === 408 || status >= 500) {
      return noteError("TRANSIENT", "HubSpot had a problem saving the note. Try again in a moment.", {
        status,
        hubspotMessage: message,
      });
    }

    return noteError(
      "API",
      "HubSpot wouldn't save the note. Try again, and add it in HubSpot directly if it keeps failing.",
      { status, hubspotMessage: message, category: category || null }
    );
  }

  // --- hs_created_by fallback ----------------------------------------------
  // Property metadata in the live portal says hs_created_by is writable, but
  // HubSpot has been known to refuse it for app (OAuth) writes anyway. Losing a
  // rep's note over an attribution field would be a bad trade, so a rejection
  // that names *that* property is treated as "send it without" rather than as a
  // failure — once, and only for that property.
  //
  // Every string HubSpot might have put the property name in: the top-level
  // message, per-error messages, and per-error context values (where the
  // validation errors carry propertyName / name).
  function errorText(body) {
    const parts = [];
    const push = (value) => {
      if (typeof value === "string" && value) parts.push(value);
      else if (Array.isArray(value)) value.forEach(push);
    };
    if (!body || typeof body !== "object") return "";
    push(body.message);
    push(body.errorType);
    push(body.category);
    const errors = Array.isArray(body.errors) ? body.errors : [];
    errors.forEach((e) => {
      if (!e || typeof e !== "object") return;
      push(e.message);
      push(e.errorType);
      push(e.name);
      push(e.propertyName);
      const context = e.context;
      if (context && typeof context === "object") Object.keys(context).forEach((k) => push(context[k]));
    });
    return parts.join(" | ").toLowerCase();
  }

  // Word-boundary match so a complaint about hs_created_by_user_id — a property
  // we never send — can't be mistaken for one about hs_created_by.
  const CREATED_BY_RE = /hs_created_by(?![a-z0-9_])/;
  const UNWRITABLE_RE = /read[\s-]?only|not\s+writ|cannot be (?:set|modified|updated)|isn't writable|is not writable|immutable|invalid|unknown|does\s?n[o']t exist|not\s+(?:a\s+)?valid/;

  function isCreatedByRejection(parsed) {
    const status = Number(parsed && parsed.status);
    if (!(status >= 400 && status < 500)) return false;
    const text = errorText(parsed.body);
    if (!CREATED_BY_RE.test(text)) return false;
    return UNWRITABLE_RE.test(text);
  }

  // --- Public API ----------------------------------------------------------
  // createNote({ text, contactId, companyId, ownerId, userId })
  //   -> { noteId, url, contactId, companyId, timestamp, attributed, createdByDowngraded }
  async function createNote(input) {
    const opts = input || {};
    const auth = ebGlobal.hubspotAuth;
    if (!auth || typeof auth.apiFetch !== "function") {
      throw noteError("AUTH", "HubSpot isn't connected yet — connect it in Settings, then sync.");
    }

    let payload = buildCreatePayload(opts);
    const contactId = idString(opts.contactId);
    const companyId = idString(opts.companyId);

    const post = async (bodyPayload) => {
      let res;
      try {
        res = await auth.apiFetch(CONFIG.NOTES_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyPayload),
        });
      } catch (e) {
        if (e && e.code && ERROR_CODES.indexOf(e.code) !== -1) throw e;
        // eslint-disable-next-line no-console
        console.debug("[EasyBooking] note request failed before a response:", (e && e.message) || e);
        throw noteError(
          "TRANSIENT",
          "Couldn't reach HubSpot. Check your connection and try again.",
          { cause: e || null }
        );
      }
      return readResponse(res);
    };

    let parsed = await post(payload);
    let createdByDowngraded = false;
    if (!parsed.ok && payload.properties.hs_created_by && isCreatedByRejection(parsed)) {
      // Exactly one retry, without the field. Never surfaced to the rep: the
      // note still lands, only "Activity created by" is left to HubSpot.
      // eslint-disable-next-line no-console
      console.debug(
        "[EasyBooking] HubSpot refused hs_created_by on this note; retrying once without it"
      );
      payload = buildCreatePayload({ ...opts, omitCreatedBy: true });
      createdByDowngraded = true;
      parsed = await post(payload);
    }
    if (!parsed.ok) throw errorFromResponse(parsed);

    const body = parsed.body || {};
    const rawId = body.id || (body.properties && body.properties.hs_object_id) || null;
    const noteId = rawId == null ? null : String(rawId);
    // eslint-disable-next-line no-console
    console.debug("[EasyBooking] note created in HubSpot:", noteId, {
      contact: contactId,
      company: companyId,
      owner: payload.properties.hubspot_owner_id || null,
      createdBy: payload.properties.hs_created_by || null,
    });
    return {
      noteId,
      url: timelineUrl(contactId, companyId),
      contactId,
      companyId,
      timestamp: payload.properties.hs_timestamp,
      attributed: !!payload.properties.hubspot_owner_id,
      createdByDowngraded,
    };
  }

  // --- Sync helpers used by the panel (pure, so they're unit-testable) -----
  // Idempotency key for "have we already synced exactly this note for exactly
  // this prospect?". FNV-1a plus the basis length; content-addressed, not a
  // security boundary.
  function syncHash(text, prospectEmail) {
    const basis = `${String(text == null ? "" : text).trim()}\u0000${String(prospectEmail || "")
      .trim()
      .toLowerCase()}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < basis.length; i++) {
      h ^= basis.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `fnv1a-${h.toString(16).padStart(8, "0")}-${basis.length}`;
  }

  // Whether the Sync button may fire, and if not, exactly what's missing.
  // Order matters: reasons are rendered as the button's hint, most actionable
  // first.
  function syncGate(input) {
    const s = input || {};
    const text = String(s.text == null ? "" : s.text).trim();
    const reasons = [];
    if (!s.signedIn) reasons.push("Connect HubSpot in Settings to sync notes.");
    if (!text) reasons.push("No note text yet — write a note in the dialer (or type one here).");
    if (!idString(s.contactId) && !idString(s.companyId)) {
      reasons.push("Prospect not matched to HubSpot yet — no contact or company record ID was captured.");
    }
    const tooLong = text ? buildNoteBody(text).length > CONFIG.MAX_BODY_CHARS : false;
    if (tooLong) {
      reasons.push(
        `Note is too long — HubSpot allows ${CONFIG.MAX_BODY_CHARS.toLocaleString()} characters once formatted.`
      );
    }
    return { enabled: reasons.length === 0 && !s.syncing, reasons, tooLong };
  }

  // Which HubSpot records a successful sync touched, for the success line.
  function targetSummary(contactId, companyId) {
    const contact = !!idString(contactId);
    const company = !!idString(companyId);
    if (contact && company) return "contact + company";
    if (contact) return "contact";
    if (company) return "company";
    return "";
  }

  ebGlobal.hubspotNotes = {
    CONFIG,
    ERROR_CODES,
    MAX_BODY_CHARS: CONFIG.MAX_BODY_CHARS,
    createNote,
    buildCreatePayload,
    isCreatedByRejection,
    buildNoteBody,
    escapeHtml,
    timelineUrl,
    recordUrl,
    syncHash,
    syncGate,
    targetSummary,
  };
})();
