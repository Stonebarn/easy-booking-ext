// hubspot-data.js — CRM reads for the side panel's identity block, Wiza, Deals
// and Activity sections.
//
// Every request goes through EB.hubspotAuth.apiFetch (bearer token, on-demand
// refresh, one retry on 401), so nothing here knows about tokens. What it does
// know about is the portal's two shared rate-limit pools, which are the whole
// reason this file exists as a layer instead of inline fetches in the panel:
//
//   CRM Search  5 req/s  — for the WHOLE portal, across all ~8 SDRs, and
//                          excluded from the general pool. This is the scarce
//                          one, and a naive implementation spends 1-2 of them
//                          on every prospect change.
//   General   110 req/10s — batch reads, association reads, pipelines, owners.
//
// Three mechanisms keep us inside that budget:
//
//   1. Record IDs from the DOM. Nooks renders the HubSpot contact/company
//      "Record ID" (see docs/nooks-dom-recon.md) and content-nooks.js scrapes
//      them, so the common path is a direct GET by ID and the search pool is
//      never touched. Search is the fallback for unmatched prospects only.
//   2. A per-email bundle cache (5-min TTL) plus in-flight dedup, so a rep
//      clicking through a call list re-renders from memory and five concurrent
//      callers share one fetch.
//   3. Session caches for things that are the same for everyone: the deal
//      pipeline/stage label map (one call, ever) and owner names.
//
// On 429 we surface a typed RATE_LIMITED error carrying Retry-After so the panel
// can show a countdown rather than hammering a limit the whole team shares.
//
// The bundle also carries two view-models the panel renders directly:
//   wiza      the portal's own product data (is this prospect a Wiza user, what
//             plan, how many credits, what does their account look like)
//   activity  up to 25 engagements per type, each attributed to an owner, plus
//             the tab counts/filters the panel's Activity tab bar is built from
// and, added in Phase 8 for the dialing decision itself — all of it read from
// properties on the same contact/company/deal records, so it costs no extra
// requests:
//   ownership       who owns outbound on this account, correctly: the portal's
//                   sdr_company_owner, not hubspot_owner_id
//   accountContext  grade, team sizes, company blurb, ICP, tech stack
//   sequence        whether this contact is already being worked
// and, added in Phase 9:
//   colleagues      the other contacts on the same company — who else is being
//                   sequenced from this account, and names to pivot to when the
//                   prospect says "wrong person". This one DOES cost requests, so
//                   it is deliberately the cheapest shape that answers the
//                   question: one association read capped at 25 + one batch read,
//                   nothing when the prospect has no company, and never a search.
// Those last helpers are shaped for the UI on purpose: they are pure functions
// over the fetched items, which is what makes the tab bar unit-testable without
// a DOM (same reasoning as the exported formatters).
//
// Plain IIFE + globals, not an ES module: CI runs `node --check` on .js files,
// which parses them as CommonJS. Load hubspot-config.js and hubspot-auth.js
// before this file.

(() => {
  "use strict";

  const EB = (self.EB = self.EB || {});
  const CFG = EB.hubspotConfig || {};

  const log = (...args) => console.debug("[EasyBooking]", ...args);

  // --- Configuration -------------------------------------------------------
  const CONFIG = {
    // Per-email bundle cache. Long enough that tabbing between prospects is
    // free, short enough that a rep who just edited HubSpot sees it after a
    // Refresh (which busts this anyway).
    CACHE_TTL_MS: 5 * 60 * 1000,
    // Engagements kept per type after the batch read, newest first. The Activity
    // tab bar shows a per-type list in a fixed-height scroller, so this is what
    // one tab can hold — not a merged total.
    ACTIVITY_PER_TYPE_LIMIT: 25,
    // HubSpot's own ceiling for a batch/read call.
    BATCH_MAX: 100,
    // Used when a 429 arrives with no (or an unparseable) Retry-After header.
    RETRY_AFTER_FALLBACK_S: 10,
    // Bumped whenever the bundle's *shape* changes. It namespaces the per-email
    // cache, so a bundle cached by an earlier version of this file (same panel
    // session, before a reload) can never be rendered by newer code that expects
    // fields it doesn't have. 10 = Phase 9's `colleagues` + Phase 10's extra
    // phone fields (both landed on 9 independently, so neither number is safe).
    CACHE_VERSION: 10,
    // Colleagues shown for the account (Phase 9). This is the *association page
    // limit we ask for* as well as the row cap, which is the point: one page, one
    // batch read, no paging, ever. 25 names is already more than a rep reads
    // mid-call, and the section scrolls.
    ACCOUNT_CONTACTS_LIMIT: 25,
    // Ceiling on owner IDs from colleague rows that are looked up *for the first
    // time* in a bundle. Cache hits are free and the SDR team is small, so in
    // practice this never bites; it exists so one account whose 25 contacts each
    // have a different owner cannot turn a 2-request section into 27 on the
    // general pool. Rows past the cap render without an owner name — never a
    // bare ID.
    ACCOUNT_OWNER_LOOKUP_MAX: 10,
    // Characters of a note body kept for the one-line activity preview.
    NOTE_PREVIEW_CHARS: 120,
    // Characters of the company blurb shown inline; the full text rides along as
    // the row's hover title. Long enough to answer "do you even know what we
    // do?", short enough that it doesn't own the panel.
    SNIPPET_CHARS: 200,
    // The AI ICP rationale runs to paragraphs — it is a hover detail, and even
    // there it gets a ceiling (a title= tooltip is not a document viewer).
    REASONING_CHARS: 400,
    // Tech-stack entries shown before "+N more". Eight fits two lines at 320px.
    TECH_STACK_MAX: 8,
    // Closed-lost reasons are free text and some reps write essays; the row
    // shows this much, the hover title the rest.
    OUTCOME_CHARS: 140,

    CONTACT_PROPERTIES: [
      "firstname",
      "lastname",
      "email",
      "jobtitle",
      "phone",
      // --- Phase 10: the wrong-number workflow -----------------------------
      // All three writable phone properties are read, not just the primary one:
      // the panel's "Wrong number?" editor shows what is currently on each
      // field and prefills the one being corrected. They come back on the
      // contact read the panel already makes, so this costs no extra request.
      "mobilephone",
      "phone_number_2",
      "lifecyclestage",
      "hs_lead_status",
      "hubspot_owner_id",
      "notes_last_updated",
      // Wiza product data on the contact ("is this person a user, and what are
      // they doing with us"). Property names verified against portal 40063500 —
      // they are portal-defined, so a typo silently returns nothing.
      "wiza_status",
      "wiza_id",
      "signed_up_at",
      "plan_status",
      "plan_credits",
      "plan_frequency",
      "number_of_credits_used_in_last_30_days",
      "date_of_last_wiza_usage",
      "wiza_admin_url",
      "wiza_usage_logs",
      "wiza_email_confirmed",
      // --- Phase 8: dialing-decision context (contact) ---------------------
      // hs_linkedin_url, NOT linkedin_url — the latter is deprecated in the
      // portal and empty on most records.
      "hs_linkedin_url",
      // "Are they already being worked?" — the sequence line in the identity
      // block. hs_latest_sequence_enrolled is the sequence *name*.
      "hs_sequences_is_enrolled",
      "hs_latest_sequence_enrolled",
      "hs_latest_sequence_enrolled_date",
      "notes_last_contacted",
    ],
    COMPANY_PROPERTIES: [
      "name",
      "domain",
      "industry",
      "numberofemployees",
      "hubspot_owner_id",
      // Wiza account data on the company (billing/API side of the same story).
      "api_wiza_account_id",
      "primary_account_id_associated_wiza",
      "number_of_associated_accounts",
      "number_of_associated_subscribed_accounts",
      "api_credit_balance",
      "number_of_credits_used_in_last_30_days",
      "last_api_credit_purchase",
      "times_api_credits_purchased",
      "account_icp",
      "industry_wiza",
      "hs_is_target_account",
      "use_case",
      // --- Phase 8: dialing-decision context (company) ---------------------
      // Ownership. HubSpot's own description of sdr_company_owner: "[OFFICIAL]
      // The SDR / outbound rep who owns prospecting for this account. Use this
      // for outbound ownership, not hubspot_owner_id." So the panel shows this
      // one first and labels all three; hubspot_owner_id above is the *company*
      // owner, which is not the same person and never was.
      "sdr_company_owner",
      "cs_company_owner",
      "outbound_ownership_change_date",
      // Worth-calling check: grade, then how big the teams are.
      "account_grade_v1",
      "asm_sales_team_size",
      "ae_team_size",
      "ob_team_size",
      "sales_leadership_team_size",
      "company_lifecycle_stage",
      // "Do you even know what we do?" — first non-empty of these three is the
      // blurb a rep can read mid-dial.
      "description",
      "about_us",
      "linkedinbio",
      "account_icp_ai_reasoning",
      "icp_fit",
      "web_technologies",
      "linkedin_company_page",
    ],
    // --- Phase 9: the other contacts on the account ------------------------
    // Deliberately NOT CONTACT_PROPERTIES: that array carries the whole Wiza
    // product block and the full identity set, and 25 contacts × ~35 properties
    // is a needlessly large response for a list of names. This is exactly what a
    // row renders — who they are, whether they're being worked, when they were
    // last touched, whose they are, and the LinkedIn link that saves the tab-out.
    ACCOUNT_CONTACT_PROPERTIES: [
      "firstname",
      "lastname",
      "jobtitle",
      "email",
      "phone",
      "hubspot_owner_id",
      "hs_sequences_is_enrolled",
      "hs_latest_sequence_enrolled",
      "hs_latest_sequence_enrolled_date",
      "notes_last_contacted",
      "notes_last_updated",
      "lifecyclestage",
      "hs_linkedin_url",
    ],
    DEAL_PROPERTIES: [
      "dealname",
      "dealstage",
      "pipeline",
      "amount",
      "closedate",
      "hubspot_owner_id",
      // --- Phase 8: closed-lost talk track ---------------------------------
      // Why the last deal died is the opener on a re-approach. Only rendered on
      // closed deals (which already sort last), never on open ones.
      "closed_lost_reason",
      "closed_loss_category",
      "closed_lost_category__secondary_",
      "hs_is_closed_lost",
      "closed_won_reason",
    ],

    // The five engagement object types, in the order ties are broken. There is
    // no single timeline endpoint (legacy engagements v1 is dead), so each type
    // is an association read + a batch read of its own properties.
    //
    // hubspot_owner_id and hs_created_by go on every type: the panel attributes
    // every row ("by Jenny Choi"). hs_created_by is the *user* id of whoever
    // logged it and is only used when the engagement has no owner — plenty of
    // dialer-logged calls land that way.
    ACTIVITY_TYPES: [
      {
        type: "calls",
        label: "Call",
        // Tab label in the panel's Activity tab bar.
        tab: "Calls",
        properties: [
          "hs_timestamp",
          "hs_call_title",
          "hs_call_disposition",
          "hs_call_direction",
          "hs_call_duration",
          "hubspot_owner_id",
          "hs_created_by",
        ],
      },
      {
        type: "emails",
        label: "Email",
        tab: "Emails",
        properties: [
          "hs_timestamp",
          "hs_email_subject",
          "hs_email_direction",
          "hubspot_owner_id",
          "hs_created_by",
        ],
      },
      {
        type: "meetings",
        label: "Meeting",
        tab: "Meetings",
        properties: [
          "hs_timestamp",
          "hs_meeting_title",
          "hs_meeting_outcome",
          "hubspot_owner_id",
          "hs_created_by",
        ],
      },
      {
        type: "notes",
        label: "Note",
        tab: "Notes",
        properties: ["hs_timestamp", "hs_note_body", "hubspot_owner_id", "hs_created_by"],
      },
      {
        type: "tasks",
        label: "Task",
        tab: "Tasks",
        properties: [
          "hs_timestamp",
          "hs_task_subject",
          "hs_task_status",
          "hubspot_owner_id",
          "hs_created_by",
        ],
      },
    ],

    // A company search on one of these would match some unrelated record that
    // happens to have the domain on file, so the domain fallback skips them.
    FREE_EMAIL_DOMAINS: [
      "gmail.com",
      "googlemail.com",
      "yahoo.com",
      "hotmail.com",
      "outlook.com",
      "live.com",
      "aol.com",
      "icloud.com",
      "me.com",
      "msn.com",
      "protonmail.com",
      "proton.me",
      "comcast.net",
      "verizon.net",
      "sbcglobal.net",
    ],

    // Portal currency. Amounts come back as bare numbers in the portal's
    // currency, with no unit in the payload.
    CURRENCY: "USD",
    LOCALE: "en-US",
  };

  // HubSpot's stock call outcomes are GUIDs. Anything not in this map (a
  // portal-defined disposition) renders as nothing rather than as a GUID.
  const CALL_DISPOSITIONS = {
    "9d9162e7-6cf3-4944-bf63-4dff82258764": "Connected",
    "f240bbac-87c9-4f6e-bf70-924b57d47db7": "Busy",
    "a4c4c377-d246-4b32-a13b-75a56a4cd0ff": "Wrong number",
    "b2cf5968-551e-4856-9783-52b3da59a7d0": "Left live message",
    "73a0d17f-1163-4015-bdd5-ec830791da20": "Left voicemail",
    "17b47fee-58de-441e-a44c-c6300d46f273": "No answer",
  };

  // HubSpot object type IDs, for record deep links.
  const OBJECT_TYPE = { contact: "0-1", company: "0-2", deal: "0-3" };

  // --- Errors --------------------------------------------------------------
  // Five codes, because the panel renders five different things:
  //   NOT_FOUND    — the lookup succeeded and there is no such record
  //   RATE_LIMITED — the shared pool is exhausted; carries retryAfterMs
  //   AUTH         — not connected, or the token itself was rejected (401)
  //   FORBIDDEN    — connected and allowed in, but not permitted to read this
  //                  (403). Not a sign-in problem and not fixable by the rep.
  //   TRANSIENT    — network, 5xx, anything worth a retry
  class HubSpotDataError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = "HubSpotDataError";
      this.code = code;
      if (extra) Object.assign(this, extra);
    }
  }

  const isDataError = (e) => e instanceof HubSpotDataError;

  // --- Low-level request ---------------------------------------------------
  // Looked up lazily rather than captured at load: keeps this file independent
  // of script order, and lets the unit harness inject a fake.
  function authApi() {
    const auth = EB.hubspotAuth;
    if (!auth || typeof auth.apiFetch !== "function") {
      throw new HubSpotDataError("AUTH", "HubSpot auth module not loaded.");
    }
    return auth;
  }

  function retryAfterMs(res) {
    const raw = res && res.headers && res.headers.get ? res.headers.get("Retry-After") : null;
    const secs = Number(raw);
    const useable = Number.isFinite(secs) && secs > 0 ? secs : CONFIG.RETRY_AFTER_FALLBACK_S;
    return Math.round(useable * 1000);
  }

  async function readBody(res) {
    try {
      return await res.json();
    } catch (_) {
      return null; // 204s and HTML error pages
    }
  }

  // Returns the parsed JSON body, or throws a typed HubSpotDataError. `path` is
  // appended to API_BASE unless it is already absolute.
  async function request(path, init) {
    const url = /^https?:/.test(path) ? path : `${CFG.API_BASE}${path}`;
    let res;
    try {
      res = await authApi().apiFetch(url, init);
    } catch (e) {
      // Errors thrown *before* the request went out are auth/config problems;
      // everything else (offline, DNS, TLS) is worth retrying.
      const code = e && e.code;
      if (code === "NOT_CONNECTED" || code === "CONFIG_MISSING") {
        throw new HubSpotDataError("AUTH", "Not connected to HubSpot.", { cause: e });
      }
      throw new HubSpotDataError("TRANSIENT", (e && e.message) || "HubSpot request failed.", {
        cause: e,
      });
    }

    if (res.status === 429) {
      const ms = retryAfterMs(res);
      log("HubSpot rate limited; retry after", Math.round(ms / 1000), "s —", url);
      throw new HubSpotDataError("RATE_LIMITED", "HubSpot rate limit reached.", {
        retryAfterMs: ms,
        status: 429,
      });
    }
    // 401 and 403 are different problems and must not share a message. A 401 is
    // "your token was rejected" — reconnecting fixes it. A 403 is "this token
    // isn't allowed to read that", which reconnecting does NOT fix: the app's
    // scope set is fixed, and HubSpot rejects the granular engagement scope names
    // outright on the current platform version, so there is nothing for a rep to
    // do about it. Telling them their sign-in expired was both wrong and
    // un-actionable.
    if (res.status === 401) {
      const body = await readBody(res);
      throw new HubSpotDataError("AUTH", describe(body) || "HTTP 401", { status: 401 });
    }
    if (res.status === 403) {
      const body = await readBody(res);
      throw new HubSpotDataError("FORBIDDEN", describe(body) || "HTTP 403", {
        status: 403,
        hubspotMessage: describe(body) || null,
      });
    }
    if (res.status === 404) {
      throw new HubSpotDataError("NOT_FOUND", "No such HubSpot record.", { status: 404 });
    }
    if (!res.ok) {
      const body = await readBody(res);
      throw new HubSpotDataError("TRANSIENT", describe(body) || `HTTP ${res.status}`, {
        status: res.status,
      });
    }
    return (await readBody(res)) || {};
  }

  function describe(body) {
    if (!body) return "";
    return String(body.message || body.error || "").slice(0, 300);
  }

  const postJson = (path, payload) => ({
    path,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  });

  function post(path, payload) {
    const p = postJson(path, payload);
    return request(p.path, p.init);
  }

  // NOT_FOUND is an answer, not a failure, for every "look this up" call.
  async function orNull(promise) {
    try {
      return await promise;
    } catch (e) {
      if (isDataError(e) && e.code === "NOT_FOUND") return null;
      throw e;
    }
  }

  // --- Small helpers -------------------------------------------------------
  const isId = (v) => v != null && /^\d+$/.test(String(v));
  const normEmail = (v) => String(v || "").trim().toLowerCase();

  // HubSpot returns every property as a string, including numbers and booleans,
  // and an unset property as "" (or omits it). These three keep "0" and "false"
  // meaningful while treating blanks as absent.
  const asText = (v) => {
    const s = v == null ? "" : String(v).trim();
    return s ? s : null;
  };

  function asNumber(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function asBool(v) {
    if (v == null || v === "") return null;
    return /^(true|yes|1)$/i.test(String(v).trim());
  }

  // A URL that came out of a CRM property is untrusted input. It is only ever
  // assigned to an <a href>, so anything that isn't plain http(s) — javascript:,
  // data:, a relative path — is dropped rather than linked.
  function safeUrl(v) {
    const s = asText(v);
    if (!s || !/^https?:\/\//i.test(s)) return null;
    try {
      const u = new URL(s);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch (_) {
      return null;
    }
  }

  // LinkedIn URLs in HubSpot are hand-entered and very often scheme-less
  // ("linkedin.com/in/jane"), which safeUrl rejects outright. A value that is
  // *exactly* a linkedin.com path gets an https:// prefix; anything else goes
  // through safeUrl untouched, so javascript:/data:/relative values are still
  // dropped rather than linked.
  function linkedInUrl(v) {
    const s = asText(v);
    if (!s) return null;
    if (/^(?:https?:\/\/)/i.test(s)) return safeUrl(s);
    // Optional www./country subdomain, then a linkedin.com path — and nothing
    // before it, so "javascript:linkedin.com/x" can never match.
    if (/^(?:www\.|[a-z]{2,3}\.)?linkedin\.com\/[^\s]*$/i.test(s)) return safeUrl(`https://${s}`);
    return safeUrl(s);
  }

  // First value that actually has text, for the description/about_us/linkedinbio
  // waterfall — most companies have exactly one of the three filled in.
  function firstText(values) {
    for (const v of values || []) {
      const t = asText(v);
      if (t) return t;
    }
    return null;
  }

  // A delimited CRM property (web_technologies is semicolon-ish, but the portal
  // has commas and newlines in it too) as a capped, de-duplicated list:
  // { items, more, total, all }. `more` is what "+N more" prints; `all` is the
  // full list for the hover title. Null when there is nothing to show.
  function delimitedList(value, max) {
    const raw = asText(value);
    if (!raw) return null;
    const cap = Number(max) > 0 ? Number(max) : CONFIG.TECH_STACK_MAX;
    const seen = Object.create(null);
    const all = [];
    for (const part of raw.split(/[;,|\r\n\t]+/)) {
      const item = part.trim().replace(/\s+/g, " ");
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      all.push(item);
    }
    if (!all.length) return null;
    return { items: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length, all };
  }

  function truncate(text, max) {
    const s = String(text == null ? "" : text);
    const limit = Number(max) > 0 ? Number(max) : 0;
    if (!limit || s.length <= limit) return s;
    // Prefer a word boundary, but never give back a stub: if the last space is
    // very early, hard-cut instead.
    const cut = s.slice(0, limit);
    const space = cut.lastIndexOf(" ");
    return (space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "") + "…";
  }

  function emailDomain(email) {
    const at = normEmail(email).lastIndexOf("@");
    return at > 0 ? normEmail(email).slice(at + 1) : null;
  }

  function isFreeMailDomain(domain) {
    return CONFIG.FREE_EMAIL_DOMAINS.indexOf(String(domain || "").toLowerCase()) !== -1;
  }

  // v3 GET associations come back as
  // { associations: { companies: { results: [{ id, type }] } } }.
  function associatedIds(record, kind) {
    const group = record && record.associations && record.associations[kind];
    const results = (group && group.results) || [];
    const ids = [];
    for (const r of results) {
      const id = r && (r.id != null ? r.id : r.toObjectId);
      if (isId(id) && ids.indexOf(String(id)) === -1) ids.push(String(id));
    }
    return ids;
  }

  // v4 association reads come back as { results: [{ toObjectId, ... }] }.
  function v4Ids(body) {
    const out = [];
    for (const r of (body && body.results) || []) {
      const id = r && (r.toObjectId != null ? r.toObjectId : r.id);
      if (isId(id) && out.indexOf(String(id)) === -1) out.push(String(id));
    }
    return out;
  }

  const propList = (props) => props.map(encodeURIComponent).join(",");

  // --- Formatting (exported: the panel renders with these, and they are the
  // easiest part of this file to get subtly wrong, so they are unit-tested) ---

  // HubSpot timestamps arrive as ISO strings on reads and epoch-ms strings on
  // some writes; accept both, and never throw on junk.
  function toMillis(value) {
    if (value == null || value === "") return 0;
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const s = String(value).trim();
    if (/^\d+$/.test(s)) return Number(s);
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatCurrency(amount) {
    if (amount == null || amount === "") return "";
    const n = Number(amount);
    if (!Number.isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(CONFIG.LOCALE, {
        style: "currency",
        currency: CONFIG.CURRENCY,
        // Whole amounts read better without ".00"; keep cents when they exist.
        minimumFractionDigits: n % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(n);
    } catch (_) {
      return `$${n}`;
    }
  }

  function formatDate(value) {
    const ms = toMillis(value);
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat(CONFIG.LOCALE, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC", // closedate is a date, not an instant — don't shift it
      }).format(new Date(ms));
    } catch (_) {
      return "";
    }
  }

  // The absolute stamp behind every activity row's relative time (title=…), so
  // "3h ago" can be resolved to a real moment on hover. Local zone, unlike
  // formatDate: an engagement is an instant, not a calendar date.
  function formatDateTime(value) {
    const ms = toMillis(value);
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat(CONFIG.LOCALE, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch (_) {
      return "";
    }
  }

  // Credit balances and plan sizes are the numbers this panel shows most, and
  // they run to five figures — thousands separators are not decoration.
  function formatNumber(value) {
    const n = asNumber(value);
    if (n == null) return "";
    try {
      return new Intl.NumberFormat(CONFIG.LOCALE, { maximumFractionDigits: 2 }).format(n);
    } catch (_) {
      return String(n);
    }
  }

  // "just now" / "14m ago" / "3h ago" / "2d ago" / "5mo ago" / "2y ago".
  function relativeTime(value, now) {
    const ms = toMillis(value);
    if (!ms) return "";
    const ref = now == null ? Date.now() : now;
    const diff = ref - ms;
    if (diff < 0) return "scheduled";
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  // Notes are stored as HTML. This is a *display* transform for a one-line
  // summary: tags are removed with a regex and the result is only ever assigned
  // to textContent. Untrusted HTML is never parsed into live nodes anywhere in
  // this extension.
  function stripHtml(html) {
    if (!html) return "";
    return String(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  // HubSpot's own vocabulary is SCREAMING_SNAKE ("SALES_QUALIFIED_LEAD"); the
  // panel shows it as "Sales qualified lead".
  function humanizeEnum(value) {
    const v = String(value || "").trim();
    if (!v) return "";
    if (/[a-z]/.test(v) && !/_/.test(v)) return v; // already a label
    const words = v.toLowerCase().replace(/_/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // Call length as a clock reading (mm:ss, h:mm:ss past an hour) — reps compare
  // call durations to each other, and "4:07" scans faster than "4m 7s".
  // hs_call_duration is milliseconds.
  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const total = Math.round(n / 1000);
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600);
    const pad = (v) => String(v).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function recordUrl(kind, id) {
    if (!isId(id) || !OBJECT_TYPE[kind] || !CFG.PORTAL_ID) return null;
    return `https://app.hubspot.com/contacts/${CFG.PORTAL_ID}/record/${OBJECT_TYPE[kind]}/${id}`;
  }

  // --- Session caches ------------------------------------------------------
  // Keyed the way the data is shared: pipelines are portal-wide (one promise),
  // owners are per-ID, bundles are per-email.
  let pipelinePromise = null;
  // Owner entries are keyed by *how* they were looked up — "o:{ownerId}" for a
  // hubspot_owner_id, "u:{userId}" for an hs_created_by user id — because the
  // two id spaces overlap numerically and mean different people.
  const ownerCache = new Map(); // "o:123" | "u:456" -> { name, email } | null
  const ownerInFlight = new Map(); // same key -> Promise
  const bundleCache = new Map(); // cacheKey(email) -> { at, bundle }
  const bundleInFlight = new Map(); // cacheKey(email) -> Promise

  // Namespacing the bundle cache by CACHE_VERSION means a bundle built by an
  // older copy of this file (a reloaded panel shares nothing, but a live session
  // that upgraded mid-flight would) can never be handed to newer render code.
  const cacheKey = (email) => `v${CONFIG.CACHE_VERSION}|${normEmail(email)}`;

  // --- Pipelines / stage labels -------------------------------------------
  // dealstage and pipeline are opaque IDs on the deal record; this is the only
  // way to render them as words. Fetched at most once per panel session.
  function getDealPipelines() {
    if (!pipelinePromise) {
      pipelinePromise = request("/crm/v3/pipelines/deals")
        .then((body) => {
          const stages = new Map();
          const pipelines = new Map();
          for (const p of (body && body.results) || []) {
            pipelines.set(String(p.id), p.label || "");
            for (const s of p.stages || []) {
              stages.set(String(s.id), {
                label: s.label || "",
                closed: String((s.metadata && s.metadata.isClosed) || "false") === "true",
                won: Number((s.metadata && s.metadata.probability) || 0) === 1,
              });
            }
          }
          log("HubSpot deal pipelines cached:", pipelines.size, "pipelines,", stages.size, "stages");
          return { pipelines, stages };
        })
        .catch((e) => {
          // A missing label map must not sink the Deals section — reset so a
          // later render can try again, and fall back to raw IDs.
          pipelinePromise = null;
          log("pipeline fetch failed; deal stages will show raw IDs:", e && e.message);
          return { pipelines: new Map(), stages: new Map() };
        });
    }
    return pipelinePromise;
  }

  // --- Owners --------------------------------------------------------------
  const ownerKey = (id, kind) => `${kind === "user" ? "u" : "o"}:${id}`;

  // kind "owner" → /owners/{ownerId}; kind "user" → the same record looked up by
  // the HubSpot *user* id that hs_created_by carries (owner id ≠ user id).
  async function fetchOwner(id, kind) {
    const query = kind === "user" ? "?idProperty=userId" : "";
    const body = await orNull(request(`/crm/v3/owners/${encodeURIComponent(id)}${query}`));
    if (!body) return null;
    const name = [body.firstName, body.lastName].filter(Boolean).join(" ").trim();
    return { name: name || body.email || "", email: body.email || "" };
  }

  // Resolves many owner IDs at once: cache hits are free, misses go out in
  // parallel, and two concurrent callers asking for the same owner share one
  // request. Owner lookups are general-pool, and an SDR team shares owners, so
  // in practice this is a handful of calls per session — which is what makes
  // per-row attribution on 100+ activity rows affordable.
  async function resolveOwners(ids, options) {
    const kind = (options && options.kind) === "user" ? "user" : "owner";
    const wanted = [];
    for (const raw of ids || []) {
      const id = String(raw == null ? "" : raw);
      if (isId(id) && wanted.indexOf(id) === -1) wanted.push(id);
    }
    await Promise.all(
      wanted.map(async (id) => {
        const key = ownerKey(id, kind);
        if (ownerCache.has(key)) return;
        if (!ownerInFlight.has(key)) {
          const p = fetchOwner(id, kind)
            .catch((e) => {
              // Never let a missing owner name break a section.
              log("owner lookup failed for", key, "-", e && e.message);
              return null;
            })
            .then((owner) => {
              ownerCache.set(key, owner);
              ownerInFlight.delete(key);
              return owner;
            });
          ownerInFlight.set(key, p);
        }
        await ownerInFlight.get(key);
      })
    );
    const out = new Map();
    for (const id of wanted) out.set(id, ownerCache.get(ownerKey(id, kind)) || null);
    return out;
  }

  const ownerName = (owners, id) => {
    const o = id != null && owners ? owners.get(String(id)) : null;
    return (o && o.name) || null;
  };

  // Budget guard for Phase 9's colleague rows. Owner IDs already in the session
  // cache are kept unconditionally (they cost nothing); IDs never seen before are
  // kept only up to `max`. So the common case — an account whose contacts are
  // owned by two or three people the panel has already resolved — resolves every
  // row, and the pathological case (25 contacts, 25 distinct unseen owners)
  // cannot quietly become 25 extra general-pool requests. Rows whose owner was
  // not resolved render with no owner name at all; a bare numeric ID is never a
  // name a rep should have to read.
  function capNewOwnerIds(ids, max) {
    const limit = Number(max) > 0 ? Number(max) : 0;
    let budget = limit;
    const out = [];
    for (const raw of ids || []) {
      const id = String(raw == null ? "" : raw);
      if (!isId(id) || out.indexOf(id) !== -1) continue;
      if (ownerCache.has(ownerKey(id, "owner"))) {
        out.push(id);
        continue;
      }
      if (budget <= 0) continue;
      budget--;
      out.push(id);
    }
    return out;
  }

  // The connected SDR's own owner ID, so a colleague row can say whether it is
  // theirs or a teammate's. Read from the stored auth record only — this is
  // deliberately NOT ensureOwnerId(), which may spend a request: the Phase 9
  // section's whole claim is that it costs two requests, and an ownership marker
  // is not worth a third. Unknown stays unknown (null), and the row then shows
  // the owner's name with no claim either way.
  async function connectedOwnerId() {
    try {
      const auth = EB.hubspotAuth;
      if (!auth || typeof auth.getAuthState !== "function") return null;
      const state = await auth.getAuthState();
      const id = state && state.ownerId;
      return isId(id) ? String(id) : null;
    } catch (e) {
      log("could not read the connected owner id:", (e && e.message) || e);
      return null;
    }
  }

  // The portal's ownership properties (sdr_company_owner, cs_company_owner) are
  // not typed the way hubspot_owner_id is: depending on how the record was
  // written they hold either an owner-ID reference *or* an already-resolved
  // name. So inspect the value rather than trusting the schema:
  //   digits      → resolve through the session owner cache; if that fails the
  //                 answer is "nothing to show", never the bare number (a rep
  //                 reading "Outbound owner 682134" learns less than nothing)
  //   anything else → already a name (or an email), pass it through
  function ownerRef(value, owners) {
    const raw = asText(value);
    if (!raw) return null;
    if (!isId(raw)) return raw;
    return ownerName(owners, raw);
  }

  // --- Contact / company resolution ---------------------------------------
  function contactByIdPath(id) {
    return (
      `/crm/v3/objects/contacts/${encodeURIComponent(id)}` +
      `?associations=companies,deals&properties=${propList(CONFIG.CONTACT_PROPERTIES)}`
    );
  }

  const getContactById = (id) => orNull(request(contactByIdPath(id)));

  const getCompanyById = (id) =>
    orNull(
      request(
        `/crm/v3/objects/companies/${encodeURIComponent(id)}` +
          `?properties=${propList(CONFIG.COMPANY_PROPERTIES)}`
      )
    );

  // The scarce call (5 req/s portal-wide). Two filter groups = OR: the primary
  // email, or the address sitting in hs_additional_emails.
  async function searchContactByEmail(email) {
    const body = await post("/crm/v3/objects/contacts/search", {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
        {
          filters: [
            { propertyName: "hs_additional_emails", operator: "CONTAINS_TOKEN", value: email },
          ],
        },
      ],
      properties: CONFIG.CONTACT_PROPERTIES,
      limit: 1,
    });
    const hit = ((body && body.results) || [])[0];
    if (!hit) return null;
    // Search results carry properties but no associations, so one direct GET
    // follows to pick up the company and deal IDs. Still only one search.
    return (await getContactById(hit.id)) || hit;
  }

  async function searchCompanyByDomain(domain) {
    const body = await post("/crm/v3/objects/companies/search", {
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
      properties: CONFIG.COMPANY_PROPERTIES,
      limit: 1,
    });
    return ((body && body.results) || [])[0] || null;
  }

  // The waterfall, cheapest first:
  //   contact  scraped record ID → email search
  //   company  scraped record ID → the contact's first association → domain search
  // A scraped ID that 404s (record merged or deleted since) falls through to
  // search rather than reporting "not found".
  async function resolveProspect(ctx) {
    const email = normEmail(ctx && ctx.email);
    let contact = null;
    let contactVia = null;

    if (isId(ctx && ctx.hsContactId)) {
      contact = await getContactById(ctx.hsContactId);
      if (contact) contactVia = "record-id";
      else log("scraped HubSpot contact id", ctx.hsContactId, "not found; falling back to search");
    }
    if (!contact && email) {
      contact = await searchContactByEmail(email);
      if (contact) contactVia = "email-search";
    }

    let company = null;
    let companyVia = null;
    if (isId(ctx && ctx.hsCompanyId)) {
      company = await getCompanyById(ctx.hsCompanyId);
      if (company) companyVia = "record-id";
    }
    if (!company && contact) {
      const id = associatedIds(contact, "companies")[0];
      if (id) {
        company = await getCompanyById(id);
        if (company) companyVia = "association";
      }
    }
    if (!company) {
      const domain = emailDomain(email);
      if (domain && !isFreeMailDomain(domain)) {
        company = await searchCompanyByDomain(domain);
        if (company) companyVia = "domain-search";
      }
    }

    return { contact, company, contactVia, companyVia };
  }

  // --- Deals ---------------------------------------------------------------
  // `dealIds` come from the contact's associations, so no association call is
  // needed here. Nothing to read → no request at all.
  async function getDeals(contactId, dealIds) {
    const ids = (dealIds || []).filter(isId).slice(0, CONFIG.BATCH_MAX);
    if (!ids.length) return [];
    const [body, labels] = await Promise.all([
      post("/crm/v3/objects/deals/batch/read", {
        properties: CONFIG.DEAL_PROPERTIES,
        inputs: ids.map((id) => ({ id })),
      }),
      getDealPipelines(),
    ]);
    const deals = ((body && body.results) || []).map((d) => {
      const p = d.properties || {};
      const stage = labels.stages.get(String(p.dealstage)) || null;
      return {
        id: String(d.id),
        name: p.dealname || "(unnamed deal)",
        stage: (stage && stage.label) || p.dealstage || "",
        closed: !!(stage && stage.closed),
        won: !!(stage && stage.won),
        pipeline: labels.pipelines.get(String(p.pipeline)) || "",
        amount: p.amount != null && p.amount !== "" ? Number(p.amount) : null,
        closeDate: p.closedate || null,
        ownerId: p.hubspot_owner_id || null,
        url: recordUrl("deal", d.id),
        // Outcome context (Phase 8). Kept as separate nullable fields rather
        // than a pre-joined string so dealOutcome() — which the panel renders
        // and the harness asserts on — stays the only place that decides what a
        // closed row says. closedLost is HubSpot's own flag; null when unset.
        closedLost: asBool(p.hs_is_closed_lost),
        lostReason: asText(p.closed_lost_reason),
        lostCategory: humanizeEnum(p.closed_loss_category) || null,
        lostCategorySecondary: humanizeEnum(p.closed_lost_category__secondary_) || null,
        wonReason: asText(p.closed_won_reason),
      };
    });
    // Open deals are what a rep is about to talk about; closed ones are context.
    deals.sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      return toMillis(b.closeDate) - toMillis(a.closeDate);
    });
    return deals;
  }

  // --- Deal outcome line (Phase 8; pure, exported, unit-tested) -------------
  // The one-line "why this ended" for a *closed* deal: the talk track for a
  // re-approach ("last time this stalled on budget…"). Open deals have no
  // outcome, and a closed deal with none of the reason properties set gets no
  // row at all rather than an empty label.
  //
  // Returns { text, title } — text is capped for the row, title carries the
  // whole thing for the hover.
  function dealOutcome(deal) {
    if (!deal || !deal.closed) return null;
    // Pipeline probability says won; hs_is_closed_lost is the portal's explicit
    // flag and wins when the two disagree. Closed and not won = lost.
    const lost = deal.closedLost === true || !deal.won;
    const parts = lost
      ? [deal.lostReason, deal.lostCategory, deal.lostCategorySecondary]
      : [deal.wonReason];
    const seen = Object.create(null);
    const kept = [];
    for (const part of parts) {
      const t = asText(part);
      if (!t) continue;
      // A secondary category that repeats the primary adds nothing to a row
      // this narrow.
      const key = t.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      kept.push(t);
    }
    if (!kept.length) return null;
    const full = kept.join(" · ");
    const prefix = lost ? "Lost" : "Won";
    return { lost, text: `${prefix}: ${truncate(full, CONFIG.OUTCOME_CHARS)}`, title: `${prefix}: ${full}` };
  }

  // --- Activity ------------------------------------------------------------
  // One row's worth of data. `summary` is the headline, `detail` the per-type
  // extras (disposition · duration, outcome, task status), `ownerId` /
  // `createdById` the two attribution candidates — the panel prints a name or
  // nothing, never a raw id.
  function activityItem(spec, obj) {
    const p = (obj && obj.properties) || {};
    const item = {
      id: String(obj && obj.id),
      type: spec.type,
      label: spec.label,
      timestamp: toMillis(p.hs_timestamp),
      summary: "",
      direction: null,
      detail: "",
      ownerId: asText(p.hubspot_owner_id),
      createdById: asText(p.hs_created_by),
      ownerName: null,
    };
    if (spec.type === "calls") {
      item.summary = asText(p.hs_call_title) || "Call";
      item.direction = /^out/i.test(p.hs_call_direction || "") ? "out" : /^in/i.test(p.hs_call_direction || "") ? "in" : null;
      item.detail = [
        CALL_DISPOSITIONS[String(p.hs_call_disposition || "").toLowerCase()] || "",
        formatDuration(p.hs_call_duration),
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (spec.type === "emails") {
      item.summary = asText(p.hs_email_subject) || "Email";
      item.direction = /^email_out|^outgoing|^out/i.test(p.hs_email_direction || "")
        ? "out"
        : /^incoming|^in|^forwarded/i.test(p.hs_email_direction || "")
          ? "in"
          : null;
    } else if (spec.type === "meetings") {
      item.summary = asText(p.hs_meeting_title) || "Meeting";
      item.detail = humanizeEnum(p.hs_meeting_outcome);
    } else if (spec.type === "notes") {
      // Note bodies are HTML and can run for paragraphs; one line is the whole
      // point of the row. (stripHtml is a display transform onto textContent —
      // the HTML is never parsed into nodes.)
      item.summary = truncate(stripHtml(p.hs_note_body), CONFIG.NOTE_PREVIEW_CHARS) || "Note";
    } else if (spec.type === "tasks") {
      item.summary = asText(p.hs_task_subject) || "Task";
      item.detail = humanizeEnum(p.hs_task_status);
    }
    return item;
  }

  // Newest first, with a deterministic tie-break: same-timestamp rows (bulk
  // imports, a call and its note logged together) would otherwise shuffle
  // between renders.
  const typeOrder = (type) => {
    const i = CONFIG.ACTIVITY_TYPES.findIndex((s) => s.type === type);
    return i === -1 ? CONFIG.ACTIVITY_TYPES.length : i;
  };

  function sortActivity(items) {
    items.sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      const t = typeOrder(a.type) - typeOrder(b.type);
      if (t !== 0) return t;
      return String(b.id).localeCompare(String(a.id));
    });
    return items;
  }

  // --- Activity view-model (pure; drives the panel's tab bar) --------------
  const ACTIVITY_TABS = ["all"].concat(CONFIG.ACTIVITY_TYPES.map((s) => s.type));

  function filterActivity(items, tab) {
    const list = items || [];
    if (!tab || tab === "all") return list.slice();
    return list.filter((i) => i && i.type === tab);
  }

  // [{ key, label, count, disabled }] — "All" first, then one per type in
  // ACTIVITY_TYPES order. A tab with nothing in it is disabled rather than
  // hidden, so the bar doesn't reflow as you move between prospects.
  function activityTabs(items) {
    const list = items || [];
    const counts = new Map();
    for (const item of list) {
      const t = item && item.type;
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const tabs = [{ key: "all", label: "All", count: list.length, disabled: !list.length }];
    for (const spec of CONFIG.ACTIVITY_TYPES) {
      const count = counts.get(spec.type) || 0;
      tabs.push({ key: spec.type, label: spec.tab || spec.label, count, disabled: count === 0 });
    }
    return tabs;
  }

  // The tab to actually render: the remembered one if it still has rows, else
  // "All". Keeps a rep's choice across prospect switches without ever showing
  // them an empty list they can't explain.
  function resolveActivityTab(items, preferred) {
    const tabs = activityTabs(items);
    const hit = tabs.find((t) => t.key === preferred);
    return hit && !hit.disabled ? hit.key : "all";
  }

  // v4 associations per type in parallel, then one batch read per type that
  // actually has associations — types with none cost exactly one association
  // read and no batch call. Worst case ~10 general-pool requests, cached per
  // contact for the bundle's TTL.
  // Each type is fetched and failed independently: one engagement type the token
  // can't read must not blank the four it can. Every per-type failure logs its
  // HTTP status, because "which type, what status" is the only thing that makes a
  // 403 here diagnosable from the panel's console. Only a total failure — every
  // type erroring — is reported to the panel as a section error; anything less
  // renders the rows that did come back, and a genuinely empty result stays
  // empty rather than looking broken.
  async function getActivity(contactId) {
    if (!isId(contactId)) return [];
    const failures = [];
    const perType = await Promise.all(
      CONFIG.ACTIVITY_TYPES.map(async (spec) => {
        try {
          const body = await orNull(
            request(
              `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/${spec.type}?limit=${CONFIG.BATCH_MAX}`
            )
          );
          const ids = v4Ids(body).slice(0, CONFIG.BATCH_MAX);
          if (!ids.length) return [];
          const read = await post(`/crm/v3/objects/${spec.type}/batch/read`, {
            properties: spec.properties,
            inputs: ids.map((id) => ({ id })),
          });
          const items = ((read && read.results) || []).map((obj) => activityItem(spec, obj));
          // Association reads come back in id order, not time order, so the cap
          // is applied *after* sorting — otherwise "25 most recent calls" would
          // really mean "25 oldest". Reading up to BATCH_MAX ids and keeping 25
          // costs the same one request either way.
          return sortActivity(items).slice(0, CONFIG.ACTIVITY_PER_TYPE_LIMIT);
        } catch (e) {
          failures.push(e);
          log(
            `activity: ${spec.type} could not be read — HTTP ${(e && e.status) || "?"}`,
            (e && e.code) || "?",
            (e && e.message) || e
          );
          return null;
        }
      })
    );

    const usable = perType.filter((rows) => rows !== null);
    if (!usable.length && failures.length) {
      log("activity: every engagement type failed; reporting it to the panel");
      throw failures[0];
    }
    if (failures.length) {
      log(
        `activity: ${failures.length} of ${CONFIG.ACTIVITY_TYPES.length} engagement types unavailable; showing the rest`
      );
    }

    // Attribution is part of a row, not a later decoration: callers of
    // getActivity always get rows they can render as-is.
    return attributeActivity(sortActivity([].concat.apply([], usable)));
  }

  // Puts a name on every activity row it can, in two batched passes over the
  // session owner cache: hubspot_owner_id first, then hs_created_by (a *user*
  // id) for the rows that have no owner — dialer-logged calls often don't. A row
  // whose ids resolve to nothing keeps ownerName null and simply renders without
  // attribution; a raw id is never shown to a rep.
  async function attributeActivity(items) {
    const list = items || [];
    if (!list.length) return list;

    const owners = await resolveOwners(list.map((i) => i.ownerId));
    for (const item of list) item.ownerName = ownerName(owners, item.ownerId);

    const orphans = list.filter((i) => !i.ownerName && i.createdById);
    if (orphans.length) {
      const users = await resolveOwners(
        orphans.map((i) => i.createdById),
        { kind: "user" }
      );
      for (const item of orphans) item.ownerName = ownerName(users, item.createdById);
    }
    return list;
  }

  // --- Account contacts (Phase 9) ------------------------------------------
  // "Who else are we touching at this account" — the question a rep currently
  // answers by filtering the full dialer tab by account (impossible mid-call) or
  // by opening the company's LinkedIn page and reading employee names off it.
  //
  // Cost, exactly, and this is the whole design constraint:
  //   1  GET  /crm/v4/objects/companies/{id}/associations/contacts?limit=25
  //   2  POST /crm/v3/objects/contacts/batch/read
  // Two requests, both on the general pool (110 req/10s), never the CRM Search
  // pool (5 req/s, portal-wide, shared by the whole team) — there is no search
  // here and there must never be one. No company → zero requests. No associated
  // contacts → one request. The result rides in the per-email bundle, so the
  // 5-minute cache and the in-flight dedup cover it like every other section: a
  // rep clicking back and forth through a call list pays this once.
  //
  // Returns raw HubSpot records; shaping, filtering and ordering are
  // accountContactsView's job (pure, and unit-tested without a DOM).
  async function getAccountContacts(companyId) {
    if (!isId(companyId)) return [];
    const limit = CONFIG.ACCOUNT_CONTACTS_LIMIT;
    const body = await orNull(
      request(
        `/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/contacts?limit=${limit}`
      )
    );
    // Asking for one page of `limit` and slicing to the same number means paging
    // is not a code path that exists here.
    const ids = v4Ids(body).slice(0, limit);
    if (!ids.length) return [];
    const read = await post("/crm/v3/objects/contacts/batch/read", {
      properties: CONFIG.ACCOUNT_CONTACT_PROPERTIES,
      inputs: ids.map((id) => ({ id })),
    });
    const results = (read && read.results) || [];
    log("account contacts:", results.length, "of", ids.length, "associated to company", companyId);
    return results;
  }

  // The view-model (pure over fetched records + resolved owner names).
  //
  // Ordering, most-useful-first, and no further:
  //   1  in a sequence now  — the literal ask ("who else has been sequenced from
  //                           that account"); someone already being worked is
  //                           both the best pivot and the teammate you must not
  //                           step on
  //   2  most recently contacted — a colleague touched last week is warmer than
  //                           one nobody has called since 2023
  //   3  name, then id      — deterministic only; rows must not shuffle between
  //                           renders of the same account
  // Job-title seniority is deliberately NOT a sort key: it needs a title
  // taxonomy to be anything better than a guess, and a wrong guess about who
  // matters at an account is worse than alphabetical.
  //
  // Excluded: the prospect the rep is already looking at — by record ID, and by
  // email for the case where the contact record wasn't matched but the same
  // person is in the association list.
  function accountContactsView(records, options) {
    const opts = options || {};
    const excludeId = isId(opts.excludeContactId) ? String(opts.excludeContactId) : null;
    const excludeEmail = normEmail(opts.excludeEmail) || null;
    const selfOwnerId = isId(opts.selfOwnerId) ? String(opts.selfOwnerId) : null;
    const owners = opts.owners || null;

    const rows = [];
    const seen = Object.create(null);
    for (const rec of records || []) {
      if (!rec || !isId(rec.id)) continue;
      const id = String(rec.id);
      if (id === excludeId || seen[id]) continue;
      const p = rec.properties || {};
      const email = normEmail(p.email) || null;
      if (excludeEmail && email === excludeEmail) continue;
      seen[id] = true;

      const name = [asText(p.firstname), asText(p.lastname)].filter(Boolean).join(" ").trim();
      const ownerId = asText(p.hubspot_owner_id);
      // Tri-state on purpose: true / false / unknown. A contact whose enrolment
      // flag the portal doesn't set must not be reported as "not sequenced" —
      // that is a claim, and the panel makes no claims it can't back.
      const enrolled = asBool(p.hs_sequences_is_enrolled);
      rows.push({
        id,
        // Never blank, and never a placeholder glyph: a name, else the email,
        // else an honest label.
        name: name || email || "(no name)",
        title: asText(p.jobtitle),
        email,
        phone: asText(p.phone),
        lifecycleStage: humanizeEnum(p.lifecyclestage) || null,
        inSequence: enrolled,
        // The sequence *name* is only meaningful as "the one they're in" when
        // they are in one; otherwise it is a historical fact about a past
        // enrolment and belongs nowhere in a one-line row.
        sequenceName: enrolled === true ? asText(p.hs_latest_sequence_enrolled) : null,
        sequenceEnrolledAt: toMillis(p.hs_latest_sequence_enrolled_date) || null,
        lastContactedAt: toMillis(p.notes_last_contacted) || null,
        lastActivityAt: toMillis(p.notes_last_updated) || null,
        ownerId,
        // Resolved through the shared session owner cache by the caller. Null
        // when it couldn't be resolved (or wasn't looked up) — the row then shows
        // no owner rather than a number.
        ownerName: ownerName(owners, ownerId),
        // true = the connected rep's own contact, false = a teammate's, null =
        // we don't know whose (unknown owner, or the connection has no owner ID
        // resolved yet). Null renders as neither claim.
        isMine: selfOwnerId && ownerId ? ownerId === selfOwnerId : null,
        linkedinUrl: linkedInUrl(p.hs_linkedin_url),
        url: recordUrl("contact", id),
      });
    }

    rows.sort((a, b) => {
      const aSeq = a.inSequence === true ? 0 : 1;
      const bSeq = b.inSequence === true ? 0 : 1;
      if (aSeq !== bSeq) return aSeq - bSeq;
      const aWhen = a.lastContactedAt || 0;
      const bWhen = b.lastContactedAt || 0;
      if (bWhen !== aWhen) return bWhen - aWhen;
      const byName = String(a.name).localeCompare(String(b.name));
      if (byName !== 0) return byName;
      return String(a.id).localeCompare(String(b.id));
    });
    return rows;
  }

  // --- Bundle --------------------------------------------------------------
  function contactView(contact, owners) {
    if (!contact) return null;
    const p = contact.properties || {};
    const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim();
    return {
      id: String(contact.id),
      name: name || p.email || "(no name)",
      email: p.email || null,
      title: p.jobtitle || null,
      phone: p.phone || null,
      // Phase 10: the other two writable numbers, for the wrong-number editor.
      // Raw values — a phone property is displayed and edited as the portal
      // stores it, never reformatted for display.
      mobilePhone: p.mobilephone || null,
      phone2: p.phone_number_2 || null,
      lifecycleStage: humanizeEnum(p.lifecyclestage) || null,
      leadStatus: humanizeEnum(p.hs_lead_status) || null,
      ownerId: p.hubspot_owner_id || null,
      ownerName: ownerName(owners, p.hubspot_owner_id),
      lastActivityAt: p.notes_last_updated ? toMillis(p.notes_last_updated) : null,
      // One-click LinkedIn from the identity block (Phase 8): the rep was going
      // to open a tab and search for them anyway.
      linkedinUrl: linkedInUrl(p.hs_linkedin_url),
      url: recordUrl("contact", contact.id),
    };
  }

  function companyView(company, owners) {
    if (!company) return null;
    const p = company.properties || {};
    return {
      id: String(company.id),
      name: p.name || p.domain || "(unnamed company)",
      domain: p.domain || null,
      industry: humanizeEnum(p.industry) || null,
      employees: p.numberofemployees != null && p.numberofemployees !== "" ? Number(p.numberofemployees) : null,
      ownerId: p.hubspot_owner_id || null,
      ownerName: ownerName(owners, p.hubspot_owner_id),
      linkedinUrl: linkedInUrl(p.linkedin_company_page),
      url: recordUrl("company", company.id),
    };
  }

  // --- Ownership (Phase 8) -------------------------------------------------
  // The correctness fix: the identity block used to show one unlabelled name
  // taken from hubspot_owner_id, which is *not* the outbound owner. HubSpot's
  // own description of sdr_company_owner says so explicitly ("use this for
  // outbound ownership, not hubspot_owner_id"), and "who owns prospecting on
  // this account" is the question a rep asks before dialing.
  //
  // So: four separately-labelled, separately-nullable names. Outbound is the
  // prominent one; the rest are supporting detail. Every value goes through
  // ownerRef, which resolves ID-shaped values and drops the ones it can't
  // resolve — a bare numeric ID is never a name.
  function ownershipView(contact, company, owners) {
    const cp = (company && company.properties) || {};
    const kp = (contact && contact.properties) || {};
    const own = {
      outbound: ownerRef(cp.sdr_company_owner, owners),
      csm: ownerRef(cp.cs_company_owner, owners),
      companyOwner: ownerRef(cp.hubspot_owner_id, owners),
      contactOwner: ownerRef(kp.hubspot_owner_id, owners),
      changedAt: toMillis(cp.outbound_ownership_change_date) || null,
    };
    own.hasData = !!(own.outbound || own.csm || own.companyOwner || own.contactOwner);
    return own;
  }

  // --- Account context (Phase 8) -------------------------------------------
  // Two SDR asks in one view-model because they answer one question — "is this
  // worth calling, and what do I open with":
  //   grade / team sizes / company status  → worth calling at all
  //   blurb / ICP / tech stack             → what to say once they pick up
  //
  // Every field is independently nullable and `hasData` is false when the
  // company has none of them (the common case for a thin record), which is what
  // lets the panel hide the whole section instead of drawing an empty card.
  function accountContextView(company) {
    const p = (company && company.properties) || {};

    // description → about_us → linkedinbio. The full text is kept for the hover
    // title; `truncated` tells the panel whether a hover is worth offering.
    const blurb = firstText([p.description, p.about_us, p.linkedinbio]);
    const snippet = blurb ? truncate(stripHtml(blurb), CONFIG.SNIPPET_CHARS) : null;
    const blurbFull = blurb ? stripHtml(blurb) : null;

    const reasoningFull = asText(p.account_icp_ai_reasoning)
      ? stripHtml(asText(p.account_icp_ai_reasoning))
      : null;

    const ctx = {
      // Worth-calling check
      grade: asText(p.account_grade_v1),
      status: humanizeEnum(p.company_lifecycle_stage) || null,
      salesTeamSize: asNumber(p.asm_sales_team_size),
      aeTeamSize: asNumber(p.ae_team_size),
      obTeamSize: asNumber(p.ob_team_size),
      leadershipTeamSize: asNumber(p.sales_leadership_team_size),
      // What to open with
      snippet,
      snippetFull: blurbFull,
      snippetTruncated: !!(blurbFull && snippet && blurbFull.length > snippet.length),
      industry: humanizeEnum(p.industry_wiza) || null,
      icp: humanizeEnum(p.account_icp) || null,
      icpFit: humanizeEnum(p.icp_fit) || null,
      icpReasoning: reasoningFull ? truncate(reasoningFull, CONFIG.REASONING_CHARS) : null,
      icpReasoningFull: reasoningFull,
      tech: delimitedList(p.web_technologies),
    };
    ctx.hasData = !!(
      ctx.grade ||
      ctx.status ||
      ctx.salesTeamSize != null ||
      ctx.aeTeamSize != null ||
      ctx.obTeamSize != null ||
      ctx.leadershipTeamSize != null ||
      ctx.snippet ||
      ctx.industry ||
      ctx.icp ||
      ctx.icpFit ||
      ctx.icpReasoning ||
      ctx.tech
    );
    return ctx;
  }

  // --- Sequence context (Phase 8) ------------------------------------------
  // "Are they already being worked, and when did anyone last touch them" — the
  // difference between a cold dial and stepping on a teammate's sequence.
  //
  // `line` is the whole statement, and it is null when the portal doesn't say:
  // claiming "Not in a sequence" on a record with no enrolment data at all would
  // be a guess presented as a fact. An unenrolled contact that still has a
  // latest-sequence name reports it as `lastSequence` instead, which is true.
  function sequenceView(contact) {
    const p = (contact && contact.properties) || {};
    const enrolled = asBool(p.hs_sequences_is_enrolled);
    const name = asText(p.hs_latest_sequence_enrolled);
    const enrolledAt = toMillis(p.hs_latest_sequence_enrolled_date) || null;
    const seq = {
      enrolled,
      name,
      enrolledAt,
      lastContactedAt: toMillis(p.notes_last_contacted) || null,
      line: null,
      lastSequence: null,
      lastSequenceAt: null,
    };
    if (enrolled === true) {
      const since = enrolledAt ? ` since ${formatDate(enrolledAt)}` : "";
      seq.line = (name ? `In sequence: ${name}` : "In sequence") + since;
    } else if (enrolled === false) {
      seq.line = "Not in a sequence";
      seq.lastSequence = name;
      seq.lastSequenceAt = name ? enrolledAt : null;
    } else if (name) {
      // No enrolment flag, but a sequence name: report the fact, not a state.
      seq.lastSequence = name;
      seq.lastSequenceAt = enrolledAt;
    }
    seq.hasData = !!(seq.line || seq.lastSequence || seq.lastContactedAt);
    return seq;
  }

  // --- Wiza product data ---------------------------------------------------
  // Most prospects are not Wiza users, so absence is the common case, not the
  // error case: every field is independently nullable, `isUser` / `hasData` say
  // whether there is anything to show at all, and the panel drops empty rows
  // rather than printing labels with blanks under them.
  function wizaUserView(contact) {
    const p = (contact && contact.properties) || {};
    const status = asText(p.wiza_status);
    const statusKey = /^(active|closed)$/i.test(status || "") ? status.toLowerCase() : null;
    // wiza_status is stored lowercase ("active"), which humanizeEnum leaves alone
    // because it already looks like a label — so the pill capitalizes it here.
    const statusLabel = humanizeEnum(status);
    const user = {
      status: statusKey, // "active" | "closed" | null — drives the pill's colour
      statusLabel: statusLabel ? statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1) : null,
      wizaId: asText(p.wiza_id),
      signedUpAt: toMillis(p.signed_up_at) || null,
      planStatus: humanizeEnum(p.plan_status) || null,
      planCredits: asNumber(p.plan_credits),
      planFrequency: humanizeEnum(p.plan_frequency) || null,
      creditsUsed30d: asNumber(p.number_of_credits_used_in_last_30_days),
      lastUsageAt: toMillis(p.date_of_last_wiza_usage) || null,
      adminUrl: safeUrl(p.wiza_admin_url),
      usageLogsUrl: safeUrl(p.wiza_usage_logs),
      emailConfirmed: asBool(p.wiza_email_confirmed),
    };
    // "Signed up", "has an id", "has a plan", "has used it" — any one of these
    // means there is a Wiza account behind this contact. A bare
    // wiza_email_confirmed=false is not enough (imports set it on non-users).
    user.isUser = !!(
      user.status ||
      user.wizaId ||
      user.signedUpAt ||
      user.planStatus ||
      user.planCredits != null ||
      user.planFrequency ||
      user.creditsUsed30d != null ||
      user.lastUsageAt ||
      user.adminUrl ||
      user.emailConfirmed === true
    );
    return user;
  }

  function wizaAccountView(company) {
    const p = (company && company.properties) || {};
    const account = {
      accountId: asText(p.api_wiza_account_id),
      primaryAccountId: asText(p.primary_account_id_associated_wiza),
      associatedAccounts: asNumber(p.number_of_associated_accounts),
      subscribedAccounts: asNumber(p.number_of_associated_subscribed_accounts),
      apiCreditBalance: asNumber(p.api_credit_balance),
      creditsUsed30d: asNumber(p.number_of_credits_used_in_last_30_days),
      lastPurchaseAt: toMillis(p.last_api_credit_purchase) || null,
      timesPurchased: asNumber(p.times_api_credits_purchased),
      icp: humanizeEnum(p.account_icp) || null,
      industry: humanizeEnum(p.industry_wiza) || null,
      useCase: humanizeEnum(p.use_case) || null,
      isTargetAccount: asBool(p.hs_is_target_account) === true,
    };
    account.hasData = !!(
      account.accountId ||
      account.primaryAccountId ||
      account.associatedAccounts != null ||
      account.subscribedAccounts != null ||
      account.apiCreditBalance != null ||
      account.creditsUsed30d != null ||
      account.lastPurchaseAt ||
      account.timesPurchased != null ||
      account.icp ||
      account.industry ||
      account.useCase ||
      account.isTargetAccount
    );
    return account;
  }

  async function buildBundle(ctx) {
    const email = normEmail(ctx.email);
    const { contact, company, contactVia, companyVia } = await resolveProspect(ctx);
    log(
      "HubSpot resolve:",
      email,
      "contact via",
      contactVia || "none",
      "/ company via",
      companyVia || "none"
    );

    const errors = {};
    let deals = [];
    let activity = [];

    // Phase 9's colleagues read is gated on the COMPANY, not the contact (an
    // account can be worth showing even when this particular person isn't in the
    // CRM), so it starts here and is awaited below — it rides alongside the
    // deals/activity reads instead of adding a serial leg. No company means no
    // request at all, which is the common case for a free-mail prospect.
    const colleaguesPromise = company
      ? getAccountContacts(company.id).catch((e) => {
          errors.colleagues = isDataError(e) ? e.code : "TRANSIENT";
          if (isDataError(e) && e.retryAfterMs) errors.colleaguesRetryAfterMs = e.retryAfterMs;
          log("account contacts fetch failed:", e && e.message);
          return [];
        })
      : Promise.resolve([]);

    if (contact) {
      const dealIds = associatedIds(contact, "deals");
      // Deals and activity are independent sections: one failing must not blank
      // the other, so each records its own typed error code instead of throwing.
      const [dealResult, activityResult] = await Promise.all([
        getDeals(contact.id, dealIds).catch((e) => {
          errors.deals = isDataError(e) ? e.code : "TRANSIENT";
          if (isDataError(e) && e.retryAfterMs) errors.dealsRetryAfterMs = e.retryAfterMs;
          log("deals fetch failed:", e && e.message);
          return [];
        }),
        getActivity(contact.id).catch((e) => {
          errors.activity = isDataError(e) ? e.code : "TRANSIENT";
          if (isDataError(e) && e.retryAfterMs) errors.activityRetryAfterMs = e.retryAfterMs;
          log("activity fetch failed:", e && e.message);
          return [];
        }),
      ]);
      deals = dealResult;
      activity = activityResult;
    }

    const accountContacts = await colleaguesPromise;
    // Best-effort, and free: read from the stored connection, never looked up.
    const selfOwnerId = await connectedOwnerId();

    // One batched owner-name pass for every ID the bundle will render. The two
    // Phase 8 ownership properties join it here rather than getting a lookup of
    // their own: resolveOwners ignores any value that isn't all digits, so a
    // property that already holds a name costs nothing, and one that holds an ID
    // shares this call (and the session cache the whole team's records hit).
    // Phase 9's colleague owners join the same pass — capped at
    // ACCOUNT_OWNER_LOOKUP_MAX *new* IDs so a list of 25 differently-owned
    // contacts can't multiply into 25 general-pool requests.
    const owners = await resolveOwners([
      contact && contact.properties && contact.properties.hubspot_owner_id,
      company && company.properties && company.properties.hubspot_owner_id,
      company && company.properties && company.properties.sdr_company_owner,
      company && company.properties && company.properties.cs_company_owner,
      ...deals.map((d) => d.ownerId),
      ...capNewOwnerIds(
        accountContacts.map((r) => r && r.properties && r.properties.hubspot_owner_id),
        CONFIG.ACCOUNT_OWNER_LOOKUP_MAX
      ),
    ]);
    for (const d of deals) d.ownerName = ownerName(owners, d.ownerId);

    return {
      email,
      version: CONFIG.CACHE_VERSION,
      contact: contactView(contact, owners),
      company: companyView(company, owners),
      // Phase 8 view-models. Additive: every existing bundle field is untouched,
      // and each of these is independently "no data" for a thin record.
      ownership: ownershipView(contact, company, owners),
      accountContext: accountContextView(company),
      sequence: sequenceView(contact),
      // Phase 9. Always an array (never null), so the panel's only decision is
      // "is there a company" → show/hide, then "any rows" → list or empty state.
      colleagues: accountContactsView(accountContacts, {
        excludeContactId: contact && contact.id,
        excludeEmail: email,
        selfOwnerId,
        owners,
      }),
      wiza: { user: wizaUserView(contact), account: wizaAccountView(company) },
      deals,
      activity,
      contactVia,
      companyVia,
      errors: Object.keys(errors).length ? errors : null,
      fetchedAt: Date.now(),
    };
  }

  // The panel's single entry point. Cache first, then in-flight dedup, then
  // fetch — so five prospect-change events in one second cost one round trip.
  async function getBundle(ctx, options) {
    const opts = options || {};
    const email = normEmail(ctx && ctx.email);
    if (!email) {
      throw new HubSpotDataError("NOT_FOUND", "No prospect email to look up.");
    }
    if (opts.force) clearCache(email);
    const key = cacheKey(email);

    const hit = bundleCache.get(key);
    if (hit && Date.now() - hit.at < CONFIG.CACHE_TTL_MS) {
      log("HubSpot bundle cache hit for", email);
      return hit.bundle;
    }
    const pending = bundleInFlight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const bundle = await buildBundle({ ...ctx, email });
        // A partially failed bundle is renderable but must not be pinned for
        // five minutes — the next render should try the failed section again.
        if (!bundle.errors) bundleCache.set(key, { at: Date.now(), bundle });
        return bundle;
      } finally {
        if (bundleInFlight.get(key) === p) bundleInFlight.delete(key);
      }
    })();
    bundleInFlight.set(key, p);
    return p;
  }

  function clearCache(email) {
    if (email) {
      bundleCache.delete(cacheKey(email));
      bundleInFlight.delete(cacheKey(email));
      return;
    }
    bundleCache.clear();
    bundleInFlight.clear();
  }

  // Called on disconnect: owner names and pipeline labels belong to the portal
  // the token was for.
  function clearAll() {
    clearCache();
    ownerCache.clear();
    ownerInFlight.clear();
    pipelinePromise = null;
  }

  EB.hubspotData = {
    CONFIG,
    HubSpotDataError,
    // Resolution + reads
    resolveProspect,
    getDeals,
    getActivity,
    getAccountContacts,
    getDealPipelines,
    resolveOwners,
    getBundle,
    // Cache control
    clearCache,
    clearAll,
    // View-models the panel renders (pure over fetched data; unit-tested)
    view: {
      wizaUser: wizaUserView,
      wizaAccount: wizaAccountView,
      activityItem,
      // Phase 8 (pure over fetched properties; the panel renders these directly)
      ownership: ownershipView,
      accountContext: accountContextView,
      sequence: sequenceView,
      dealOutcome,
      // Phase 9 (pure: records + resolved owner names in, ordered rows out)
      accountContacts: accountContactsView,
    },
    activity: {
      TABS: ACTIVITY_TABS,
      tabs: activityTabs,
      filter: filterActivity,
      resolveTab: resolveActivityTab,
    },
    // Formatting (shared with the panel; unit-tested)
    format: {
      currency: formatCurrency,
      date: formatDate,
      dateTime: formatDateTime,
      number: formatNumber,
      relativeTime,
      duration: formatDuration,
      stripHtml,
      humanizeEnum,
      truncate,
      safeUrl,
      linkedInUrl,
      firstText,
      delimitedList,
      toMillis,
      recordUrl,
    },
  };
})();
