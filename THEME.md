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

## Tracker palette — 8 slots, separated on lightness *and* hue

Extended for *separability*, and separated on **two** axes rather than one.

The first version of this table was the five supplied colours plus three more,
all matched on lightness (~78–84%) so they read as one pastel set. Measured with
a colour-vision validator, that set failed: the worst adjacent pair was ΔE 3.0
under deuteranopia (`#8FD3E8` ↔ `#F3B6E4`) and ΔE 4.3 under *normal* vision
(`#8E94F2` ↔ `#9FA0FF`, ~3° apart in hue — those two should never both have been
tracker colours). Matching everything on lightness is what caused it:
**deuteranopia collapses the red–green axis**, so two colours that differ only
in hue along it become the same colour, and no hue spacing fixes that. A
lightness difference survives every simulation.

So the slots below hold hues from the family and vary their lightness step:
OKLCH L 0.52–0.66, C ≥ 0.10.

| # | Hex | Hue | L | Name |
|---|---|---|---|---|
| 1 | `#A4517D` | 349° | 0.55 | plum |
| 2 | `#7EA040` | 126° | 0.66 | moss |
| 3 | `#9272CB` | 299° | 0.62 | violet |
| 4 | `#29885E` | 160° | 0.56 | fern |
| 5 | `#3A98D4` | 241° | 0.65 | sky |
| 6 | `#CB6854` |  33° | 0.63 | clay |
| 7 | `#4C66A5` | 266° | 0.52 | indigo |
| 8 | `#22A89A` | 184° | 0.66 | teal |

Verified: every adjacent pair ≥ ΔE 15 under normal vision (worst 17.7),
≥ ΔE 15 under protanopia (15.9) and deuteranopia (15.4), and every colour
≥ 3.4:1 against `--ink-850` and `--ink-900` as a non-text indicator.

**The order is the safety mechanism, not a preference.** New trackers cycle this
list in order, skipping colours already used in the current profile before
repeating; reshuffling it puts weakly separated colours next to each other in a
two-tracker profile.

None of the five supplied colours appears here, and that is the point of the
section above: they are UI identity, and they keep those roles untouched. The
supplied hues are still represented — indigo and violet are the periwinkle and
mauve hues re-stepped, teal and sky the ice hue, plum the rose hue — but at a
lightness and chroma that can actually carry identity.

Because these sit lower on the lightness ramp than the old pastels, the "never
fill a large area" rule below matters more, not less: they are still only ever
dots, bars, ticks, digits and 1px borders, and tile labels stay `--text`.

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
