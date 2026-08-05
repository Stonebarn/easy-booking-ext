// hubspot-data.js — CRM reads for the side panel's Contact / Company / Deals /
// Activity sections.
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
    // Activity rows rendered in the panel (merged across all five types).
    ACTIVITY_LIMIT: 10,
    // HubSpot's own ceiling for a batch/read call.
    BATCH_MAX: 100,
    // Used when a 429 arrives with no (or an unparseable) Retry-After header.
    RETRY_AFTER_FALLBACK_S: 10,

    CONTACT_PROPERTIES: [
      "firstname",
      "lastname",
      "email",
      "jobtitle",
      "phone",
      "lifecyclestage",
      "hs_lead_status",
      "hubspot_owner_id",
      "notes_last_updated",
    ],
    COMPANY_PROPERTIES: ["name", "domain", "industry", "numberofemployees", "hubspot_owner_id"],
    DEAL_PROPERTIES: [
      "dealname",
      "dealstage",
      "pipeline",
      "amount",
      "closedate",
      "hubspot_owner_id",
    ],

    // The five engagement object types, in the order ties are broken. There is
    // no single timeline endpoint (legacy engagements v1 is dead), so each type
    // is an association read + a batch read of its own properties.
    ACTIVITY_TYPES: [
      {
        type: "calls",
        label: "Call",
        properties: ["hs_timestamp", "hs_call_title", "hs_call_disposition", "hs_call_direction", "hs_call_duration"],
      },
      { type: "emails", label: "Email", properties: ["hs_timestamp", "hs_email_subject", "hs_email_direction"] },
      { type: "meetings", label: "Meeting", properties: ["hs_timestamp", "hs_meeting_title", "hs_meeting_outcome"] },
      { type: "notes", label: "Note", properties: ["hs_timestamp", "hs_note_body"] },
      { type: "tasks", label: "Task", properties: ["hs_timestamp", "hs_task_subject", "hs_task_status"] },
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
  // Four codes, because the panel renders four different things:
  //   NOT_FOUND    — the lookup succeeded and there is no such record
  //   RATE_LIMITED — the shared pool is exhausted; carries retryAfterMs
  //   AUTH         — not connected / token rejected / scope missing
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
    if (res.status === 401 || res.status === 403) {
      const body = await readBody(res);
      throw new HubSpotDataError("AUTH", describe(body) || `HTTP ${res.status}`, {
        status: res.status,
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

  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const total = Math.round(n / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  function recordUrl(kind, id) {
    if (!isId(id) || !OBJECT_TYPE[kind] || !CFG.PORTAL_ID) return null;
    return `https://app.hubspot.com/contacts/${CFG.PORTAL_ID}/record/${OBJECT_TYPE[kind]}/${id}`;
  }

  // --- Session caches ------------------------------------------------------
  // Keyed the way the data is shared: pipelines are portal-wide (one promise),
  // owners are per-ID, bundles are per-email.
  let pipelinePromise = null;
  const ownerCache = new Map(); // id -> { name, email } | null
  const ownerInFlight = new Map(); // id -> Promise
  const bundleCache = new Map(); // email -> { at, bundle }
  const bundleInFlight = new Map(); // email -> Promise

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
  async function fetchOwner(id) {
    const body = await orNull(request(`/crm/v3/owners/${encodeURIComponent(id)}`));
    if (!body) return null;
    const name = [body.firstName, body.lastName].filter(Boolean).join(" ").trim();
    return { name: name || body.email || "", email: body.email || "" };
  }

  // Resolves many owner IDs at once: cache hits are free, misses go out in
  // parallel, and two concurrent callers asking for the same owner share one
  // request. Owner lookups are general-pool, and an SDR team shares owners, so
  // in practice this is a handful of calls per session.
  async function resolveOwners(ids) {
    const wanted = [];
    for (const raw of ids || []) {
      const id = String(raw || "");
      if (isId(id) && wanted.indexOf(id) === -1) wanted.push(id);
    }
    await Promise.all(
      wanted.map(async (id) => {
        if (ownerCache.has(id)) return;
        if (!ownerInFlight.has(id)) {
          const p = fetchOwner(id)
            .catch((e) => {
              // Never let a missing owner name break a section.
              log("owner lookup failed for", id, "-", e && e.message);
              return null;
            })
            .then((owner) => {
              ownerCache.set(id, owner);
              ownerInFlight.delete(id);
              return owner;
            });
          ownerInFlight.set(id, p);
        }
        await ownerInFlight.get(id);
      })
    );
    const out = new Map();
    for (const id of wanted) out.set(id, ownerCache.get(id) || null);
    return out;
  }

  const ownerName = (owners, id) => {
    const o = id != null && owners ? owners.get(String(id)) : null;
    return (o && o.name) || null;
  };

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
      };
    });
    // Open deals are what a rep is about to talk about; closed ones are context.
    deals.sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      return toMillis(b.closeDate) - toMillis(a.closeDate);
    });
    return deals;
  }

  // --- Activity ------------------------------------------------------------
  function activityItem(spec, obj) {
    const p = obj.properties || {};
    const item = {
      id: String(obj.id),
      type: spec.type,
      label: spec.label,
      timestamp: toMillis(p.hs_timestamp),
      summary: "",
      direction: null,
      detail: "",
    };
    if (spec.type === "calls") {
      item.summary = p.hs_call_title || "Call";
      item.direction = /^out/i.test(p.hs_call_direction || "") ? "out" : /^in/i.test(p.hs_call_direction || "") ? "in" : null;
      item.detail = [
        CALL_DISPOSITIONS[String(p.hs_call_disposition || "").toLowerCase()] || "",
        formatDuration(p.hs_call_duration),
      ]
        .filter(Boolean)
        .join(" · ");
    } else if (spec.type === "emails") {
      item.summary = p.hs_email_subject || "Email";
      item.direction = /^email_out|^outgoing|^out/i.test(p.hs_email_direction || "")
        ? "out"
        : /^incoming|^in|^forwarded/i.test(p.hs_email_direction || "")
          ? "in"
          : null;
    } else if (spec.type === "meetings") {
      item.summary = p.hs_meeting_title || "Meeting";
      item.detail = humanizeEnum(p.hs_meeting_outcome);
    } else if (spec.type === "notes") {
      item.summary = stripHtml(p.hs_note_body) || "Note";
    } else if (spec.type === "tasks") {
      item.summary = p.hs_task_subject || "Task";
      item.detail = humanizeEnum(p.hs_task_status);
    }
    return item;
  }

  // v4 associations per type in parallel, then one batch read per type that
  // actually has associations — types with none cost exactly one association
  // read and no batch call. Worst case ~10 general-pool requests, cached per
  // contact for the bundle's TTL.
  async function getActivity(contactId) {
    if (!isId(contactId)) return [];
    const found = await Promise.all(
      CONFIG.ACTIVITY_TYPES.map(async (spec) => {
        const body = await orNull(
          request(
            `/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/${spec.type}?limit=${CONFIG.BATCH_MAX}`
          )
        );
        return { spec, ids: v4Ids(body).slice(0, CONFIG.BATCH_MAX) };
      })
    );

    const batches = await Promise.all(
      found
        .filter((f) => f.ids.length > 0)
        .map(async (f) => {
          const body = await post(`/crm/v3/objects/${f.spec.type}/batch/read`, {
            properties: f.spec.properties,
            inputs: f.ids.map((id) => ({ id })),
          });
          return ((body && body.results) || []).map((obj) => activityItem(f.spec, obj));
        })
    );

    const merged = [].concat.apply([], batches);
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged.slice(0, CONFIG.ACTIVITY_LIMIT);
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
      lifecycleStage: humanizeEnum(p.lifecyclestage) || null,
      leadStatus: humanizeEnum(p.hs_lead_status) || null,
      ownerId: p.hubspot_owner_id || null,
      ownerName: ownerName(owners, p.hubspot_owner_id),
      lastActivityAt: p.notes_last_updated ? toMillis(p.notes_last_updated) : null,
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
      url: recordUrl("company", company.id),
    };
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

    const owners = await resolveOwners([
      contact && contact.properties && contact.properties.hubspot_owner_id,
      company && company.properties && company.properties.hubspot_owner_id,
      ...deals.map((d) => d.ownerId),
    ]);
    for (const d of deals) d.ownerName = ownerName(owners, d.ownerId);

    return {
      email,
      contact: contactView(contact, owners),
      company: companyView(company, owners),
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

    const hit = bundleCache.get(email);
    if (hit && Date.now() - hit.at < CONFIG.CACHE_TTL_MS) {
      log("HubSpot bundle cache hit for", email);
      return hit.bundle;
    }
    const pending = bundleInFlight.get(email);
    if (pending) return pending;

    const p = (async () => {
      try {
        const bundle = await buildBundle({ ...ctx, email });
        // A partially failed bundle is renderable but must not be pinned for
        // five minutes — the next render should try the failed section again.
        if (!bundle.errors) bundleCache.set(email, { at: Date.now(), bundle });
        return bundle;
      } finally {
        if (bundleInFlight.get(email) === p) bundleInFlight.delete(email);
      }
    })();
    bundleInFlight.set(email, p);
    return p;
  }

  function clearCache(email) {
    if (email) {
      bundleCache.delete(normEmail(email));
      bundleInFlight.delete(normEmail(email));
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
    getDealPipelines,
    resolveOwners,
    getBundle,
    // Cache control
    clearCache,
    clearAll,
    // Formatting (shared with the panel; unit-tested)
    format: {
      currency: formatCurrency,
      date: formatDate,
      relativeTime,
      duration: formatDuration,
      stripHtml,
      humanizeEnum,
      toMillis,
      recordUrl,
    },
  };
})();
