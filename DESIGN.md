---
name: Dialer Helper Pro
description: Wiza's SDR side panel — dense, calm, glanceable prospect context for live calls
colors:
  page-white: "#ffffff"
  card-mist: "#f6f8fa"
  hairline: "#dfe1e6"
  gridline: "#eceff3"
  deep-plum-ink: "#26114a"
  dusk-grey: "#615e6e"
  edge-grey: "#9491a1"
  wiza-violet: "#7e43ff"
  violet-ink: "#4c24a3"
  lavender-mid: "#9371f0"
  lavender-soft: "#b5aeff"
  lilac-tint: "#e4d8fd"
  lilac-wash: "#f5f0ff"
  meadow-green: "#1e7f5c"
  meadow-green-text: "#1d7b59"
  meadow-tint: "#e3f4ec"
  ochre-amber: "#9b6d27"
  ochre-amber-text: "#8c6223"
  butter-tint: "#fdeab9"
  signal-red: "#ea384c"
  signal-red-text: "#c22e3f"
  blush-tint: "#fce6ea"
  slate-blue: "#3671a8"
  ice-tint: "#ebf2fc"
typography:
  display:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 700
  body:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "Inter, -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.05em"
rounded:
  tiny: "4px"
  tile: "5px"
  control-sm: "6px"
  chip: "7px"
  control: "8px"
  nested: "9px"
  card: "10px"
  round: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
components:
  button-primary:
    backgroundColor: "{colors.wiza-violet}"
    textColor: "{colors.page-white}"
    rounded: "{rounded.control}"
    typography: "{typography.body}"
  button-outlink:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.wiza-violet}"
    rounded: "{rounded.round}"
  chip-stat:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.deep-plum-ink}"
    rounded: "{rounded.chip}"
    padding: "1px 6px"
  card-section:
    backgroundColor: "{colors.card-mist}"
    textColor: "{colors.deep-plum-ink}"
    rounded: "{rounded.card}"
  card-won:
    backgroundColor: "{colors.meadow-tint}"
    borderColor: "{colors.meadow-green}"
    textColor: "{colors.meadow-green-text}"
    rounded: "{rounded.card}"
  block-labelled:
    textColor: "{colors.deep-plum-ink}"
    labelColor: "{colors.dusk-grey}"
    typography: "{typography.body}"
  bar-mode:
    backgroundColor: "{colors.lilac-wash}"
    borderColor: "{colors.wiza-violet}"
    textColor: "{colors.violet-ink}"
    rounded: "{rounded.control}"
motion:
  ease-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  feedback: "160ms"
  state: "240ms"
  entrance: "320ms"
  focal-burst: "1100–1800ms"
  stagger-step: "26ms"
  stagger-cap: 6
---

# Design System: Dialer Helper Pro

## Overview

**Creative North Star: "The Caddie's Card"**

A caddie's yardage book: dense, glanceable, everything the player needs before
the swing and nothing else. The SDR is mid-call with divided attention; every
surface is built for the two-second read — label over value, one fact per
line, counts in the section heads, and the single most important fact (the
record name) as the only large type on screen. Density is a feature, not a
compromise; the panel earns trust by never lying, never going silent, and
never raising its voice unless something truly demands it.

The panel feels **calm, fast, trustworthy, friendly**: a white page with mist
cards and hairlines, brand carried by one violet and its lavender family,
warmth from initials tiles and small purple moments rather than decoration.
Confirmed rejections: dark mode (never — the spec is light-only), interpunct
"·" separators (banned; structure comes from gaps, chips, and line breaks),
and semantic color as decoration.

**Key Characteristics:**
- Label-over-value everywhere; muted 10px caps label above a 12px ink value
- One decorated surface per screen (the live-capture booking cluster's wash)
- Tones fire for meaning only; the panel is violet-and-neutral at rest
- Denser than the official Wiza extension, but its rounding and restraint

## Colors

A white field with one violet voice and four semantic tones that speak only
when something is true.

### Primary
- **Wiza Violet** (#7e43ff): the one accent — primary button fills, focus
  rings, key metrics, sparkline strokes, competitor highlights.
- **Violet Ink** (#4c24a3): accent TEXT on tinted ground and anywhere the
  violet must pass AA on a wash; also the third data series.
- **Lavender Mid** (#9371f0) / **Lavender Soft** (#b5aeff): secondary data
  series and soft accents.
- **Lilac Tint** (#e4d8fd): selection highlights — the active tab outline,
  stage pill fills.
- **Lilac Wash** (#f5f0ff): the faintest layer — hovers, icon discs, and the
  booking cluster's wash (the panel's one decorated surface).

### Neutral
- **Page White** (#ffffff): the page, chip fills, and control faces.
- **Card Mist** (#f6f8fa): every section card fill.
- **Hairline** (#dfe1e6): card, pill, and divider strokes.
- **Gridline** (#eceff3): skeletons, disabled fills, minimal rules.
- **Deep Plum Ink** (#26114a): every heading and body line — text is never
  pure black.
- **Dusk Grey** (#615e6e): all secondary/caption TEXT.
- **Edge Grey** (#9491a1): NEVER text (fails AA) — control edges and the idle
  dot only, where 3:1 against the page is the bar.

### Semantic tones (meaning only)
Five tones matching the data layer's tone API — positive | caution |
negative | neutral | info. Each pairs a text color with a tint:
- **Meadow Green** (#1e7f5c, text #1d7b59 on #e3f4ec): live/positive states —
  the capture dot, in-sequence pills, up-trends.
- **Ochre Amber** (#9b6d27, text #8c6223 on #fdeab9): caution — armed
  confirms, cool-down status.
- **Signal Red** (#ea384c, text #c22e3f on #fce6ea): errors, lost deals,
  DNC-class facts — and nothing else.
- **Slate Blue** (#3671a8 on #ebf2fc): informational stage/status pills.

**The Meaning-Only Rule.** Semantic tones are reserved for facts with
valence. Decoration, emphasis, and data-viz come from the purple scale;
a tone on screen must be translatable to a sentence about the prospect.

**The Painted-Pixel Rule.** Contrast is verified on rendered pixels, not
spec sheets: the three `-text` variants exist because the brand tints fail
AA at pill sizes; fills keep the spec hex, text uses the darkened variant.

## Typography

**Display/Body Font:** Inter (system-sans fallback stack; no webfont — MV3
CSP forbids remote fonts and the system stack is the design)

**Character:** one quiet sans doing every job through four weights (400
body / 500 caption / 600 value / 700 head) and two cases. Hierarchy is
carried by weight, case, and tone far more than by size.

### Hierarchy
- **Display** (700, 20px, 1.25): empty-state headlines only — the one place
  with room to breathe ("No prospect captured yet").
- **Headline** (700, 14px): the record name — the panel's single biggest
  fact, and the only 14px on screen.
- **Body/Value** (400–600, 12px, 1.4): every value, control label, prose
  line, and input.
- **Label/Caption** (700 caps tracked 0.04–0.06em, or 400–600 sentence-case,
  10px): ALL-CAPS structural labels and muted metadata lines — the same size
  split by case and weight, exactly as the stat-chip idiom proves works.

**The Three-Sizes Rule.** The content scale is 10/12/14 plus the 20px
empty-state moment. New work never introduces a fifth size; if a role feels
missing, reach for weight, case, or tone first.

## Layout

A single scrolling column of section cards on a white page; the panel is
user-resizable 320–580px and never fixes a width. Contact & company render
as two columns inside one card (stacking is layout, not content). Spacing
rhythm is 4/6/8/12px — tight inside groups, 12px between sections. Related
facts cluster into wrap-grids of stat chips; long content clamps at two
lines behind MORE/LESS toggles. Nothing scrolls horizontally, ever; values
wrap (emails break after the @) rather than clip.

## Elevation & Depth

Flat. Depth is conveyed by fill steps (white page → mist card → white chip)
and hairlines, never shadows — with exactly one exception: the settings
popover floats on `0 8px 24px rgba(38,17,74,0.16)` (ink at 16%), because it
genuinely sits above the page. The live-capture dot carries a soft tone halo
as a status glow, not depth.

**The Flat-Field Rule.** Cards never cast shadows; if a surface needs
separation, it gets a fill step or a hairline, not elevation.

## Shapes

Soft, quiet rounding scaled to the element's size — the full observed ladder:
4px tiny controls, 5px the 20px initials tiles, 6px compact controls, 7px
stat chips, 8px buttons and inputs, 9px surfaces nested one inset inside a
card (outer radius minus inset, an optical rule), 10px section cards, and
fully-round (999px / 50%) pills, avatars, and icon discs. Borders are 1px
hairlines; the active tab is an outlined violet pill on white. No
zero-radius elements, no decorative borders thicker than 1px.

**The Nested-Radius Rule.** A surface inset inside a rounded parent takes
the parent's radius minus the inset, so the curves stay concentric.

## Components

### Buttons
- **Shape:** 8px radius, compact (12px type, 6–8px vertical padding)
- **Primary:** Wiza Violet fill, white label ("Fill form", "Sync to
  HubSpot") — the only saturated fills on screen
- **Armed/confirm state:** caution amber fill with its text pair — a
  two-step write always shows its armed state
- **Disabled:** gridline fill, dusk-grey label, and a visible one-line
  reason nearby (disabled controls always explain themselves)
- **Out-links:** bordered white pills with violet label ("Company LinkedIn",
  "Open in Wiza Admin")

### Stat chips
- **Style:** page-white box on the mist card, hairline border, 7px radius,
  1px 6px padding; 10px caps label over 12px value; label never wraps,
  value does
- **Tone:** only a *status* chip tints its value — a tone is meaning

### Labelled blocks
The stat chip taken vertical, for a fact too long to sit in a chip: the tech
stack and the ICP rationale.
- **Style:** 10px caps dusk-grey label on its own line, content beneath on
  the 12px body step in deep-plum ink — the same size and ink as every other
  value in the panel
- **Never an inline prefix.** These were "Tech: …" and "Why: …" rows at 10px
  in muted grey, and reps reported both as too small to read. 10px in this
  panel is for ALL-CAPS labels and single-fact caption lines, never for a
  paragraph or a list of product names. Moving the word into a label is what
  paid for the content's size, so no row got taller.
- Long content still clamps to two lines with an explicit MORE/LESS toggle;
  the DOM holds the full text either way

### Pills
- **Style:** fully-round, tone tint fill with tone text ("In sequence",
  "lead", "Grade B"); 10px, one per fact — never stacked decoration

### Cards / Sections
- **Style:** mist fill, hairline border, 10px radius; ALL-CAPS 10px section
  title with a 2px-stroke outline glyph outside the card; empty sections
  render nothing (never an empty box)

### Inputs / Fields
- **Style:** white face, edge-grey 1px stroke (the 3:1 bar), 8px radius;
  focus ring in violet; the notes textarea rests quiet (transparent border)
  and gains its edge on focus

### Tiles / Avatars
- **Style:** photos in circles (36px contact), company favicons in 28px
  rounded tiles, everyone else 20px initials tiles (5px radius) filled from
  the purple scale deterministically by name — initials render first, an
  image only replaces them after it decodes

### The sparkline row (signature)
Label over value+chart+trend on one line: 10px caps label, 12px value, an
inline SVG sparkline (~72×16) stroked in Wiza Violet at 1.5px with rounded
joins, a quadratic smooth through the points, and a faint lilac-tint area
fill; a small trend arrow (up = meadow green, down = dusk grey — never red;
usage decline is information, not an alarm). A zero latest value renders
muted, not bold — a zero is an absence, not a headline. Under 3 history
points the chart disappears and the value stands alone.

### The won-meeting receipt
A positive-tone card (meadow tint, meadow-green hairline) at the very top of
the column when a booking is confirmed: 10px caps "MEETING BOOKED" over the
prospect's 12px name, an "Open in HubSpot" out-link, the day's count as a
white round chip on the tone border, and a drawn dismiss glyph. It is the one
place a second decorated surface is allowed, because it is a fact with
valence rather than decoration — and it is transient. Absent by default;
never a modal, never focus-stealing.

### Arrange mode
Section order belongs to the rep, so the panel has one temporary mode for
setting it — and the mode carries all of its own chrome, so the everyday panel
carries none.

- **The mode bar** (`bar-mode`): a lilac-wash strip with a full-violet
  hairline, sticky to the top of the arrangeable list, holding a 10px caps
  "ARRANGING SECTIONS", a text Reset and a solid Done. Strong on purpose — the
  panel is in a state it must be able to leave.
- **Section heads gain** a 10px tabular "3/7" readout and two 20px ghost
  chevron buttons, right-aligned. Disabled at the ends of the *visible* list.
- **Each movable section** gains a 1px dashed lavender-soft edge showing how
  far it reaches. Deliberately faint: which sections are movable is said by the
  controls and the readout, so the edge is a supporting hint, and seven
  saturated boxes down a 320px column would drown what they describe.
- **Feedback** is a 320ms outline pulse on the section that moved — violet and
  solid, settling back to the dashed hint. Not a slide: sliding cards inside a
  scrolling panel fight the scroll position.
- **Nothing is pinned inside the mode.** The won-meeting receipt and the
  booking block stay above the bar and never move, because they are the call
  rather than context about it.

## Motion

Motion here is feedback first and spectacle once. The panel opens with every
element already in its final state, so a blocked or reduced animation costs
nothing but the explanation.

**Timing.** One easing curve for arrivals — `cubic-bezier(0.16, 1, 0.3, 1)`,
an exponential ease-out — at four durations: 160ms for feedback (a check
landing), 240ms for a state change (a card arriving), 320ms for an entrance
(the receipt), and 420ms for the sparkline drawing itself. Nothing routine
runs past half a second; long feedback reads as latency, and the rep is
mid-call.

**The focal moment.** Exactly one: the confetti burst when a meeting is
booked (1.1s / 1.45s / 1.8s for the 1st, 3rd, and 5th of the day). Canvas,
hand-rolled, purple scale with a single positive-tone piece, two cannons in
the bottom corners firing up and inward — the shape that reads in a 320px
column. It never takes a pointer event, stops the instant the panel is
hidden, and removes itself when spent.

**The supporting four.** The signature sparkline strokes in left to right
(`pathLength="1"`, so one keyframe serves every series); a prospect's
sections rise together in reading order with the stagger capped at 6 × 26ms;
a synced note's ✓ settles in over 160ms so a routine write feels certain
rather than celebrated; the live capture dot sends a slow ring outward while
a prospect is loaded. Each one explains something the panel already states in
words.

**Rules.** No audio, ever — the rep is on a live call and a sound would go
down the line. Nothing animates on every render: the arrival runs once per
prospect, the draw-in clears its own class. `prefers-reduced-motion` drops
every animation and the confetti entirely, keeping all final states. And the
one flourish has an off switch in Settings, because a delight nobody can
decline stops being one.

## Do's and Don'ts

### Do:
- **Do** keep every color a token used once — new hex values are a design
  decision, not an implementation detail.
- **Do** put the label over the value (10px caps over 12px ink) for every
  labeled datapoint.
- **Do** make disabled and empty states explain themselves in one plain
  sentence naming the fix.
- **Do** verify contrast on painted pixels (the harness measures rendered
  composites) — 4.5:1 for text, 3:1 for large/bold and control edges.

### Don't:
- **Don't** use dark mode, ever — light-only is a confirmed brand
  commitment (`color-scheme: light`).
- **Don't** use the interpunct "·" as a separator anywhere a rep can see —
  gaps, chips, and line structure instead.
- **Don't** spend semantic color on decoration or routine states — red is
  for errors, lost deals, and do-not-call facts only.
- **Don't** add a fifth font size or a second family; reach for weight,
  case, and tone.
- **Don't** let company imagery stand in for a person — a person's fallback
  is always their own initials.
