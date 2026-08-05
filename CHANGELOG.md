# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

<!-- BEGIN notes-sync (Phase 4) -->

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

<!-- END notes-sync (Phase 4) -->

### Added
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
- Placeholder sections in the panel for the v3 work still to land — HubSpot
  connect, Contact, Company, Deals, Recent activity, Notes. Structure only; no
  HubSpot code, credentials or network requests exist yet.
- `manifest.json`: `sidePanel` permission, `side_panel.default_path`, and
  `minimum_chrome_version: "114"` (the side panel API's floor).
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
