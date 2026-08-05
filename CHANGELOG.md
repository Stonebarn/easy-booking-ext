# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-05

The side-panel release: the popup is gone, the panel is the product, and it now
talks to HubSpot with each rep's own login. **Network egress and OAuth tokens are
new in this version** — see [Privacy &
permissions](./README.md#privacy--permissions).

### Added — settings popover

- **A gear in the panel header** opens a small anchored popover (`role="dialog"`)
  holding the two controls that aren't per-prospect context: **Refresh CRM data**
  and the whole **HubSpot connection** UI (Connect / *Connected as {email}* /
  Disconnect, plus the connection's error line). It closes on Escape or a click
  outside, keeps focus inside while open (Tab wraps, disabled and hidden controls
  are skipped), hands focus back to the gear on close, and fits the panel's 320px
  floor in both themes.
- **Connection state is now a header dot** — green connected, amber not, with the
  detail (including *"connected as …"*) in its tooltip.
- Signed-out CRM sections keep their *"Connect HubSpot to see CRM data"* empty
  state and gain an inline **Connect** link that opens the popover, so the action
  the copy names is one click away.

### Added — notes sync

- **Notes capture** (`content-nooks.js`, new `NOTES_CONFIG` + `eb:notes` key):
  reads both the **live draft** in the dialer's "Add note" dialog — via `input`
  events on the `<textarea>`, because typing changes `.value` and never produces
  a DOM mutation an observer could see — and the **saved notes** rendered in the
  notes card, per Prospect/Account tab (which map 1:1 onto HubSpot
  contact-/company-level notes). Anchored on the card's `data-testid` with
  label-text fallbacks; the saved-note reader is deliberately structure-agnostic
  because the populated list DOM is still unverified, and returns `null` rather
  than guessing. Stored under its **own** key (`eb:notes`) — never inside
  `eb:currentProspect`, which would reset the booking tab's fill state on every
  keystroke — with the prospect email from the same scan, so a prospect change
  clears the notes instead of re-attributing them.
- **`hubspot-notes.js`** (new, `EB.hubspotNotes`): creates note engagements via
  `POST /crm/v3/objects/notes` through `EB.hubspotAuth.apiFetch`, with
  `hs_timestamp`, `hubspot_owner_id` (the SDR) and `HUBSPOT_DEFINED`
  associations to the contact (`202`) and company (`190`) — each included only
  when its record ID is known. Note text is HTML-escaped before newlines become
  `<br>`, and the 65,536-char `hs_note_body` ceiling is enforced on the rendered
  HTML before the request is made. Failures arrive as typed errors
  (`MISSING_SCOPES` — surfacing HubSpot's own scope names, `RATE_LIMITED` with
  `Retry-After`, `AUTH`, `TRANSIENT`, `API`).
- **Side panel Notes section** (replaces the Notes placeholder): editable
  textarea pre-filled from the captured draft, character count, read-only view of
  saved notes, and a **Sync to HubSpot** button that is enabled only when signed
  in, with note text, and with a matched contact or company — otherwise it names
  exactly what's missing. Live via `storage.onChanged` on `eb:notes` and
  `eb:prospectContext`; degrades to "prospect not matched yet" when the context
  key is absent. A rep's edits are never clobbered by an incoming capture.
- **Idempotent syncing**: a hash of (note text + prospect email) is stored under
  `eb:notes:lastSynced`; re-syncing identical text shows "Already synced ✓" and
  requires an explicit confirming second click. Success shows which records were
  written plus an "Open in HubSpot" link.

### Added
- **Wiza product data in the side panel** — a new **Wiza** section answers "do
  they already use us?" without leaving the dialer. **User** (from the contact):
  an Active/Closed status pill, sign-up date, plan status · credits · frequency,
  credits used in the last 30 days, last usage, Wiza ID, and **Open in Wiza
  Admin** / **Usage logs** links when the record carries them. **Account** (from
  the company): account ID, subscribed accounts, API credit balance, credits used
  in 30 days, last credit purchase, ICP, industry, use case and a **Target
  account** badge.
  - Built for absence, since most prospects have never signed up: no user data
    reads *"Not a Wiza user yet"*, and individual empty properties are dropped
    rather than rendered as blank rows. Dates are humanized and numbers get
    thousands separators.
  - URL properties are only turned into links after a scheme check, so a
    property containing `javascript:` can never become a clickable link.
- **Activity deep-dive** — the flat top-10 list is now a tabbed view: **All ·
  Calls · Emails · Meetings · Notes · Tasks**, each tab labelled with its count,
  holding up to **25 rows per type** (was 10 across all types). Tabs with nothing
  logged are dimmed and inert; the list scrolls inside a fixed ceiling (~40% of
  the panel, min 200px) so the section footprint stays small; **All** merges every
  type newest-first; the chosen tab persists as you move between prospects. Tabs
  are proper `tablist`/`tab` semantics with arrow/Home/End keyboard support.
  - **Every row is attributed** — "by Jenny Choi" — resolved through the session
    owner cache from `hubspot_owner_id`, falling back to `hs_created_by` (looked
    up by user ID) for engagements logged without an owner. An unresolvable
    owner renders with no attribution; a raw ID is never shown.
  - Richer per-type detail: direction arrow + disposition + duration as `mm:ss`
    on calls, direction + subject on emails, title + outcome on meetings, the
    first ~120 characters of the body on notes, subject + status on tasks. Every
    row shows a relative timestamp with the exact date on hover.
- **Live HubSpot CRM context in the side panel** — the Contact, Company, Deals
  and Recent activity placeholders are now real. Loading a prospect in the dialer
  resolves them in HubSpot and renders: contact name (linked to the record) with
  a lifecycle-stage pill, lead status, title, phone and owner; company name
  (linked), domain, industry, employee count and owner; one row per deal with a
  human-readable stage, formatted amount and close date; and the 10 most recent
  calls, emails, meetings, notes and tasks merged newest-first with relative
  timestamps and direction arrows. Each section has its own loading placeholder
  and its own error state, and a **Refresh** button in the panel header busts the
  cache for the current prospect.
  - HubSpot property values are rendered with `textContent` only — never
    `innerHTML`. Note bodies (which are stored as HTML) are regex-stripped for a
    one-line summary rather than parsed into live nodes.
- **`content-nooks.js` now also captures prospect context** — name, title,
  company, phone and, most importantly, the **HubSpot contact and company record
  IDs** that the dialer's own HubSpot panes render. Anchored on the
  `data-testid` attributes documented in `docs/nooks-dom-recon.md` (primary) with
  label text as the fallback, per the no-generated-CSS-classes convention.
  - This goes in a **new storage key, `eb:prospectContext`**, with its own
    change-signature dedupe. `eb:currentProspect` is untouched — same fields,
    same write cadence — because `content-scheduler.js` resets its fill state and
    un-dismisses its banner on any write to that key, and the record IDs
    typically arrive a second *after* the email as the dialer's HubSpot panes
    hydrate.
  - New config knobs: `TESTID_ANCHORS`, `CONTEXT_LABELS`,
    `HEADER_MAX_LEVELS_UP`, `RECORD_ID_MIN_DIGITS`.
- **`hubspot-data.js`** — the CRM read layer (`EB.hubspotData`), built around the
  portal's *shared* rate limits: CRM Search allows **5 req/s for the whole
  portal** across all ~8 reps, separate from the general 110 req/10s pool.
  - Resolution waterfall: a scraped record ID means a direct `GET` and **no
    search at all**; without one, a single contact search (email `EQ`, plus a
    filter group on `hs_additional_emails CONTAINS_TOKEN`). Company: scraped ID →
    the contact's first associated company → company search by email domain
    (skipped for free-mail domains). A scraped ID that 404s falls back to search
    rather than reporting "not found".
  - Deals come from the contact's associations via one `batch/read`; the deal
    pipeline/stage label map is fetched **once per session** so stages render as
    words. Activity is v4 association reads in parallel, then a `batch/read` per
    type that actually has associations — types with none cost no batch call.
  - Caching is load-bearing, not an optimization: 5-minute per-email bundle
    cache, in-flight dedup so five rapid prospect switches make one round trip,
    and session caches for owner names and pipeline labels. Partially failed
    bundles are not cached, so a failed section retries on the next render.
  - Errors are typed — `NOT_FOUND`, `RATE_LIMITED` (carrying `Retry-After`),
    `AUTH`, `TRANSIENT` — so the panel renders four distinct states instead of
    one generic failure. On a 429 it counts the wait down in the UI and retries
    once, rather than hammering a limit the whole team shares.
- README: a **CRM sidebar** subsection under Usage, config tables for the new
  `content-nooks.js` knobs and for `hubspot-data.js`, `hubspot-data.js` in the
  project structure, seven new troubleshooting rows, and an updated data-flow
  diagram showing both storage keys.
- **Side panel** (`sidepanel.html` / `sidepanel.js`): clicking the toolbar icon
  now opens Chrome's side panel instead of a popup. It carries over everything
  the popup showed — captured email, timezone (`IST · UTC+5:30` plus the
  prospect's local time), capture age with staleness coloring, and the manual
  "Fill now" button — and adds behavior a popup could not have: it stays open
  while you move between the dialer and booking tabs, **subscribes to
  `chrome.storage.onChanged`** so a newly loaded prospect appears without any
  interaction, and ticks every 30s so the "captured Nm ago" line stays honest.
  The layout is fluid (works down to Chrome's ~320px floor) and follows the OS
  light/dark preference.
- A placeholder Notes section in the panel for the sync work still to land.
  (The Contact, Company, Deals and Recent activity placeholders added alongside
  it are live as of the CRM-context entry above.)
- **Per-SDR HubSpot connection** (`hubspot-config.js` / `hubspot-auth.js` + the
  panel's HubSpot section): each rep connects their own HubSpot login via
  `chrome.identity.launchWebAuthFlow`, so future notes and activity are
  attributed to them (`hubspot_owner_id`) rather than to a shared account. The
  panel shows *Not connected → Connecting… → Connected as {email}* with a
  Disconnect link, and surfaces failures inline.
  - **No client secret in the extension** (SOC 2 secrets management): the two
    OAuth operations that need it — authorization-code exchange and refresh —
    run in a hosted Lovable Cloud edge function
    (`lovable/hubspot-token-function.ts`), which reads the secret from Lovable's
    secret store and is locked to this extension's origin. The function also
    performs the identity introspection, so the extension never sees the secret
    or HubSpot's token endpoints. All other CRM traffic still goes extension →
    `api.hubapi.com` directly. No host permission is needed for the function's
    domain — its CORS headers name this extension's origin.
  - Refresh token in `chrome.storage.local` (survives restarts), access token in
    `chrome.storage.session`, refreshed on demand 5 min before expiry behind a
    single-flight guard, plus one refresh-and-retry on a 401.
  - Failure handling distinguishes a **dead refresh token** (4xx that HubSpot
    itself produced → clear auth, show "Connect" again) from a **transient
    problem** (network, 5xx, or the function refusing the request → keep
    credentials, so a blip never forces an SDR to re-consent).
  - The owner-ID lookup runs *after* the refresh token is persisted, so a
    failure there can no longer strand a rep who is connected in HubSpot but
    signed out here.
  - `hubspot-config.js` ships with the real client ID (a public identifier) and
    the deployed token-service URL, so there is nothing for a rep to configure —
    load unpacked and click Connect. If either value is ever blanked the panel
    degrades to a **Setup needed** state rather than failing mid-OAuth.
- `manifest.json`: `sidePanel` permission, `side_panel.default_path`,
  `minimum_chrome_version: "114"` (the side panel API's floor), the `identity`
  permission, and `https://api.hubapi.com/*` host permission.
- `scripts/validate.mjs`: validates `side_panel.default_path` exists, that the
  `sidePanel` and `identity` permissions are present, that
  `minimum_chrome_version` is set, that the toolbar `action` still has an icon,
  and — new in this release — that **every `<script src>` in `sidepanel.html`
  resolves to a file that exists** and that none of them is remote. The manifest
  never mentions the panel's scripts, so before this a renamed
  `hubspot-data.js` broke the panel with nothing but a console error to show for
  it.
- **Rollout section in the README**: load-unpacked steps for reps, the
  first-connect walkthrough, and the offboarding note (removing a rep from the
  HubSpot portal, or revoking their Connected App entry, kills their tokens — the
  extension holds no shared credential).

### Changed
- **Error copy across the panel is now consistent and rep-facing**: every failure
  path says what happened and what to do next, and no error code, HTTP status,
  source filename, config key or HubSpot error body reaches the UI any more —
  those go to `console.debug` under the `[EasyBooking]` prefix. Recovery
  instructions point at **Settings**, where Connect and Refresh now live (they
  used to say "above" and "click Refresh", both of which stopped being true when
  the connection UI moved into the popover). Missing-scope *names* are the one
  detail still surfaced, because they're what a fix needs.
- **The Contact and Company sections are now one compact identity block**: name
  (linked) with a lifecycle-stage pill, then title *@* company (linked), then
  owner · phone · lead status — with the company's domain, industry and headcount
  moved to the link's hover text. Three dense lines instead of two cards; the
  vertical space goes to the Wiza and Activity sections.
- `hubspot-data.js` now versions its per-prospect cache (`CACHE_VERSION`), so a
  bundle cached before an upgrade can't be rendered by code expecting the new
  fields. `ACTIVITY_LIMIT` (10, merged) is replaced by `ACTIVITY_PER_TYPE_LIMIT`
  (25, per type). Call durations render as `4:07` rather than `4m 7s`.
- `background.js`: sets `sidePanel.setPanelBehavior({ openPanelOnActionClick:
  true })` on install and startup so the toolbar icon opens the panel. Badge and
  alarm behavior is unchanged.
- CI (`.github/workflows/validate.yml`): the JS syntax check now globs
  git-tracked `*.js`/`*.mjs` instead of a hard-coded file list, so new scripts
  can't slip through unchecked.
- **README rewritten around the network egress this release adds.** *Privacy &
  permissions* is now the whole story rather than a patched version of the old
  one: the two destinations (`api.hubapi.com` with the rep's own OAuth token, and
  the Lovable Cloud token endpoint, which sees only auth codes and refresh
  tokens), what each receives, where the tokens live
  (`chrome.storage.local`/`session`), that the client secret exists only in
  Lovable's secret store, the offboarding path, and every permission with a
  one-line justification. The architecture diagram now shows the panel, HubSpot
  and the notes flow, and stale claims ("nothing is sent to any external server",
  the captured email being "only ever read back into the booking form", the notes
  sync being "still to land") are gone rather than superseded by a later note.

### Removed
- **`popup.html` / `popup.js`** and `action.default_popup` — replaced by the
  side panel. (A manifest popup would suppress `openPanelOnActionClick`.) The
  `action` entry itself remains, with its title and icon.
- **The HubSpot section in the panel body**, and the standalone **Refresh** button
  in the header — both now live in the settings popover. Nothing was dropped; the
  panel body is CRM context and notes only.

## [0.2.0] - 2026-06-25

### Added
- `content-nooks.js`: also captures the prospect's **timezone** from the
  dialer's "Time Zone" field (e.g. `EDT (12:04 PM)`, `IST (9:34 PM)`), storing
  the abbreviation and the prospect's current UTC offset (derived from their
  local clock) alongside the email.
- `content-scheduler.js`: **auto-selects the timezone** in the booking form's
  react-select dropdown. It reads Default's full ~88-zone list live from the
  control's React props and resolves the prospect's zone from the abbreviation
  **disambiguated by offset** (neither is unique on its own — `CST` is US
  Central, China, Cuba and Mexico City), covering every zone Default offers.
  Then it types the resolved IANA value and clicks the option.
- **On-page panel**: `content-scheduler.js` injects a slim banner above the
  booking form (Shadow DOM, so the app can't distort or remove it) previewing
  the data pulled from Nooks — email and timezone — with per-field status that
  flips to "Filled ✓" / "Set ✓" as each is applied, plus capture age and a
  dismiss button. Lets reps see at a glance that it's connected.
- **Toolbar badge**: `background.js` shows a green ✓ on the extension icon while
  a fresh prospect is captured and clears it once the capture goes stale
  (uses the `alarms` permission).
- **Popup redesign**: per-field "Captured" status, a friendly timezone line
  (`IST · UTC+5:30` + the prospect's local time), staleness coloring, and
  branding consistent with the on-page panel.

### Changed
- `content-scheduler.js`: email-field detection is now placeholder/label-aware
  (`input[placeholder*="@"]` plus an "email"-label fallback) so it works on the
  internal queue/member pages (e.g. `/21470/queue/10664`), whose email field
  uses a different placeholder (`john.smith@wiza.com`) than the public booking
  link (`name@company.com`).

## [0.1.0] - 2026-06-09

### Added
- Initial release.
- `content-nooks.js`: captures the current prospect's email from the Nooks
  dialer by anchoring on the "Email" contact-card label, with mailto and
  visible-text fallbacks; stores it in `chrome.storage.local`.
- `content-scheduler.js`: auto-fills the booking form email input on
  `scheduler.default.com` using a React-safe value setter; skips stale
  (>30 min) captures and never overwrites a value the rep already typed.
- `popup.html` / `popup.js`: shows the captured email and a manual "Fill now".
- `background.js`: minimal MV3 service worker.
- `scripts/validate.mjs`: manifest + referenced-file validator (used by CI).

[Unreleased]: https://github.com/jackfoley-wiza/easy-booking-ext/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jackfoley-wiza/easy-booking-ext/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jackfoley-wiza/easy-booking-ext/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jackfoley-wiza/easy-booking-ext/releases/tag/v0.1.0
