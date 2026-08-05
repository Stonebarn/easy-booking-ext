# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
  `sidePanel` permission accompanies a `side_panel` key, that
  `minimum_chrome_version` is set, and that the toolbar `action` still has an
  icon.

### Changed
- `background.js`: sets `sidePanel.setPanelBehavior({ openPanelOnActionClick:
  true })` on install and startup so the toolbar icon opens the panel. Badge and
  alarm behavior is unchanged.
- CI (`.github/workflows/validate.yml`): the JS syntax check now globs
  git-tracked `*.js`/`*.mjs` instead of a hard-coded file list, so new scripts
  can't slip through unchecked.
- README **Privacy & permissions**: the claim that "nothing is sent to any
  external server" was true until this phase and is not any more. It now names
  both destinations (the token function and `api.hubapi.com`), what each
  receives, that the captured prospect email is still never transmitted, and
  where the tokens are stored.

### Removed
- **`popup.html` / `popup.js`** and `action.default_popup` — replaced by the
  side panel. (A manifest popup would suppress `openPanelOnActionClick`.) The
  `action` entry itself remains, with its title and icon.

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

[Unreleased]: https://github.com/jackfoley-wiza/easy-booking-ext/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jackfoley-wiza/easy-booking-ext/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jackfoley-wiza/easy-booking-ext/releases/tag/v0.1.0
