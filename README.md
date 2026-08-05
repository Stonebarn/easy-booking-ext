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
                       ┌─────────────┴──────────────┐
                background.js                 sidepanel.js
                       │                            │
              toolbar badge (green ✓)      side panel (live, storage.onChanged)
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
4. **`sidepanel.html` / `sidepanel.js`** are the **side panel** (Chrome 114+),
   opened by clicking the toolbar icon. It shows the currently captured email and
   timezone (with a friendly `IST · UTC+5:30` line and the prospect's local
   time), how long ago the capture happened, and a manual "Fill now" button as a
   fallback. Unlike the old popup it stays open while you move between tabs and
   **updates live** as prospects change in the dialer.

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
- Click the icon to open the **side panel**, which shows the captured details
  (email, timezone, capture age) and a manual **Fill now** button. The panel
  stays open as you switch tabs and refreshes itself the moment a new prospect
  loads in the dialer — no need to close and re-open it. Drag its inner edge to
  resize. Requires **Chrome 114+**.
- The extension **never overwrites** a value a rep has already typed.

<!-- BEGIN notes-sync (Phase 4) -->

### Syncing call notes to HubSpot

Dialer Helper Pro can push the notes you take during a call straight onto the
matched HubSpot **contact and company** timelines, attributed to you.

1. Take your notes in the dialer as usual — either in the **Add note** dialog
   (the panel picks up your draft **as you type**, so you don't have to save it
   first) or by saving notes on the Prospect / Account tabs.
2. Open the side panel. The **Notes** section shows the draft in an editable box
   with a character count; already-saved notes appear read-only underneath, under
   "Saved notes in the dialer".
3. Trim or add anything you want — editing here never changes the note in the
   dialer, and your edits are kept even if the dialer draft changes underneath
   you (the panel tells you when that happens).
4. Click **Sync to HubSpot**.

The button only lights up when all three of these are true; when it doesn't, the
line underneath says exactly what's missing:

- you're **connected to HubSpot**,
- there's **note text**, and
- the prospect is **matched** to a HubSpot contact and/or company record.

Result states:

- **"Note added to contact + company ✓"** with an **Open in HubSpot** link (new
  tab). If only one record matched, the note goes on that one and the message
  says so.
- **"Already synced ✓"** — the exact same text was already synced for this
  prospect. The button becomes **Sync again** and needs a second, confirming
  click before it will add a duplicate.
- Errors are spelled out in place: rate limited (with how long to wait), sign-in
  expired, missing HubSpot permissions (naming the scope), or a temporary
  failure. Your note text is never lost on a failure — just click again.

Notes are tied to the prospect they were taken for: loading a different prospect
in the dialer clears the section rather than re-attributing your notes.

<!-- END notes-sync (Phase 4) -->

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

**`sidepanel.js`:**

| Constant | Purpose | Default |
|---|---|---|
| `MAX_AGE_MS` | Age at which a capture is shown as stale (keep in sync with `background.js` / `content-scheduler.js`) | `30 * 60 * 1000` (30 min) |
| `TICK_MS` | How often the "captured Nm ago" line is refreshed | `30 * 1000` (30 s) |
| `NOTICE_MS` | How long a transient status message ("Fill triggered.") replaces the age line | `4000` |

<!-- BEGIN notes-sync config (Phase 4) -->

**`content-nooks.js` → `NOTES_CONFIG`** (notes capture → `chrome.storage.local`
key `eb:notes`):

| Key | Purpose | Default |
|---|---|---|
| `CARD_TESTID` | `data-testid` of the dialer's notes card (primary anchor) | `"notes-prospect-view-card"` |
| `DIALOG_SELECTOR` | How the "Add note" dialog is found (it has no testid) | `'[role="dialog"]'` |
| `TEXTAREA_PLACEHOLDER` | Exact placeholder of the note editor | `"Enter your note here..."` |
| `TEXTAREA_PLACEHOLDER_PREFIX` | Case-insensitive prefix used if the wording drifts | `"enter your note"` |
| `TEXTAREA_ANY_FALLBACK` | Accept the dialog's only `<textarea>` even if the placeholder changed entirely | `true` |
| `TAB_LABELS` | The note scopes, in tab order (map 1:1 to HubSpot contact/company notes) | `["Prospect", "Account"]` |
| `DEFAULT_TAB` | Assumed scope when the active tab can't be determined | `"prospect"` |
| `EXCLUDE_TEXTS` | Card chrome to ignore when reading saved notes (exact leaf matches) | `Notes`, `Add note`, `No notes`, tab labels |
| `DEBOUNCE_MS` | Debounce for note rescans — longer than the prospect scan's `300`, because this also runs while the rep types | `600` |
| `MAX_CHARS` | Cap on note text carried in storage | `20000` |
| `CLEAR_DRAFT_ON_CLOSE` | Drop the draft when the dialog closes. Off by default: after Save the dialog unmounts and the rep still needs that text to sync it. A prospect change clears it either way | `false` |

**`hubspot-notes.js` → `CONFIG`** (note creation):

| Key | Purpose | Default |
|---|---|---|
| `PORTAL_ID` | Wiza's HubSpot portal, used only to build record links | `"40063500"` |
| `ASSOC_TYPE_ID_CONTACT` | `HUBSPOT_DEFINED` association type for note → contact | `202` |
| `ASSOC_TYPE_ID_COMPANY` | `HUBSPOT_DEFINED` association type for note → company | `190` |
| `MAX_BODY_CHARS` | HubSpot's ceiling for `hs_note_body`, enforced on the rendered HTML | `65536` |

Note text is scraped, untrusted input: it is HTML-escaped before newlines become
`<br>`, and it only ever reaches the panel's DOM through `.value`/`.textContent`
— never `innerHTML`.

<!-- END notes-sync config (Phase 4) -->

---

## Project structure

```
easy-booking-ext/
├── manifest.json          # MV3 config: hosts, content scripts, action, side panel, icons
├── background.js          # service worker: toolbar badge + side-panel-on-click
├── content-nooks.js       # captures prospect email + timezone → chrome.storage
├── content-scheduler.js   # fills email, selects timezone, shows on-page panel
├── sidepanel.html         # side panel UI (captured prospect + manual fill)
├── sidepanel.js           # side panel logic: live storage subscription, "Fill now"
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
| "No prospect captured yet" in the side panel | The dialer has no prospect loaded, or the card layout changed — check the `Email` label still exists. |
| Clicking the toolbar icon does nothing | The side panel needs **Chrome 114+**. Also reload the extension on `chrome://extensions` — the click-to-open behavior is set on install/startup. |
| Wrong email captured | Add the unwanted address to `IGNORE_SUBSTRINGS` in `content-nooks.js`. |
| Timezone not captured | The dialer's "Time Zone" label/format changed — check `TZ_FIELD_RE` / `TIMEZONE_LABELS`. The side panel shows what was captured. |
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
- **`sidePanel`** — renders the extension's own UI in Chrome's side panel
  (clicking the toolbar icon opens it). No page content is read through it.
- **Host permissions** are limited to `*.nooks.in` and `scheduler.default.com`.
- The captured email is overwritten as prospects change and is only ever read
  back into the booking form.

<!-- BEGIN notes-sync privacy (Phase 4) -->
- **Notes sync sends data off-device.** This supersedes the "nothing is sent to
  any external server" line above (written before any HubSpot integration
  existed): when you click **Sync to HubSpot**, the note text you see in the
  panel is sent to `api.hubapi.com` and written to the matched contact and
  company records, attributed to your HubSpot user. Nothing is sent until you
  click. Notes captured from the dialer are otherwise held in
  `chrome.storage.local` (key `eb:notes`) and are cleared/replaced when the
  prospect changes.
<!-- END notes-sync privacy (Phase 4) -->

