---
target: sidepanel.html
total_score: 33
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-06T18-15-44Z
slug: sidepanel-html
---
# Critique re-run: Dialer Helper Pro side panel (post fix-wave, commit 1f2c972)

Method: dual-agent (A: design review · B: detector/browser evidence). Prior baseline 30.5/40.

## Design Health Score: 33/40 (Good, high end)

| # | Heuristic | Score | Key evidence |
|---|-----------|-------|-----------|
| 1 | Visibility of status | 4 | Receipts, skeletons, visible rate-limit countdown, capture-dot aria |
| 2 | Real-world match | 3 | Rep-language copy; "(all roles, not you)" and "Cool down" need decoding |
| 3 | User control | 3 | Confirm-arms + disarms-on-edit; no undo for synced note / phone write |
| 4 | Consistency | 4 | Tokens once; three-sizes rule held; one idiom panel-wide |
| 5 | Error prevention | 4 | Armed confirms both writes; dedupe hash; prospect-bleed guard |
| 6 | Recognition | 3 | Labels everywhere; MORE(n) hides; activity type word title-only |
| 7 | Flexibility | 2 | Tasks automated but zero accelerators; call #80 = call #1 |
| 8 | Minimalist | 4 | Empty renders nothing; run-length suppression; one decorated surface |
| 9 | Error recovery | 3 | Typed per-section errors; BUT auth loss wipes rendered context |
| 10 | Help | 3 | UI self-documenting; internal tool |

Detector: ZERO findings (source + built page). Browser: no overflow, no sub-10px text, all hit24 targets pass effective ≥24px (remaining fails are text/pill links, interpretive under WCAG 2.5.8), alt hygiene clean, title-only 36 (mostly sanctioned absolute-timestamp layer), role=status inventory correct.

## Priority Issues (new backlog)
1. [P1] Auth loss mid-call wipes rendered context (crmOnAuth → clearAll): keep last bundle painted under a caution "session expired — showing cached · Reconnect" banner; clear only on explicit disconnect.
2. [P1] Sync fallback at bottom of 320px scroll behind Activity's inner scroll-trap: sticky receipt strip at panel bottom, or overscroll-behavior: contain + shorter activity ceiling ≤360px.
3. [P2] Account Context 8 chips undivided: split "Fit" / "Team" sub-rows or disclose team sizes.
4. [P2] No heading semantics (no h2 anywhere): make .section-title real h2s (visual unchanged) for SR section jumps.
5. [P3] Out-of-hours "their time" carries no tone though it's the most action-changing fact (Meaning-Only rule permits caution tint outside ~8-18h).

## Notables
- Specificity verdict: authored, not assembled (docked booking cluster, run-length attribution, never-red declines); sameness creeping between Account Context and Wiza Usage chip grids; Wiza (the USP) renders at commodity temperature.
- Cognitive load: ~1.5-2/8 failures, both density (8-chip grid; 6 activity tabs worst-case).
- Peak-end strong: timestamped sync receipt + honest partial-failure copy; worst valley = auth expiry mid-call.
- Sparkline trend is hover/title-only for SR (P3-adjacent); "MORE (1)" hides a single chip (render it); double hairline in no-prospect; email breaks BEFORE @ (doc says after; render is better, align doc).
- Sam: settings focus trap + roving tabs textbook; needs headings/skip mechanism.
- Provocations: tone the local time; receipt-as-primary (button shrinks); memory across calls (collapse state, learned order).
