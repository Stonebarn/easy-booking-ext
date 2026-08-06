# Nooks live-DOM recon (Phase 0)

Captured 2026-08-05 against the live dialer (`app.nooks.in/workspaces/<id>/dialer`),
prospect expanded in the queue ("expanded view"). Wiza workspace; HubSpot
integration is connected in Nooks (its panes render HubSpot data natively).

**Headline finding:** Nooks ships stable, semantic `data-testid` attributes on
every section we need. Scrapers should anchor on these first, with the
label-text strategy as fallback — a much stronger position than the v0.2
label-only approach.

## Section anchors (expanded prospect view)

| Section | `data-testid` / `id` | Contents |
|---|---|---|
| Prospect fields | `prospect-fields-prospect-view-card` | Label→value rows: Email, Title, Sequence, AI Intel, Time Zone, Activity |
| Account fields | `account-fields-prospect-view-card` | Account-level fields |
| **HubSpot contact pane** | `hubspot-contact-pane-prospect-view-card` | Includes a **"Record ID" row = HubSpot contact ID** |
| **HubSpot account pane** | `hubspot-account-pane-prospect-view-card` | Includes **"Record ID" row = HubSpot company ID** (e.g. `54934007447`), Account Grade, Company Status, LinkedIn Company Page, Number of Employees, Prospecting Status |
| Notes card | `notes-prospect-view-card` (also `id`) | Header "Notes" + "Add note" link + **Prospect / Account tabs** + note list ("No notes" when empty) |
| Activity | `activity-prospect-view-card` | Prospect/Account tabs, connect/unanswered/replied/emails counts |
| Prospect activity | `prospect-activity-prospect-view-card` | |
| Account activity | `account-activity-prospect-view-card` | |
| LinkedIn | `prospect-linkedin-prospect-view-card` | Profile photo (`img`, licdn signed URL — expires), linkedin.com profile link, name, location, headline ("Role at Co \| ..."), About bio (confirmed via screenshot 2026-08-06) |
| Prospect name (header) | `prospectDataExpanded-prospectName` | Header also shows `Company • Title` line and phone |
| View tabs | `expanded-view-dashboard` / `-activity` / `-battlecards` / `-transcript`, `expanded-view-prospect` / `-account` | |
| Queue table | `dialing-table`, `dialing-row-0`, `prospect-name`, `prospect-phone-number`, `column-header-*` (incl. `column-header-prospectNote`, `column-header-timezone`) | |

## Notes editor (the scrape/inject target)

- "Add note" (a `<p cursor=pointer>` inside the notes card header) opens a **MUI
  dialog** (`[role="dialog"]`, no testid) titled **"Add a Prospect Note"** or
  **"Add an Account Note"** depending on the active tab; header shows the
  target entity name (e.g. "Intercoastal Mortgage — Account").
- The editor is a plain **`<textarea>`**, `rows=2`, placeholder
  **"Enter your note here..."** — NOT contenteditable, no rich text. Its `id`
  is MUI-generated (`:r158:` style) — unstable, do not anchor on it.
  Anchor: `[role="dialog"] textarea[placeholder="Enter your note here..."]`.
- Buttons: `Cancel` / `Save` (Save disabled until text present, shows a
  progressbar while saving). No testids on the buttons — match by text.
- **Notes have two scopes — Prospect and Account tabs** — mapping 1:1 onto
  HubSpot contact-level and company-level notes.
- Reading existing notes: they render inside `notes-prospect-view-card` under
  the active tab (empty state: "No notes"). Structure of a populated note list
  is **UNVERIFIED** (no saved note existed at capture time) — capture once a
  note exists.

## Network / persistence observations

- REST API at `api.nooks.in` (Firebase auth via `securetoken.googleapis.com`;
  Firestore realtime channels open). Relevant reads observed:
  - `POST /dialer_app/load_tasks`, `POST /tasks/pull_smart_list`
  - `GET /outreach/v2/tasks/pull_tasks_for_prospect?...&prospectId=97934`
  - `GET /v1/integration/custom_properties?...&integrationType=hubspot`
  - `GET /sep_integrations/properties?...&objectType=contacts&integrationType=hubspot`
  - `POST /v1/integration/activities`
- **No REST POST observed for the note save** — persistence appears to go over
  the Firestore Write channel. DOM scraping (not network interception) is the
  right capture strategy.
- The workspace has Nooks' **native HubSpot integration** enabled
  (`integrationType=hubspot` requests; HubSpot panes in the UI). **Confirmed
  (Jack, 2026-08-05): Nooks does NOT sync notes to HubSpot** — the extension's
  note sync (Phase 4) is the only path for getting dialer notes into the CRM.

## Consequences for the plan

1. **Both HubSpot record IDs are scrapeable from the DOM** (contact + company
   "Record ID" rows). Phase 3 can go straight to
   `GET /crm/v3/objects/{contacts|companies}/{id}` — the 5 req/s search-pool
   bottleneck disappears for matched prospects. Keep email/domain search only
   as fallback when the panes are absent/empty.
2. Scraper config should gain a `TESTID_ANCHORS` map (primary) alongside the
   existing label arrays (fallback), staying within the "no generated css-*
   classes" convention — `data-testid` is a stable, intentional hook.
3. Identity fields (name, title, company, phone, email) are all available:
   header (`prospectDataExpanded-prospectName` + company•title line) and
   `prospect-fields-prospect-view-card` rows.
4. Timezone still available as `EDT (3:45 PM)` format in both queue column and
   prospect fields — existing `TZ_FIELD_RE` keeps working.

## Still unverified / to capture later

- **The disposition / call-outcome control** — the trigger the won-meeting
  celebration wants ("Meeting Booked"). It only exists during or after a live
  call, so no capture has it. Until it is captured, the celebration fires from
  the booking form instead (see the booking detection in content-scheduler.js).
  Run `docs/diagnostics/booked-signal-probe.js` in the dialer console on a
  freshly-dispositioned call; it prints the control's anchors and its option
  labels, which is everything the dialer-side trigger needs.
- **The booking confirmation screen** on scheduler.default.com — the same probe,
  run on the booking tab after a real booking, replaces today's deliberately
  broad phrase/URL guesses with the page's real markup.
- Populated note list DOM (need a saved note on screen).
- The **in-call view** (live dialing session) — recon above is the queue's
  expanded prospect view; the on-call layout may differ. Capture during a real
  session (user-driven; do not start sessions from automation).
- Whether the `data-testid` set differs between "User to view as" identities
  or workspaces.
