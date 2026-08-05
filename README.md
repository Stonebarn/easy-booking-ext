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
│   • reads identity + HubSpot  │        │   • shows the on-page panel    │
│     record IDs                │        │                                │
│   • writes to storage ────────┼───┐    └───▲────────────────────────────┘
└───────────────────────────────┘   │        │
                                     │        │
                              chrome.storage.local
                    keys: "eb:currentProspect"   (email + timezone)
                          "eb:prospectContext"   (identity + HubSpot IDs)
                                     │
                       ┌─────────────┴──────────────┐
                background.js                 sidepanel.js
                       │                            │
              toolbar badge (green ✓)      side panel (live, storage.onChanged)
                                                    │
                                            hubspot-data.js
                                                    │
                                      api.hubapi.com (identity, Wiza,
                                       deals, activity — cached 5 min)
```

The two storage keys are deliberately separate: `content-scheduler.js` resets its
fill state and re-shows its on-page banner on **any** write to
`eb:currentProspect`, so the CRM-facing data (which updates again a moment later,
when the dialer's HubSpot panes finish loading) lives under its own key.

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
   **updates live** as prospects change in the dialer. It also renders the live
   CRM context — see [CRM sidebar](#crm-sidebar).
5. **`hubspot-data.js`** does the CRM reads for the panel: it resolves the
   prospect to a HubSpot contact and company (including the Wiza product
   properties on both), then loads deals and up to 25 engagements per type, each
   attributed to the rep who logged it. Resolution prefers the **record IDs scraped from the dialer's
   HubSpot panes** (a direct `GET` by ID) and only falls back to CRM Search —
   which is capped at **5 requests/second for the entire portal**, shared by
   every rep — when there is no ID to use. Results are cached per email for 5
   minutes, concurrent lookups for the same prospect share one request, and a
   `429` is surfaced as a countdown rather than a retry storm.

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

### HubSpot connection

The side panel's **HubSpot** section connects your own HubSpot login, so notes
and activity are attributed to you rather than to a shared service account.

1. Open the side panel → **HubSpot** → **Connect HubSpot**.
2. A HubSpot window opens; approve the requested permissions for the Wiza
   portal. (Your HubSpot user needs permission for those scopes, or the install
   fails at the consent screen.)
3. The section flips to **Connected** and shows your HubSpot email. Use
   **Disconnect** to remove the stored tokens.

Each rep connects once. The connection survives browser restarts — the access
token is refreshed automatically in the background as it expires. Once connected,
the panel starts filling in the CRM sections below; the Notes sync is the one
piece still to land.

**There is nothing to configure.** `hubspot-config.js` already carries the app's
client ID and the deployed token-service URL, so loading the extension unpacked
and clicking **Connect HubSpot** is the whole setup.

**No client secret goes anywhere near this repo.** The HubSpot client secret is
stored only in Lovable Cloud's secret store (as `HUBSPOT_CLIENT_SECRET`), where
the token-exchange function reads it — see
[`lovable/hubspot-token-function.ts`](./lovable/hubspot-token-function.ts). The
client ID that *is* checked in is a public identifier, not a credential.

### CRM sidebar

With HubSpot connected, loading a prospect in the dialer fills four sections in
the side panel — who they are, whether they use Wiza, their deals, and every
call/email/meeting/note/task on the record. Everything is read-only, and every
record name links out to HubSpot (opens in a new tab).

| Section | What it shows |
|---|---|
| **Contact & company** | One compact identity block, three lines: the contact's name (linked to the record) with a lifecycle-stage pill; their job title *@* their company (also linked); then owner, phone and lead status. Hover the company name for its domain, industry and headcount. The company is matched from the record ID on the dialer's account pane, else the contact's associated company, else the email domain. If the prospect isn't in HubSpot: *"No HubSpot contact for {email}"*; a company matched with no contact record says *"No contact record"*. |
| **Wiza** | Whether this prospect is a Wiza user, and what their account looks like. **User**: an Active/Closed status pill, sign-up date, plan (status · credits · frequency), credits used in the last 30 days, when they last used Wiza, their Wiza ID, and **Open in Wiza Admin** / **Usage logs** links when the record has them. **Account** (from the company): account ID, subscribed accounts, API credit balance, credits used in 30 days, last credit purchase, ICP, industry, use case, and a **Target account** badge. Most prospects aren't users — those read *"Not a Wiza user yet"*, and any single value that isn't set is left out rather than shown blank. |
| **Deals** | One row per associated deal — name (linked), human-readable stage, amount, close date, owner. Open deals sort first; closed-won gets a green pill. Empty: *"No open deals"*. |
| **Activity** | A tab per engagement type — **All · Calls · Emails · Meetings · Notes · Tasks** — each with its count, and up to 25 rows per type. Types with nothing logged are dimmed and not clickable. Every row is attributed to whoever logged it ("by Jenny Choi") and carries a relative timestamp with the exact date on hover, plus per-type detail: direction arrow, disposition and duration (`4:07`) on calls; direction and subject on emails; title and outcome on meetings; the first line of the body on notes; subject and status on tasks. **All** merges every type newest-first. The list scrolls inside a fixed height (about 40% of the panel) so the section stays small no matter how much history there is; your chosen tab sticks as you move between prospects. |

- Sections show **loading placeholders** while a lookup is in flight, and each
  one reports its own failure — a rate-limited Deals fetch doesn't blank the
  Contact card that already loaded.
- **Refresh** (top-right of the panel header) discards the cached data for the
  current prospect and refetches. Otherwise a prospect's data is cached for 5
  minutes, so switching back and forth is instant and costs no API calls.
- If HubSpot's rate limit is hit, the section shows *"HubSpot rate limit —
  retrying in Xs"* and retries itself once the wait is over. The limit is shared
  by the whole team, so the panel waits it out rather than retrying immediately.
- Not connected → *"Connect HubSpot to see CRM data"*. No prospect loaded → a
  muted empty state.

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
| `TESTID_ANCHORS` | `data-testid` of each card the context scraper reads — prospect name, prospect fields, account fields, and the two HubSpot panes. **Primary** anchor strategy (see [the recon notes](./docs/nooks-dom-recon.md)); the label arrays are the fallback | 5 entries |
| `CONTEXT_LABELS` | Label text used to pick a value row out of one of those cards: `RECORD_ID`, `TITLE`, `COMPANY`, `PHONE` | `["Record ID", …]`, … |
| `HEADER_MAX_LEVELS_UP` | How far to climb from the prospect-name element looking for the header's `Company • Title` line and phone | `4` |
| `RECORD_ID_MIN_DIGITS` | Minimum digit run to accept as a HubSpot record ID (keeps employee counts and grades out) | `5` |

`TZ_FIELD_RE` parses the field as `ABBR (h:mm AM/PM)`; the abbreviation and the
UTC offset derived from that clock are stored and resolved on the scheduler side.

The context scraper writes a **separate** storage key (`eb:prospectContext`) and
dedupes on its own signature, so the record IDs appearing a second after the
email does not disturb the booking tab.

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
| `CRM_DEBOUNCE_MS` | Coalesces the burst of `eb:prospectContext` writes a prospect change produces into one CRM fetch | `500` |

**`hubspot-data.js` → `EB.hubspotData.CONFIG`:**

| Key | Purpose | Default |
|---|---|---|
| `CACHE_TTL_MS` | How long a resolved prospect bundle is reused before refetching (**Refresh** ignores it) | `5 * 60 * 1000` (5 min) |
| `ACTIVITY_PER_TYPE_LIMIT` | Rows kept **per engagement type** (newest first) — what one Activity tab can hold | `25` |
| `BATCH_MAX` | Objects per `batch/read` and IDs per association read (HubSpot's own ceiling) | `100` |
| `RETRY_AFTER_FALLBACK_S` | Wait used when a `429` carries no usable `Retry-After` header | `10` |
| `CACHE_VERSION` | Namespaces the per-prospect cache; bump it whenever the bundle's shape changes so older cached data can't be rendered by newer code | `6` |
| `NOTE_PREVIEW_CHARS` | Characters of a note body kept for its one-line activity row | `120` |
| `CONTACT_PROPERTIES` | Contact properties requested | firstname, lastname, email, jobtitle, phone, lifecyclestage, hs_lead_status, hubspot_owner_id, notes_last_updated, **wiza_status, wiza_id, signed_up_at, plan_status, plan_credits, plan_frequency, number_of_credits_used_in_last_30_days, date_of_last_wiza_usage, wiza_admin_url, wiza_usage_logs, wiza_email_confirmed** |
| `COMPANY_PROPERTIES` | Company properties requested | name, domain, industry, numberofemployees, hubspot_owner_id, **api_wiza_account_id, primary_account_id_associated_wiza, number_of_associated_accounts, number_of_associated_subscribed_accounts, api_credit_balance, number_of_credits_used_in_last_30_days, last_api_credit_purchase, times_api_credits_purchased, account_icp, industry_wiza, hs_is_target_account, use_case** |
| `DEAL_PROPERTIES` | Deal properties requested | dealname, dealstage, pipeline, amount, closedate, hubspot_owner_id |
| `ACTIVITY_TYPES` | The five engagement types, their display + tab labels and per-type properties (every type also asks for `hubspot_owner_id` and `hs_created_by`, which is how rows get attributed) | calls, emails, meetings, notes, tasks |
| `FREE_EMAIL_DOMAINS` | Domains the company-by-domain fallback refuses to search on (a `gmail.com` search matches something irrelevant) | gmail, outlook, yahoo, … |
| `CURRENCY` / `LOCALE` | Currency and locale used to format deal amounts and dates | `USD` / `en-US` |

**`hubspot-config.js` → `EB.hubspotConfig`:**

| Key | Purpose | Default |
|---|---|---|
| `CLIENT_ID` | HubSpot app client ID (public identifier, not a secret) | `8d295d37-…-1565ed99025f` |
| `TOKEN_PROXY_URL` | Deployed Lovable Cloud token-exchange function | `https://wiza-hs-connect.lovable.app/api/public/hubspot-token` |
| `REDIRECT_URL` | Must exactly match a redirect URL registered on the Auth tab **and** the function's own `REDIRECT_URL` | `https://<ext-id>.chromiumapp.org/hubspot` |
| `SCOPES` | Scopes requested at install; must include every scope marked *required* on the app (including `oauth`) | `oauth` + contacts/companies read-write, deals read, owners read |
| `AUTHORIZE_URL` | HubSpot's consent endpoint (browser-side; no secret involved) | `https://app.hubspot.com/oauth/authorize` |
| `API_BASE` | CRM API host; must stay covered by `host_permissions` | `https://api.hubapi.com` |
| `PORTAL_ID` | Wiza portal, for record deep links | `40063500` |

> **There is no client secret in this repo.** It lives only in Lovable Cloud's
> secret store, and only the hosted token function reads it — which is why
> `TOKEN_URL` and `INTROSPECT_URL` are absent above: the extension never calls
> HubSpot's token endpoints.

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
├── content-nooks.js       # captures prospect email + timezone, identity + HubSpot record IDs
├── content-scheduler.js   # fills email, selects timezone, shows on-page panel
├── sidepanel.html         # side panel UI (captured prospect, HubSpot, CRM sections)
├── sidepanel.js           # side panel logic: live storage subscription, "Fill now", CRM rendering
├── hubspot-config.js      # HubSpot OAuth app config (client id, scopes — no secret)
├── hubspot-auth.js        # per-SDR HubSpot OAuth: login/logout/token refresh
├── hubspot-data.js        # CRM reads: contact/company resolution, Wiza data, deals, activity, caching
├── lovable/
│   └── hubspot-token-function.ts  # hosted token exchange (holds the secret; deployed to Lovable Cloud)
├── docs/
│   ├── PLAN-v3-hubspot-sidebar.md # the v3 plan and its settled decisions
│   └── nooks-dom-recon.md         # live-DOM anchors the scrapers are built on
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
| CRM sections say "Connect HubSpot to see CRM data" | You're signed out — use **Connect HubSpot** in the panel's HubSpot section. |
| "No HubSpot contact for …" for a prospect you know exists | The address in the dialer isn't the one on the HubSpot record (and isn't in `hs_additional_emails` either). Check the contact in HubSpot, or look for a duplicate record. |
| CRM data looks out of date | Click **Refresh** in the panel header — data is cached for 5 minutes per prospect. |
| "HubSpot rate limit — retrying in Xs" | Expected under heavy parallel dialing: HubSpot's search limit is 5 req/s for the whole portal. It retries itself. If it's constant, the dialer's HubSpot panes probably aren't rendering the Record ID rows, so every lookup is falling back to search — check `TESTID_ANCHORS` / `CONTEXT_LABELS.RECORD_ID`. |
| Deal stages show as raw IDs like `appointmentscheduled` | The one-off `GET /crm/v3/pipelines/deals` call failed (usually a missing `crm.objects.deals.read` scope). Reconnect HubSpot; the console logs the failure. |
| Identity block shows a name but no company | No company association on the contact, and the email domain didn't match a company's `domain` property (free-mail domains are deliberately not searched). |
| Wiza section says "Not a Wiza user yet" for someone you know signed up | The Wiza properties live on the HubSpot record — if the sync hasn't written `wiza_status` / `signed_up_at` / `wiza_id` to this contact, the panel has nothing to show. Check the contact in HubSpot first. |
| An activity row has no "by …" attribution | The engagement has no owner, or its owner/creator no longer exists in the portal (a deactivated user). The panel would rather show nothing than a raw ID. |
| An Activity tab is dimmed | That type has nothing logged for this prospect. |

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
  booking tab can read it, plus your HubSpot tokens (see below).
- **`alarms`** — used only to clear the toolbar badge when a capture goes stale.
- **`sidePanel`** — renders the extension's own UI in Chrome's side panel
  (clicking the toolbar icon opens it). No page content is read through it.
- **`identity`** — opens the HubSpot consent window when you click **Connect
  HubSpot**, and nothing else.
- **Host permissions** are limited to `*.nooks.in`, `scheduler.default.com` and
  `api.hubapi.com`.
- **What leaves your browser, and where it goes.** Two destinations, both only
  once you connect:
  - the **Lovable Cloud token function** (`TOKEN_PROXY_URL`) receives your
    OAuth authorization code, and later your refresh token, and returns access
    tokens plus your HubSpot email/ID. It exists so the client secret never
    ships in the extension (SOC 2 secrets management); it is locked to this
    extension's origin and stores nothing.
  - **`api.hubapi.com`** receives your access token on CRM reads. Those reads
    are **read-only** and send the prospect's email address (or, when the dialer
    supplies it, their HubSpot record ID) so HubSpot can return the matching
    contact, company, Wiza properties, deals and activity. Nothing is written, and nothing
    about a prospect is sent anywhere other than HubSpot — the portal that
    already holds their record.

  The captured prospect email is not transmitted anywhere else: for the booking
  flow it only moves from the dialer tab to the booking tab through local
  storage.
- **CRM data is cached in the panel's memory only** (5 minutes, or until you
  click Refresh or close the panel). It is never written to disk.
- Your HubSpot **refresh token** lives in `chrome.storage.local` and the
  short-lived access token in `chrome.storage.session` (discarded when Chrome
  closes). **Disconnect** deletes both.
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

