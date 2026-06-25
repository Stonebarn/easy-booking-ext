# Easy Booking — Nooks → Scheduler Autofill

A Chrome extension (Manifest V3) for the sales team. It captures the **current
prospect's email and timezone** from the [Nooks](https://nooks.in) dialer and
**auto-fills** them into the booking form on `scheduler.default.com` — filling
the email field and selecting the timezone in the scheduling dropdown — so reps
never have to retype an address or hunt for a timezone mid-call. It works on
both public booking links and the internal queue/member pages
(e.g. `/21470/queue/10664`).

> **Internal tool.** Built for the Wiza sales team. See [LICENSE](./LICENSE).

---

## Contents

- [How it works](#how-it-works)
- [Install (unpacked)](#install-unpacked)
- [Usage](#usage)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [How the selectors were derived](#how-the-selectors-were-derived)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Privacy & permissions](#privacy--permissions)

---

## How it works

Two content scripts share data through `chrome.storage.local` (the dialer and
booking site live in separate tabs); the service worker drives the toolbar badge:

```
┌──────────────────────────────┐        ┌───────────────────────────────┐
│  Nooks dialer (app.nooks.in)  │        │  scheduler.default.com         │
│                               │        │  (booking form)                │
│  content-nooks.js             │        │  content-scheduler.js          │
│   • reads the prospect's      │        │   • fills the email input      │
│     Email + Time Zone         │        │   • selects the timezone       │
│   • writes to storage ────────┼───┐    │   • shows the on-page panel    │
└───────────────────────────────┘   │    └───▲────────────────────────────┘
                                     │        │
                              chrome.storage.local
                              key: "eb:currentProspect"
                                     │
                              background.js ──→ toolbar badge (green ✓)
```

1. **`content-nooks.js`** (runs on `*.nooks.in`) watches the dialer's React DOM
   for the prospect contact card. It locates the email by anchoring on the
   literal **"Email" field label** — not on CSS classes, which Nooks generates
   per-build and are unstable. It also reads the **"Time Zone"** field (rendered
   as an abbreviation + the prospect's local time, e.g. `EDT (12:04 PM)`,
   `IST (9:34 PM)`), storing the **abbreviation** and the prospect's current
   **UTC offset** (derived from that clock). Both are stored with a timestamp.
2. **`content-scheduler.js`** (runs on `scheduler.default.com`) waits for the
   booking form to render, then:
   - **fills the email input.** The input is found by placeholder/label (it
     differs between the public form, `name@company.com`, and the internal queue
     form, `john.smith@wiza.com`). Its value is set via the native setter plus
     dispatched `input`/`change` events — otherwise React ignores the change.
   - **selects the timezone** in the react-select dropdown. It reads Default's
     full ~88-zone list live from the control's React props, resolves the
     prospect's zone from the **abbreviation disambiguated by offset** (neither
     is unique alone — `CST` is US Central, China, Cuba and Mexico City), then
     types the resolved IANA value and clicks the option (e.g.
     `IST (+5:30)` → "India, Sri Lanka Time", `EDT (-4)` → "Eastern Time - US &
     Canada").
   - **shows an on-page panel** above the form (in a Shadow DOM) previewing the
     pulled email + timezone, with per-field status that flips to "Filled ✓" /
     "Set ✓" as each is applied — so reps can see at a glance it's connected.
3. **`background.js`** puts a green ✓ **badge** on the toolbar icon while a fresh
   prospect is captured, and clears it once the capture goes stale.
4. **`popup.html` / `popup.js`** show the currently captured email and timezone
   (with a friendly `IST · UTC+5:30` line and the prospect's local time), and
   offer a manual "Fill now" button as a fallback.

---

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Open the Nooks dialer (with a prospect loaded) in one tab, and a
   `scheduler.default.com` booking link in another tab
5. **Reload both tabs** so the content scripts inject

---

## Usage

- With both tabs open, the booking form's **Email** field populates and the
  **timezone** is selected automatically from the prospect shown in the dialer.
- A **panel above the booking form** previews the pulled email + timezone and
  shows per-field status ("Filled ✓" / "Set ✓") so you know it's connected.
- The **toolbar icon** shows a green ✓ while a fresh prospect is captured.
- Click the icon to see the captured details (email, timezone, age) or to
  trigger a manual **Fill now**.
- The extension **never overwrites** a value a rep has already typed.

---

## Configuration

Most behavior is tunable at the top of each content script.

**`content-nooks.js` → `CONFIG`:**

| Key | Purpose | Default |
|---|---|---|
| `FIELD_LABELS` | Card labels whose value is the prospect email | `["Email"]` |
| `TIMEZONE_LABELS` | Card labels whose value is the prospect timezone | `["Timezone", "Time Zone", "Local Time", ...]` |
| `FIELD_MAX_LEVELS_UP` | How far to climb from a label to its row container | `3` |
| `PRECISE_SELECTORS` | Optional exact CSS selectors (highest priority) | `[]` |
| `IGNORE_SUBSTRINGS` | Emails to never treat as a prospect | nooks/no-reply/support |
| `DEBOUNCE_MS` | Debounce for DOM-change rescans | `300` |

`TZ_FIELD_RE` parses the field as `ABBR (h:mm AM/PM)`; the abbreviation and the
UTC offset derived from that clock are stored and resolved on the scheduler side.

**`content-scheduler.js`:**

| Constant | Purpose | Default |
|---|---|---|
| `EMAIL_SELECTORS` | Ordered list of email-input selectors (incl. `placeholder*="@"`) | placeholder-first |
| `ABBR_HINTS` | Maps a timezone abbreviation → Default zone value(s); multi-value entries are disambiguated by offset | covers all of Default's zones |
| `PRIORITY` | Tie-break order when two zones share an offset | US-first |
| `FALLBACK_ZONES` | Backup of Default's option list if the live read fails | snapshot of 88 zones |
| `MAX_AGE_MS` | Ignore captures older than this | `30 * 60 * 1000` (30 min) |

---

## Project structure

```
easy-booking-ext/
├── manifest.json          # MV3 config: hosts, content scripts, action, icons
├── background.js          # service worker: toolbar badge for fresh captures
├── content-nooks.js       # captures prospect email + timezone → chrome.storage
├── content-scheduler.js   # fills email, selects timezone, shows on-page panel
├── popup.html             # toolbar popup UI (captured prospect + manual fill)
├── popup.js               # popup logic + manual "Fill now"
├── icons/                 # ext_icon.png (toolbar + store icon)
├── scripts/
│   └── validate.mjs       # validates manifest + referenced files (used by CI)
└── README.md
```

---

## How the selectors were derived

Both pages are client-rendered, so selectors were verified against the **live
DOM**, not the static HTML snapshots:

- **Nooks email** lives in a MUI contact card as label→value rows
  (`Email` → `prospect@company.com`). The MUI/emotion class names
  (`css-14w7q5o`, …) change per build, so the script anchors on the `Email`
  label text and climbs to the row container.
- **Booking email input** is a `<input type="text">` with no `id`/`name`. Its
  placeholder differs by page — `name@company.com` on public links,
  `john.smith@wiza.com` on internal queue pages — so it is matched by
  `placeholder*="@"` (with an "email"-label fallback). It is **not**
  `type="email"`.
- **Timezone control** is a `react-select` combobox whose options are grouped
  and friendly-labeled ("Eastern Time - US & Canada"), but whose filter matches
  the underlying **IANA value**, and whose full option list (88 zones, with
  values) is readable from the component's React props. The script types the
  resolved IANA zone to narrow the list to one option and clicks it. Verified
  live: typing `America/New_York` yields exactly "Eastern Time - US & Canada".
  Note Default uses some **legacy IANA values** (`Asia/Calcutta`, not
  `Asia/Kolkata`), which is why resolution targets Default's own value list. The
  email field is a plain chakra `<input>`, so the two never collide.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Field doesn't fill | Reload both tabs after loading/updating the extension. |
| "No prospect email captured" in popup | The dialer has no prospect loaded, or the card layout changed — check the `Email` label still exists. |
| Wrong email captured | Add the unwanted address to `IGNORE_SUBSTRINGS` in `content-nooks.js`. |
| Timezone not captured | The dialer's "Time Zone" label/format changed — check `TZ_FIELD_RE` / `TIMEZONE_LABELS`. The popup shows what was captured. |
| Wrong timezone selected | A shared abbreviation resolved to the wrong region — adjust `ABBR_HINTS` / `PRIORITY` in `content-scheduler.js`. Console logs the chosen zone. |
| Timezone shows a raw name like `Asia/Calcutta` | That's correct — it's Default's own value for that zone (= IST / India; the dropdown labels it "India, Sri Lanka Time"). Default just displays the selected value using its IANA name. |
| Panel or badge not showing | Reload the tab after updating the extension; both appear only for a fresh (<30 min) capture. |
| Stale email | Captures older than 30 min are skipped; re-open the prospect in the dialer. |
| Extension doesn't run on booking page | Confirm the URL matches `https://scheduler.default.com/*` in `manifest.json`. |

Open the page's DevTools console and look for `[EasyBooking]` debug logs.

---

## Development

There is no build step — it's plain JS/HTML loaded unpacked.

```bash
# Validate the manifest and that all referenced files exist
node scripts/validate.mjs
```

After editing a content script, click the **reload** icon for the extension on
`chrome://extensions`, then reload the affected tab.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions and the PR checklist.

---

## Privacy & permissions

- **`storage`** — caches the most recently seen prospect email locally so the
  booking tab can read it. Nothing is sent to any external server by this
  extension.
- **`alarms`** — used only to clear the toolbar badge when a capture goes stale.
- **Host permissions** are limited to `*.nooks.in` and `scheduler.default.com`.
- The captured email is overwritten as prospects change and is only ever read
  back into the booking form.
