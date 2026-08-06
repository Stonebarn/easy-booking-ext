---
target: sidepanel.html
total_score: 30.5
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-08-06T14-25-33Z
slug: sidepanel-html
---
# Critique: Dialer Helper Pro side panel (v0.4.0, commit 6b08116)

Method: dual-agent (A: design review · B: detector/browser evidence). Target: sidepanel.html + sidepanel.js at HEAD snapshot (working tree had unrelated in-flight edits).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Skeletons, sync receipts, visible rate-limit countdown |
| 2 | Match System / Real World | 3 | "Cool down"/"Grade B" no legend; owner ontology is HubSpot's |
| 3 | User Control and Freedom | 3 | No undo after note lands; auto-sync lacks per-event cancel |
| 4 | Consistency and Standards | 2.5 | Same person red in one column, ink in next; red = error AND not-yours |
| 5 | Error Prevention | 4 | Idempotency hash, armed confirms, stale-capture warning |
| 6 | Recognition Rather Than Recall | 3 | 41 title-only disclosures (mouse-only recognition) |
| 7 | Flexibility and Efficiency | 2 | No click-to-copy email/phone; 17+ sub-24px tap targets |
| 8 | Aesthetic and Minimalist Design | 3 | Red flood; owner printed 3x; empty sentence repeated 6x |
| 9 | Error Recovery | 4 | Section-scoped errors; empty-beats-stale; failures name the fix |
| 10 | Help and Documentation | 2 | Red convention and grade scale explained nowhere in UI |
| **Total** | | **30.5/40** | **Good** |

## Design Specificity

High concept-specificity (their-time-first booking, wrong-number write-back with current values in selects, competitor partition, attribution run-length suppression; IA = theory of a cold call). Medium-low visual specificity (reskinnable grey-card register). Deterministic scan: 1 finding only — flat-type-hierarchy (9–14px, adjacent steps 1.11:1). Browser evidence: no overflow, no console errors, 9 elements at 9px, 17–19 sub-24px targets (inline links = WCAG-exempt FPs; wn-open 85x12, prose-more 32x11, tabs ~18px tall are real), 3 decorative alt="" (intentional), 41 title-only disclosures. No overlay (headless; extension page).

## Priority Issues

1. [P1] Red "not yours" floods panel, inverts semantic system (own-alert/peer-alert paint negative on routine state; same name red+plain in adjacent columns). Fix: neutral/caution "Owned by {name}", flag once at card level, reserve negative for errors/lost/DNC.
2. [P1] Notes editor at bottom of ~3-screen scroll at 320px despite being the most-used mid-call tool. Fix: sticky bottom notes bar or move under identity card.
3. [P1] #notes-result has no aria-live — sync outcome (the only dialer→CRM write path) silent to screen readers. Fix: role="status", mirror wn-result pattern.
4. [P2] Owner printed 3x with 3 labels for one person; implement the promised collapse ("Owner: X (all roles)").
5. [P2] Hover-title dependence (41 title-only) + sub-24px controls (wn-open, prose-more, activity tabs, #fill). Promote decision-relevant data to visible text; pad hit areas.
6. [P3] Empty/signed-out states repeat one sentence 6x; render once, hide rest.

## Persona Red Flags

Alex (power SDR): email wraps mid-word at 320; false red alarm every call; owner read 3x; 3-screen scroll to notes; NO click-to-copy on email/phone; fill-on-wrong-tab is two actions where focus-and-fill could be one.
Sam (SR/keyboard): popover focus trap + roving tabs textbook; Fill announces via #meta. But red flagging = title-on-span (unreachable), sync result silent, timeline direction announced as "up arrow".

## Minor

- variant-nomatch: Sync enabled while identity says "Not in HubSpot" (gate keys off ctx.hsContactId, identity off live fetch) — data-flow check.
- "Wiza user/account information" label too long; "Wiza usage" scans.
- Green header dot reads "connected", means "prospect captured".
- Strengths: dual-home booking cluster; state-honesty system; run-length attribution; painted-pixel AA accounting; initials fallback (broken-image impossible).

## Questions

1. Is the rare "this one's YOURS" the real color-worthy alert, not the routine inverse?
2. Which three facts change what the rep says in the next 10s — why aren't they 3x the size?
3. Should this be a notes editor with context around it, not a context browser with notes at the bottom?
