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
// and, added in Phase 11 — all of it pure, none of it costing a request:
//   accountContext.techStack  the tech row as a real view-model: clean vendor
//                   labels (web_technologies holds snake_case enum values, so the
//                   panel used to print literal underscores), a competitor flag
//                   per item, and a visible/hidden split for the MORE toggle in
//                   which a competitor is never the thing being hidden
//   ownership.roles the three owner rows the panel always draws, each carrying a
//                   three-state "is this me?" — so a rep can be told an account
//                   is someone else's, but only when that is actually known
//   status.tone     datapoint kind + raw value → a semantic tone NAME
//                   (positive/caution/negative/neutral/info) for status pills.
//                   The theme owns the colours; this file owns the meaning.
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
    // v0.9.0: association ids collected per engagement type, across every page
    // of the v4 associations read (contact + company + deals merged). A hard
    // cap so a 3,000-call account can't turn one prospect into 30 requests.
    ACTIVITY_ASSOC_MAX: 500,
    // Of those ids, how many get a batch read. Engagement ids grow over time,
    // so the numerically largest ids are the newest; reading the top 100 and
    // then sorting by hs_timestamp is what "most recent 25" really needs.
    ACTIVITY_ASSOC_READ: 100,
    // Deals whose engagements are merged into Activity. One v4 batch
    // association read per type covers all of them, so this caps that call's
    // input size, not a request count.
    ACTIVITY_DEAL_MAX: 10,
    // HubSpot's own ceiling for a batch/read call.
    BATCH_MAX: 100,
    // Used when a 429 arrives with no (or an unparseable) Retry-After header.
    RETRY_AFTER_FALLBACK_S: 10,
    // Bumped whenever the bundle's *shape* changes. It namespaces the per-email
    // cache, so a bundle cached by an earlier version of this file (same panel
    // session, before a reload) can never be rendered by newer code that expects
    // fields it doesn't have. 10 = Phase 9's `colleagues` + Phase 10's extra
    // phone fields (both landed on 9 independently, so neither number is safe).
    // 11 = Phase 11's accountContext.techStack and ownership.roles. 12 = Phase
    // 12's Wiza custom-object reads (wiza.userObject / wiza.accountObject /
    // wiza.trial) — a bundle cached before this phase has none of those keys.
    // 13 = v0.8.1's accountContext.accountType / teamMix / rep notes,
    // contact.inboundSource and wiza.usage. 14 = v0.8.1's accountContext
    // gtmTech / allTech / techCount (the GTM tech block).
    // 15 = v0.9.0's callBrief. 16 = v0.9.0's activityFailed.
    CACHE_VERSION: 16,
    // Colleagues shown for the account (Phase 9). This is the *association page
    // limit we ask for* as well as the row cap, which is the point: one page, one
    // batch read, no paging, ever. 25 names is already more than a rep reads
    // mid-call, and the section scrolls.
    ACCOUNT_CONTACTS_LIMIT: 25,
    // Ceiling on owner IDs from colleague rows that are looked up *for the first
    // time* in a bundle. v0.8.1 raised it from 10 to ACCOUNT_CONTACTS_LIMIT:
    // every colleague row now states its owner, so a row past the cap would
    // read "Owner unresolved" for a name the panel could have had. Cache hits
    // are still free and the SDR team is small, so the realistic cost is a
    // handful of owner reads, once per session; the cap stays so the bound is
    // explicit. A row whose owner still can't resolve says so — never a bare ID.
    ACCOUNT_OWNER_LOOKUP_MAX: 25,
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
    // v0.8.1: communications_channel_company is a multi-select whose stored
    // values are lowercase keys; these are the portal's own labels for them.
    // A key the portal adds later falls through to humanizeEnum, never blank.
    COMM_CHANNEL_LABELS: {
      slack: "Slack",
      sms: "SMS",
      phone: "Phone",
      email: "Email",
      whatsapp: "WhatsApp",
      video_call: "Video call",
      inperson: "In-person",
      other: "Other",
    },
    // v0.8.1: Wiza usage's depletion-days chip turns caution under the first
    // number and negative under the second. Two weeks is enough runway to sell
    // a top-up; one week is a customer about to hit a wall.
    DEPLETION_CAUTION_DAYS: 14,
    DEPLETION_NEGATIVE_DAYS: 7,
    // v0.8.1: a competitor renewal inside the first window is caution, inside
    // the second negative — the window to displace them is closing.
    RENEWAL_CAUTION_DAYS: 30,
    RENEWAL_NEGATIVE_DAYS: 7,
    // v0.8.1: the deal `competitor` enum stores most values as labels already,
    // but a few as lowercase keys. Those map here; anything else prints as-is.
    COMPETITOR_LABELS: {
      cognism: "Cognism",
      seamlessai: "Seamless.ai",
      swordfishai: "Swordfish.ai",
      snovio: "Snov.io",
      anyleads: "AnyLeads",
      kaspr: "Kaspr",
      hunterio: "Hunter.io",
      other: "Other",
    },

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
      // --- v0.8.1: how this person came in ---------------------------------
      // PLG Signup / Abandoned Booking / Denied Booking / Website Visit. The
      // identity block shows it as an "Inbound" pill when set.
      "inbound_source",
      "inbound_source_last_updated",
      // --- v0.9.0: Win back mode -------------------------------------------
      // The SDR Call Brief: newline-separated "• LABEL: text" lines written by
      // an automation. Same internal name on the company (see below).
      "sdr_call_brief",
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
      // v0.8.1: where outbound is with the account (Ready For Outbound ...
      // Do Not Outbound). Shown beside Company Status in Account context.
      "prospecting_status",
      // "Do you even know what we do?" — first non-empty of these three is the
      // blurb a rep can read mid-dial.
      "description",
      "about_us",
      "linkedinbio",
      "account_icp_ai_reasoning",
      "icp_fit",
      "web_technologies",
      "linkedin_company_page",
      // --- v0.8.1: account type (Inbound vs Prospected) --------------------
      // inbound_source wins; a bulk contact enrichment is what "we went and
      // found them" looks like on the record; neither is "Unknown".
      "inbound_source",
      "inbound_source_last_updated",
      "last_bulk_contact_enrichment_date",
      // --- v0.8.1: sales team mix (contact-role rollups on the company) ----
      // A different source from the *_team_size properties above: these count
      // the associated contacts by role, the team sizes are enrichment data.
      "sdr_contacts",
      "ae_contacts",
      "amcs_contacts",
      "sales_leader_contacts",
      "gtm_ops_contacts",
      "number_of_associated_sales_team_contacts",
      // --- v0.8.1: rep notes (fields reps fill in on the company) ----------
      "company_source",
      "communications_channel_company",
      "next_checkin",
      "competitor_tech",
      "competitor_renewal_date",
      "missing_wiza_features",
      "company_research",
      // --- v0.8.1: Wiza usage rollups on the company -----------------------
      // number_of_credits_used_in_last_30_days is already requested above.
      "wiza_account_create_date",
      "number_of_active_users_last_30_days",
      "api_credit_balance_company",
      "api_credits_used__30_days_cloned",
      "credit_use_per_day_company",
      "wiza_credit_depletion_days_company",
      // v0.9.0: the company's SDR Call Brief (Win back mode).
      "sdr_call_brief",
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
      // --- v0.8.1: who we're up against on this deal, and when they renew --
      "competitor",
      "competitor_renewal_date_deal",
    ],

    // --- Phase 12: Wiza custom objects (richer product data) --------------
    // The rollup properties on CONTACT_PROPERTIES / COMPANY_PROPERTIES above
    // are a thin slice of the portal's own Wiza User / Wiza Account / Trial
    // custom objects — one record per user, one per billing account, an
    // optional Trial on either. Every view-model built from these is null
    // whenever the object doesn't exist for this prospect (no association),
    // can't be read (403 ahead of crm.objects.custom.read landing on a
    // reconnect, 404, anything) — see fetchCustomObject — so the section
    // renders the rollup view above and nothing about it looks unfinished.
    WIZA_USER_OBJECT_TYPE: "2-48448238",
    WIZA_ACCOUNT_OBJECT_TYPE: "2-48693578",
    TRIAL_OBJECT_TYPE: "2-40064102",
    // Associations on a v3 object GET come back keyed by the fully-qualified
    // name; some responses key them by the "2-X" object type id instead. Every
    // lookup tries both — see firstAssocId.
    WIZA_USER_ASSOC_KEYS: ["p40063500_wiza_users", "2-48448238"],
    WIZA_ACCOUNT_ASSOC_KEYS: ["p40063500_accounts", "2-48693578"],
    TRIAL_ASSOC_KEYS: ["p40063500_trials", "2-40064102"],
    WIZA_USER_OBJECT_PROPERTIES: [
      "wiza_user_id",
      "user_status",
      "wiza_role",
      "wiza_email",
      "user_signup_date",
      "number_of_credits_used_in_last_30_days",
      "date_of_last_wiza_usage",
      "date_of_last_enrichment",
      "date_of_last_bulk_export",
      "last_usage_at",
      "extension_version",
      "wiza_admin_url",
      "wiza_usage_logs",
    ],
    // The one series the User sub-section can sparkline: credits used, last
    // 30 days, as it stood at every version HubSpot kept.
    WIZA_USER_HISTORY_PROPERTIES: ["number_of_credits_used_in_last_30_days"],
    WIZA_ACCOUNT_OBJECT_PROPERTIES: [
      "account_id",
      "plan_name",
      "plan_price",
      "plan_frequency",
      "plan_category",
      "plan_period_end",
      "plan_seats_used",
      "account_plan_seats_no",
      "account_email_credits",
      "account_phone_credits",
      "api_credit_balance",
      "export_credits",
      "number_of_credits_used_in_last_30_days",
      "number_of_active_users_last_30_days",
      "number_of_new_users_in_last_30_days",
      "reports_count_30d",
      "spend_last_30d",
      "total_spend",
      "last_payment_date",
      "last_payment_amount",
      "has_overage",
      "has_card_on_file",
      "stripe_plan_subscription_status",
      "account_status",
      "account_trial_status",
      "trial_ends_at__edt_",
      "crm_connected",
    ],
    // Account-wide credits used, 30 days — the second of the panel's two
    // sparkline series. api_credit_balance and active-users history are asked
    // for too (density here is unknown ahead of a real read) but the panel only
    // ever draws a line for the two credits-used series; see wizaAccountObjectView.
    WIZA_ACCOUNT_HISTORY_PROPERTIES: [
      "number_of_credits_used_in_last_30_days",
      "api_credit_balance",
      "number_of_active_users_last_30_days",
    ],
    TRIAL_OBJECT_PROPERTIES: [
      "company_name",
      "trial_start_date",
      "trial_end_date",
      "trial_end_date_calculated",
      "trial_length",
      "paid_trial",
      "trial_amount",
      "how_many_trial_users",
      "emails_of_trial_users",
      "trial_notes",
      "trial_export_credits",
      "trial_api_credits",
      "monitor_access",
    ],
    // Points kept per sparkline after downsampling — a handful of pixels wide,
    // so more than this buys no legibility.
    HISTORY_MAX_POINTS: 24,
    // Fewer usable (numeric, timestamped) history versions than this and a
    // line is not a trend — the renderer prints the value alone. Portal
    // history density is unverified ahead of a real read: a property that has
    // never changed still comes back with exactly one version, which must
    // degrade at least this gracefully, not draw a flat two-pixel stub.
    HISTORY_MIN_SPARKLINE_POINTS: 3,

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

    // v0.9.0: the OAuth scope that lets a token read each engagement type.
    // scripts/test-views.mjs asserts every ACTIVITY_TYPES entry has one and
    // that each is requested in hubspot-config.js SCOPES or OPTIONAL_SCOPES, so a new type can't
    // ship without its scope. HubSpot names no granular scope for these
    // engagement types, and rejected the crm.objects.notes.* style names when
    // they were tried (see request()'s 403 comment), so they ride on the
    // contact read scope. Emails is the exception (v0.9.1): one-to-one email
    // engagements need sales-email-read, requested via OPTIONAL_SCOPES
    // (the authorize URL's optional_scope parameter).
    ACTIVITY_SCOPES: {
      calls: "crm.objects.contacts.read",
      emails: "sales-email-read",
      meetings: "crm.objects.contacts.read",
      notes: "crm.objects.contacts.read",
      tasks: "crm.objects.contacts.read",
    },

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

    // --- Tech-stack labels (Phase 11) --------------------------------------
    // web_technologies is a delimited list of HubSpot *enum* values, so it
    // arrives as snake_case slugs ("google_analytics", "hubspot_crm",
    // "salesforce_crm") and the panel was printing the underscores. The label
    // pipeline is:
    //
    //   split → slug each value (lowercase, runs of non-alphanumerics → "_")
    //         → look the whole slug up here
    //         → else walk the words left to right, matching the LONGEST run of
    //           words that has an entry here
    //         → else Title Case the word
    //
    // Because matching is per-run rather than per-value, one entry per vendor
    // covers every compound the portal spells it in:
    //   hubspot → "HubSpot"  covers hubspot, hubspot_crm, hubspot_forms, …
    //   crm     → "CRM"      covers salesforce_crm, hubspot_crm, …
    //
    // TO EXTEND: add one entry keyed on the slug (lowercase, words joined by
    // "_") whose value is the exact casing to print. Alternate spellings the
    // portal uses get their own key pointing at the same label. Nothing else in
    // this file needs to change, and unknown values still Title Case rather than
    // breaking.
    TECH_LABELS: {
      // Contact-data / prospecting vendors (mostly COMPETITORS, see below)
      apollo_io: "Apollo.io",
      // Not the competitor: Apollo GraphQL is a web framework. See the note on
      // COMPETITOR_EXCEPTIONS.
      apollo_graphql: "Apollo GraphQL",
      zoominfo: "ZoomInfo",
      leadiq: "LeadIQ",
      lead_iq: "LeadIQ",
      seamless_ai: "Seamless.AI",
      snov_io: "Snov.io",
      snov: "Snov.io",
      hunter_io: "Hunter.io",
      adapt_io: "Adapt.io",
      rocketreach: "RocketReach",
      rocket_reach: "RocketReach",
      contactout: "ContactOut",
      contact_out: "ContactOut",
      uplead: "UpLead",
      up_lead: "UpLead",
      people_data_labs: "People Data Labs",
      datanyze: "Datanyze",
      salesintel: "SalesIntel",
      sales_intel: "SalesIntel",
      dropcontact: "Dropcontact",
      drop_contact: "Dropcontact",
      findymail: "Findymail",
      prospeo: "Prospeo",
      clearbit: "Clearbit",
      cognism: "Cognism",
      kaspr: "Kaspr",
      lusha: "Lusha",
      clay: "Clay",
      amplemarket: "Amplemarket",
      // CRM, sales engagement, revenue — integrations and partners, never
      // competitors (see NON_COMPETITORS)
      hubspot: "HubSpot",
      salesforce: "Salesforce",
      outreach: "Outreach",
      salesloft: "Salesloft",
      gong: "Gong",
      nooks: "Nooks",
      marketo: "Marketo",
      zendesk: "Zendesk",
      intercom: "Intercom",
      drift: "Drift",
      qualified: "Qualified",
      chili_piper: "Chili Piper",
      calendly: "Calendly",
      gainsight: "Gainsight",
      churnzero: "ChurnZero",
      churn_zero: "ChurnZero",
      zuora: "Zuora",
      netsuite: "NetSuite",
      workday: "Workday",
      greenhouse: "Greenhouse",
      lever: "Lever",
      ashby: "Ashby",
      // Analytics, product, marketing automation
      google_analytics: "Google Analytics",
      google_tag_manager: "Google Tag Manager",
      gtm: "Google Tag Manager",
      mixpanel: "Mixpanel",
      segment: "Segment",
      amplitude: "Amplitude",
      heap: "Heap",
      pendo: "Pendo",
      hotjar: "Hotjar",
      fullstory: "FullStory",
      full_story: "FullStory",
      optimizely: "Optimizely",
      vwo: "VWO",
      looker: "Looker",
      tableau: "Tableau",
      snowflake: "Snowflake",
      braze: "Braze",
      iterable: "Iterable",
      klaviyo: "Klaviyo",
      attentive: "Attentive",
      mailchimp: "Mailchimp",
      sendgrid: "SendGrid",
      twilio: "Twilio",
      // Platform, infrastructure, front end
      amazon_web_services: "Amazon Web Services",
      aws: "Amazon Web Services",
      cloudflare: "Cloudflare",
      wordpress: "WordPress",
      shopify: "Shopify",
      stripe: "Stripe",
      zapier: "Zapier",
      slack: "Slack",
      zoom: "Zoom",
      okta: "Okta",
      auth0: "Auth0",
      datadog: "Datadog",
      sentry: "Sentry",
      new_relic: "New Relic",
      postgresql: "PostgreSQL",
      postgres: "PostgreSQL",
      mysql: "MySQL",
      mongodb: "MongoDB",
      mongo_db: "MongoDB",
      node_js: "Node.js",
      nodejs: "Node.js",
      react: "React",
      next_js: "Next.js",
      nextjs: "Next.js",
      vue_js: "Vue.js",
      vuejs: "Vue.js",
      vue: "Vue.js",
      jquery: "jQuery",
      typescript: "TypeScript",
      javascript: "JavaScript",
      graphql: "GraphQL",
      recaptcha: "reCAPTCHA",
      // Social / media
      youtube: "YouTube",
      vimeo: "Vimeo",
      facebook: "Facebook",
      linkedin: "LinkedIn",
      x_twitter: "X (Twitter)",
      twitter: "X (Twitter)",
      instagram: "Instagram",
      tiktok: "TikTok",
      // Acronyms that would otherwise Title Case into nonsense ("Crm", "Api").
      // These are single-word entries matched by the same run walk, so they fix
      // every compound at once.
      crm: "CRM",
      api: "API",
      ai: "AI",
      ui: "UI",
      ux: "UX",
      seo: "SEO",
      sdk: "SDK",
      cdn: "CDN",
      cms: "CMS",
      css: "CSS",
      html: "HTML",
      php: "PHP",
      sql: "SQL",
      saas: "SaaS",
      b2b: "B2B",
      iot: "IoT",
      gdpr: "GDPR",
    },
    // Longest run of words looked up in TECH_LABELS at once. 4 covers the
    // longest entry above ("people data labs" is 3); raising it only costs a few
    // failed object lookups per value.
    TECH_LABEL_MAX_WORDS: 4,

    // --- Competitors (Phase 11) ---------------------------------------------
    // Wiza sells B2B contact data / prospecting, so a competitor already in the
    // account's stack is the most useful thing in the whole tech row: it turns a
    // cold pitch into a displacement conversation. Flagged items are also pulled
    // into the visible set (see techStackView) so one can never hide behind
    // "MORE".
    //
    // Matched case-insensitively against the *slug* of each tech value with
    // word-boundary semantics: the entry must appear as a contiguous run of the
    // slug's "_"-separated words. Naive substring matching is deliberately NOT
    // used — it would flag "Clearbit" inside unrelated strings like
    // "clearbitmap" and burn the rep's trust in the pill.
    //
    // TO EXTEND: add the competitor's slug, plus any alternate spelling the
    // portal uses, as its own entry. TO STOP flagging one: delete its entries.
    COMPETITORS: [
      // AMBIGUITY, deliberate and documented: a bare "apollo" in
      // web_technologies may be Apollo GraphQL — a web framework, not a
      // competitor — rather than Apollo.io. It is flagged anyway, because
      // Apollo.io dominates this portal's data and a missed displacement opening
      // costs more than a rep glancing at one wrong pill. TO STOP: delete this
      // one line; "apollo_io" keeps working on its own, and the explicit GraphQL
      // spellings are already in COMPETITOR_EXCEPTIONS.
      "apollo",
      "apollo_io",
      "zoominfo",
      "leadiq",
      "lead_iq",
      "people_data_labs",
      "lusha",
      "cognism",
      "seamless_ai",
      "rocketreach",
      "rocket_reach",
      "hunter_io",
      "clearbit",
      "uplead",
      "up_lead",
      "snov_io",
      "snov",
      "kaspr",
      "contactout",
      "contact_out",
      "datanyze",
      "salesintel",
      "sales_intel",
      "adapt_io",
      "prospeo",
      "findymail",
      "dropcontact",
      "drop_contact",
      "clay",
      "amplemarket",
    ],
    // Values that match a COMPETITORS entry but are not the competitor. Matched
    // on the WHOLE slug (exact), not by word run, so an entry here can only ever
    // excuse the exact value it names — "clearbit_for_salesforce" is still a
    // competitor.
    COMPETITOR_EXCEPTIONS: ["apollo_graphql", "apollo_server", "apollo_client", "apollo_federation"],
    // Integrations and partners. They share no name with anything in
    // COMPETITORS, so this list changes no behaviour today — it is a guard with
    // a name: if a future COMPETITORS entry ever collides with one of these, the
    // partner wins and nobody has to rediscover why HubSpot got flagged as a
    // competitor in the panel. Exact-slug, same as COMPETITOR_EXCEPTIONS.
    NON_COMPETITORS: [
      "hubspot",
      "salesforce",
      "outreach",
      "salesloft",
      "nooks",
      "gong",
      "intercom",
      "segment",
      "mixpanel",
      "zendesk",
      "marketo",
    ],

    // --- Status pill tones (Phase 11) ---------------------------------------
    // Tone NAMES, never colours: the theme decides what "caution" looks like in
    // light and dark, and a hex code in this file would be a second source of
    // truth for it. Keyed kind → value slug → tone.
    //
    // An unknown kind, or a value nobody mapped, is `neutral`. That is the
    // whole safety property: a status this file has never heard of is not
    // evidence of anything, and a confidently wrong colour is worse than grey.
    //
    // TO EXTEND: add the value's slug under its kind. Kinds are the HubSpot
    // property names wherever one exists, so the renderer can pass the property
    // it already has; STATUS_KINDS below maps the panel's own aliases onto them.
    STATUS_TONES: {
      // Account grade. Letters only — "A+"/"a-" slug down to their letter.
      account_grade_v1: {
        a: "positive",
        b: "positive",
        c: "caution",
        d: "negative",
        f: "negative",
      },
      // Company Status (the portal's own lifecycle field, not HubSpot's).
      company_lifecycle_stage: {
        customer: "positive",
        active_deal: "positive",
        active_customer: "positive",
        prospecting: "info",
        open: "info",
        new: "info",
        nurture: "caution",
        cool_down: "caution",
        cooldown: "caution",
        disqualified: "negative",
        churned: "negative",
        closed_lost: "negative",
      },
      // HubSpot's stock contact lifecycle stage. Both spellings the API returns
      // ("salesqualifiedlead" and "SALES_QUALIFIED_LEAD") are keyed.
      lifecyclestage: {
        subscriber: "neutral",
        lead: "info",
        marketingqualifiedlead: "info",
        marketing_qualified_lead: "info",
        salesqualifiedlead: "info",
        sales_qualified_lead: "info",
        opportunity: "positive",
        customer: "positive",
        evangelist: "positive",
        other: "neutral",
        disqualified: "negative",
      },
      // Wiza account status on the contact.
      wiza_status: { active: "positive", closed: "negative" },
      // The AI ICP verdict. "moderate" is not in the portal's picklist today but
      // costs nothing to map and is the obvious middle value.
      icp_fit: { strong: "positive", moderate: "info", medium: "info", weak: "caution" },
      // Deal state. Accepts either a slug or a deal row from getDeals(), which
      // is what the panel actually has (see dealStateSlug).
      deal: {
        open: "info",
        closed_won: "positive",
        closedwon: "positive",
        won: "positive",
        closed_lost: "negative",
        closedlost: "negative",
        lost: "negative",
        closed: "neutral",
      },
      // Sequence enrolment. `info`, not `caution`: being worked is a fact about
      // the record, and the "don't step on a teammate" judgement belongs to the
      // rep reading the owner next to it — a warning colour on every sequenced
      // contact would cry wolf on the common case.
      sequence: { enrolled: "info", not_enrolled: "neutral" },
      // Stripe's own subscription status (design critique, Wiza usage polish):
      // billing is a different fact than "is this person an active Wiza
      // user" (the section pill already says that), so it only earns a tone
      // when the news is actually bad — a lapsed or failed payment a rep
      // might want to know about mid-call. "active"/"trialing" stay
      // unmapped, which statusTone reads as `neutral` and the renderer
      // treats as no tone at all — a plain value, not a second status pill.
      // Exact enum unverified against a live past_due/canceled record.
      stripe_plan_subscription_status: {
        past_due: "caution",
        unpaid: "caution",
        incomplete: "caution",
        canceled: "negative",
        cancelled: "negative",
        incomplete_expired: "negative",
      },
    },
    // Aliases → the STATUS_TONES key they mean, so the renderer can ask for
    // either the HubSpot property name or the label the panel shows.
    STATUS_KINDS: {
      grade: "account_grade_v1",
      account_grade: "account_grade_v1",
      company_status: "company_lifecycle_stage",
      status: "company_lifecycle_stage",
      contact_lifecycle_stage: "lifecyclestage",
      contact_status: "lifecyclestage",
      lifecycle_stage: "lifecyclestage",
      lifecyclestage_contact: "lifecyclestage",
      wiza: "wiza_status",
      icp: "icp_fit",
      deal_stage: "deal",
      deal_status: "deal",
      sequence_enrolled: "sequence",
      in_sequence: "sequence",
      stripe: "stripe_plan_subscription_status",
      stripe_status: "stripe_plan_subscription_status",
    },

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

  // Lookup on a plain-object map that can never return something off
  // Object.prototype: a CRM value of "constructor" or "toString" must miss, not
  // hand back a function that then gets rendered.
  const own = (obj, key) =>
    obj && key != null && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;

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

  // The split half of delimitedList, shared with the tech-stack view-model:
  // a delimited CRM property (web_technologies is semicolon-ish, but the portal
  // has commas and newlines in it too) → trimmed, whitespace-collapsed items,
  // de-duplicated case-insensitively, empty entries dropped. Always an array, so
  // "a__b;;c-d;" and null and 42 are all just inputs, never special cases.
  function splitDelimited(value) {
    const raw = asText(value);
    if (!raw) return [];
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
    return all;
  }

  // A delimited CRM property as a capped, de-duplicated list:
  // { items, more, total, all }. `more` is what "+N more" prints; `all` is the
  // full list for the hover title. Null when there is nothing to show.
  //
  // Raw values, verbatim: this is the generic helper, and callers that need
  // vendor-cased labels go through techStackView instead.
  function delimitedList(value, max) {
    const all = splitDelimited(value);
    if (!all.length) return null;
    const cap = Number(max) > 0 ? Number(max) : CONFIG.TECH_STACK_MAX;
    return { items: all.slice(0, cap), more: Math.max(0, all.length - cap), total: all.length, all };
  }

  // --- Tech stack (Phase 11; pure, exported, unit-tested) -------------------
  // The normalized key for a CRM enum value: lowercase, every run of
  // non-alphanumerics collapsed to a single "_", no leading or trailing "_".
  // Everything that matches on a value — TECH_LABELS, COMPETITORS,
  // STATUS_TONES — matches on this, so "Google Analytics", "google_analytics"
  // and "GOOGLE-ANALYTICS" are one thing, and "Apollo.io" is apollo_io.
  function enumSlug(value) {
    const s = value == null ? "" : String(value);
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // Title Case for one word, without mangling casing the portal got right: a
  // word that is already mixed-case ("iPhone", "1C:Enterprise") is a deliberate
  // spelling and is left alone. Anything else is lowercased and gets its first
  // letter raised — the first *letter*, so "(twitter)" becomes "(Twitter)".
  function titleCaseWord(word) {
    const w = String(word == null ? "" : word);
    if (!w) return "";
    if (/[A-Z]/.test(w) && /[a-z]/.test(w)) return w;
    return w.toLowerCase().replace(/[a-z]/, (c) => c.toUpperCase());
  }

  // One tech value → the label a rep should read. See CONFIG.TECH_LABELS for the
  // pipeline and how to extend it. Never returns an empty string: a value with
  // no letters or digits at all (";", "-") returns null so the caller drops it
  // rather than rendering a stray delimiter.
  function techLabel(value) {
    const raw = asText(value);
    if (!raw) return null;
    // Punctuation only ("-", ";", "()") is not a label. Unicode-aware so a
    // non-ASCII vendor name — which slugs to nothing — still passes through.
    if (!/[\p{L}\p{N}]/u.test(raw)) return null;
    const slug = enumSlug(raw);
    // Whole-value lookup, then the same value with its separators collapsed, so
    // one entry per vendor also covers the portal's other spelling of it:
    // "zoom_info" finds zoominfo, "clear_bit" finds clearbit. Exact-value only —
    // it never widens the per-run matching below.
    const whole = own(CONFIG.TECH_LABELS, slug) || own(CONFIG.TECH_LABELS, slug.replace(/_/g, ""));
    if (whole) return whole;
    // Words as the portal wrote them (only "_" and "-" become spaces), so
    // punctuation inside an unknown vendor name survives; the map is keyed on
    // the slug of each run, which is what makes "Node.js" and "node_js" the
    // same lookup.
    const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const maxRun = Number(CONFIG.TECH_LABEL_MAX_WORDS) > 0 ? Number(CONFIG.TECH_LABEL_MAX_WORDS) : 4;
    const out = [];
    let i = 0;
    while (i < words.length) {
      let hit = null;
      let len = 0;
      for (let n = Math.min(maxRun, words.length - i); n >= 1; n--) {
        const found = own(CONFIG.TECH_LABELS, enumSlug(words.slice(i, i + n).join("_")));
        if (found) {
          hit = found;
          len = n;
          break;
        }
      }
      if (hit) {
        out.push(hit);
        i += len;
      } else {
        out.push(titleCaseWord(words[i]));
        i += 1;
      }
    }
    const label = out.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return label || null;
  }

  // Word-boundary containment on a slug: `phrase` must appear as a contiguous
  // run of the slug's "_"-separated words. Padding both sides with "_" turns
  // that into one substring test — "clearbit" hits "clearbit_enrichment" and
  // misses "clearbitmap".
  function slugHasRun(slug, phrase) {
    if (!slug || !phrase) return false;
    if (slug === phrase) return true;
    return `_${slug}_`.indexOf(`_${phrase}_`) !== -1;
  }

  // Is this tech value one of Wiza's competitors? See CONFIG.COMPETITORS (which
  // spellings, and the deliberate bare-"apollo" ambiguity),
  // CONFIG.COMPETITOR_EXCEPTIONS (exact values that only look like one) and
  // CONFIG.NON_COMPETITORS (partners, which win on an exact match).
  function isCompetitorTech(value) {
    const slug = enumSlug(value);
    if (!slug) return false;
    if ((CONFIG.COMPETITOR_EXCEPTIONS || []).indexOf(slug) !== -1) return false;
    // The whole value with separators collapsed, compared for EQUALITY only:
    // "zoom_info" and "snovio" are spellings of listed competitors, while
    // "clearbitmap" — which a substring test on the collapsed form would have
    // matched — still misses.
    const compact = slug.replace(/_/g, "");
    let matched = false;
    for (const entry of CONFIG.COMPETITORS || []) {
      if (slugHasRun(slug, entry) || compact === entry.replace(/_/g, "")) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
    return (CONFIG.NON_COMPETITORS || []).indexOf(slug) === -1;
  }

  // The tech row's whole view-model. Returns null when there is nothing to show
  // (no property, or a value that was only delimiters).
  //
  //   { items, visible, hidden, visibleCount, hiddenCount, more, total, max,
  //     competitors, competitorCount, hasCompetitors, all }
  //
  // `items` is EVERY item, never truncated — the renderer needs the full list
  // for a MORE/LESS toggle — as { label, slug, isCompetitor, raw } objects.
  // Competitors are partitioned to the front (original order kept within each
  // group) and `visibleCount` is never smaller than the number of them, so a
  // competitor can never be the thing hidden behind "MORE". Surfacing one is the
  // entire reason this row is worth the space.
  function techStackView(value, options) {
    const opts = options || {};
    const parts = splitDelimited(value);
    if (!parts.length) return null;
    const cap = Number(opts.max) > 0 ? Number(opts.max) : CONFIG.TECH_STACK_MAX;

    const seen = Object.create(null);
    const items = [];
    for (const part of parts) {
      const label = techLabel(part);
      if (!label) continue;
      const slug = enumSlug(label) || enumSlug(part);
      // De-duplicated on the *normalized* value, not the raw one, so
      // "google_analytics" and "Google Analytics" in the same property are one
      // chip rather than two.
      const key = slug || label.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      items.push({
        label,
        slug: key,
        // Checked on both the raw value and the canonical label: the portal's
        // spelling ("lead_iq") and ours ("LeadIQ") are each enough on their own.
        isCompetitor: isCompetitorTech(part) || isCompetitorTech(label),
        raw: part,
      });
    }
    if (!items.length) return null;

    const ordered = items
      .filter((t) => t.isCompetitor)
      .concat(items.filter((t) => !t.isCompetitor));
    const competitors = ordered.filter((t) => t.isCompetitor);
    const visibleCount = Math.min(ordered.length, Math.max(cap, competitors.length));
    return {
      items: ordered,
      visible: ordered.slice(0, visibleCount),
      hidden: ordered.slice(visibleCount),
      visibleCount,
      hiddenCount: ordered.length - visibleCount,
      // Same name delimitedList uses for the "+N more" count, so a renderer that
      // already prints one does not have to learn a second word for it.
      more: ordered.length - visibleCount,
      total: ordered.length,
      max: cap,
      competitors: competitors.map((t) => t.label),
      competitorCount: competitors.length,
      hasCompetitors: competitors.length > 0,
      all: ordered.map((t) => t.label),
    };
  }

  // --- Company Status / Prospecting Status (v0.8.1; pure, exported) --------
  // company_lifecycle_stage is labelled "Company Status" in the portal. Its
  // stored "Open Deal" reads "Active Deal" to reps; every other value prints
  // as-is.
  function companyStatusLabel(value) {
    const h = humanizeEnum(value);
    if (!h) return null;
    return enumSlug(h) === "open_deal" ? "Active Deal" : h;
  }

  // A subtle tone on the two status values in Account context: red for the
  // "do not call" answers, green for the "this is live" ones, and no tone for
  // everything else (null, which the renderer reads as default ink).
  const ACCOUNT_STATUS_TONES = {
    do_not_outbound: "negative",
    disqualified: "negative",
    demo_outstanding: "positive",
    actively_engaged: "positive",
    active_deal: "positive",
    customer: "positive",
  };
  function accountStatusTone(label) {
    return label ? own(ACCOUNT_STATUS_TONES, enumSlug(label)) || null : null;
  }

  // --- GTM tech (v0.8.1; pure, exported, unit-tested) ----------------------
  // The GTM tools a company runs, out of everything in web_technologies. The
  // property holds the portal's enum VALUES, so a GTM tool is an exact-slug
  // hit in gtm-tech.js's TOOLS map (self.EB.gtmTech, loaded by the panel
  // before this file). No fuzzy matching: a value that is not a TOOLS key is
  // not a GTM tool. Read at call time, not load time, and an absent map is an
  // empty one, so a context that never loaded gtm-tech.js still gets allTech.
  //
  //   { gtmTech:  [{ slug, label, cat, competitor }]  competitors first, then A-Z
  //     allTech:  [{ slug, label }]                   every value, A-Z, no cap
  //     techCount }
  //
  // The competitor flag reuses isCompetitorTech (COMPETITORS + exceptions). No
  // competitor slug exists in the portal enum today, so it never fires on real
  // data; it stays so a future enum option is flagged without a code change.
  function gtmToolsMap() {
    const g = self.EB && self.EB.gtmTech;
    return (g && g.TOOLS) || {};
  }

  function gtmTechView(value) {
    const tools = gtmToolsMap();
    const parts = splitDelimited(value);
    const byLabel = (a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" });
    const gtmTech = [];
    const allTech = [];
    for (const slug of parts) {
      const tool = own(tools, slug);
      const label = (tool && tool.label) || techLabel(slug);
      if (!label) continue;
      allTech.push({ slug, label });
      if (tool) {
        gtmTech.push({
          slug,
          label,
          cat: tool.cat || null,
          competitor: isCompetitorTech(slug) || isCompetitorTech(label),
        });
      }
    }
    gtmTech.sort((a, b) => (a.competitor === b.competitor ? byLabel(a, b) : a.competitor ? -1 : 1));
    allTech.sort(byLabel);
    return { gtmTech, allTech, techCount: allTech.length };
  }

  // The pre-Phase-11 { items, more, total, all } shape, built from the cleaned
  // labels. Kept because it is what the panel's tech row renders today, and a
  // label fix should not have to wait for a renderer change to reach a rep.
  function techListLegacy(stack) {
    if (!stack) return null;
    return {
      items: stack.visible.map((t) => t.label),
      more: stack.hiddenCount,
      total: stack.total,
      all: stack.all,
    };
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

  // --- Phase 12: custom-object association lookup --------------------------
  // A contact/company GET's associations block can key a custom object by its
  // fully-qualified name OR by its "2-X" object type id — see the CONFIG
  // comment above WIZA_USER_ASSOC_KEYS. `keys` lists both spellings; the first
  // one that actually has results wins.
  //
  // Deliberately the FIRST associated id, not the "best" one: telling which of
  // several is the right one (say, by last-usage date) needs a request per
  // candidate, and that is the batch-fan-out this phase's budget explicitly
  // rules out. One prospect, one Wiza user, one fetch.
  function firstAssocId(record, keys) {
    for (const key of keys || []) {
      const ids = associatedIds(record, key);
      if (ids.length) return ids[0];
    }
    return null;
  }

  // One custom-object GET, resilient exactly like getActivity's per-type
  // reads: ANY failure — no id to fetch, 403 (the app's crm.objects.custom.read
  // scope not yet on this rep's token), 404, rate-limited, offline — logs its
  // HTTP status and resolves to null rather than throwing. This is
  // deliberate and different from deals/activity, which surface a section
  // error on total failure: a Wiza custom object is an ENRICHMENT of the
  // rollup properties already on the contact/company, never the only source
  // for the section, so its failure must never be reported to the rep at
  // all — the section simply renders what the rollups have, which is exactly
  // what it rendered before this phase existed.
  async function fetchCustomObject(kind, objectTypeId, id, properties, historyProperties) {
    if (!isId(id)) return null;
    try {
      const hist =
        historyProperties && historyProperties.length
          ? `&propertiesWithHistory=${propList(historyProperties)}`
          : "";
      return await request(
        `/crm/v3/objects/${objectTypeId}/${encodeURIComponent(id)}?properties=${propList(properties)}${hist}`
      );
    } catch (e) {
      log(
        `custom object (${kind} ${id}) could not be read — HTTP ${(e && e.status) || "?"}`,
        (e && e.code) || "?",
        (e && e.message) || e
      );
      return null;
    }
  }

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

  // Phase 12: plan price and total spend run from tens of dollars into the low
  // six figures on this portal. Exact below $10k — a rep reading a monthly
  // plan price wants the real number — and compact ("$86K") at $10k and
  // above, where the extra digits buy nothing anyone acts on.
  function formatCurrencyCompact(amount) {
    const n = asNumber(amount);
    if (n == null) return "";
    if (Math.abs(n) < 10000) return formatCurrency(n);
    try {
      return new Intl.NumberFormat(CONFIG.LOCALE, {
        style: "currency",
        currency: CONFIG.CURRENCY,
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(n);
    } catch (_) {
      return formatCurrency(n);
    }
  }

  // Several of the portal's credit-balance properties use -1 as "Unlimited"
  // rather than a picklist, so a raw -1 must never reach the panel looking like
  // a data error.
  function formatCredits(value) {
    const n = asNumber(value);
    if (n == null) return "";
    return n < 0 ? "Unlimited" : formatNumber(n);
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

  // v0.8.1: stripHtml's multi-line sibling, for company_research — a rich-text
  // property reps paste whole briefs into, where the paragraph breaks are the
  // structure. Block ends and <br> become newlines, every entity (named or
  // numeric) is decoded, whitespace collapses within a line, and blank lines
  // go. Same contract as stripHtml: the result only ever reaches textContent.
  const HTML_ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
  function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref) => {
      if (ref.charAt(0) === "#") {
        const code = ref.charAt(1).toLowerCase() === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        // A code point outside Unicode (or 0) is dropped, not thrown on.
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      const named = own(HTML_ENTITIES, ref.toLowerCase());
      return named == null ? m : named;
    });
  }

  function htmlToText(html) {
    if (!html) return "";
    const text = decodeEntities(
      String(html)
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(td|th)\s*>/gi, " ")
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|ul|ol|table)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
    );
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  // v0.9.0: the SDR Call Brief as a list. The property is plain text, one
  // "• LABEL: text" line per bullet, but it is written by an automation and
  // edited by hand, so every line is read defensively: HTML goes through
  // htmlToText (which also splits CRLF and drops blank lines), a leading "•",
  // "-" or "*" bullet is optional, and the label is only the text before the
  // first colon when that text is an UPPERCASE label. Anything else is a line
  // with no label. Inline " · " separators stay inside the text. Pure: string
  // in, [{ label, text }] out ([] for nothing), and only ever textContent.
  const BRIEF_BULLET = /^(?:[\u2022\u25CF\u25AA]\s*|[-*]\s+)/;
  const BRIEF_LABEL = /^([A-Z][A-Z0-9 &/'().-]{0,39}?)\s*:\s*([\s\S]*)$/;
  function callBriefView(value) {
    const raw = asText(value);
    if (!raw) return [];
    const items = [];
    for (const line of htmlToText(raw).split("\n")) {
      const body = line.replace(BRIEF_BULLET, "").trim();
      if (!body) continue;
      const m = BRIEF_LABEL.exec(body);
      if (m && m[1].trim()) items.push({ label: m[1].trim(), text: m[2].trim() });
      else items.push({ label: null, text: body });
    }
    return items;
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

  // --- Status pill tones (Phase 11; pure, exported, unit-tested) ------------
  // The five tones a pill can have. NAMES, not colours — see CONFIG.STATUS_TONES
  // for why, and for the kind → value → tone table itself.
  const TONES = ["positive", "caution", "negative", "neutral", "info"];

  // Accepts either a STATUS_TONES key or one of the CONFIG.STATUS_KINDS aliases;
  // null for a kind nobody has mapped (which tones as `neutral`).
  function statusKindOf(kind) {
    const slug = enumSlug(kind);
    if (!slug) return null;
    if (own(CONFIG.STATUS_TONES, slug)) return slug;
    const alias = own(CONFIG.STATUS_KINDS, slug);
    return alias && own(CONFIG.STATUS_TONES, alias) ? alias : null;
  }

  // A deal row from getDeals() → the state its pill is about. Same precedence as
  // dealOutcome(): the portal's explicit hs_is_closed_lost flag wins over the
  // pipeline probability, and closed-and-not-won is lost.
  function dealStateSlug(deal) {
    if (!deal || typeof deal !== "object") return null;
    if (!deal.closed) return "open";
    return deal.closedLost === true || !deal.won ? "closed_lost" : "closed_won";
  }

  // The value's key in STATUS_TONES[kind]. Two kinds take richer input than a
  // string because that is what the panel actually holds: `deal` accepts a deal
  // row, `sequence` accepts the tri-state enrolment boolean (or a sequence
  // view-model). Everything else is slugged.
  function statusValueSlug(kind, value) {
    const k = statusKindOf(kind);
    if (k === "deal" && value && typeof value === "object") return dealStateSlug(value);
    if (k === "sequence") {
      const v = value && typeof value === "object" ? value.enrolled : value;
      if (v === true) return "enrolled";
      if (v === false) return "not_enrolled";
      const s = enumSlug(v);
      if (!s) return null;
      if (/^(true|yes|1|enrolled|in_sequence|in_a_sequence)$/.test(s)) return "enrolled";
      if (/^(false|no|0|not_enrolled|not_in_sequence|not_in_a_sequence)$/.test(s)) {
        return "not_enrolled";
      }
      return s;
    }
    // No other kind has an object form, and String({}) is "[object Object]" —
    // which must never become a slug, a label, or a tone.
    if (value && typeof value === "object") return null;
    const slug = enumSlug(value);
    if (!slug) return null;
    if (k === "account_grade_v1") {
      // "A", "A+", "b-", "grade_b" are all the same grade; the modifier is not
      // a separate tone.
      const m = /^(?:grade_)?([a-z])(?:_.*)?$/.exec(slug);
      return m ? m[1] : slug;
    }
    return slug;
  }

  // (kind, value) → one of TONES. Never throws, and never guesses: an unmapped
  // kind or value is `neutral`.
  function statusTone(kind, value) {
    const k = statusKindOf(kind);
    if (!k) return "neutral";
    const slug = statusValueSlug(k, value);
    if (!slug) return "neutral";
    const map = own(CONFIG.STATUS_TONES, k) || {};
    // The second lookup absorbs HubSpot's two spellings of the same enum
    // ("SALES_QUALIFIED_LEAD" and "salesqualifiedlead") without a second entry.
    const tone = own(map, slug) || own(map, slug.replace(/_/g, ""));
    return TONES.indexOf(tone) !== -1 ? tone : "neutral";
  }

  // humanizeEnum, then a capital: HubSpot's lowercase picklists ("active",
  // "customer") already look like labels to humanizeEnum, and a pill reads as a
  // label, not as a sentence fragment.
  function statusLabel(value) {
    const h = humanizeEnum(value);
    return h ? h.charAt(0).toUpperCase() + h.slice(1) : null;
  }

  // Everything a status pill needs: { kind, slug, label, tone }. Null when there
  // is no value at all, so the caller drops the pill instead of drawing an empty
  // one. `kind` is the canonical STATUS_TONES key (aliases resolved), or null if
  // the kind is unmapped — the pill still renders, tone `neutral`.
  function statusPill(kind, value) {
    const k = statusKindOf(kind);
    const slug = statusValueSlug(k, value);
    const tone = statusTone(k, value);
    const raw = value && typeof value === "object" ? null : value;
    let label;
    if (k === "sequence") {
      label =
        slug === "enrolled"
          ? "In sequence"
          : slug === "not_enrolled"
            ? "Not in a sequence"
            : statusLabel(raw) || statusLabel(slug);
    } else {
      label = statusLabel(raw) || statusLabel(slug);
    }
    if (!slug && !label) return null;
    return { kind: k, slug: slug || null, label: label || null, tone };
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

  // "Is this me?" — three states, and the third one is the whole point.
  //
  //   true   the record's owner ID is the connected rep's own
  //   false  a different owner, and we can name them
  //   null   we cannot say, and the renderer must NOT draw a "not yours" flag:
  //          telling a rep an account isn't theirs when it might be is worse
  //          than saying nothing. Three ways to land here:
  //            · no connected owner ID (the connection never resolved one)
  //            · no owner ID on the record — including a property that holds a
  //              *name* rather than an ID, which is not comparable to an ID
  //            · an owner ID that resolved to no name. "Someone else, and we
  //              can't tell you who" is not a flag worth raising; a name is what
  //              makes it actionable.
  //
  // The one asymmetry, deliberately: an ID equal to the rep's own is `true` even
  // when the name lookup failed. It is their own ID — there is nothing left to
  // be unsure about, and "yours" is the claim that cannot cause a false alarm.
  function ownerIsMine(ownerId, selfOwnerId, resolvedName) {
    const self = isId(selfOwnerId) ? String(selfOwnerId) : null;
    const id = isId(ownerId) ? String(ownerId) : null;
    if (!self || !id) return null;
    if (id === self) return true;
    return asText(resolvedName) ? false : null;
  }

  // --- Contact / company resolution ---------------------------------------
  // Phase 12: both the contact and company GETs additionally ask for the
  // custom-object associations they might carry — zero extra requests, the
  // ids just ride along in the same response's `associations` block (see
  // firstAssocId). Trial is requested on BOTH ends because which side it
  // associates to is unverified; whichever comes back non-empty wins.
  function contactByIdPath(id) {
    return (
      `/crm/v3/objects/contacts/${encodeURIComponent(id)}` +
      `?associations=companies,deals,${CONFIG.WIZA_USER_ASSOC_KEYS[0]},${CONFIG.TRIAL_ASSOC_KEYS[0]}` +
      `&properties=${propList(CONFIG.CONTACT_PROPERTIES)}`
    );
  }

  const getContactById = (id) => orNull(request(contactByIdPath(id)));

  const getCompanyById = (id) =>
    orNull(
      request(
        `/crm/v3/objects/companies/${encodeURIComponent(id)}` +
          `?associations=${CONFIG.WIZA_ACCOUNT_ASSOC_KEYS[0]},${CONFIG.TRIAL_ASSOC_KEYS[0]}` +
          `&properties=${propList(CONFIG.COMPANY_PROPERTIES)}`
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
        // v0.8.1: { competitor, competitorRenewalAt } — see dealCompetitorView.
        ...dealCompetitorView(p),
      };
    });
    // Open deals are what a rep is about to talk about; closed ones are context.
    deals.sort((a, b) => {
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      return toMillis(b.closeDate) - toMillis(a.closeDate);
    });
    return deals;
  }

  // v0.8.1: the deal's competitor and their renewal date, for the row's meta
  // line. "Unknown" and "None" are values reps pick to mean "no competitor",
  // so they display as nothing, same as blank. Pure over the deal's
  // properties, so the harness can assert it without a batch read.
  function dealCompetitorView(p) {
    const props = p || {};
    const raw = asText(props.competitor);
    const label = raw ? own(CONFIG.COMPETITOR_LABELS, raw.toLowerCase()) || raw : null;
    return {
      competitor: label && !/^(unknown|none)$/i.test(label) ? label : null,
      competitorRenewalAt: toMillis(props.competitor_renewal_date_deal) || null,
    };
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
  //
  // v0.9.0: `failed` is the bundle's activityFailed list. A type that failed
  // outright stays clickable (its tab shows "n/a", and the list says why)
  // instead of reading as a believable "0". A partial failure (company or
  // deal leg only) keeps its count and just carries the failure along.
  function activityTabs(items, failed) {
    const list = items || [];
    const failures = new Map();
    for (const f of failed || []) if (f && f.type) failures.set(f.type, f);
    const counts = new Map();
    for (const item of list) {
      const t = item && item.type;
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const tabs = [{ key: "all", label: "All", count: list.length, disabled: !list.length }];
    for (const spec of CONFIG.ACTIVITY_TYPES) {
      const count = counts.get(spec.type) || 0;
      const failure = failures.get(spec.type) || null;
      const unavailable = !!(failure && !failure.partial);
      tabs.push({
        key: spec.type,
        label: spec.tab || spec.label,
        count,
        disabled: count === 0 && !unavailable,
        failure,
        unavailable,
      });
    }
    return tabs;
  }

  // --- v0.9.0 activity fetch helpers (pure; unit-tested) --------------------
  // Merge association id lists from every object (contact, company, deals),
  // dedupe, and keep the `max` newest. Ids are digit strings that grow over
  // time; comparing length first then lexically is a numeric sort that stays
  // exact past 2^53.
  function topActivityIds(lists, max) {
    const seen = new Set();
    for (const list of lists || []) {
      for (const id of list || []) if (isId(id)) seen.add(String(id));
    }
    const ids = Array.from(seen).sort((a, b) =>
      b.length !== a.length ? b.length - a.length : b < a ? -1 : b > a ? 1 : 0
    );
    return max == null ? ids : ids.slice(0, Math.max(0, max));
  }

  // The `after` cursor of a v4 associations page, or null on the last page.
  function assocNextAfter(body) {
    const after = body && body.paging && body.paging.next && body.paging.next.after;
    return after != null && after !== "" ? String(after) : null;
  }

  // v4 batch association read: { results: [{ from: { id }, to: [{ toObjectId }] }] }.
  function v4BatchIds(body) {
    const ids = [];
    for (const r of (body && body.results) || []) {
      for (const t of (r && r.to) || []) {
        const id = t && (t.toObjectId != null ? t.toObjectId : t.id);
        if (isId(id)) ids.push(String(id));
      }
    }
    return topActivityIds([ids]);
  }

  // The shape a per-type failure takes on the bundle. `partial` means the
  // contact's own engagements loaded and only a company/deal leg failed.
  function activityFailure(type, err, partial) {
    const status = err && Number(err.status);
    return {
      type: String(type),
      status: status > 0 ? status : null,
      code: (err && err.code) || "TRANSIENT",
      partial: !!partial,
    };
  }

  // "Notes unavailable (HTTP 403)": the one string a failed tab shows.
  function activityFailureText(failure) {
    if (!failure) return "";
    const spec = CONFIG.ACTIVITY_TYPES.find((s) => s.type === failure.type);
    const label = (spec && (spec.tab || spec.label)) || failure.type;
    const why = failure.status ? `HTTP ${failure.status}` : humanizeEnum(failure.code) || "network error";
    return failure.partial
      ? `Some company or deal ${label.toLowerCase()} unavailable (${why})`
      : `${label} unavailable (${why})`;
  }

  // The tab to actually render: the remembered one if it still has rows, else
  // "All". Keeps a rep's choice across prospect switches without ever showing
  // them an empty list they can't explain.
  function resolveActivityTab(items, preferred, failed) {
    const tabs = activityTabs(items, failed);
    const hit = tabs.find((t) => t.key === preferred);
    return hit && !hit.disabled ? hit.key : "all";
  }

  // Every page of one object's v4 associations to an engagement type, capped
  // at ACTIVITY_ASSOC_MAX ids. A missing record (404) is "no associations".
  async function fetchAssocIds(fromType, fromId, toType) {
    const ids = new Set();
    let after = null;
    do {
      const q = `limit=${CONFIG.BATCH_MAX}` + (after ? `&after=${encodeURIComponent(after)}` : "");
      const body = await orNull(
        request(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/${toType}?${q}`)
      );
      for (const id of v4Ids(body)) ids.add(id);
      after = assocNextAfter(body);
    } while (after && ids.size < CONFIG.ACTIVITY_ASSOC_MAX);
    return Array.from(ids).slice(0, CONFIG.ACTIVITY_ASSOC_MAX);
  }

  // All of the deals' associations to one engagement type in ONE request.
  async function fetchDealAssocIds(dealIds, toType) {
    const ids = (dealIds || []).filter(isId).slice(0, CONFIG.ACTIVITY_DEAL_MAX);
    if (!ids.length) return [];
    const body = await post(`/crm/v4/associations/deals/${toType}/batch/read`, {
      inputs: ids.map((id) => ({ id: String(id) })),
    });
    return v4BatchIds(body);
  }

  // Per engagement type, in parallel: the contact's associations (every page),
  // the company's, and one batch association read for the deals, all at once.
  // The merged ids are deduped and only the ACTIVITY_ASSOC_READ newest get
  // batch-read, then sorted by hs_timestamp and cut to ACTIVITY_PER_TYPE_LIMIT.
  // Typical cost: 3 association reads + 1 batch read per type.
  //
  // Each type fails independently and the failure is returned, not just
  // logged: { items, failed: [{ type, status, code, partial }] }. The contact
  // leg failing fails the type; a company or deal leg failing keeps the
  // contact's rows and marks the type `partial`. buildBundle never caches a
  // bundle with any failed type. Only a total failure (every type erroring
  // outright) throws, so the panel shows a section error.
  async function getActivity(contactId, options) {
    if (!isId(contactId)) return { items: [], failed: [] };
    const opts = options || {};
    const companyId = isId(opts.companyId) ? String(opts.companyId) : null;
    const dealIds = (opts.dealIds || []).filter(isId);
    const failed = [];
    const errors = [];
    const perType = await Promise.all(
      CONFIG.ACTIVITY_TYPES.map(async (spec) => {
        try {
          const legs = [fetchAssocIds("contacts", contactId, spec.type)];
          if (companyId) legs.push(fetchAssocIds("companies", companyId, spec.type));
          if (dealIds.length) legs.push(fetchDealAssocIds(dealIds, spec.type));
          const settled = await Promise.all(
            legs.map((p, i) => p.then((ids) => ({ ids }), (err) => ({ err, primary: i === 0 })))
          );
          const primary = settled.find((r) => r.err && r.primary);
          if (primary) throw primary.err;
          const secondary = settled.find((r) => r.err);
          if (secondary) {
            failed.push(activityFailure(spec.type, secondary.err, true));
            log(
              `activity: company/deal ${spec.type} could not be read: HTTP ${(secondary.err && secondary.err.status) || "?"}`
            );
          }
          const ids = topActivityIds(
            settled.filter((r) => r.ids).map((r) => r.ids),
            CONFIG.ACTIVITY_ASSOC_READ
          );
          if (!ids.length) return [];
          const chunks = [];
          for (let i = 0; i < ids.length; i += CONFIG.BATCH_MAX) chunks.push(ids.slice(i, i + CONFIG.BATCH_MAX));
          const reads = await Promise.all(
            chunks.map((chunk) =>
              post(`/crm/v3/objects/${spec.type}/batch/read`, {
                properties: spec.properties,
                inputs: chunk.map((id) => ({ id })),
              })
            )
          );
          const items = [];
          for (const read of reads) {
            for (const obj of (read && read.results) || []) items.push(activityItem(spec, obj));
          }
          // Sorted by time, then cut: ids only approximate recency.
          return sortActivity(items).slice(0, CONFIG.ACTIVITY_PER_TYPE_LIMIT);
        } catch (e) {
          errors.push(e);
          // A type that failed outright replaces any partial entry for it.
          for (let i = failed.length - 1; i >= 0; i--) if (failed[i].type === spec.type) failed.splice(i, 1);
          failed.push(activityFailure(spec.type, e, false));
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
    if (!usable.length && errors.length) {
      log("activity: every engagement type failed; reporting it to the panel");
      throw errors[0];
    }
    if (errors.length) {
      log(
        `activity: ${errors.length} of ${CONFIG.ACTIVITY_TYPES.length} engagement types unavailable; showing the rest`
      );
    }
    // Stable order for the panel and tests: ACTIVITY_TYPES order.
    failed.sort((a, b) => typeOrder(a.type) - typeOrder(b.type));

    // Attribution is part of a row, not a later decoration: callers of
    // getActivity always get rows they can render as-is.
    const items = await attributeActivity(sortActivity([].concat.apply([], usable)));
    return { items, failed };
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
      const resolvedOwner = ownerName(owners, ownerId);
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
        ownerName: resolvedOwner,
        // true = the connected rep's own contact, false = a named teammate's,
        // null = we can't say (no connected owner ID, no owner on the row, or an
        // owner ID that resolved to no name). Null renders as neither claim —
        // identical semantics to the ownership rows, same helper. See
        // ownerIsMine.
        isMine: ownerIsMine(ownerId, selfOwnerId, resolvedOwner),
        linkedinUrl: linkedInUrl(p.hs_linkedin_url),
        url: recordUrl("contact", id),
      });
    }

    // v0.8.1: one row per person. The id check above covers a record listed
    // twice; this covers two HubSpot records for the same email (a merge that
    // never happened), which the panel showed as the same name twice. The row
    // kept is the one contacted most recently, so its owner and "contacted"
    // time are the live ones. Same name with different emails stays as two
    // rows: those are real CRM duplicates a rep should see, not hide.
    const byEmail = Object.create(null);
    const unique = [];
    for (const row of rows) {
      if (!row.email) {
        unique.push(row);
        continue;
      }
      const at = byEmail[row.email];
      if (at == null) {
        byEmail[row.email] = unique.length;
        unique.push(row);
      } else if ((row.lastContactedAt || 0) > (unique[at].lastContactedAt || 0)) {
        unique[at] = row;
      }
    }
    rows.length = 0;
    rows.push(...unique);

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
      // v0.8.1: how this person came in (PLG Signup, Abandoned Booking, ...).
      // Null for a prospected contact, which is the common case.
      inboundSource: humanizeEnum(p.inbound_source) || null,
      inboundSourceAt: toMillis(p.inbound_source_last_updated) || null,
      // v0.9.0: the SDR Call Brief, parsed. [] when the record has none.
      callBrief: callBriefView(p.sdr_call_brief),
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
      // v0.9.0: the company's SDR Call Brief, parsed. [] when it has none.
      callBrief: callBriefView(p.sdr_call_brief),
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
  // One ownership row: { key, label, name, ownerId, isMine, missing, unresolved }.
  //
  // `name` is null rather than a number when the value is an ID the owner cache
  // could not resolve — the pre-existing rule, and `unresolved` is how the
  // renderer tells that case ("owner on file, name unavailable") apart from
  // `missing` ("nobody owns this"), which are different facts and read
  // differently to a rep.
  function ownerRole(key, label, value, owners, selfOwnerId) {
    const raw = asText(value);
    const ownerId = raw && isId(raw) ? String(raw) : null;
    const name = ownerRef(raw, owners);
    return {
      key,
      label,
      name: name || null,
      ownerId,
      isMine: ownerIsMine(ownerId, selfOwnerId, name),
      missing: !raw,
      unresolved: !!raw && !name,
    };
  }

  // Phase 11 adds `roles`: Outbound, Company and Contact owner ALWAYS present, in
  // that order, because the panel now draws all three unconditionally — an unset
  // one is a row saying "unassigned", not a row that vanishes. (A missing
  // ownership row used to be indistinguishable from a section that hadn't
  // loaded.) Each row carries the three-state `isMine` from ownerIsMine; the
  // renderer flags outbound and contact, and the null state is never flagged.
  //
  // `options.selfOwnerId` is the connected rep's owner ID (connectedOwnerId()).
  // Omit it and every `isMine` is null, which is the honest answer when the
  // connection never resolved one — the function stays pure either way.
  function ownershipView(contact, company, owners, options) {
    const cp = (company && company.properties) || {};
    const kp = (contact && contact.properties) || {};
    const selfOwnerId = isId(options && options.selfOwnerId) ? String(options.selfOwnerId) : null;

    const roles = [
      ownerRole("outbound", "Outbound owner", cp.sdr_company_owner, owners, selfOwnerId),
      ownerRole("company", "Company owner", cp.hubspot_owner_id, owners, selfOwnerId),
      ownerRole("contact", "Contact owner", kp.hubspot_owner_id, owners, selfOwnerId),
    ];
    // The CSM is supporting detail, not one of the three the panel always draws,
    // so it stays out of `roles` — a renderer iterating `roles` must always get
    // exactly the three rows it promised the rep.
    const csmRole = ownerRole("csm", "CSM", cp.cs_company_owner, owners, selfOwnerId);

    const own = {
      // Unchanged flat fields (what the panel renders today).
      outbound: roles[0].name,
      csm: csmRole.name,
      companyOwner: roles[1].name,
      contactOwner: roles[2].name,
      changedAt: toMillis(cp.outbound_ownership_change_date) || null,
      // Phase 11.
      roles,
      byKey: { outbound: roles[0], company: roles[1], contact: roles[2], csm: csmRole },
      csmRole,
      selfOwnerId,
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
  // --- v0.8.1: account type, team mix, rep notes ---------------------------
  // "Did they come to us, or did we go to them?" — the first thing a rep wants
  // to know before deciding how warm to open. Precedence, by design:
  //   inbound_source set                 → Inbound (they raised a hand; that
  //                                        outranks any enrichment we ran)
  //   last_bulk_contact_enrichment_date  → Prospected
  //   neither                            → Unknown (a claim the record can't
  //                                        back is not made)
  // `detail` is the relative time behind the type; `at` is the raw stamp for
  // the hover. Pure apart from `now`, which tests pass in.
  function accountTypeView(p, now) {
    const source = humanizeEnum(p.inbound_source) || null;
    if (source) {
      const at = toMillis(p.inbound_source_last_updated) || null;
      return {
        kind: "inbound",
        label: `Inbound · ${source}`,
        detail: at ? relativeTime(at, now) : null,
        source,
        at,
      };
    }
    const enrichedAt = toMillis(p.last_bulk_contact_enrichment_date) || null;
    if (enrichedAt) {
      return {
        kind: "prospected",
        label: "Prospected",
        detail: `enriched ${relativeTime(enrichedAt, now)}`,
        source: null,
        at: enrichedAt,
      };
    }
    return { kind: "unknown", label: "Unknown", detail: null, source: null, at: null };
  }

  // The contact-role rollups, raw. Null as a whole when no member is a
  // positive count — zero contacts in every role is the same "nothing to say"
  // as no data, and the panel hides the row on null.
  function teamMixView(p) {
    const mix = {
      sdr: asNumber(p.sdr_contacts),
      ae: asNumber(p.ae_contacts),
      amcs: asNumber(p.amcs_contacts),
      leaders: asNumber(p.sales_leader_contacts),
      gtmOps: asNumber(p.gtm_ops_contacts),
      total: asNumber(p.number_of_associated_sales_team_contacts),
    };
    return Object.keys(mix).some((k) => mix[k] != null && mix[k] > 0) ? mix : null;
  }

  // communications_channel_company → [{ key, label }], in the order the
  // portal stored them. HubSpot returns a multi-select as "slack;email".
  function commChannels(value) {
    return splitDelimited(value).map((raw) => {
      const key = raw.toLowerCase();
      return { key, label: own(CONFIG.COMM_CHANNEL_LABELS, key) || humanizeEnum(raw) };
    });
  }

  // HubSpot stores a date-only property as midnight UTC (and fmt.date shows it
  // in UTC), but "today" is the rep's own calendar day: at 8pm in Atlanta the
  // UTC date has already rolled to tomorrow, and a check-in due today would
  // read overdue. So today is the viewer's LOCAL Y/M/D re-expressed as a UTC
  // midnight, which is directly comparable to the stored value.
  function localTodayUtc(now) {
    const ref = new Date(now == null ? Date.now() : now);
    return Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate());
  }

  // next_checkin is a calendar date (midnight UTC), so "overdue" means a day
  // strictly before the viewer's local today, not "earlier than this instant":
  // a check-in due today is due, not late.
  function isPastDate(ms, now) {
    if (!ms) return false;
    return ms < localTodayUtc(now);
  }

  // Where a calendar date sits against today (the viewer's local date), for the competitor
  // renewal chip: "past" | "negative" (within RENEWAL_NEGATIVE_DAYS) |
  // "caution" (within RENEWAL_CAUTION_DAYS) | null (further out, or no date).
  function renewalState(ms, now) {
    if (!ms) return null;
    const days = Math.floor((ms - localTodayUtc(now)) / 86400000);
    if (days < 0) return "past";
    if (days <= CONFIG.RENEWAL_NEGATIVE_DAYS) return "negative";
    if (days <= CONFIG.RENEWAL_CAUTION_DAYS) return "caution";
    return null;
  }

  // Whole calendar days from the viewer's local today to a date-only stamp:
  // negative once passed, 0 today, null with no date.
  function daysFromToday(ms, now) {
    if (!ms) return null;
    return Math.floor((ms - localTodayUtc(now)) / 86400000);
  }

  function accountContextView(company, options) {
    const p = (company && company.properties) || {};
    const now = options && options.now != null ? options.now : null;

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
      // "Company Status" in the portal (the property is named lifecycle).
      // Stored "Open Deal" displays as "Active Deal"; everything else as-is.
      status: companyStatusLabel(p.company_lifecycle_stage),
      prospectingStatus: humanizeEnum(p.prospecting_status) || null,
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
      // Phase 11: the tech row's real view-model — cleaned vendor labels, a
      // competitor flag per item, and a visible/hidden split for MORE/LESS.
      techStack: techStackView(p.web_technologies),
      // The { items, more, total, all } shape the panel renders today, built from
      // the same cleaned labels so the underscore bug is fixed for both readers.
      tech: null,
    };
    ctx.tech = techListLegacy(ctx.techStack);
    ctx.statusTone = accountStatusTone(ctx.status);
    ctx.prospectingStatusTone = accountStatusTone(ctx.prospectingStatus);
    // v0.8.1: the GTM tech block. gtmTech is what renders as pills, allTech the
    // "All tech (n)" disclosure under it.
    Object.assign(ctx, gtmTechView(p.web_technologies));

    // v0.8.1. Account type rides in the section head beside the grade; the
    // team mix sits under the chip grid; the rep notes follow the ICP Why.
    ctx.accountType = accountTypeView(p, now);
    ctx.teamMix = teamMixView(p);
    const nextCheckinAt = toMillis(p.next_checkin) || null;
    const researchFull = asText(p.company_research) ? htmlToText(p.company_research) || null : null;
    const research = researchFull ? truncate(researchFull, CONFIG.REASONING_CHARS) : null;
    Object.assign(ctx, {
      companySource: humanizeEnum(p.company_source) || null,
      channels: commChannels(p.communications_channel_company),
      nextCheckinAt,
      nextCheckinOverdue: isPastDate(nextCheckinAt, now),
      competitorTech: asText(p.competitor_tech),
      // The COMPANY's own renewal date only. A deal's competitor_renewal_date_deal
      // is never used as a fallback here: the two are separate sources and the
      // deal row shows its own.
      competitorRenewalAt: toMillis(p.competitor_renewal_date) || null,
      competitorRenewalState: renewalState(toMillis(p.competitor_renewal_date) || null, now),
      missingFeatures: asText(p.missing_wiza_features),
      research,
      researchFull,
      researchTruncated: !!(researchFull && research && researchFull.length > research.length),
    });
    // v0.8.1: the bottom of Account context as two labelled groups. Call intel
    // is what automations extracted from previous calls (what they use today,
    // when it renews, what they said Wiza lacks, when to check back); Account
    // notes is what reps keep on the record by hand. Flat fields above stay
    // for existing readers.
    const renewDays = daysFromToday(ctx.competitorRenewalAt, now);
    const checkinDays = daysFromToday(nextCheckinAt, now);
    ctx.callIntel = {
      using: ctx.competitorTech,
      renewsAt: ctx.competitorRenewalAt,
      renewsState: ctx.competitorRenewalState,
      renewsHint: renewDays == null ? null : renewDays < 0 ? "passed" : renewDays === 0 ? "today" : `in ${renewDays}d`,
      missingFeatures: ctx.missingFeatures,
      nextCheckinAt,
      nextCheckinOverdue: ctx.nextCheckinOverdue,
      nextCheckinHint:
        checkinDays == null ? null : ctx.nextCheckinOverdue ? "overdue" : checkinDays === 0 ? "today" : `in ${checkinDays}d`,
    };
    ctx.callIntel.hasData = !!(ctx.callIntel.using || ctx.callIntel.renewsAt || ctx.callIntel.missingFeatures || nextCheckinAt);
    ctx.accountNotes = {
      source: ctx.companySource,
      channels: ctx.channels,
      research,
      researchFull,
    };
    ctx.accountNotes.hasData = !!(ctx.companySource || ctx.channels.length || research);

    ctx.hasRepNotes = !!(
      ctx.companySource ||
      ctx.channels.length ||
      ctx.nextCheckinAt ||
      ctx.competitorTech ||
      ctx.competitorRenewalAt ||
      ctx.missingFeatures ||
      ctx.research
    );

    ctx.hasData = !!(
      ctx.accountType.kind !== "unknown" ||
      ctx.teamMix ||
      ctx.hasRepNotes ||
      ctx.grade ||
      ctx.status ||
      ctx.prospectingStatus ||
      ctx.salesTeamSize != null ||
      ctx.aeTeamSize != null ||
      ctx.obTeamSize != null ||
      ctx.leadershipTeamSize != null ||
      ctx.snippet ||
      ctx.industry ||
      ctx.icp ||
      ctx.icpFit ||
      ctx.icpReasoning ||
      ctx.allTech.length > 0
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

  // v0.8.1: the company-level usage rollups (bundle.wiza.usage). A separate
  // view from wizaAccountView on purpose: these are the company's own
  // properties, present on a record with no Wiza Account object at all, and
  // the Wiza section shows on them alone. Once the rollups count as data (any
  // value > 0, or a create date), zero is a real value (0 active users is
  // something a rep acts on); all-zero/null is `hasData: false`. `depletionTone` is the semantic tone NAME for the depletion chip.
  function wizaUsageView(company) {
    const p = (company && company.properties) || {};
    const depletionDays = asNumber(p.wiza_credit_depletion_days_company);
    const usage = {
      accountCreatedAt: toMillis(p.wiza_account_create_date) || null,
      activeUsers30d: asNumber(p.number_of_active_users_last_30_days),
      creditsUsed30d: asNumber(p.number_of_credits_used_in_last_30_days),
      apiCreditBalance: asNumber(p.api_credit_balance_company),
      apiCreditsUsed30d: asNumber(p.api_credits_used__30_days_cloned),
      apiCreditsPerDay: asNumber(p.credit_use_per_day_company),
      depletionDays,
      depletionTone:
        depletionDays == null
          ? null
          : depletionDays < CONFIG.DEPLETION_NEGATIVE_DAYS
            ? "negative"
            : depletionDays < CONFIG.DEPLETION_CAUTION_DAYS
              ? "caution"
              : null,
    };
    // v0.8.1: all-zero/null rollups are not data (HubSpot rollups default to 0
    // on companies that never used Wiza); a positive number or an account
    // create date is.
    const counts = [
      usage.activeUsers30d,
      usage.creditsUsed30d,
      usage.apiCreditBalance,
      usage.apiCreditsUsed30d,
      usage.apiCreditsPerDay,
      usage.depletionDays,
    ];
    usage.hasData = !!(usage.accountCreatedAt || counts.some((n) => n != null && n > 0));
    return usage;
  }

  // v0.8.1 Wiza tiles: three small shapers the Account and Usage tiles draw
  // from, kept here (pure, unit-tested) so the colour rules live in one place.
  //
  // Stripe status → the status dot's tone NAME. Broader than the pill-tone map
  // above on purpose: the dot always draws, so "active" needs its green here,
  // while a canceled or missing subscription is grey (a fact, not an alarm).
  // Accepts the raw enum or the label statusLabel made of it ("Past due").
  const STRIPE_DOT_TONES = {
    active: "positive",
    trialing: "positive",
    past_due: "caution",
    unpaid: "caution",
    incomplete: "caution",
  };
  function stripeDotTone(value) {
    const slug = String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return Object.prototype.hasOwnProperty.call(STRIPE_DOT_TONES, slug) ? STRIPE_DOT_TONES[slug] : "neutral";
  }

  // Seats used of total, for a thin meter. `ratio` is null when there is no
  // usable total (the tile then prints the used count alone); it is clamped
  // to 0..1 and `over` says when the account is past its seat count.
  function seatsMeterView(used, total) {
    const u = asNumber(used);
    if (u == null) return null;
    const t = asNumber(total);
    if (t == null || t <= 0) return { used: u, total: null, ratio: null, over: false };
    return { used: u, total: t, ratio: Math.max(0, Math.min(1, u / t)), over: u > t };
  }

  // Days of credit runway → a meter. Green at 14 days and up, amber under 14,
  // red under 7 (the same thresholds as depletionTone). The bar is full at
  // DEPLETION_METER_FULL_DAYS so a healthy account reads as a full bar rather
  // than a sliver of some arbitrary maximum.
  const DEPLETION_METER_FULL_DAYS = 30;
  function depletionMeterView(days) {
    const d = asNumber(days);
    if (d == null) return null;
    const tone =
      d < CONFIG.DEPLETION_NEGATIVE_DAYS ? "negative" : d < CONFIG.DEPLETION_CAUTION_DAYS ? "caution" : "positive";
    return { days: d, tone, ratio: Math.max(0, Math.min(1, d / DEPLETION_METER_FULL_DAYS)) };
  }

  // --- Phase 12: property history → sparkline view-model -------------------
  // propertiesWithHistory arrives as { value, timestamp, sourceType, ... },
  // NEWEST FIRST, and version density is unverified ahead of a live read — a
  // property that has never changed still comes back with exactly one
  // version, and one that changes on every credit spend could come back with
  // hundreds. Both turn into the same shape, so the renderer never branches:
  //   points     numbers only, OLDEST → NEWEST (left-to-right on a
  //              sparkline), downsampled to HISTORY_MAX_POINTS with both
  //              endpoints always kept
  //   count      how many usable (numeric, timestamped) versions there were
  //              BEFORE downsampling — what `sparkline` is decided from, not
  //              the (possibly smaller) length of `points`
  //   latest     the newest usable value, or null when there is none
  //   trend      "up" | "down" | "flat" | null — the two endpoints of
  //              `points` compared; null with fewer than two of them
  //   sparkline  true once there is enough history to draw a line at all; the
  //              renderer prints the value alone when this is false — no
  //              empty chart, no placeholder, ever
  function historyView(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const points = [];
    for (let i = list.length - 1; i >= 0; i--) {
      // A version whose value never parses as a number, or that arrived with
      // no usable timestamp, is dropped rather than plotted as a break.
      const e = list[i];
      const v = asNumber(e && e.value);
      const t = toMillis(e && e.timestamp);
      if (v == null || !t) continue;
      points.push(v);
    }
    if (!points.length) return { points: [], count: 0, latest: null, trend: null, sparkline: false };

    const max = Number(CONFIG.HISTORY_MAX_POINTS) > 0 ? Number(CONFIG.HISTORY_MAX_POINTS) : 24;
    let sampled = points;
    if (points.length > max) {
      // Even spacing by index, both endpoints always kept: "where it started"
      // and "where it is now" matter more to a rep glancing at the line than
      // any point in between.
      sampled = [];
      const step = (points.length - 1) / (max - 1);
      let lastIdx = -1;
      for (let i = 0; i < max; i++) {
        const idx = Math.round(i * step);
        if (idx === lastIdx) continue; // rounding can repeat an index near the ends
        sampled.push(points[idx]);
        lastIdx = idx;
      }
    }
    const latest = points[points.length - 1];
    const first = points[0];
    const floor =
      Number(CONFIG.HISTORY_MIN_SPARKLINE_POINTS) > 0 ? Number(CONFIG.HISTORY_MIN_SPARKLINE_POINTS) : 3;
    return {
      points: sampled,
      count: points.length,
      latest,
      trend: points.length >= 2 ? (latest > first ? "up" : latest < first ? "down" : "flat") : null,
      sparkline: points.length >= floor,
    };
  }

  // --- Phase 12: Wiza custom objects — richer product data ------------------
  // Each view-model is null whenever fetchCustomObject came back with
  // nothing (no association, a 403 ahead of the app's crm.objects.custom.read
  // scope landing on a reconnect, a 404, anything) — never a half-built object
  // with the renderer left to guess which half. `hasData` is what the panel
  // gates a whole sub-section's extra content on.
  function wizaUserObjectView(obj) {
    if (!obj) return null;
    const p = obj.properties || {};
    const hist = obj.propertiesWithHistory || {};
    const view = {
      id: String(obj.id),
      userId: asText(p.wiza_user_id),
      status: asText(p.user_status),
      // The Wiza custom objects share the same lowercase, no-underscore enum
      // convention as the contact's own wiza_status ("active"/"closed") —
      // humanizeEnum leaves those alone because they already look like a
      // label, so every one of them goes through statusLabel() here instead,
      // which additionally capitalizes.
      statusLabel: statusLabel(p.user_status),
      role: statusLabel(p.wiza_role),
      email: asText(p.wiza_email),
      signedUpAt: toMillis(p.user_signup_date) || null,
      creditsUsed30d: asNumber(p.number_of_credits_used_in_last_30_days),
      creditsUsed30dHistory: historyView(hist.number_of_credits_used_in_last_30_days),
      // The richer of the two "last used" properties this object carries;
      // date_of_last_wiza_usage is the same fact the contact rollup has, kept
      // here as a fallback for a record where last_usage_at was never backfilled.
      lastUsageAt: toMillis(p.last_usage_at) || toMillis(p.date_of_last_wiza_usage) || null,
      lastEnrichmentAt: toMillis(p.date_of_last_enrichment) || null,
      lastBulkExportAt: toMillis(p.date_of_last_bulk_export) || null,
      extensionVersion: asText(p.extension_version),
      adminUrl: safeUrl(p.wiza_admin_url),
      usageLogsUrl: safeUrl(p.wiza_usage_logs),
    };
    view.hasData = !!(
      view.status ||
      view.role ||
      view.email ||
      view.signedUpAt ||
      view.creditsUsed30d != null ||
      view.lastUsageAt ||
      view.lastEnrichmentAt ||
      view.lastBulkExportAt ||
      view.extensionVersion ||
      view.adminUrl ||
      view.usageLogsUrl
    );
    return view;
  }

  function wizaAccountObjectView(obj) {
    if (!obj) return null;
    const p = obj.properties || {};
    const hist = obj.propertiesWithHistory || {};
    const view = {
      id: String(obj.id),
      accountId: asText(p.account_id),
      planName: asText(p.plan_name),
      planPrice: asNumber(p.plan_price),
      planFrequency: statusLabel(p.plan_frequency),
      planCategory: statusLabel(p.plan_category),
      planPeriodEnd: toMillis(p.plan_period_end) || null,
      planSeatsUsed: asNumber(p.plan_seats_used),
      planSeatsTotal: asNumber(p.account_plan_seats_no),
      // -1 on any of these three means Unlimited (see formatCredits); the raw
      // number rides in the view-model either way, and the renderer decides.
      emailCredits: asNumber(p.account_email_credits),
      phoneCredits: asNumber(p.account_phone_credits),
      exportCredits: asNumber(p.export_credits),
      apiCreditBalance: asNumber(p.api_credit_balance),
      apiCreditBalanceHistory: historyView(hist.api_credit_balance),
      creditsUsed30d: asNumber(p.number_of_credits_used_in_last_30_days),
      creditsUsed30dHistory: historyView(hist.number_of_credits_used_in_last_30_days),
      activeUsers30d: asNumber(p.number_of_active_users_last_30_days),
      activeUsers30dHistory: historyView(hist.number_of_active_users_last_30_days),
      newUsers30d: asNumber(p.number_of_new_users_in_last_30_days),
      listsCount30d: asNumber(p.reports_count_30d),
      spend30d: asNumber(p.spend_last_30d),
      totalSpend: asNumber(p.total_spend),
      lastPaymentAt: toMillis(p.last_payment_date) || null,
      lastPaymentAmount: asNumber(p.last_payment_amount),
      hasOverage: asBool(p.has_overage),
      hasCardOnFile: asBool(p.has_card_on_file),
      stripeStatus: statusLabel(p.stripe_plan_subscription_status),
      accountStatus: statusLabel(p.account_status),
      trialStatus: statusLabel(p.account_trial_status),
      trialEndsAt: toMillis(p.trial_ends_at__edt_) || null,
      // A vendor name ("hubspot", "salesforce"), not an enum state — techLabel
      // is the panel's existing vendor-casing table (the tech-stack row uses
      // it for exactly this), so this reads "HubSpot", never "Hubspot".
      crmConnected: techLabel(p.crm_connected),
    };
    view.hasData = !!(
      view.planName ||
      view.planPrice != null ||
      view.planSeatsUsed != null ||
      view.planSeatsTotal != null ||
      view.emailCredits != null ||
      view.phoneCredits != null ||
      view.exportCredits != null ||
      view.apiCreditBalance != null ||
      view.creditsUsed30d != null ||
      view.activeUsers30d != null ||
      view.newUsers30d != null ||
      view.listsCount30d != null ||
      view.spend30d != null ||
      view.totalSpend != null ||
      view.lastPaymentAt ||
      view.hasOverage != null ||
      view.hasCardOnFile != null ||
      view.stripeStatus ||
      view.accountStatus ||
      view.trialStatus ||
      view.trialEndsAt ||
      view.crmConnected
    );
    return view;
  }

  function trialObjectView(obj) {
    if (!obj) return null;
    const p = obj.properties || {};
    const view = {
      id: String(obj.id),
      companyName: asText(p.company_name),
      startAt: toMillis(p.trial_start_date) || null,
      // The calculated end date is the portal's own answer to "when does this
      // actually end" (it accounts for extensions the plain end date doesn't);
      // the plain field is the fallback for a record where it was never set.
      endAt: toMillis(p.trial_end_date_calculated) || toMillis(p.trial_end_date) || null,
      lengthDays: asNumber(p.trial_length),
      paid: statusLabel(p.paid_trial),
      amount: asNumber(p.trial_amount),
      userCount: asNumber(p.how_many_trial_users),
      userEmails: asText(p.emails_of_trial_users),
      notes: asText(p.trial_notes) ? stripHtml(asText(p.trial_notes)) : null,
      exportCredits: statusLabel(p.trial_export_credits),
      apiCredits: statusLabel(p.trial_api_credits),
      monitorAccess: asBool(p.monitor_access),
    };
    view.hasData = !!(
      view.startAt ||
      view.endAt ||
      view.lengthDays != null ||
      view.paid ||
      view.amount != null ||
      view.userCount != null ||
      view.exportCredits ||
      view.apiCredits ||
      view.monitorAccess != null
    );
    return view;
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
    let activityFailed = [];
    let wizaUserObj = null;

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

    // Phase 12: the Wiza Account custom object, gated on the company exactly
    // like colleagues, and the Trial — requested off whichever of contact or
    // company actually carries the association (unverified which one it is;
    // see CONFIG.TRIAL_ASSOC_KEYS). Both are resilient on their own
    // (fetchCustomObject never throws), so neither one ever touches `errors`:
    // a Wiza custom object is enrichment on top of the rollup properties, not
    // a section of its own, and its absence must read as "nothing to add",
    // never as a failure.
    const wizaAccountObjPromise = fetchCustomObject(
      "wiza_account",
      CONFIG.WIZA_ACCOUNT_OBJECT_TYPE,
      company ? firstAssocId(company, CONFIG.WIZA_ACCOUNT_ASSOC_KEYS) : null,
      CONFIG.WIZA_ACCOUNT_OBJECT_PROPERTIES,
      CONFIG.WIZA_ACCOUNT_HISTORY_PROPERTIES
    );
    const trialObjPromise = fetchCustomObject(
      "trial",
      CONFIG.TRIAL_OBJECT_TYPE,
      (contact && firstAssocId(contact, CONFIG.TRIAL_ASSOC_KEYS)) ||
        (company && firstAssocId(company, CONFIG.TRIAL_ASSOC_KEYS)) ||
        null,
      CONFIG.TRIAL_OBJECT_PROPERTIES,
      null
    );

    if (contact) {
      const dealIds = associatedIds(contact, "deals");
      // Deals and activity are independent sections: one failing must not blank
      // the other, so each records its own typed error code instead of throwing.
      // The Wiza User object rides the same Promise.all — one fetch, gated on
      // the contact, no fan-out even when several users are associated (see
      // firstAssocId).
      const [dealResult, activityResult, wizaUserObjResult] = await Promise.all([
        getDeals(contact.id, dealIds).catch((e) => {
          errors.deals = isDataError(e) ? e.code : "TRANSIENT";
          if (isDataError(e) && e.retryAfterMs) errors.dealsRetryAfterMs = e.retryAfterMs;
          log("deals fetch failed:", e && e.message);
          return [];
        }),
        // v0.9.0: the company's and deals' engagements merge in, so a note
        // logged on the account (or a call logged on the deal) shows here too.
        getActivity(contact.id, { companyId: company && company.id, dealIds }).catch((e) => {
          errors.activity = isDataError(e) ? e.code : "TRANSIENT";
          if (isDataError(e) && e.retryAfterMs) errors.activityRetryAfterMs = e.retryAfterMs;
          log("activity fetch failed:", e && e.message);
          return { items: [], failed: [] };
        }),
        fetchCustomObject(
          "wiza_user",
          CONFIG.WIZA_USER_OBJECT_TYPE,
          firstAssocId(contact, CONFIG.WIZA_USER_ASSOC_KEYS),
          CONFIG.WIZA_USER_OBJECT_PROPERTIES,
          CONFIG.WIZA_USER_HISTORY_PROPERTIES
        ),
      ]);
      deals = dealResult;
      activity = activityResult.items;
      activityFailed = activityResult.failed;
      wizaUserObj = wizaUserObjResult;
    }

    const accountContacts = await colleaguesPromise;
    const [wizaAccountObj, trialObj] = await Promise.all([wizaAccountObjPromise, trialObjPromise]);
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
      // selfOwnerId rides in so every ownership row can answer "is this me?" —
      // read from the stored connection above, so it costs nothing.
      ownership: ownershipView(contact, company, owners, { selfOwnerId }),
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
      wiza: {
        user: wizaUserView(contact),
        account: wizaAccountView(company),
        // Phase 12: the custom-object views. Each is null exactly when
        // fetchCustomObject came back with nothing — see its own comment —
        // and the panel's fallback rule is "render precisely what these
        // being null renders today", not a separate code path.
        userObject: wizaUserObjectView(wizaUserObj),
        accountObject: wizaAccountObjectView(wizaAccountObj),
        trial: trialObjectView(trialObj),
        // v0.8.1: company-level usage rollups — shows the section on its own.
        usage: wizaUsageView(company),
      },
      deals,
      activity,
      // v0.9.0: [{ type, status, code, partial }] for every engagement type
      // that could not be read. Non-empty means the bundle is never cached.
      activityFailed,
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
        // Same for a bundle with any engagement type unreadable (v0.9.0).
        if (!bundle.errors && !(bundle.activityFailed || []).length) {
          bundleCache.set(key, { at: Date.now(), bundle });
        }
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
      // v0.8.1
      wizaUsage: wizaUsageView,
      stripeDotTone,
      seatsMeter: seatsMeterView,
      depletionMeter: depletionMeterView,
      contact: contactView,
      company: companyView,
      // Phase 12: the custom-object views + the history → sparkline shaper,
      // each pure over a fetched object (or null) so the harness can build a
      // bundle without a network call, same as every view-model above.
      wizaUserObject: wizaUserObjectView,
      wizaAccountObject: wizaAccountObjectView,
      trial: trialObjectView,
      history: historyView,
      activityItem,
      // Phase 8 (pure over fetched properties; the panel renders these directly)
      ownership: ownershipView,
      accountContext: accountContextView,
      sequence: sequenceView,
      dealOutcome,
      // v0.8.1
      dealCompetitor: dealCompetitorView,
      // Phase 9 (pure: records + resolved owner names in, ordered rows out)
      accountContacts: accountContactsView,
      // Phase 11
      techStack: techStackView,
      // v0.8.1
      gtmTech: gtmTechView,
      companyStatusLabel,
      accountStatusTone,
      // v0.9.0: SDR Call Brief text -> [{ label, text }]
      callBrief: callBriefView,
      // (ownerId, selfOwnerId, resolvedName) → true | false | null. Exported
      // because the three-state rule is the part a renderer can get wrong: null
      // must never be drawn as "not yours".
      isMine: ownerIsMine,
    },
    // Phase 11: status pills. Tone NAMES only — the theme owns the colours.
    //   tone(kind, value)  → "positive" | "caution" | "negative" | "neutral" | "info"
    //   pill(kind, value)  → { kind, slug, label, tone } | null
    status: {
      TONES,
      tone: statusTone,
      pill: statusPill,
      label: statusLabel,
      kindOf: statusKindOf,
      dealState: dealStateSlug,
    },
    // Phase 11: tech-stack labelling and competitor detection, on their own so a
    // renderer can label a single value without building a whole stack.
    tech: {
      stack: techStackView,
      gtm: gtmTechView,
      label: techLabel,
      slug: enumSlug,
      isCompetitor: isCompetitorTech,
    },
    activity: {
      TABS: ACTIVITY_TABS,
      tabs: activityTabs,
      filter: filterActivity,
      resolveTab: resolveActivityTab,
      // v0.9.0 fetch hardening
      topIds: topActivityIds,
      nextAfter: assocNextAfter,
      batchIds: v4BatchIds,
      failure: activityFailure,
      failureText: activityFailureText,
    },
    // Formatting (shared with the panel; unit-tested)
    format: {
      currency: formatCurrency,
      currencyCompact: formatCurrencyCompact,
      credits: formatCredits,
      date: formatDate,
      dateTime: formatDateTime,
      number: formatNumber,
      relativeTime,
      duration: formatDuration,
      stripHtml,
      htmlToText,
      humanizeEnum,
      truncate,
      safeUrl,
      linkedInUrl,
      firstText,
      delimitedList,
      splitDelimited,
      slug: enumSlug,
      techLabel,
      toMillis,
      recordUrl,
    },
  };
})();
