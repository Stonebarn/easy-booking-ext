# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Wiza's internal SDR team — and only them, for the product's lifetime (confirmed
2026-08-06). The SDR is on a live sales call, running the Nooks dialer at
app.nooks.in in the main tab, with this extension open in Chrome's side panel
(320–580px). Attention is divided by definition: they are listening, talking,
and glancing. Jack Foley (jack.foley@wiza.com) owns the tool and is the
primary maintainer-user.

## Product Purpose

"Dialer Helper Pro" gives an SDR full prospect context the moment a call
connects, without leaving the dialer. The confirmed primary success measure is
**faster, better-informed calls** — time-to-context in seconds. Booking-form
autofill (Scheduler/Default) and Nooks-notes→HubSpot sync are supporting jobs
built on that foundation, not co-equal goals.

## Positioning

The only bridge between the Nooks dialer and Wiza's HubSpot portal: Nooks'
native HubSpot integration is display-only and does not sync notes (confirmed
2026-08-05), so this extension's note sync is the single write path from
dialer to CRM. It also reads Wiza's own product-usage data (Wiza User /
Wiza Account / Trial custom objects) so an SDR sees whether the prospect
already uses Wiza — context no generic CRM sidebar could show.

## Operating Context

- Chrome MV3 side panel (minimum Chrome 114), pinned extension ID
  `ihajiebioinbhaljdmaihgonjglhalpa`.
- Reads the Nooks dialer DOM via stable `data-testid` anchors (documented in
  docs/nooks-dom-recon.md); fills the booking form at scheduler.default.com.
- HubSpot portal 40063500; per-SDR OAuth. Token exchange runs on a Lovable
  Cloud edge function (`wiza-hs-connect.lovable.app`) because Wiza is pursuing
  SOC 2: **no secrets may ever live in this repo or the shipped extension**.
- Rate budget: HubSpot 110 req/10s portal-wide shared; the panel piggybacks
  and caches aggressively (bundle cache, direct-ID fast path over search).

## Capabilities and Constraints

- Capabilities: prospect identity + HubSpot contact/company context, ownership
  with red-flagging, account-context chips, colleagues at the account,
  Wiza product usage (custom objects with history sparklines), deals,
  activity timeline, notes capture with auto-sync on save, booking autofill
  with timezone resolution, wrong-number HubSpot write flow.
- The surface is named **"Dialer Helper Pro"**; "Nooks" must not appear in
  user-facing copy. The codebase keeps its internal "easy booking" identity
  (`eb:*` storage keys, `[EasyBooking]` log prefix) — do not rename internals.
- Code conventions are load-bearing: plain-JS IIFEs (`node --check` must parse
  every .js), `textContent` only for API/scraped strings (never innerHTML),
  safeUrl + `rel=noopener` for links, scraping anchored on `data-testid`
  (never generated css-* classes).
- `eb:currentProspect` storage writes reset the scheduler's fill state —
  its write cadence is untouchable; new capture data goes in separate keys.
- Undecided/unverified product facts are tracked in docs/ (live-verification
  items such as `sdr_company_owner` value shape and custom-object history
  density); do not paper over them.

## Brand Commitments

- Wiza brand, light-only — **never dark mode** (Jack, verbatim spec
  2026-08-06). The palette lives as tokens in sidepanel.html: white page,
  #F6F8FA cards / #DFE1E6 borders, ink #26114A, accent #7E43FF with the
  purple scale, semantic red/amber/green/blue **strictly for meaning, never
  decoration**. Inter/system sans.
- Idioms: label-over-value everywhere; no interpunct "·" separators
  (explicitly banned); tighter spacing than the official Wiza extension but
  its rounding (~10–12px) and restraint. The official Wiza extension
  screenshot is the standing cohesion reference.
- Official mark: icons/wizainc_logo.png (header, ~20px); ext_icon.png is the
  extension icon.

## Evidence on Hand

- Live HubSpot portal data (real contacts/companies/custom objects) — the
  panel is developed against real records, not invented fixtures alone.
- docs/nooks-dom-recon.md (live-DOM capture) and
  docs/PLAN-v3-hubspot-sidebar.md (architecture record) are factual project
  memory.
- A Playwright/vm test harness with a realistic fixture lives in the session
  scratchpad (ephemeral, rebuilt per session; suites: assert/variants/theme).
- No marketing claims, testimonials, or public-facing content exist or are
  needed — this product has no Persuade surface.

## Product Principles

1. **Glanceable under divided attention.** The SDR is mid-call; a two-second
   read beats a complete one. Density is a feature, scanability is the bar.
2. **Never falsely alarm.** Red flags only on certainty (3-state ownership
   logic; "No Activity Found" instead of fake sign-in errors). A wrong alarm
   mid-call is worse than a missed one.
3. **Degrade gracefully, never blanker than before.** Every data source has a
   fallback (custom objects → rollups, photos → initials, IDs → search);
   a failed fetch may never empty a section that had a cheaper answer.
4. **The dialer is the workspace.** The panel augments the call; it never
   interrupts, never steals focus, never demands input to keep working.
5. **CRM writes are sacred.** Every write is attributed to the SDR,
   validated before sending, and confirm-gated when destructive.

## Accessibility & Inclusion

WCAG AA informally (confirmed 2026-08-06): painted-pixel AA contrast and
keyboard operability are maintained as an engineering habit (the harness
measures real rendered contrast), but no formal audit or certification is
required. Screen-reader support is best-effort (aria-expanded on toggles,
alt/aria-hidden discipline on decorative images).
