# Easy Booking v3 — HubSpot Sidebar Plan

**Goal:** Evolve the extension from a popup autofill tool into a full SDR sidebar:
per-SDR HubSpot OAuth, live contact/company context (properties, deals, activity),
and one-click sync of Nooks call notes into HubSpot on both the contact and company.

**Portal:** Wiza HubSpot (account `40063500`), ~8 SDR users (SDR Team + Inbound SDRs).

---

## Architecture decisions (settled during scoping)

| Decision | Choice | Why |
|---|---|---|
| OAuth flow | Public HubSpot app + `chrome.identity.launchWebAuthFlow` + **token exchange on a Lovable Cloud edge function** (final, 2026-08-05, SOC 2-driven) | HubSpot has no PKCE, so token exchange needs the client secret somewhere — and SOC 2 secrets-management controls rule out embedding it in source. Lovable is already-approved software at Wiza with a hosted secret store. The function (source: `lovable/hubspot-token-function.ts`) does exchange + refresh + introspect only, origin-locked to the pinned extension ID; **all CRM traffic stays Ext ↔ HubSpot directly**. (History: a zero-backend embedded-secret variant was briefly built the same day, then reversed for SOC 2.) |
| App listing | Unlisted public app | Public apps work without marketplace listing; installs are per-user via OAuth, which gives us per-SDR identity (`hubspot_owner_id` on notes). |
| UI surface | `chrome.sidePanel`, global (not per-tab) | Panel persists while SDR moves between Nooks and scheduler tabs. `openPanelOnActionClick: true`; remove `default_popup`. Chrome 114+ (team is on current Chrome). |
| Reactive data flow | Keep `chrome.storage.local` as the bus; side panel subscribes via `storage.onChanged` | Matches the existing content-script → storage → consumer pattern; panel document stays alive while open, so no service-worker wake gymnastics for UI updates. |
| HubSpot calls | Directly from the **side panel document** via `fetch` with `https://api.hubapi.com/*` host permission | Extensions bypass CORS for permitted hosts. Fetching from the panel (not the service worker) sidesteps MV3 SW sleep entirely — the panel page is long-lived while open, the SW is not. The backend only does token exchange. |
| Token storage & refresh | Refresh token in `chrome.storage.local`; access token in `storage.session`/memory; **refresh-on-demand** before each API batch (`expires_at - now < 5min`) | Access tokens live 30 min (`expires_in: 1800`); refresh tokens never expire and don't rotate. On-demand checking survives MV3 service-worker death with no scheduling; an alarm is an optional nicety, not the mechanism. `storage.session` alone would force re-auth every browser restart. Serialize concurrent refreshes (in-flight promise + storage mutex). |
| Rate limiting | Cache contactId by email + per-prospect data cache (5-min TTL) + ~500ms debounce on prospect change | Two shared pools per portal: general **110 req/10s** (batch/association reads) and — the real constraint — **CRM Search at 5 req/s**, excluded from the general pool. Every prospect change starts with 1–2 searches, shared across all 8 SDRs. Honor `Retry-After` on 429. |
| Build | Stay plain JS, no build step | `scripts/validate.mjs` + CI stay as-is; extend validation to cover new files. |

---

## What we actually have (verified by codebase scoping)

- `content-nooks.js` captures **email + timezone only** (`detectProspect()` returns exactly those). Name, company, phone, title, LinkedIn are **not captured anywhere** — all identity fields needed for HubSpot matching are net-new capture work. Contact matching by email works day one; company fallback can use the email domain.
- **The Nooks notes DOM is unknown.** `samples/*.html` are empty pre-hydration React shells (`<div id="root">` — zero notes/identity markup). The original selectors were derived against the live DOM, and the notes scraper needs the same: an explicit live-recon task (Phase 0). The repo's `.claude/settings.local.json` already pre-authorizes chrome-devtools/playwright for exactly this.
- The reusable capture primitive is `fromLabeledField()` (label-anchor + climb + extract from `textContent`). It **cannot read a `<textarea>` or `contenteditable` value** — those don't surface in `textContent` after user edits — so notes extraction needs a new terminal step (find the `textarea`/`[contenteditable]`/`[role="textbox"]` descendant and read `.value`/`.innerText`).
- **Storage-key hazard:** `content-scheduler.js`'s `storage.onChanged` handler resets fill state and un-dismisses the on-page banner on **any** write to `eb:currentProspect`, and the Nooks MutationObserver (`characterData: true`, whole document, 300ms debounce) fires on every typing pause. Notes and HubSpot state MUST live under separate keys (`eb:notes`, `eb:hs:*`), never nested in `eb:currentProspect`.
- `background.js` is badge-only with zero message passing (the one `EB_REQUEST_EMAIL` handler is dead code); its `alarms.onAlarm` already branches on name, so token-refresh alarms slot in cleanly (use `periodInMinutes`, armed once in `onInstalled`/`onStartup` — not re-armed per storage write).
- `popup.js` reads storage **once** at load (no listener) and "Fill now" works by re-writing the payload with a bumped `capturedAt` — a storage nudge, not a message. The panel port must add `storage.onChanged` + an age ticker.
- The `"eb:currentProspect"` key literal and a `fmtOffset()` helper are duplicated across files — v3 should introduce `lib/` of plain **native ES modules** (`lib/storage.js`, `lib/hubspot.js`, `lib/format.js`), which needs no bundler and preserves the no-build convention (stated three times across README/CONTRIBUTING).
- **CI landmines:** `.github/workflows/validate.yml` hard-codes the JS file list (new files silently unchecked — switch to a `git ls-files` glob), and `node --check` parses `.js` as CommonJS so ES modules fail CI (name shared modules `.mjs` or use `--input-type=module`). `scripts/validate.mjs` doesn't validate `side_panel.default_path` — extend it.

---

## Phase 0 — Live DOM recon (blocker for identity capture + notes)

With a real prospect loaded in the Nooks dialer, drive the live DOM (chrome-devtools/playwright, already permitted) and document:

1. **Notes editor**: element type (`textarea` vs `contenteditable` vs rich-text framework like Slate/Lexical), its `aria-label`/`placeholder`/`role`, exact label text + casing, distance from label to editor (the current `FIELD_MAX_LEVELS_UP: 3` climb budget may be too small), whether notes are per-call or per-contact, and whether a save/commit event exists.
2. **Identity fields**: exact label strings for name, company, phone, title, LinkedIn rows in the contact card (to extend the `FIELD_LABELS` pattern).
3. **Disposition control** (if we ever want call outcomes): type and labels.

Output: a short `docs/nooks-dom-recon.md` with the anchors. Per CONTRIBUTING, no generated `css-*` classes — stable signals only.

---

## Phase 1 — Side panel shell (replace popup)

1. Manifest: add `"sidePanel"` permission + `"side_panel": {"default_path": "sidepanel.html"}`; remove `action.default_popup` but **keep a bare `"action": {}`** (toolbar icon still toggles the panel); set `minimum_chrome_version: "114"`; add `https://api.hubapi.com/*` to `host_permissions`.
2. `background.js`: `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in `onInstalled` (note: a popup defined in the manifest defeats this — hence removing it; a fallback popup can be re-enabled at runtime with `chrome.action.setPopup()` if ever needed).
3. Create `sidepanel.html` / `sidepanel.js`: port popup UI (current prospect card, capture age, "Fill now" button), subscribe to `storage.onChanged` for live updates (read current state with `storage.local.get()` first — messages sent while the panel was closed are lost, storage is the source of truth), add empty sections (HubSpot login, Contact, Company, Deals, Activity, Notes) as placeholders.
4. Layout: the panel is full-height and user-resizable with a ~320px floor and **no programmatic width control** — replace the popup's fixed-width styles with `width: 100%` flex layout that works at 320px. Add `prefers-color-scheme: dark` styles (Chrome themes only the panel frame, not our document). Remove any `window.close()`-style dismiss logic — the panel is persistent by design, and init code must handle a new prospect loading *under an already-open panel*.
5. Extend `scripts/validate.mjs` for the new files; delete `popup.html`/`popup.js` once parity is confirmed.

**Exit criteria:** sidebar opens from toolbar icon, live-updates as prospects change in Nooks, Fill-now works. No HubSpot yet.

## Phase 2 — Per-SDR OAuth

1. Create the HubSpot public app (classic/legacy style — the new 2025.2+ platform caps unlisted installs; irrelevant for one portal but classic has no cap) in a free developer account; accept the AUP (installs fail without it). Scopes: `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read`, `crm.objects.owners.read`. Engagement reads are historically gated by the contacts scopes; add granular scopes (`crm.objects.notes.read`, `crm.objects.emails.read`, …) only when a MISSING_SCOPES error names them — some don't appear in the scope picker (known HubSpot gap). Do NOT use deprecated `sales-email-read`.
2. **Spike first (both flagged UNVERIFIED in research):** confirm HubSpot's app settings accept `https://<extension-id>.chromiumapp.org/hubspot` as a redirect URL (meets all documented rules but unconfirmed in the wild; fallback = redirect to a worker-hosted page that `launchWebAuthFlow` intercepts), and smoke-test which engagement scopes are actually needed/selectable.
3. Token exchange lives in a **Lovable Cloud edge function** (`lovable/hubspot-token-function.ts` is the canonical source; deployed via Lovable). Secrets `HUBSPOT_CLIENT_ID`/`HUBSPOT_CLIENT_SECRET` in Lovable's secret store only. Contract: `POST {action: "exchange", code}` → tokens + SDR identity (server-side introspect); `POST {action: "refresh", refresh_token}` → fresh access token. Origin-locked to `chrome-extension://ihajiebioinbhaljdmaihgonjglhalpa`; CORS headers make it callable from the panel without extra host permissions. The extension config holds only CLIENT_ID + the function URL.
4. Extension auth module (`hubspot-auth.js`, plain-IIFE style per CI constraint):
   - `login()` → `chrome.identity.launchWebAuthFlow` → code → direct token exchange → tokens; then `POST /oauth/v3/token/introspect` for the SDR's email/`hub_id`.
   - `getAccessToken()` → return cached if fresh, else direct refresh (on-demand is the primary mechanism; single-flight guard); 401 → one refresh-and-retry.
   - `logout()` → clear tokens (optionally revoke via `DELETE /oauth/v1/refresh-tokens/{token}`).
   - Map SDR email → `hubspot_owner_id` once via `GET /crm/v3/owners/?email=` (owner ID ≠ user ID) and store it for note attribution.
5. Panel UI: signed-out state → "Connect HubSpot" button; signed-in state shows SDR name + disconnect.

**Exit criteria:** each SDR can connect/disconnect; tokens survive browser restarts; refresh works unattended; created test note attributes to the right owner.

## Phase 3 — HubSpot context in the sidebar

Prep: extend `content-nooks.js` to capture the identity fields found in Phase 0 recon (name, company, phone, title) via new `FIELD_LABELS`-style config arrays — net-new capture, documented in the README config table per CONTRIBUTING.

On prospect change (email in `eb:currentProspect`), the panel fetches and renders:

1. **Contact match** — `POST /crm/v3/objects/contacts/search` filter `email EQ` (consider a second filter group on `hs_additional_emails CONTAINS_TOKEN`). This is the scarce call (5 req/s portal-wide) — cache email→contactId aggressively. Show configurable property list (default: lifecycle stage, owner, last activity date, lead status, title, phone). Not found → "Create contact?" affordance (stretch).
2. **Company + deal IDs in one call** — `GET /crm/v3/objects/contacts/{id}?associations=companies,deals`, then `GET /crm/v3/objects/companies/{id}` (name, domain, industry, employee count, owner). Fallback: company search by email domain (another search-pool call — cache it).
3. **Deals** — `POST /crm/v3/objects/deals/batch/read` (max 100/batch) for `dealname`, `dealstage`, `pipeline`, `amount`, `closedate`, `hubspot_owner_id`. Fetch `GET /crm/v3/pipelines/deals` once and cache to render human-readable stage/pipeline labels. Link each row to the HubSpot record (`app.hubspot.com/contacts/40063500/record/0-3/{id}`).
4. **Activity** — no single timeline endpoint exists (legacy engagements v1 is deprecated): v4 associations contact→{calls, emails, meetings, notes, tasks} (parallel), then batch read each type with `hs_timestamp` + type-specific props (`hs_call_title/disposition/duration`, `hs_email_subject/direction`, `hs_meeting_title/outcome`, `hs_note_body`, `hs_task_subject/status`); merge, sort desc, show latest ~10 with type icons. ~10 requests worst case per prospect — from the roomier 110/10s pool and cacheable per contactId.
5. Caching layer (`lib/hubspot-cache.mjs`): per-email cache, 5-min TTL, manual refresh button; in-flight dedup so tab-switch storms don't burn the shared limits; on 429 honor `Retry-After`.
6. Property config: hardcode sensible defaults now; a small options page listing which properties to display is a fast follow.

**Exit criteria:** loading a prospect in Nooks populates contact, company, deals, and recent activity in <2s warm-cache, with linkouts to HubSpot.

## Phase 4 — Notes scraping + sync

1. Extend `content-nooks.js` with a notes scraper built from the Phase 0 recon: label-anchor to locate the notes region, then a **new terminal extraction step** reading the editor's `.value` (textarea) or `.innerText` (contenteditable) — `fromLabeledField`'s `textContent` read cannot see edited values. Store under a **separate key** `eb:notes` `{ text, html, prospectEmail, capturedAt }` (never inside `eb:currentProspect` — see storage-key hazard above). Tie notes to the prospect captured at the same time to avoid cross-prospect bleed. Watch scan cost: the observer fires per keystroke; keep the notes pass cheap or raise its debounce.
2. Panel Notes section: preview scraped notes, editable textarea before send, **"Sync to HubSpot"** button.
3. Sync = one `POST /crm/v3/objects/notes` with `hs_note_body` (HTML-safe, max 65,536 chars), required `hs_timestamp`, `hubspot_owner_id` = the SDR, and associations in the create payload: `{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": 202}` → contact, `190` → company (both IDs verified current; confirmable per-portal via `GET /crm/v4/associations/{from}/{to}/labels`).
4. Idempotency: hash last-synced note text per prospect in storage; warn on duplicate sync; show success state with a link to the created note.
5. Optional (decide later): auto-sync on call end / prospect change instead of manual button.

**Exit criteria:** an SDR finishes a call, clicks Sync, and the note appears on both the contact and company timelines in HubSpot attributed to them.

## Phase 5 — Hardening & rollout

- Error surfaces in-panel (token expired, rate limited → retry-after, contact not found).
- **Tooling debt**: extend `scripts/validate.mjs` to validate `side_panel.default_path`, new permissions, and `minimum_chrome_version`; switch the CI syntax-check loop to a `git ls-files` glob; settle the ESM check (`.mjs` naming or `--input-type=module`).
- **README rewrite is a deliverable, not polish**: the Privacy & permissions section currently states "Nothing is sent to any external server" — false once HubSpot egress, OAuth tokens, and new host permissions land. The architecture diagram and config tables also change. This is the artifact reps (and whoever approves the rollout) will read.
- CHANGELOG (Keep-a-Changelog format, `## [Unreleased]` section) + version bump — **decide the number up front**: CONTRIBUTING declares SemVer and v3 is breaking (popup removed, network egress added), so this is `0.3.0` or `1.0.0`, not "3.0.0"; git history's "v2" = `0.2.0`.
- Land as several small PRs per CONTRIBUTING (recon → shared lib → side panel → OAuth → context → notes sync), not one mega-PR.
- Pilot with 1–2 SDRs → full SDR team; monitor the shared rate limit under real usage.

---

## Risks

- **Notes DOM unknown until Phase 0** — the scraper design (and whether notes are per-call or per-contact) depends entirely on live recon; scope after recon, not before.
- **Nooks DOM drift** — notes editor selectors will be as brittle as the contact card; keep the CONFIG-driven anchor pattern (no generated `css-*` classes) and log loudly on miss.
- **Scheduler thrash** — any write to `eb:currentProspect` resets the booking tab's fill state and banner; new state goes in separate keys, and consider gating the scheduler's reset on the email actually changing.
- **Shared rate limits** — the CRM Search pool (5 req/s, portal-wide) is the tight one; every prospect change starts with a search, multiplied across 8 SDRs dialing in parallel. General pool is 110 req/10s (~10 requests/prospect uncached). Caching in Phase 3 is not optional.
- **Redirect URI unverified** — `chromiumapp.org` URLs meet HubSpot's documented rules but no confirmed precedent was found; spike it first in Phase 2 (fallback pattern exists).
- **Engagement scope murkiness** — some granular engagement scopes reportedly don't show in HubSpot's scope picker; plan scope selection empirically, driven by MISSING_SCOPES errors.
- **Token-endpoint dependency** — the Lovable Cloud function is the single point of failure for sign-in and refresh (existing access tokens keep working ~30 min; CRM reads are unaffected once a token is held). Offboarding note for SOC 2 evidence: removing a user from the HubSpot portal (or revoking their Connected App entry) kills their tokens; the extension holds no shared secrets.
- **HubSpot app approval** — none needed for unlisted classic apps, but each SDR must have portal permissions covering the requested scopes or their individual install fails at consent time.
- **Convention pressure** — the no-build rule is stated three times across the docs; a framework sidebar would need explicit buy-in. Native ES modules in `lib/` keep us inside the convention.
