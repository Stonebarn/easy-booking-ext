# Dialer Helper Pro — dialer → scheduler autofill + HubSpot sidebar

A Chrome extension (Manifest V3) for the sales team. It does two things:

- **Autofill.** It captures the **current prospect's email and timezone** from
  the dialer and fills them into the booking form on `scheduler.default.com` —
  filling the email field and selecting the timezone in the scheduling dropdown —
  so reps never have to retype an address or hunt for a timezone mid-call. Works
  on both public booking links and the internal queue/member pages
  (e.g. `/21470/queue/10664`).
- **A HubSpot sidebar.** A Chrome side panel that, once a rep connects **their
  own** HubSpot login, shows the prospect's HubSpot context (identity, Wiza
  product data, deals, every logged call/email/meeting/note/task) and syncs the
  call notes they take in the dialer onto the matched contact and company.

> **Network egress.** Once a rep connects HubSpot, the extension talks to
> `api.hubapi.com` and to a hosted token endpoint. Read
> [Privacy & permissions](#privacy--permissions) before rolling it out.

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
- [Rollout](#rollout)
- [Privacy & permissions](#privacy--permissions)

---

## How it works

Nothing messages anything directly. Two content scripts write to
`chrome.storage.local`; the side panel, the service worker and the booking tab all
read from it and react to `storage.onChanged`. Only the side panel talks to the
network, and only after a rep connects HubSpot:

```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│ dialer (*.nooks.in)              │      │ scheduler.default.com            │
│ content-nooks.js                 │      │ content-scheduler.js             │
│  • email + timezone              │      │  • fills the email input         │
│  • identity + HubSpot record IDs │      │  • selects the timezone          │
│  • call notes (draft + saved)    │      │  • on-page preview panel         │
└───────────────┬──────────────────┘      └──────────────▲───────────────────┘
                │                                        │
                │           chrome.storage.local         │
                └──►  eb:currentProspect  ───────────────┘
                      eb:prospectContext      eb:notes
                      eb:hs:auth              eb:notes:lastSynced
                                   │
        ┌──────────────────────────┴───────────────────────┐
   background.js                                sidepanel.html / .js
   toolbar badge (green ✓)                      side panel, live via
                                                storage.onChanged
                                                          │
          ┌───────────────────────────────┬───────────────┴────────────┐
   hubspot-auth.js                 hubspot-data.js              hubspot-notes.js
   per-SDR OAuth,                  CRM reads,                   "Sync to HubSpot":
   token refresh                   5-minute cache               one note on the
          │                                │                    contact + company
          │                                └──────────┬─────────────────┘
   wiza-hs-connect.lovable.app                        │
   (auth code / refresh token  →  access token;   api.hubapi.com
    the client secret lives only here)           (reads, and the note POST)
```

The storage keys are deliberately separate. `content-scheduler.js` resets its fill
state and re-shows its on-page banner on **any** write to `eb:currentProspect`, so
the CRM-facing data (which updates again a moment later, once the dialer's HubSpot
panes finish loading) and the notes (which update as the rep types) live under
their own keys.

1. **`content-nooks.js`** (runs on `*.nooks.in`) watches the dialer's React DOM
   for the prospect contact card. It locates the email by anchoring on the
   literal **"Email" field label** — not on CSS classes, which the dialer
   generates per-build and are unstable. It also reads the **"Time Zone"** field
   (rendered as an abbreviation + the prospect's local time, e.g.
   `EDT (12:04 PM)`, `IST (9:34 PM)`), storing the **abbreviation** and the
   prospect's current **UTC offset** (derived from that clock). Both are stored
   with a timestamp. The same script also captures the prospect's identity, the
   **HubSpot record IDs** the dialer's own CRM panes render, and the **call
   notes** — each under its own storage key.
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
   CRM context — see [CRM sidebar](#crm-sidebar) — and the
   [notes sync](#syncing-call-notes-to-hubspot). The **gear** in its header opens
   the [Settings popover](#settings-refresh-and-your-hubspot-connection): Refresh,
   and your HubSpot connection.
5. **`hubspot-auth.js`** owns the per-rep HubSpot connection: the consent round
   trip, the stored tokens, and refreshing the access token on demand. The two
   OAuth steps that need the app's client secret happen in a hosted endpoint, not
   here — see [Privacy & permissions](#privacy--permissions).
6. **`hubspot-data.js`** does the CRM reads for the panel: it resolves the
   prospect to a HubSpot contact and company (including the Wiza product
   properties on both), then loads deals and up to 25 engagements per type, each
   attributed to the rep who logged it. Resolution prefers the **record IDs scraped from the dialer's
   HubSpot panes** (a direct `GET` by ID) and only falls back to CRM Search —
   which is capped at **5 requests/second for the entire portal**, shared by
   every rep — when there is no ID to use. Results are cached per email for 5
   minutes, concurrent lookups for the same prospect share one request, and a
   `429` is surfaced as a countdown rather than a retry storm.
7. **`hubspot-notes.js`** creates the note when a rep clicks **Sync to HubSpot**:
   one `POST /crm/v3/objects/notes` associated to the matched contact and company,
   stamped with the rep's own `hubspot_owner_id`. It is the only write this
   extension makes, and only on that click.

---

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder
4. Open the dialer (with a prospect loaded) in one tab, and a
   `scheduler.default.com` booking link in another tab
5. **Reload both tabs** so the content scripts inject

For rolling this out to the team, see [Rollout](#rollout).

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

### Settings: Refresh and your HubSpot connection

Everything that isn't per-prospect context lives behind the **gear** in the panel
header:

- **Refresh CRM data** — discards this prospect's cached HubSpot data and
  refetches. (Otherwise it's cached for 5 minutes.) Clicking it closes the
  popover so you're looking at the sections it just reloaded.
- **Notes** — **Auto-sync saved notes to HubSpot** (on by default). See
  [auto-sync on save](#auto-sync-on-save).
- **HubSpot** — **Connect HubSpot**, or, once connected, your HubSpot email and a
  **Disconnect** link. Connection problems are reported here.

The popover closes on **Escape** or a click anywhere outside it, and while it's
open **Tab** cycles inside it.

Next to the gear is a small **connection dot**: **green** when HubSpot is
connected, **amber** when it isn't. Hover it for the detail ("HubSpot connected as
you@wiza.com"). Signed-out CRM sections also carry a **Connect** link straight to
the popover.

#### Connecting HubSpot

You connect **your own** HubSpot login, so notes and activity are attributed to
you rather than to a shared service account.

1. Open the side panel → **gear** → **Connect HubSpot**.
2. A HubSpot window opens; approve the requested permissions for the Wiza portal.
   (Your HubSpot user needs permission for those scopes, or the install fails at
   the consent screen.)
3. The popover flips to **Connected** and shows your HubSpot email; the header dot
   turns green. Use **Disconnect** to remove the stored tokens.

Each rep connects once. The connection survives browser restarts — the access
token is refreshed automatically as it expires. Once connected, the CRM sections
and the notes sync start working.

**There is nothing to configure.** `hubspot-config.js` already carries the app's
client ID and the deployed token-endpoint URL, so loading the extension unpacked
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
- **Refresh CRM data** (in the **gear** popover) discards the cached data for the
  current prospect and refetches. Otherwise a prospect's data is cached for 5
  minutes, so switching back and forth is instant and costs no API calls.
- If HubSpot's rate limit is hit, the section shows *"HubSpot rate limit —
  retrying in Xs"* and retries itself once the wait is over. The limit is shared
  by the whole team, so the panel waits it out rather than retrying immediately.
- Not connected → *"Connect HubSpot to see CRM data"* with a **Connect** link into
  the gear popover. No prospect loaded → a muted empty state.
- Failures are always phrased as what to do next ("connect again in Settings",
  "use Refresh in Settings"). Error codes and HTTP statuses go to the console, not
  to the panel — if you're debugging, open DevTools and filter for
  `[EasyBooking]`.

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
4. Click **Sync to HubSpot** — or let **auto-sync** do it (see below).

Every note is attributed to **you**: the HubSpot account you connected shows up
as the note's *Activity assigned to*, so a rep's notes read as their own work.

#### Auto-sync on save

By default, **saving a note in the dialer syncs it to HubSpot for you** — no
click needed. The Notes section then shows a passive line: *"Auto-synced to
contact + company just now ✓"* with an **Open in HubSpot** link, and the pill
reads **Auto-synced ✓**.

What it will and won't do:

- It only ever syncs a note you actually **saved**. A draft you're still typing
  is never sent on its own — that's what the button is for. (Clicking **Cancel**
  in the note dialog is not a save, and never triggers anything.)
- **One save, one sync.** The same note can't land twice: a save that follows a
  manual sync of the same text is recognised and skipped, and so is a repeated
  signal from the dialer.
- It won't sync a note for a prospect you've since moved off, a prospect with no
  matched HubSpot record, or when HubSpot isn't connected. In each case the
  **Sync to HubSpot** button is still there with the reason underneath.
- If an auto-sync fails, it says so (*"Couldn't auto-sync that note…"*) and hands
  you back the button with your note text intact. It never retries by itself and
  never drops a note silently.
- A note saved while the panel was closed syncs when you next open the panel, as
  long as it's recent (within 30 minutes).

**Turning it off:** **gear → Notes → "Auto-sync saved notes to HubSpot"**. The
setting is per rep, remembered across restarts (`eb:settings` in
`chrome.storage.local`), and with it off the behavior is exactly the manual flow
described above.

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
| `AUTO_MAX_AGE_MS` | How old a saved note may be and still auto-sync when the panel opens (older ones wait for the button) | `30 * 60 * 1000` (30 min) |

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
| `SAVE_BUTTON_TEXTS` | Labels that count as the note dialog's **Save** control. A click on one of these is half of a save detection (the other half is the note appearing in the saved list) | `Save`, `Save note`, … |
| `CANCEL_BUTTON_TEXTS` | Labels that positively **cancel** a pending save. Cancel never produces a save signal | `Cancel`, `Close`, `Discard`, `Delete` |
| `SAVE_CONFIRM_WINDOW_MS` | How long a clicked Save waits to be confirmed by the saved list before it is dropped (Save shows a progressbar while it persists) | `20000` |
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

---

## Project structure

```
easy-booking-ext/
├── manifest.json          # MV3 config: hosts, content scripts, action, side panel, icons
├── background.js          # service worker: toolbar badge + side-panel-on-click
├── content-nooks.js       # captures prospect email + timezone, identity + HubSpot record IDs, call notes
├── content-scheduler.js   # fills email, selects timezone, shows on-page panel
├── sidepanel.html         # side panel UI (prospect, settings popover, CRM sections, notes)
├── sidepanel.js           # side panel logic: live storage subscription, "Fill now", settings popover, CRM rendering, notes sync
├── hubspot-config.js      # HubSpot OAuth app config (client id, scopes — no secret)
├── hubspot-auth.js        # per-SDR HubSpot OAuth: login/logout/token refresh
├── hubspot-data.js        # CRM reads: contact/company resolution, Wiza data, deals, activity, caching
├── hubspot-notes.js       # note creation: POST /crm/v3/objects/notes + contact/company associations
├── lovable/
│   └── hubspot-token-function.ts  # hosted token exchange (holds the secret; deployed to Lovable Cloud)
├── docs/
│   ├── PLAN-v3-hubspot-sidebar.md # the v3 plan and its settled decisions
│   └── nooks-dom-recon.md         # live-DOM anchors the scrapers are built on
├── icons/                 # ext_icon.png (toolbar + store icon)
├── scripts/
│   └── validate.mjs       # validates the manifest, its referenced files, and the panel's <script src> list (used by CI)
└── README.md
```

The panel's scripts load in dependency order — config, auth, data, notes, then the
panel itself — as plain `<script src>` tags with **no `import`/`export`**: CI
syntax-checks `.js` with `node --check`, which parses them as CommonJS. Shared ES
modules, if any are ever added, go in `.mjs` files. `scripts/validate.mjs` checks
that every script `sidepanel.html` references still exists.

---

## How the selectors were derived

Both pages are client-rendered, so selectors were verified against the **live
DOM**, not the static HTML snapshots:

- **The dialer's email field** lives in a MUI contact card as label→value rows
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
| CRM sections say "Connect HubSpot to see CRM data" | You're signed out — click **Connect** in that empty state, or the **gear** → **Connect HubSpot**. |
| The header dot is amber | HubSpot isn't connected (hover it for the detail). Open the **gear** and connect. |
| "HubSpot isn't set up in this build" | `hubspot-config.js` is missing its client ID or token-endpoint URL — the checked-in file has both, so this means a modified/partial copy. Reload the extension from a clean checkout. |
| "No HubSpot contact for …" for a prospect you know exists | The address in the dialer isn't the one on the HubSpot record (and isn't in `hs_additional_emails` either). Check the contact in HubSpot, or look for a duplicate record. |
| CRM data looks out of date | **Gear** → **Refresh CRM data** — data is cached for 5 minutes per prospect. |
| A panel section is blank and the console shows a script 404 | A panel script was renamed without updating `sidepanel.html`. Run `node scripts/validate.mjs`, which checks every `<script src>` the panel loads. |
| "HubSpot rate limit — retrying in Xs" | Expected under heavy parallel dialing: HubSpot's search limit is 5 req/s for the whole portal. It retries itself. If it's constant, the dialer's HubSpot panes probably aren't rendering the Record ID rows, so every lookup is falling back to search — check `TESTID_ANCHORS` / `CONTEXT_LABELS.RECORD_ID`. |
| Deal stages show as raw IDs like `appointmentscheduled` | The one-off `GET /crm/v3/pipelines/deals` call failed (usually a missing `crm.objects.deals.read` scope). Reconnect HubSpot; the console logs the failure. |
| Identity block shows a name but no company | No company association on the contact, and the email domain didn't match a company's `domain` property (free-mail domains are deliberately not searched). |
| Wiza section says "Not a Wiza user yet" for someone you know signed up | The Wiza properties live on the HubSpot record — if the sync hasn't written `wiza_status` / `signed_up_at` / `wiza_id` to this contact, the panel has nothing to show. Check the contact in HubSpot first. |
| An activity row has no "by …" attribution | The engagement has no owner, or its owner/creator no longer exists in the portal (a deactivated user). The panel would rather show nothing than a raw ID. |
| An Activity tab is dimmed | That type has nothing logged for this prospect. |
| Activity says "No activity found" | Exactly what it says — nothing is logged on that contact in HubSpot. It is not an error state, and it never means your sign-in is broken. |
| "Can't read activity — your HubSpot permissions don't cover it." | HubSpot refused the read (403). The app's permissions are fixed and there is nothing for a rep to change — tell the team. The console logs the failing engagement type and its status. |
| A synced note shows "No owner" / "Activity assigned to: No owner" in HubSpot | The owner lookup hadn't succeeded when that note was created. It now resolves itself on the next sync with no reconnect needed — notes created from then on are attributed. Older notes can be re-assigned in HubSpot. |
| A synced note shows "Created by user ID: No user" | Expected. HubSpot sets that field itself and leaves it empty for app writes; *Activity created by* is the one the extension fills. |
| A note you saved in the dialer didn't auto-sync | Check the toggle (**gear → Notes**), that HubSpot is connected, and that the prospect matched a HubSpot record — the Notes section names whichever is missing. Drafts never auto-sync, and neither does a note you saved more than 30 minutes before opening the panel. Use **Sync to HubSpot**. |

Open the page's DevTools console and look for `[EasyBooking]` debug logs. The panel
deliberately shows plain-English errors with the next step to take; the code,
status and HubSpot's own error text are in those logs. For the side panel, open
DevTools on the panel itself (right-click inside it → **Inspect**).

---

## Development

There is no build step — it's plain JS/HTML loaded unpacked.

```bash
# Validate the manifest, everything it references, and the panel's script tags
node scripts/validate.mjs

# Same syntax check CI runs (node --check parses .js as CommonJS: no import/export)
for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done
```

After editing a content script, click the **reload** icon for the extension on
`chrome://extensions`, then reload the affected tab. After editing the panel,
close and re-open the panel.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions and the PR checklist.

---

## Rollout

**Installing it (each rep, once):**

1. Get the extension folder (clone the repo, or unzip the folder that was shared
   with you) and put it somewhere permanent — Chrome loads it from that path every
   time it starts, so don't leave it in Downloads.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked**, and select the folder.
3. Pin **Dialer Helper Pro** to the toolbar so the panel is one click away.
4. Reload any dialer or `scheduler.default.com` tabs you already had open.

**First connect (each rep, once):**

1. Click the toolbar icon — the side panel opens on the right.
2. Click the **gear** (top right of the panel) → **Connect HubSpot**.
3. Approve the permissions in the HubSpot window for the **Wiza** portal. You need
   a HubSpot seat with access to contacts, companies and deals; if consent fails,
   that's what to check first.
4. The popover shows **Connected** with your HubSpot email and the header dot turns
   green. Load a prospect in the dialer and the CRM sections fill in.

The connection is per rep and survives browser restarts. Notes you sync are
attributed to *you* (your `hubspot_owner_id`), which is the whole reason the
connection is per rep rather than a shared service account.

**Updating:** replace the folder's contents, then hit **reload** on the extension
in `chrome://extensions`. The stored HubSpot connection survives an update.

**Offboarding.** Removing someone from the HubSpot portal — or deleting the
extension's entry under *HubSpot → Settings → Integrations → Connected Apps* for
their user — revokes their tokens immediately, and every CRM call the extension can
make dies with them. There is no shared credential to rotate and no server-side
session to expire: the extension holds only that rep's own refresh token, on their
own machine. Uninstalling the extension (or clicking **Disconnect**) deletes it
locally as well. Nothing else needs to happen for access to end.

---

## Privacy & permissions

### What leaves the machine

There are exactly **two** network destinations, and both are silent until a rep
clicks **Connect HubSpot**. Before that, the extension makes no network requests at
all.

| Destination | What it receives | What it returns |
|---|---|---|
| **`api.hubapi.com`** (HubSpot's CRM API) | The rep's **own** OAuth access token, and what's needed to identify the record: the prospect's email address, or their HubSpot record ID when the dialer supplied one. On a notes sync, the note text the rep sees in the panel. | The matching contact, company (incl. the Wiza product properties), deals and engagements — and, for a sync, the created note's ID. |
| **`wiza-hs-connect.lovable.app`** (the token endpoint, source in [`lovable/hubspot-token-function.ts`](./lovable/hubspot-token-function.ts)) | **Only OAuth material**: the one-time authorization code at connect time, and the rep's refresh token when an access token needs renewing (about every 30 minutes of use). It never sees a prospect, a note, or anything scraped from a page. | A fresh access token, plus the rep's HubSpot email/user ID/portal ID at connect time. |

**Nothing else leaves the machine.** No analytics, no telemetry, no error
reporting, no third-party scripts (Manifest V3's CSP forbids remote code, and
`scripts/validate.mjs` fails the build if a remote `<script src>` ever appears in
the panel). The captured prospect email travels from the dialer tab to the booking
tab through `chrome.storage.local` and nowhere else. Everything that reaches HubSpot
goes to the portal that already holds that prospect's record.

Reads are read-only. **The only write this extension ever makes** is the note
created when a rep clicks **Sync to HubSpot**, or when a note they *saved in the
dialer* is auto-synced (gear → Notes, on by default) — one note on the matched
contact and company, attributed to that rep.

**Notes are attributed to the connected rep, by design.** Each note carries the
HubSpot **owner ID** and **user ID** of the account that authorised the
connection, so it shows up in HubSpot as that rep's activity (*Activity assigned
to* / *Activity created by*) rather than as an anonymous integration write. The
owner ID is looked up once from the rep's own HubSpot email
(`GET /crm/v3/owners/?email=…`) and cached in `eb:hs:auth`; if that lookup ever
fails, the note is still created — just unattributed — and the lookup is retried
the next time. No other user's identity is ever sent.

### Where credentials live

- The rep's **refresh token** is stored in `chrome.storage.local` (so the
  connection survives a browser restart) under `eb:hs:auth`, together with their
  HubSpot email, portal ID and owner ID.
- The **access token** is stored in `chrome.storage.session` — Chrome discards it
  when the browser closes — and is refreshed on demand, ~5 minutes before it
  expires.
- Both are per rep, on that rep's machine, and never sent anywhere except the two
  destinations above. **Disconnect** (gear → Disconnect) deletes both immediately.
- **The HubSpot client secret is not in this repo and not in the extension.** It
  exists only in Lovable Cloud's secret store as `HUBSPOT_CLIENT_SECRET`, read by
  the hosted token function — which is why token exchange and refresh are hosted at
  all (SOC 2 secrets management). The client ID that *is* checked in is a public
  identifier, not a credential.
- CRM data is cached **in the panel's memory only** (5 minutes, or until Refresh,
  or until the panel closes). It is never written to disk. Captured prospect data
  and notes do live in `chrome.storage.local` (`eb:currentProspect`,
  `eb:prospectContext`, `eb:notes`, `eb:notes:lastSynced`) and are overwritten or
  cleared as the prospect changes. `eb:settings` holds the rep's own preferences
  (currently just the notes auto-sync toggle) and contains no prospect data.

### Revoking access (offboarding)

Removing a user from the Wiza HubSpot portal, or deleting this app's entry under
*HubSpot → Settings → Integrations → Connected Apps* for their user, **revokes
their tokens** — their refresh token stops working, and every CRM call the
extension makes on their behalf fails from that point. Their already-issued access
token can keep working for up to its 30-minute lifetime; nothing beyond that.

There is no shared credential to rotate, no server-side session to expire, and no
copy of anyone's data held outside HubSpot and their own browser profile. Removing
them from HubSpot is sufficient; uninstalling the extension also deletes the local
tokens.

### Permissions, and why each one is needed

| Permission | Why it's requested |
|---|---|
| `storage` | The only channel between the dialer tab, the booking tab, the badge and the panel — plus where the rep's HubSpot tokens are kept. |
| `alarms` | One periodic alarm, used only to clear the toolbar badge once a capture goes stale (30 min). |
| `sidePanel` | Renders the extension's own UI in Chrome's side panel; clicking the toolbar icon opens it. No page content is read through it. |
| `identity` | Opens the HubSpot consent window (`chrome.identity.launchWebAuthFlow`) when a rep clicks **Connect HubSpot**, and returns the redirect. Nothing else uses it. |
| `https://*.nooks.in/*` | Where `content-nooks.js` reads the prospect's email, timezone, identity, HubSpot record IDs and call notes. Read-only; nothing is injected into the page. |
| `https://scheduler.default.com/*` | Where `content-scheduler.js` fills the booking form and shows its preview banner. |
| `https://api.hubapi.com/*` | Lets the panel call HubSpot's CRM API directly (a host permission is how an extension bypasses CORS). The token endpoint needs **no** host permission — it answers with CORS headers naming this extension's origin. |

`minimum_chrome_version: "114"` is the side panel API's floor, not a permission.

### Untrusted input

Everything the panel displays is untrusted: prospect data is scraped from a page,
and HubSpot property values (including note bodies, which HubSpot stores as HTML)
are written by people. All of it reaches the DOM only through `textContent` /
`.value` — **never `innerHTML`** — and URL properties become links only after a
scheme check, so a property containing `javascript:` can't become a clickable link.
Note text sent to HubSpot is HTML-escaped before newlines become `<br>`.

