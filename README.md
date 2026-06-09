# Easy Booking — Nooks → Scheduler Autofill

A Chrome extension (Manifest V3) for the sales team. It captures the **current
prospect's email** from the [Nooks](https://nooks.in) dialer and **auto-fills**
it into the email field of the booking form on `scheduler.default.com`, so reps
never have to retype an address mid-call.

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

The extension runs as two content scripts that share data through
`chrome.storage.local` (the dialer and booking site live in separate tabs):

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Nooks dialer                │         │  scheduler.default.com        │
│  (app.nooks.in)              │         │  (booking form)               │
│                              │         │                               │
│  content-nooks.js            │         │  content-scheduler.js         │
│   • watches the contact card │         │   • waits for the email input │
│   • reads the "Email" field  │         │   • auto-fills it (React-safe)│
│   • writes to storage ───────┼────┐    │   ▲                           │
└──────────────────────────────┘    │    └───┼───────────────────────────┘
                                     │        │
                              chrome.storage.local
                              key: "eb:currentProspect"
```

1. **`content-nooks.js`** (runs on `*.nooks.in`) watches the dialer's React DOM
   for the prospect contact card. It locates the email by anchoring on the
   literal **"Email" field label** — not on CSS classes, which Nooks generates
   per-build and are unstable. The detected email is stored with a timestamp.
2. **`content-scheduler.js`** (runs on `scheduler.default.com`) waits for the
   booking form's email input to render, then fills it. The field is a
   React-controlled input, so the value is set via the native setter plus
   dispatched `input`/`change` events — otherwise React ignores the change.
3. **`popup.html` / `popup.js`** show the currently captured email and offer a
   manual "Fill now" button as a fallback.

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

- With both tabs open, the booking form's **Email** field populates
  automatically from the prospect currently shown in the dialer.
- Click the extension icon to see the captured email and its age, or to trigger
  a manual **Fill now**.
- The extension **never overwrites** an email a rep has already typed.

---

## Configuration

Most behavior is tunable at the top of each content script.

**`content-nooks.js` → `CONFIG`:**

| Key | Purpose | Default |
|---|---|---|
| `FIELD_LABELS` | Card labels whose value is the prospect email | `["Email"]` |
| `FIELD_MAX_LEVELS_UP` | How far to climb from a label to its row container | `3` |
| `PRECISE_SELECTORS` | Optional exact CSS selectors (highest priority) | `[]` |
| `IGNORE_SUBSTRINGS` | Emails to never treat as a prospect | nooks/no-reply/support |
| `DEBOUNCE_MS` | Debounce for DOM-change rescans | `300` |

**`content-scheduler.js`:**

| Constant | Purpose | Default |
|---|---|---|
| `EMAIL_SELECTORS` | Ordered list of email-input selectors | placeholder-first |
| `MAX_AGE_MS` | Ignore captures older than this | `30 * 60 * 1000` (30 min) |

---

## Project structure

```
easy-booking-ext/
├── manifest.json          # MV3 config: hosts, content scripts, action, icons
├── background.js          # minimal service worker (lifecycle/logging)
├── content-nooks.js       # captures the prospect email → chrome.storage
├── content-scheduler.js   # auto-fills the booking form email input
├── popup.html             # toolbar popup UI
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
- **Booking email input** is `<input type="text" placeholder="name@company.com">`
  — notably **not** `type="email"`, and it has no `id`/`name`. The placeholder
  is the dependable anchor. A separate `react-select` combobox on the page is
  deliberately not matched.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Field doesn't fill | Reload both tabs after loading/updating the extension. |
| "No prospect email captured" in popup | The dialer has no prospect loaded, or the card layout changed — check the `Email` label still exists. |
| Wrong email captured | Add the unwanted address to `IGNORE_SUBSTRINGS` in `content-nooks.js`. |
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
- **Host permissions** are limited to `*.nooks.in` and `scheduler.default.com`.
- The captured email is overwritten as prospects change and is only ever read
  back into the booking form.
