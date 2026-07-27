# TickIt — colour system

Built on the supplied periwinkle/mauve palette. Two separate jobs, deliberately
kept apart.

## The supplied palette — UI identity

| Token | Hex | Role |
|---|---|---|
| `--lavender-grey` | `#8895B3` | muted text, dividers, inactive tab icons, stencil labels |
| `--soft-periwinkle` | `#8E94F2` | **primary accent** — active tab, focus ring, primary button |
| `--wisteria-blue` | `#9FA0FF` | pressed/hover state of primary, live counter digits |
| `--mauve` | `#BBADFF` | secondary accent, selected chips, running indicator |
| `--mauve-2` | `#DAB6FC` | highlight, gradient terminus, sparingly for emphasis |

Use the supplied gradient (`135deg`, lavender-grey → mauve-2) **once per screen
at most** — the app title lockup or the primary action. A gradient everywhere
reads as a template.

## Why these cannot be the tracker colours

They span hue 222°–271° and sit at 62–85% lightness. Adjacent members
(`#8E94F2` vs `#9FA0FF`) are ~3° apart — indistinguishable side by side on a
dim phone screen. Tracker colour exists to identify a tracker at a glance in
the grid, on the day ribbon, and in the timeline. Five shades of the same
purple cannot carry that.

## Tracker palette — 8 hues, one family

Extended for *separability* while matched on lightness (~78–84%) and chroma so
they still read as one pastel set. First five are the supplied colours.

| # | Hex | Hue | Name |
|---|---|---|---|
| 1 | `#8895B3` | 222° | lavender grey |
| 2 | `#8E94F2` | 236° | soft periwinkle |
| 3 | `#9FA0FF` | 239° | wisteria |
| 4 | `#BBADFF` | 250° | mauve |
| 5 | `#DAB6FC` | 271° | orchid |
| 6 | `#F3B6E4` | 316° | rose |
| 7 | `#8FD3E8` | 193° | ice |
| 8 | `#A6E3C4` | 154° | mint |

New trackers cycle this list in order, skipping colours already used in the
current profile before repeating.

## Surfaces — stay near-black

The pastels are all light. They must sit on a very dark, near-neutral ramp,
faintly cooled toward the palette's hue so the app feels of a piece.

| Token | Hex | Use |
|---|---|---|
| `--ink-900` | `#08090D` | app background |
| `--ink-850` | `#0D0F16` | cards, tiles |
| `--ink-800` | `#13161F` | raised surfaces, sheets |
| `--ink-700` | `#1C2030` | borders, dividers |
| `--ink-600` | `#2A2F44` | hairlines on raised surfaces |
| `--text` | `#E6E7EF` | primary text (not pure white) |
| `--text-dim` | `#8895B3` | secondary text (= lavender-grey) |

**Never fill a large area with a palette colour.** Tiles tint their background
by mixing ~8–12% of the tracker colour into `--ink-850`. Full chroma is reserved
for small elements: dots, rules, digits, icons, 1px borders.

This is the 3am mitigation. Cool hues at high luminance are more alerting than
warm ones; keeping them small and keeping the field near-black is what makes a
blue-violet palette survivable in a dark room.

## Destructive stays warm

| Token | Hex | Use |
|---|---|---|
| `--ember` | `#FF6B4A` | Stop, Delete — **only** these |

None of the five supplied colours can carry "stop": they are all the same
temperature as the accents, so a Stop button would stop reading as different in
kind. Warm-against-cool is doing real semantic work here, not decoration. It is
also the only colour a half-asleep person can find without reading.

## Contrast floor

Body text ≥ 4.5:1 against its background; large text and non-text indicators
≥ 3:1. `--text-dim` on `--ink-900` must be verified — it is the most likely
failure. Every pastel on `--ink-850` clears 3:1 comfortably; none of them clear
4.5:1 as *text on a tinted tile*, so tile labels use `--text`, never the
tracker colour.
