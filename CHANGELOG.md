# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed — the side panel wears Wiza's colours, and you can pick light or dark

A re-theme, not a redesign: no layout, spacing or section order changed, and the
density pass's heights are untouched (**1,210px at 320px, 1,093px at 580px**, same
to the pixel in both themes).

- **Wiza's palette, from wiza.co.** `#0C3380` primary navy carries links, accent
  text, focus rings and every filled button; `#310C80` violet appears exactly
  once, on the lifecycle pill; `#1A1B25` is body text and `#615E6E` muted text in
  light mode, over white and `#E6E2E3`-family grounds. The panel header is a navy
  bar in both themes. The old lavender `#9371F0` — which appears nowhere in
  Wiza's brand — is gone.
- **Light mode you can choose.** **gear → Appearance → System / Light / Dark**.
  **System** stays the default and follows your computer; Light and Dark pin the
  panel either way. Saved per rep in `eb:settings.theme`, applied to every open
  panel window at once, and applied from `<head>` on load so an explicit choice
  does not flash the other theme first.
- **Contrast is now checked, not eyeballed.** Every text/background pair the panel
  renders meets WCAG AA in both themes (4.5:1 body, 3:1 large text and control
  edges), including three that did not before: the armed **Save** button's label
  on its amber fill (white-on-bright-amber was 1.9:1 in dark mode — the label is
  now dark there), the textarea and phone-editor borders, and the `@` in
  "title @ company" (an `opacity: 0.55` that computed to 2.6:1).
- Native scrollbars, select popups and focus rings now match the panel's theme
  (`color-scheme`), instead of a light scrollbar on a dark panel.
- The header wordmark drops the redundant **"· from dialer"** suffix; the
  connection dots and the gear are unchanged. (The on-page scheduler banner still
  carries the old suffix and its near-black bar — `content-scheduler.js` was out
  of scope for this pass.)

### Changed — density pass on the side panel (no data lost)

Behaviour-preserving layout work: nothing about fetching, auth, sync or scraping
changed, and every value the panel showed before is still readable — on screen or
in a hover title. Measured against a live prospect fixture (13 activities, 4
colleagues, no deals, no Wiza user, a zeroed Wiza account), the panel went from
**2,246px to 1,210px at the 320px floor (−46%)** and **1,898px to 1,093px at
580px (−42%)**. Section order is unchanged.

- **Booking block: ~181px → 44px.** Two lines — the captured email, then
  `BST · UTC+1 · 5:40 AM their time` with a right-aligned, no-longer-full-width
  **Fill form** button. Dropped: both "Captured" pills (the header dot already
  says a prospect is live), the `EMAIL` / `TIMEZONE` ALL-CAPS labels, and the
  standing "captured Nm ago" line, which is now the block's hover title along
  with the full timezone name. A **stale** capture still shows its amber warning
  line, and the Fill result messages are unchanged (that line is now an
  `aria-live` region, so the result is announced).
- **A section with nothing to say renders nothing.** Deals now hides itself when
  there are no deals (was a 55px "No open deals" card), Wiza hides when there is
  no user *and* no surviving account data, and "Others at this account" hides
  when there are no other contacts. Activity keeps **"No activity found"** —
  absence is the answer there — and Notes always renders because it is an input.
  Error states always keep their section visible.
- **Wiza is no longer self-contradictory.** Zero metrics are suppressed
  individually — a `0` credit balance, `0 of 1` subscribed, `0` credits used and
  `0×` purchases told a rep nothing across five labelled cells — and what is
  left folds into one line (*"Not a Wiza user · Account 163547 · Saas tech ·
  Software"*). ~150px → ~30px. The `User` / `Account` sub-labels only appear when
  both halves are on screen. Non-zero metrics are untouched.
- **Activity rows: three lines → two.** Line 1 is the type glyph, the title and
  the relative time pushed to the trailing edge; line 2 is the
  disposition/status/outcome, and only appears when it has something to add. The
  ALL-CAPS type word moved onto the glyph's (and the timestamp's) title.
  **Attribution is run-length suppressed**: the owner shows on the first row and
  then only when it changes, so "Jasper Guilaran" appears three times instead of
  thirteen — and a genuine change of owner is now visible rather than buried.
  Absolute timestamps stay in the hover title.
- **Zero-count activity tabs are gone.** `Emails 0 · Meetings 0 · Notes 0` used
  ~40% of the bar to report three absences. Only tabs with rows render, and if
  only one type has rows the bar is hidden entirely.
- **"Others at this account" states a shared owner once.** When every colleague
  has the same owner the section head reads *"Others at this account (4) · all
  Jasper Guilaran"* and the rows drop it; mixed owners still show per-row. Rows
  read `contacted 4d ago` with the absolute stamp on hover. At panel widths
  ≥500px the list goes two-up instead of costing a second screen.
- **The phone row no longer prints the same number twice.** `phone` and
  `mobilephone` frequently hold identical values; numbers are compared on digits
  only and a repeat renders once, with the fields it sits on in its hover title.
  The **Wrong number?** editor and its field picker are unchanged — it still
  offers all three writable fields and shows what is on each.
- **Ownership collapses by name.** One person usually holds the outbound,
  company and contact owner roles, which was the same name on three lines. Now a
  single `Owner <name>` line whose title lists the roles it covers; genuinely
  different names still get their own labelled line.
- **Running prose is clamped to two lines with a MORE / LESS toggle** (the
  company blurb and the ICP rationale). The *full* text is in the DOM and the
  clamp is CSS, so expanding shows all of it and the collapsed state never ends
  mid-sentence in a hard-truncated "…". The toggle only renders when the text is
  actually being clipped.
- **Account context lost its labelled grid.** Eight `LABEL / value` cells became
  two `·`-joined lines (`Cool down · Strong ICP fit` and `Sales team 8 · AE 3 ·
  Outbound 4 · Leadership 1`), with each label kept as the item's hover title.
  464px → 219px at 320px.
- **Section chrome is shorter** — smaller pill line-height so a pill never makes
  a head taller than its title, 3px from head to card, 8px between sections, a
  12px main gutter (which is also 8px more content width at 320px, worth a line
  on several rows), and tighter card padding.
- **Notes**: the hint line only renders when it has direction to give (no
  prospect matched, nothing captured yet) rather than restating the textarea's
  own placeholder, and the textarea starts at 66px.
- **Explicit `data-theme="dark"` / `data-theme="light"` support** on the root,
  alongside the existing `prefers-color-scheme` rules, so the theme can be forced
  (by a harness, or a future in-panel toggle) and wins over the OS preference.
- Removed the now-unused `.kv` / `.kv-grid` label-above-value styles and their
  `kv()` builder.

### Added — "Others at this account"

- **A new collapsible CRM section listing the other contacts on the prospect's
  company**, placed after Account context. Two SDR asks, one section: *"who else
  has been sequenced from that account"* — visible today only on the full dialer
  tab filtered by account, i.e. never during a live call — and the *"wrong person"*
  pivot, which reps currently handle by opening the company's LinkedIn page and
  reading employee names off it mid-dial.
- Each row: the colleague's **name** (linked to their HubSpot contact record,
  `0-1/{id}`), an **In sequence** badge (hover names the sequence and its start
  date) or a muted **Not sequenced** when the portal says either way — and *no*
  badge when it doesn't say, because "not in a sequence" is a claim; their **job
  title**; **Last contacted 3d ago** with the exact time on hover; the **owner**,
  shown as *"Owner: You"* when it's the connected rep's own contact and as the
  teammate's name otherwise; and a compact **in** link to their LinkedIn profile
  when `hs_linkedin_url` is set. The list scrolls inside a fixed height, like
  Activity, so the panel's footprint doesn't depend on how big the account is.
- Ordering is a pure, unit-tested view-model (`EB.hubspotData.view.accountContacts`):
  **currently in a sequence first**, then **most recently contacted**, then name
  and id purely for determinism. Job-title seniority is deliberately not a sort
  key — it needs a title taxonomy to beat guessing, and a wrong guess about who
  matters at an account is worse than alphabetical. The prospect the rep is already
  looking at is excluded, by record ID *and* by email.
- **Request budget: exactly two added requests per prospect** — one
  `GET /crm/v4/objects/companies/{id}/associations/contacts?limit=25` and one
  `POST /crm/v3/objects/contacts/batch/read`. Both are on the general pool
  (110 req/10s); **no CRM Search call is made**, ever — that pool is 5 req/s for
  the whole portal. Zero requests when the prospect has no company, one when the
  company has no associated contacts. The page size *is* the row cap, so paging
  isn't a code path. The result rides in the existing per-email bundle, so the
  5-minute cache and the in-flight dedup already cover it (`CACHE_VERSION` 8 → 9).
  Owner names come from the same batched, session-cached owner pass the rest of the
  bundle uses, with a new `ACCOUNT_OWNER_LOOKUP_MAX` (10) ceiling on *first-time*
  lookups so an account whose 25 contacts each have a different owner can't turn a
  2-request section into 27.
- Owner IDs are never shown: an ID that can't be resolved to a name renders with no
  owner at all. "Yours vs a teammate's" is decided by comparing IDs against the
  stored connection, which costs no request — and when the connection has no owner
  ID resolved yet, the row makes neither claim.
- States match the rest of the panel: no company → the section is hidden outright;
  no colleagues → *"No other contacts on this account"*; signed out → the shared
  **Connect** prompt; a rate limit → the countdown. A **403 does not claim the
  sign-in expired** (it says the rep's permissions don't cover it), a genuine 401
  does, and an empty result always renders as empty rather than as an error.

### Added — fix a wrong number from the panel (write path)

- **Reps can now correct a contact's phone number in HubSpot from the side
  panel.** The SDR problem this solves: 100+ uncallable numbers per rep, fixed by
  tabbing out to LinkedIn → Wiza → Outreach. HubSpot is the source of truth —
  data flows **HubSpot → Outreach → the dialer** and Outreach cannot write back —
  so the panel writes to HubSpot and lets it propagate.
- **New `hubspot-write.js`** (`EB.hubspotWrite`), the extension's first non-note
  write path, built on the same conventions as `hubspot-notes.js`:
  `PATCH /crm/v3/objects/contacts/{id}` with `{properties: {[field]: value}}`
  through `EB.hubspotAuth.apiFetch`.
  - **Field allowlist**: `phone`, `mobilephone`, `phone_number_2` and nothing
    else. Checked with `indexOf` over a fixed array, so `email`,
    `hs_lead_status`, `__proto__`, `constructor` and friends are all rejected —
    no caller can write an arbitrary property.
  - **Digit-validated `contactId`** (same rule as the notes module): a write
    aimed at the wrong record isn't something a rep can undo.
  - **Confirm required at the module boundary too** — an unconfirmed call is
    refused before any request, so the "no one-click writes" rule can't be lost
    in a future refactor.
  - **Phone validation and normalization**: unambiguous numbers become E.164
    (10-digit NANP and `1`-prefixed 11-digit → `+1…`; anything with an explicit
    `+` keeps its country code and loses only punctuation). Extensions, IDD
    prefixes, 7–9-digit fragments and 10-digit values that aren't a valid NANP
    shape are **passed through exactly as typed**, and the panel says so before
    the rep confirms. Letters, <7 or >15 digits, junk characters and an unchanged
    number are rejected **before** a request is spent.
  - **Typed errors** mirroring the notes module: `INVALID_INPUT`, `NO_TARGET`,
    `AUTH`, `FORBIDDEN`, `RATE_LIMITED` (honors `Retry-After`), `TRANSIENT`,
    `API`. A **403 is `FORBIDDEN`, never "sign-in expired"** — per the Phase 7
    rule — and no status, category or HubSpot response text reaches panel copy.
- **Audit trail**: a successful phone change also files a HubSpot note —
  *"Phone corrected by you@wiza.com: Mobile phone (415) 555-0134 → +14155559876
  (via Dialer Helper Pro)"* — on the contact and company, attributed to the rep.
  Strictly **best-effort**: a failed note never makes a successful update look
  failed; it's reported as a footnote and logged.
- **Panel UI in the identity block's phone row.** The row now shows every number
  on the record (**Phone**, **Mobile**, **Phone 2** — `mobilephone` and
  `phone_number_2` were added to the contact read, which costs no extra request)
  plus a **Wrong number?** link (**Add a number** when the contact has none).
  Opening it reveals: which field to update (a dropdown showing what's on each,
  defaulting to the one displayed), the current value for reference, an input
  prefilled with it, and **Cancel** / **Update in HubSpot**. The first click on
  **Update in HubSpot** arms a **Confirm update** step that states the change in
  full (*"Change Mobile phone from … to … on this contact in HubSpot?"*);
  **nothing is written until the second click**, and any edit disarms it. The
  button is dead unless HubSpot is connected, a real contact ID is matched, and
  the number is valid *and* different — with the reason underneath, always.
- **After a successful write**: *"Mobile phone updated in HubSpot ✓ — Outreach
  usually picks it up within ~10 minutes; the dialer shows it after that."* The
  row updates immediately and the cached bundle for that prospect is dropped, so
  **Refresh** shows the new number instead of the old one. State is per contact:
  a prospect change discards a half-typed correction rather than carrying it onto
  someone else's record.
- **No new scopes**: `crm.objects.contacts.write` was already in the app's scope
  set. README's Privacy & permissions section now spells out that the extension
  can **write contact phone numbers** — a meaningful capability change from
  "notes only" for anyone reviewing it — with a table of every write it can make.

### Fixed — note attribution was blank

- **Notes synced to HubSpot came out with "Activity assigned to: No owner".** The
  owner lookup ran exactly once, at connect time, as best-effort enrichment — so a
  single failure there left `ownerId` null in `eb:hs:auth` permanently, and every
  note that connection ever created was unattributed. `hubspot-auth.js` now
  resolves the owner ID **lazily and self-healingly** (`ensureOwnerId()`): cached
  value if present, else one single-flight `GET /crm/v3/owners/?email=…` patched
  into the stored record. **Existing connections heal themselves on the next
  sync — no reconnect.** A failure still returns `null` and is logged rather than
  blocking the write: an unattributed note beats a lost one.
- Notes now also set **`hs_created_by`** (the rep's HubSpot *user* ID, which is a
  different number from their owner ID) so *"Activity created by"* is populated.
  Both IDs are digit-validated independently. If HubSpot refuses `hs_created_by`
  as read-only for app writes, the note is retried **once** without it and still
  lands; the downgrade is logged and never shown to the rep.
  `hs_created_by_user_id` is deliberately never sent — HubSpot owns it and leaves
  it empty for OAuth-app writes.
- `getAuthState()` now exposes `userId` alongside `ownerId`.

### Added — auto-sync notes on save

- **Saving a note in the dialer syncs it to HubSpot on its own.**
  `content-nooks.js` detects a *save transition* in two positive steps and
  publishes it as a distinct `lastSaved: { text, scope, savedAt, id }` field on
  `eb:notes`: (1) a click on the note dialog's **Save** control arms a pending
  save, capturing the draft at that instant; (2) a later scan confirms it only
  when the dialog is gone **and** the saved list for that scope carries the text
  (or grew). A **Cancel** click never arms one and actively disarms a pending
  one, and "the draft disappeared" is never itself treated as a save — Cancel does
  that too. Unconfirmed saves expire after 20s. One save produces exactly one
  signal, with an id the panel dedupes on.
- **The side panel auto-syncs that signal** through the *same* path as the Sync
  button, so the existing idempotency hash covers both: a save after a manual
  sync of the same text, or a repeated signal, cannot double-post. The result is a
  passive, timestamped state in the Notes section — *"Auto-synced to contact +
  company just now ✓"* with the HubSpot link, and an **Auto-synced ✓** pill.
- **Guardrails**: only positively-saved notes (never a draft), never when the
  prospect changed after capture (the bleed guard is honored), never without a
  matched contact/company, never when signed out, one attempt per save signal (no
  retry storms), and nothing older than 30 minutes syncs on panel open. Each skip
  is logged with its reason. On failure the rep sees *"Couldn't auto-sync that
  note…"* and gets the manual button back with their text intact — a note is
  never dropped silently.
- **New setting**: gear → **Notes** → *"Auto-sync saved notes to HubSpot"*,
  default **on**, persisted per rep in `chrome.storage.local` under `eb:settings`.
  Off = exactly the previous manual flow.

### Fixed — "sign-in expired" on an empty Activity section

- **A 403 no longer claims the rep's sign-in expired.** `hubspot-data.js` mapped
  both 401 and 403 to `AUTH`, whose copy is *"HubSpot sign-in expired — connect
  again in Settings"* — wrong and un-actionable for a permissions problem, since
  the app's scope set is fixed (HubSpot rejects the granular engagement scope
  names outright on the current platform version, so engagement reads ride on
  `crm.objects.contacts.read`). 401 keeps `AUTH`; 403 is now its own `FORBIDDEN`
  code carrying the status and HubSpot's message **for the console only**, and
  renders as *"Can't read activity — your HubSpot permissions don't cover it."*
- **An empty result now always reads as empty.** Activity's genuinely-empty state
  says **"No activity found"** (was "No activity logged yet") and wins over any
  section error code; the same rule was applied to Deals ("No open deals"). No
  section implies an auth problem for what is actually an empty list.
- **Activity is fetched per engagement type resiliently**: one type the token
  can't read no longer blanks the four it can, and every per-type failure logs its
  engagement type and HTTP status so the real cause is visible in the panel
  console. Only a total failure is reported as a section error. The CRM bundle log
  now also prints the per-section error codes.
- Hardened the notes panel's signed-in check: an authoritative `connected: false`
  can no longer read as signed-in because of a cached owner ID.

### Fixed — the panel showed the wrong owner

- **Ownership in the identity block was the wrong field.** It showed the record's
  `hubspot_owner_id`, unlabelled. HubSpot's own description of the company
  property `sdr_company_owner` is explicit — *"[OFFICIAL] The SDR / outbound rep
  who owns prospecting for this account. Use this for outbound ownership, not
  hubspot_owner_id"* — and "who owns prospecting here" is the question SDRs were
  using that line to answer before dialing. The block now shows up to four
  **labelled** names, each only when set: **Outbound owner** (`sdr_company_owner`,
  prominent, with `outbound_ownership_change_date` as its hover detail), **CSM**
  (`cs_company_owner`), **Company owner** (company `hubspot_owner_id`) and
  **Contact owner** (contact `hubspot_owner_id`). The unlabelled owner is gone.
- These two properties are not typed like `hubspot_owner_id`: depending on how a
  record was written they hold either an owner-ID reference **or** an
  already-resolved name. Values are inspected at render time — ID-shaped ones go
  through the existing session owner cache, name-shaped ones pass through
  untouched, and anything that can't be resolved is **left out**. A bare numeric
  owner ID can no longer reach the panel.

### Added — dialing-decision context (Phase 8, all from properties on records the panel already reads)

- **Account context** (new section, between *Contact & company* and *Wiza*):
  account grade (`account_grade_v1`) in the section pill, **Company status**
  (`company_lifecycle_stage`, humanized), **ICP fit** (`icp_fit`), and the team
  sizes SDRs qualify on — **Sales team using Wiza** (`asm_sales_team_size`,
  labelled after the property's own description), **AE team** (`ae_team_size`),
  **Outbound team** (`ob_team_size`), **Sales leadership**
  (`sales_leadership_team_size`).
- **The company in its own words**, for the *"do you even know what we do?"*
  objection: the first non-empty of `description` / `about_us` / `linkedinbio`,
  trimmed of HTML, capped at ~200 characters with the full text on hover; plus
  `industry_wiza`, `account_icp`, and `account_icp_ai_reasoning` as a muted
  *"Why: …"* line (long, so it's secondary with the rest on hover). Industry and
  ICP are skipped here when the Wiza section is already showing them.
- **Tech stack** from `web_technologies`: split on `;` `,` `|` newlines and tabs,
  trimmed, de-duplicated case-insensitively, capped at 8 with *"+N more"* and the
  whole list on hover.
- **One-click LinkedIn** in the identity block: company `linkedin_company_page`
  and contact `hs_linkedin_url` (**not** the deprecated `linkedin_url`). Values
  are hand-entered and often scheme-less, so a bare `linkedin.com/...` path is
  upgraded to `https://`; everything else still goes through the same `safeUrl`
  filter, and `javascript:` / `data:` / relative values are dropped rather than
  linked.
- **Sequence context**: *"In sequence: {name} since {date}"* or *"Not in a
  sequence"* from `hs_sequences_is_enrolled` / `hs_latest_sequence_enrolled` /
  `hs_latest_sequence_enrolled_date`, plus *"Last contacted 3d ago"* from
  `notes_last_contacted` (exact time on hover). A record with no enrolment data
  gets **no** line — claiming "not in a sequence" without being told would be a
  guess presented as a fact.
- **Closed-deal talk track**: closed rows (which already sort after open ones)
  carry a one-line *"Lost: {reason} · {category} · {secondary}"* or *"Won:
  {reason}"* from `closed_lost_reason`, `closed_loss_category`,
  `closed_lost_category__secondary_`, `hs_is_closed_lost` and
  `closed_won_reason`. Repeated categories collapse, long reasons are capped with
  the rest on hover, open deals never show one, and a closed deal with nothing on
  file shows no line at all.

### Changed

- `CACHE_VERSION` **6 → 8**, so a bundle cached earlier in a live panel session
  can't be rendered by the new sections (it wouldn't have the fields).
- **No new requests.** Every property above was added to the existing
  `CONTACT_PROPERTIES` / `COMPANY_PROPERTIES` / `DEAL_PROPERTIES` arrays, so it
  rides the contact GET, the company GET and the deals batch read that already
  happen — the search fallbacks reuse the same arrays. The only extra traffic
  possible is an owner-name lookup for an ID-shaped ownership value, which joins
  the batched owner pass the bundle already runs and is cached for the session.

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
