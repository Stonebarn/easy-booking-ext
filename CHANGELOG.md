# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.7.1] - 2026-08-11

### Fixed — Account context's tech stack and rationale are readable

Rep feedback: the **Tech** and **Why** lines in Account context were too small
and hard to read. They were — both ran as inline rows prefixed "Tech: " /
"Why: " at **10px in muted grey**, and 10px in this panel is meant for ALL-CAPS
labels and single-fact caption lines, never for a paragraph or a list of product
names.

Both are labelled blocks now, the same label-over-value shape as the stat chips
directly above them: a 10px caps **TECH** / **WHY** label on its own line, with
the content beneath on the **12px body step in full ink** — the same size and
colour as the company blurb and as every other value in the panel. Contrast on
the rendered pixels goes from 5.9:1 muted grey to 13.9:1 ink.

Moving the word up into the label is what paid for the size: the inline prefix
is gone, so no row got taller. Everything else holds — the rationale still
clamps to two lines with a MORE toggle, the tech list still shows four with
MORE (n), and competitor names still carry the violet highlight (verified
through the expand toggle).

`.fact-line` — the generic 10px muted fact row — is removed. The tech stack was
its last remaining user, which is to say the rule existed only to style the row
reps couldn't read.

## [0.7.0] - 2026-08-11

### Added — reps set their own section order

Brian and Savannah both asked to move the panel's sections up and down so the
one they open with is the one at the top. Seven sections move: Contact &
company, Account context, Others at this account, Wiza usage, Deals, Activity
and Dialer notes. The order is per rep, saved locally, and applied every time
the panel opens.

**Settings → Layout → Arrange sections** turns the mode on. Each section head
grows an up and a down control plus its position ("3/7"), and a sticky bar above
the list holds Reset and Done. Everything about the mode is built when it turns
on and removed when it turns off, so the everyday panel gains nothing at all —
no extra buttons in the heads, and no extra tab stops on the way to the note a
rep came for.

Chosen over drag-and-drop deliberately: dragging tall cards inside a 320px
scrolling panel while on a live call is fragile, and up/down works from the
keyboard and a screen reader without a second mechanism. Drag can be added on
top of this later.

Details worth knowing:

- **A move jumps over sections that are hidden** because this prospect has
  nothing for them. Swapping with something invisible reads as a dead button.
- **The booking block never travels.** The captured email, the prospect's clock
  and Fill form merge into the Contact column only while Contact & company is
  the first section on screen; move it down and the cluster stays pinned in its
  own block at the top. That cluster is the call, not context about it.
- **A saved order survives a future release.** A section this build has but the
  saved order never heard of lands next to the section it shipped behind, not at
  the bottom of every arranged panel — and an unknown, duplicated, or garbage
  stored value can never cost a rep a section.
- **Escape leaves the mode**, like every other transient state in the panel, and
  focus returns to the gear.
- The order shares `eb:settings` with the auto-sync and celebration switches;
  all three merge, so none can turn another off.

### Changed

- The rule that used to sit above Dialer notes is gone. It marked a "CRM context
  above, notes below" boundary that stops being true once the rep owns the
  order; the rule between the booking block and the list stays, because that
  boundary holds whatever order the list is in.
- Reordering no longer re-renders the CRM. The layout change re-decides where
  the booking cluster lives and nothing else, instead of rebuilding six cards on
  every press of an arrow.

## [0.6.1] - 2026-08-06

### Fixed — the booking page's actual confirmation is now recognized

The live booking page says **"Your meeting has been scheduled!"** (confirmed by
Jack). As shipped in 0.6.0 that would never have fired: the matcher only looked
for a phrase at the *start* of a line, and the phrase list had no entry for
"meeting has been scheduled" — so the celebration would have stayed silent
after a real booking. Three changes:

- The confirmation string and its siblings are in the list, and phrases now
  match **anywhere** in a short visible line. Each carries a subject and a verb
  so a stray word can't trip it; bare words ("Confirmed", "Booked") count only
  when they are the whole line.
- Nested markup reads as one sentence. A headline split by tags
  (`<h2>Your meeting has been <strong>scheduled</strong>!</h2>`) previously
  scanned as the single word "scheduled" and missed.
- **A recognized submit-button label is no longer required.** Detection starts
  when the form is filled, snapshots the page's copy as a baseline, and
  publishes when *new* confirmation copy appears — so an unexpected button
  label, or a submit by keyboard, can't suppress a real booking. This is the
  same failure mode that kept note auto-sync from ever firing (0.5.2): don't
  gate a feature on guessing a third party's control label when the page states
  the outcome in words.

Guards kept: only a form this extension filled for a known prospect counts, only
copy that was **not** already on screen at fill time is evidence (the page's own
description mentions bookings, and a leftover confirmation in the same tab must
not re-fire), and one booking publishes exactly one signal.

## [0.6.0] - 2026-08-06

### Added — the won-meeting moment

The panel now celebrates the thing the whole call is for. When a booking is
confirmed on the booking form, a positive-tone receipt appears at the top of
the column (who was booked, the day's count, a link to the HubSpot record)
and a confetti burst plays in the panel — hand-rolled on a canvas, drawn from
the brand's purple scale, bigger for the 3rd and 5th booking of the day.

- **The trigger is evidence, not a guess** (`content-scheduler.js`). A filled
  form is never a booking: the signal is published only when a submit-classified
  click on a form *this extension filled* is followed by evidence it landed —
  a confirmation URL, a confirmation phrase that was **not** on screen when the
  click happened (the page's own copy mentions "booked"), or the form closing
  and staying closed. No evidence, no celebration.
- Deliberately absent: audio of any kind (the rep is on a live call), emoji,
  and anything that moves focus. `prefers-reduced-motion` keeps the receipt and
  drops the confetti; Settings has an off switch.
- The dialer's own "Meeting booked" disposition is the other natural trigger,
  but its DOM has never been captured (it only exists during a live call).
  `docs/diagnostics/booked-signal-probe.js` collects what's needed to wire it.

### Added — a motion language for the panel

The panel had almost no motion (one caret rotate, one skeleton pulse). Four
small pieces now explain what it already says in words: the signature sparkline
strokes itself in as usage data lands, a prospect's sections rise together in
reading order (stagger capped at 6 × 26ms), a synced note's ✓ settles in over
160ms so a routine write reads as *certain*, and the live capture dot sends a
slow ring outward while a prospect is loaded. One easing curve, four durations,
all documented in DESIGN.md's new Motion section. Everything is additive to an
already-visible default and reduced-motion guarded.

### Fixed — two label weights were silently rendering at 400

The won-meeting label and tally chip referenced a `--fw-label` token that does
not exist (the 10px caps weight is `--fw-head`), and the receipt's dismiss
button inherited the base full-width `button` rule, which crushed the card's
text to one character per line. Both caught by the harness before shipping.

## [0.5.2] - 2026-08-06

### Fixed — every note saved in a session now syncs (auto-sync actually fires)

Live report: with several notes in one call session, each note "overwrote"
the previous one — only the last note manually synced ever reached HubSpot —
and auto-sync on save never fired at all. Three root causes, all fixed:

- **Save detection no longer depends on guessed button labels or the
  unverified saved-list DOM** (`content-nooks.js`). A save is now confirmed
  in layers: a classified Save click plus the dialog closing confirms on its
  own (saved-list evidence just accelerates it, and its absence can no longer
  veto it — including when the notes card isn't on screen at all, which
  previously hit an early bail that skipped confirmation entirely). A dialog
  that closes with a draft and no Cancel to explain it becomes an *implicit*
  candidate, confirmed only if the draft's own text appears in the saved
  list — so an Escape'd draft can never sync. "Add"/"Add Note" now classify
  as Save (the dialog is titled "Add a Prospect Note").
- **Save signals queue instead of being burned one-shot** (`sidepanel.js`).
  The old code marked a signal handled before checking conditions, so a save
  arriving mid-sync, before the record match, or while signed out was
  skipped forever. Now permanent reasons resolve a signal visibly, transient
  ones leave it queued, and every unblocking event (sign-in, context
  arriving, the CRM match, a sync finishing) drains the queue in save order.
  A failed auto-sync holds the queue for 15s rather than steamrolling the
  error line.
- **The idempotency record remembers every synced note, not just the last
  one** (`hashes` ledger, bounded at 20). Re-saving an earlier note's text is
  recognized as a duplicate; previously only the most recent hash counted.

Continuous *typing* still never syncs by design: the note syncs when it is
saved in the dialer, one HubSpot note per save.

## [0.5.1] - 2026-08-06

### Fixed — Lovable token function reference: fixed introspection, added failure logging and a hub allowlist

`lovable/hubspot-token-function.ts` (the reference source for the deployed
`wiza-hs-connect.lovable.app` edge function) sent HubSpot's introspect
endpoint the wrong form field (`access_token` instead of the required
`token`), so identity lookup 400'd silently on every exchange. Not yet
redeployed — see the file's own `## Deploying updates` note for how.

### Fixed — synced notes are attributed to the signed-in SDR again

Notes reached HubSpot but landed as **"Activity created by: No user"** and
**"Activity assigned to: No owner"** on the live portal, because the extension
never actually knew who the signed-in rep was.

Root cause: the OAuth token exchange was the **only** code path that ever
captured identity, and it captured nulls. The hosted token function asks
HubSpot's introspect endpoint for the SDR's identity but posts the token as
`access_token`, while that endpoint requires a form field named `token` — so it
400s, the function swallows the failure and returns `user_email: null,
user_id: null`. `login()` stored those nulls; no email meant the owner lookup
had nothing to search by, so **both** attribution fields stayed unset. A
restored session read the same nulls back out of `chrome.storage.local`, and a
token refresh never looked at identity at all.

Identity is now resolved **from the token itself**, on demand, on every path —
fresh login, restored session, just-refreshed token:
`GET /oauth/v1/access-tokens/{token}` is public token metadata (no client
secret; the bearer token is the path segment) and returns the SDR's email,
user id and hub id. The answer is persisted into `eb:hs:auth`, so a connection
that has been writing anonymous notes for weeks heals itself on its next sync
with nothing for the rep to do, and the owner lookup then resolves
`hubspot_owner_id` from the email it just learned. `hs_created_by` gets the
**user** id and `hubspot_owner_id` the **owner** id, still two different id
spaces; `hs_created_by_user_id` remains read-only and is never sent.

Enrichment can never cost a note: every lookup is single-flight, failures are
never cached as a permanent null (the next sync retries), and a sync goes out
unattributed rather than failing. When it does, the receipt under **Sync** now
says so in one muted sentence — *"Synced without attribution — reconnect
HubSpot to fix."* — instead of only whispering it to the console. The same
healing applies to the phone-correction audit note. No token-function redeploy
is required.

### Changed — the type scale is three sizes, and empty states get a headline

Six font sizes (9–14px, adjacent steps as small as 8%) collapse to three:
**10px** captions (ALL-CAPS labels and sentence-case metadata, told apart by
case and weight as the chip idiom always did), **12px** body/values, **14px**
the record name — the panel's one biggest fact. Every 9px, 11px and 13px use
merges into its neighbor; no role lost its distinction because size was never
what carried it — weight, case and tone were. The panel gets ~26px *shorter*
at 320px.

The empty-state headline ("No prospect captured yet") becomes the scale's one
**20px display moment** — and drops its negative-tone red for plain ink: a
waiting panel is an invitation, not an error. Empty states are the only
screens with room for display type, so it costs no mid-call height.

## [0.5.0] - 2026-08-06

### Added — Wiza custom objects: richer usage data, and two sparklines

The "Wiza usage" section (renamed from "Wiza user/account information" — the
old compound didn't scan at 10px caps) now layers the portal's own Wiza User,
Wiza Account and Trial **custom objects** on top of the rollup properties it
already rendered. The rollup view is untouched and remains the automatic
fallback: no association, a 403 (the new `crm.objects.custom.read` scope not
yet on a rep's token — reconnect in Settings to pick it up), a 404, anything —
degrades silently to exactly what the section rendered before this shipped,
never blanker.

When the objects **are** readable, the section gains:

- **User**: Role, Extension version, Last enrichment and Last bulk export
  (behind a **MORE (n)** toggle), and an inline **Credits 30d sparkline**
  replacing the plain chip once there's a real trend to draw.
- **Account**: Plan (name + compact price) and Seats (used of total) as
  headline chips; Renews (plan period end), Credits (email/phone/export
  balances — `-1` renders as **Unlimited**, never a negative number), Spend
  (30-day and lifetime), Last payment, Overage, Card on file and Stripe
  status behind their own **MORE (n)**; and a second **Credits 30d
  sparkline** for the account-wide trend.
- **Trial**: a new sub-section, shown only when a Trial record is
  associated — dates, length, paid status, amount, trial users, export/API
  credit tiers and monitor access.

Sparklines are built as inline SVG from numbers computed in `hubspot-data.js`
(never from interpolated CRM strings), downsampled to at most 24 points; a
property with fewer than 3 recorded history versions renders its value alone,
with no chart. A trend arrow appears only for "up" or "down" — up in the
panel's positive green, down in a muted grey, never red (a churn-red arrow
mid-dial would cry wolf on the common case).

Fetch cost: **+0 to +3** requests per prospect (one per associated custom
object, only when one exists), all riding on associations the existing
contact/company reads already carry for free. `CACHE_VERSION` bumped to 12.

### Changed — ownership tone: red retired, neutral in, flagged once per card

Design critique P1 ("Neutral chip, red retired"): another rep's name on a
shared account is a routine, benign state, not an error, and red was painted
on every other-owned record — the per-row `.own-alert` highlight on Outbound
and Contact owner, the `.peer-alert` outline+tint on every colleague row.
Negative tone is now reserved for actual negatives (section errors, lost
deals, `.crm-note.bad`); ownership renders in plain ink with a quiet, muted
"(not you)" / "Owned by {name}" suffix — visible text, not a hover-only
`title`, so it reaches screen readers too. The fact is stated **once** per
identity card (on the most prominent flaggable role — outbound, then
contact — never twice for the same person) and colleague rows drop their
per-row alert styling entirely, relying on the section head's existing
shared-owner note plus a quiet per-row "Owned by {name}" when owners differ.

Also collapses the owner triplication the identity section always drew:
Outbound owner / Company owner / Contact owner now render as one "Owner"
row (with a quiet "(all roles)" suffix) whenever all three resolve to the
same name; a divergent, missing or unresolved trio keeps the split rows,
"Not set"/"Unknown" states and the outbound ownership-change hover intact.
Dead CSS from an earlier, already-abandoned owner-row layout (`.own`,
`.own-primary`, `.own-more`) is removed along with the retired alert rules.

### Fixed — tap targets under 24x24 CSS px

`button.wn-open` ("Wrong number?"), `button.prose-more` ("More"), the activity
type tabs, `#fill`, `summary.sec-toggle` (Others at this account), `a.li-glyph`
and `a.peer-li` all measured under the 24px floor a thumb needs. Each now
carries a `.hit24` class: a shared, invisible `::after` overlay expands the
*hit area* past 24x24 in whichever axis was short, while the control's own
visible box — the pixels a rep actually sees — is untouched.

### Fixed — hover-title-only content promoted to accessible/visible text

Three facts a rep (or a screen reader) needed mid-call lived only in a
`title`, which a keyboard or screen-reader user never reaches:

- Activity rows now carry a screen-reader-only "\<Type\>, outbound/inbound"
  companion to the direction arrow (which stays decorative/aria-hidden). Past
  a 500px panel width there is room to spare, so the same text becomes a
  small visible caption instead of staying sr-only — nothing changes at the
  320px floor.
- The booking cluster's capture age ("captured 2m ago") was genuinely
  title-only whenever the capture wasn't stale — the visible meta line is
  deliberately silent for that common case. It's now always mirrored into a
  screen-reader-only node so that fact is reachable without a mouse hover.
- The colleague "In sequence" pill's name and enrolment date ("In sequence:
  UK Outbound Q3 since Jul 26, 2026") lived only in its title; it's now also
  the pill's `aria-label`. The visible pill text is unchanged ("In sequence")
  — there's no room to spend on a name at 320px next to four other rows.

### Fixed — captured email wraps mid-word at the 320px floor

`aaron.moloney@powtoon.com` could render as `aaron.moloney@p` / `owtoon.com`.
The email is now built with a `<wbr>` immediately after the `@` (via
`createTextNode`/`createElement`, never innerHTML — it's scraped data), so the
browser breaks there first; `.bk-email`'s `overflow-wrap: anywhere` stays as
the last-resort fallback for a pathological local part.

### Added — click-to-copy for the captured email and the contact's phone

A small button (authored inline SVG, 2px stroke, matching the panel's
section-head icon style) beside the booking cluster's email and beside the
contact's primary phone number. `navigator.clipboard.writeText`, with the
panel's existing "swap in place, then revert" confirmation idiom translated
into an icon swap (copy → check, tone-positive) since there's no room for a
text label; a rejected write swaps to an X (tone-negative) instead of failing
silently. Both buttons reach the 24px tap floor via `.hit24` without growing
past their 14-16px visible box. The email button *floats* rather than sitting
in a flex row beside the text — inside the Contact column the email needs its
full width to fit in two lines, and a flex sibling was costing a whole third
line; a float only narrows the single line box beside it.

### Changed — Fill focuses the booking tab instead of asking the rep to

Clicking **Fill form** while the scheduler tab was open but not the active tab
used to reject with "Open the booking tab first, then click again." It now
finds that tab wherever it is (`chrome.tabs.query` against the same
`scheduler.default.com` pattern already in `host_permissions` — no new
permission needed), brings it to the front (`chrome.tabs.update` +
`chrome.windows.update`), and proceeds with the same storage nudge in one
action. The "no booking tab open at all" case still shows the original
message; the stale-capture re-stamp and the "Fill triggered." result notice
are unchanged.

### Changed — Notes recast as a dialer receipt, not an editor

The SDR types in Nooks; this section only ever scraped and synced it — but its
big bordered textarea at "type here" size read as the primary editor even to a
design reviewer. Nothing about the sync path changed (same gate, same arming,
same idempotency, same storage keys) — only how the section presents itself:

- The section title is now **"Dialer notes"** — provenance leads. The caption
  under the textarea leans further into the existing "draft from the dialer,
  Xm ago" line: it now reads **"captured from your dialer notes, Xm ago."**
- The textarea drops visual weight: borderless and ~2 lines tall at rest, a
  soft fill instead of a hard edge, growing to full height and its border back
  only on focus. It is still fully editable — pre-sync touch-ups are legitimate
  — but the **Sync to HubSpot** button and the sync-state line underneath it
  are now the section's visually primary elements, not the box.
- Copy no longer invites typing into the box: the placeholder is now "Notes you
  save in the dialer appear here." and the empty state reads "No dialer note
  captured yet — notes you save in the dialer appear here."

### Fixed — sync outcome and blockers are now screen-reader-audible

`#notes-result` and `#notes-blockers` both carry `role="status"`, mirroring the
`wn-result` idiom (the wrong-number editor already did this via an explicit
`aria-live="polite"`). Both are guarded against re-announcing unchanged text —
`render()` runs on every keystroke and on the new `eb:crm-match` event (see
below), and neither node is touched unless its message actually changed.

### Fixed — CRM empty/signed-out states no longer repeat the same line six times

Signed out, or no prospect captured: every one of the six CRM section cards
(Contact & company, Account context, Others at this account, Wiza, Deals,
Activity) used to render the identical sentence. Now only the first section
(Contact & company — it never hides itself) shows the message, with the Connect
action where relevant; the other five hide outright. Loading, error and
"nothing loaded yet" are unchanged — they still render per-section. The booking
cluster's full-width fallback (`mountBooking`) is untouched and still renders
independently of CRM state in both cases.

### Fixed — notes Sync gate no longer trusts a scraped ID the live fetch just contradicted

The Sync button gated on `eb:prospectContext`'s dialer-scraped
`hsContactId`/`hsCompanyId`, which is Nooks' own cached idea of the record and
can outlive it (deleted or merged in HubSpot after Nooks displayed it). The CRM
module's live fetch — the same one that renders "Not in HubSpot" on the
identity card — now publishes what it actually found for the current prospect
(an in-memory `eb:crm-match` event; nothing persisted). Once that confirmation
is in, it's authoritative for what a sync can target; the scraped ID is trusted
only while no confirmation has arrived yet (bundle pending) or can't (signed
out) — matching what identity already shows, instead of occasionally
disagreeing with it.

## [0.4.0] - 2026-08-06

### Changed — the live capture lives in the Contact column

Email, timezone and **Fill form** are no longer a separate block above the CRM
sections: the captured email *is* the contact's identity, so the whole cluster now
sits **inside the Contact column of Contact & company**, directly under the
contact's name row, on a faint purple wash that marks it as the live capture. The
fill behaviour, its disabled/stale states, the result messages and the capture-age
tooltip are unchanged — the same node moved, not a second renderer.

It **moves back** to a block of its own (with the rule under it) in every state
where there is no Contact column to sit in: no HubSpot match, no prospect matched
yet, a section error, and — the one that matters most — **signed out of HubSpot
entirely**. Email/timezone/Fill are the original v0.2 workflow and they now render
from `eb:currentProspect` independently of the CRM bundle's freshness or presence,
so a rep who never connects HubSpot gets exactly the panel they had before.

### Changed — "Wiza" is now "Wiza user/account information", and only that

The section carried two company fields (**ICP** and **industry**) that have nothing
to do with our product relationship, with a suppression rule that hid them from
Account context whenever Wiza happened to have account data. That rule is
**inverted**: Account context owns ICP and industry outright, and the Wiza section
never shows them. What is left is Wiza product data only — the user (status, Wiza
ID, signed up, plan, credits, last usage, the admin/usage-log links) and the Wiza
account (account ID, subscriptions, API credits, credits 30d, purchases, last
purchase, use case). Empty behaviour is unchanged: no Wiza relationship at all and
the section does not render.

### Changed — labelled datapoints are stat chips

Account context and the Wiza section are now built out of **stat chips**: a muted
ALL-CAPS label over a bold value, in a rounded box of page white on the card's
grey. It replaces the label-left inline rows, which read as a sentence and scanned
like one. A datapoint with **no value renders no chip** — never an empty box — and
only a *status* chip tints its value, because a tone is meaning. It costs some
vertical space and buys scannability: "how big is their sales team" is now a
labelled box, not a phrase.

### Removed — the "·" separator, panel-wide

There is no interpunct anywhere a rep can see one: not in a line, not in a
tooltip. Every place that strung facts together with a glyph now uses real
structure instead — a flex gap (the timezone line, the sequence line, the
company's domain/industry/headcount, activity detail, ownership), a chip (Account
context, Wiza), a right-aligned column (a colleague's "contacted 3d ago" now sits
at the trailing edge of its own line, under the name and badges), or plain
punctuation inside a single value (tooltips are comma- or dash-joined). Values
`hubspot-data.js` composes with an interpunct — a call's `Connected · 3:34`, a
deal's lost reason and category — are split back into spans by the panel. The
`--sep` token and its rules are gone.

### Added — logos, photos and icons, so the panel isn't a wall of text

- **Company favicon** beside the company name (28px), from
  `https://www.google.com/s2/favicons?domain=…` — **the one third-party request
  the panel makes**, sending the company's domain and nothing else, with no
  referrer. Documented in **Privacy & permissions → What leaves the machine**. The
  domain is validated against a bare-hostname pattern and URL-encoded before it is
  interpolated.
- **The contact's photo** (36px circle), from the LinkedIn card the dialer
  scrapes — `eb:prospectContext.linkedin.photoUrl`, https-validated. A person's
  fallback is **always their own initials**; company imagery is only ever valid on
  a company row.
- **Initials tiles** for every other person (20px), one or two letters on a
  purple-scale square chosen deterministically from the name, so the same person
  keeps the same tile. Only fills that pass AA for their label are in the
  rotation: `--accent` and `--accent-ink` carry white, `--accent-2` carries
  `--ink`; `--accent-soft` is excluded (white on it is 1.71:1).
- **Initials render first in every case.** An image only replaces them once it has
  actually decoded, so a slow, blocked or expired URL shows initials rather than
  an empty box or a broken-image glyph — and a response that arrives after the
  section re-rendered is dropped, so a photo can never land on the next
  prospect's card. LinkedIn photo URLs are signed and expire, which makes this the
  normal path rather than an error path.
- **A LinkedIn glyph** beside the contact's name when the dialer captured a
  profile URL (their headline is its tooltip; there is no visible headline line).
  It suppresses the row-level "LinkedIn" link, which pointed at the same person.
- **Section-head icons** — one 2px-stroke outline glyph per section (person,
  building, people, the Wiza W, tag, bolt, pencil), static markup, `currentColor`.
- **Activity type icons** — the text glyphs (☎ ✉ ◷ ✎ ✓), which rendered at a
  different size and weight on every platform, are now SVG icons in an 18px
  purple-wash disc, giving the timeline a rhythm down its left edge.
- **The Wiza mark** at the far left of the panel's header, from
  `icons/wizainc_logo.png`.

All of it is decorative (`aria-hidden`, empty `alt`), all of it is built with
`createElementNS` rather than `innerHTML`, and no handler is inline — MV3's CSP
forbids both.

### Changed — the panel reads more like the product

Cards are rounded 10px (spacing unchanged — this panel is used mid-call and stays
tight), the selected activity tab is an **outlined violet pill** on page white
rather than a tinted slab, and the row-level out-links (LinkedIn, Company
LinkedIn, the Wiza admin links) take a compact bordered treatment instead of a
bare underlined word, matching the colleague "in" chip.

### Fixed — a colleague's name met AA on the alert tint

On a colleague row owned by someone else (the negative tint), the accent violet
name was 4.27:1 — under AA for 12px text. It takes `--accent-ink` there (8.4:1),
the same "accent text on a tinted ground" rule the rest of the panel follows.

### Changed — `scripts/validate.mjs` checks the panel's images

It already validated every local `<script src>` the panel loads; it now does the
same for `<img src>`, so a renamed icon fails the build instead of showing a
broken tile in the header. Remote images are skipped by design (the favicon
service is fetched at runtime).

### Fixed — the tech stack reads like English again

`web_technologies` holds HubSpot *enum* values, so the panel was printing them raw:
`google_analytics`, `hubspot_crm`, `salesforce_crm`. Every value now goes through a
label pass — separators become spaces, words are Title Cased, and a lookup table
keeps vendor casing the way the vendor writes it (**HubSpot**, not Hubspot;
**ZoomInfo**, **LeadIQ**, **Apollo.io**, **Seamless.AI**, **jQuery**, **reCAPTCHA**,
**PostgreSQL**, **Node.js**, **X (Twitter)**, ~150 entries). Matching is per *run of
words*, so one entry per vendor fixes every compound it appears in: `hubspot` →
HubSpot covers `hubspot_crm` and `hubspot_forms`, and `crm` → CRM covers every
`*_crm`. Unknown values still Title Case instead of breaking, and a value that is
only punctuation is dropped rather than rendered as a stray delimiter.
See **Configuration → `TECH_LABELS`** for how to add a vendor.

### Added — competitors in the tech stack are flagged, and never hidden

Wiza sells B2B contact data, so a competitor already in the account's stack is the
most useful thing in that row: it makes the call a displacement conversation
instead of a cold pitch. Each tech item now carries `isCompetitor`, matched
case-insensitively against `CONFIG.COMPETITORS` (Apollo.io, ZoomInfo, LeadIQ,
People Data Labs, Lusha, Cognism, Seamless.AI, RocketReach, Hunter.io, Clearbit,
UpLead, Snov.io, Kaspr, ContactOut, Datanyze, SalesIntel, Adapt.io, Prospeo,
Findymail, Dropcontact, Clay, Amplemarket) with **word-boundary** semantics — the
entry has to be a whole word of the value, so `Clearbit` does not match
`clearbitmap`. HubSpot, Salesforce, Outreach, Salesloft, Nooks, Gong, Intercom,
Segment, Mixpanel, Zendesk and Marketo are integrations and are listed as
`NON_COMPETITORS`, which can never be flagged.

Flagged items are sorted to the front of the row and the suggested visible count
grows to fit them, so **a competitor is never the thing hidden behind "+N more"** —
surfacing one is the whole reason the row earns its space.

- **Known ambiguity:** a bare `apollo` may be Apollo GraphQL (a framework) rather
  than Apollo.io. It is flagged anyway — Apollo.io dominates this portal's data,
  and a missed displacement opening costs more than one wrong pill. The explicit
  GraphQL spellings are excepted, and deleting the single `"apollo"` line from
  `CONFIG.COMPETITORS` turns the bare match off.

### Added — every ownership row says whether the account is yours

`ownership` now returns **all three** owner rows — Outbound owner, Company owner,
Contact owner — on every render, each as
`{ label, name, ownerId, isMine, missing, unresolved }`. Rows used to be omitted
when the property was unset, which made "nobody owns this" indistinguishable from
"the section didn't load"; an unset owner is now an explicit `missing: true` with a
null name. The pre-existing rule holds: a numeric owner ID that the owner-name
cache cannot resolve shows **no name**, never the bare number.

`isMine` is three-state, and the third state is the point:

- `true` — the connected rep's own owner ID
- `false` — a different owner, and we can name them
- `null` — **we cannot say**, and the renderer must not flag it. No connected owner
  ID, no owner ID on the record (a property holding a *name* is not comparable to
  an ID), or an owner ID that resolved to no name. Falsely telling a rep an account
  isn't theirs is worse than saying nothing.

Colleague rows in **Others at this account** use the same helper and the same
semantics.

### Added — semantic tones for status pills

`EB.hubspotData.status.tone(kind, value)` maps a datapoint kind plus a raw CRM
value to one of five tone **names** — `positive`, `caution`, `negative`, `neutral`,
`info` — and `status.pill(kind, value)` returns `{ kind, slug, label, tone }` with
the humanized label alongside it. Covered: account grade (A/B → positive, C →
caution, D/F → negative), Company Status, contact lifecycle stage, `wiza_status`,
`icp_fit`, deal state (open / closed-won / closed-lost, from a deal row or a slug)
and sequence enrolment. Unmapped kinds and values are `neutral` — a status nobody
mapped is not evidence of anything, and a confidently wrong colour is worse than
grey. No colour appears anywhere in `hubspot-data.js`; the theme owns those.

All of the above is pure and covered by the view-model harness (2,201 assertions),
which runs `hubspot-data.js` in `node:vm` with no DOM and no network.
`CACHE_VERSION` is bumped to `11` for the new bundle shape.

### Changed — the side panel is on brand, and light only

A re-theme, not a redesign: no section moved, and the restyle itself does not
change the panel's height (measured against the same page rendered with the
previous type: **1,270px at 320px / 1,092px at 580px**, a −0.24% / −0.27%
difference that comes entirely from one typography fix, below). This **replaces**
the navy palette of the previous pass, which was derived by scraping `wiza.co`
rather than taken from the brand sheet.

- **The brand palette, verbatim.** White page, `#F6F8FA` cards, `#DFE1E6`
  borders, `#26114A` for every heading and body line, `#615E6E` muted, and
  `#7E43FF` violet as the primary accent — links, filled buttons, focus rings —
  backed by the supporting purple scale (`#9371F0`, `#4C24A3`, `#B5AEFF`,
  `#E4D8FD`, `#F5F0FF`). `#0C3380`/`#123769`/`#091948` navy is gone from the
  panel *and* from the on-page scheduler banner, which was still a near-black
  bar. Every value is declared exactly once, in one `:root` block; no rule below
  it contains a colour literal.
- **Dark mode is gone, not hidden.** No dark token set, no
  `@media (prefers-color-scheme: dark)`, no `data-theme`, and no
  System/Light/Dark control — `theme.js` and the `eb:settings.theme` key are
  deleted. `color-scheme: light` keeps Chrome's own scrollbars, `<select>` popups
  and autofill light as well, so the panel is fully light with the OS in dark
  mode (asserted at both widths under both OS preferences). A `theme` value left
  in a rep's `eb:settings` from the old build is ignored; the auto-sync toggle is
  unaffected and still round-trips.
- **Semantic colour means something now.** The four semantic pairs — positive
  `#1E7F5C`/`#E3F4EC`, caution `#9B6D27`/`#FDEAB9`, negative `#EA384C`/`#FCE6EA`,
  informational `#3671A8`/`#EBF2FC` — are reserved for state: lifecycle stage,
  company and Wiza status, sequence enrolment, deal open/won/lost, a stale
  capture, error and success lines, and the armed confirm step on a destructive
  write. Everything decorative — counts, the selected tab, hovers, skeletons, the
  `·` between facts — draws from the purple scale instead. The five tone names
  `hubspot-data.js` returns (`positive` / `caution` / `negative` / `neutral` /
  `info`) each have a matching `tone-*` CSS class, so a renderer hands over a
  tone name and never a colour.
- **A gear you can actually see.** The header's `⚙` glyph — small, low-contrast
  and platform-dependent — is now an inline SVG wheel: a 30×30 hit box round a
  20px glyph, ink stroke, `#F5F0FF` on hover and `#E4D8FD` while the popover is
  open, with a visible focus ring. Static markup, not injected, and no remote
  asset (MV3 CSP). Its ARIA contract is unchanged.
- **The connection dot beside the gear is removed.** It was 7px of colour with no
  label. Connection state now reads as a full status badge in the settings
  popover — **Connected** / **Connecting…** / **Not connected** / **Setup
  needed**, on the matching tone, with its own dot — and the CRM sections still
  say so in prose with a **Connect** link. The dot to the left of the wordmark is
  a different signal (prospect captured) and stays.
- **Header:** a white bar with a hairline under it instead of a coloured slab.
- **Type: Inter, four weights, one per role.** Inter with a platform-UI fallback
  and no webfont request (CSP, and the panel must work offline). **700** for
  structural ALL-CAPS labels, record titles and in-line emphasis; **600** for
  values, names, links and buttons; **500** for caption lines; **400** for
  running text. Ad-hoc weights are gone. One fix came out of this: a link with no
  size context was falling back to the 16px UA default, which made "Company
  LinkedIn" the largest type on a 320px panel.
- **Contrast is a gate.** Every text/background pair the panel can paint is
  measured on the painted pixels and meets WCAG AA (4.5:1 body and small text,
  3:1 large text, control edges and graphical marks) — 55 distinct pairs, at both
  widths, under both OS preferences.
  - **Three brand pairings do not clear AA at pill type sizes** and are called
    out where they are declared: `#EA384C` on `#FCE6EA` is 3.41:1, `#9B6D27` on
    `#FDEAB9` is 3.83:1, `#1E7F5C` on `#E3F4EC` is 4.34:1. Each tone therefore
    carries a slightly darkened value for **text** (`#C22E3F`, `#8C6223`,
    `#1D7B59`) while the brand value stays the tone's fill and graphical mark —
    the same split the accent already uses (`#7E43FF` fills, `#4C24A3` text on a
    tint).
  - **`#9491A1`, the sheet's caption grey, carries no text.** It is 3.08:1 on
    white and 2.89:1 on a card fill, below AA for small text and below even the
    3:1 non-text floor inside a card. Caption text uses `#615E6E` (5.9–6.3:1);
    `#9491A1` is left to control edges and the idle dot, where 3:1 is the bar.

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
