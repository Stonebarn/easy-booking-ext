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
