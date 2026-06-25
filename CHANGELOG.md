# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
