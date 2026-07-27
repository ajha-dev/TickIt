/**
 * Tracker and profile colours — see THEME.md.
 *
 * These are *identity* colours, and they are a different job from the five
 * supplied UI colours, which keep their roles untouched (accent, focus ring,
 * running indicator). The first attempt at this list was the supplied pastels
 * plus three more: eight hues all sitting at 78–87% lightness. Measured, that
 * set collapsed — the worst adjacent pair was ΔE 3.0 under deuteranopia and
 * ΔE 4.3 under *normal* vision, which is two colours a full-sighted reader
 * cannot tell apart on a dim phone at 3am.
 *
 * The fix varies **lightness as well as hue**. Deuteranopia collapses the
 * red–green axis, so no amount of hue spacing separates a pastel pink from a
 * pastel aqua at the same lightness; a lightness step does. Each slot below
 * holds a hue from the family and moves its lightness/chroma step until the
 * whole set passes: OKLCH L 0.52–0.66, C ≥ 0.10, every adjacent pair ≥ ΔE 15
 * under normal, protan and deutan vision, and every colour ≥ 3.4:1 against
 * --ink-850 and --ink-900.
 *
 * The order is the CVD-safety mechanism and must not be reshuffled: it is what
 * puts the best-separated pairs next to each other for a tracker set of two or
 * three, which is the common case.
 *
 * They are never used as a fill: a tile mixes 8–12% of one into --ink-850 and
 * reserves full chroma for dots, bars, ticks and hairlines.
 */

export const TRACKER_COLOURS = [
  '#A4517D', // 349° plum
  '#7EA040', // 126° moss
  '#9272CB', // 299° violet
  '#29885E', // 160° fern
  '#3A98D4', // 241° sky
  '#CB6854', //  33° clay
  '#4C66A5', // 266° indigo
  '#22A89A', // 184° teal
] as const

const FALLBACK: string = TRACKER_COLOURS[6]

/**
 * The colour for the next tracker (or profile) in a set: the palette in order,
 * skipping anything already in use, and only repeating once all eight are
 * taken. Two trackers created back to back never collide.
 */
export function nextColour(used: Iterable<string | null | undefined>): string {
  const taken = new Set<string>()
  for (const colour of used) {
    if (typeof colour === 'string') taken.add(colour.toLowerCase())
  }

  const free = TRACKER_COLOURS.find((c) => !taken.has(c.toLowerCase()))
  if (free) return free

  // Every hue is spoken for — start the cycle again from the top.
  return TRACKER_COLOURS[taken.size % TRACKER_COLOURS.length] ?? FALLBACK
}

/** Falls back to the family's indigo when the server hands back something unusable. */
export function safeColour(colour: string | null | undefined): string {
  if (typeof colour === 'string' && /^#[0-9a-f]{3,8}$/i.test(colour)) return colour
  return FALLBACK
}

/**
 * A tile/card background: the tracker colour at 8–12% over --ink-850, which is
 * the only way a palette colour is ever allowed to cover area.
 */
export function tintedSurface(colour: string, percent = 10): string {
  return `color-mix(in oklab, ${colour} ${percent}%, var(--ink-850))`
}

/** A 1px identity border — full chroma, but only ever one pixel of it. */
export function tintedBorder(colour: string, percent = 22): string {
  return `color-mix(in oklab, ${colour} ${percent}%, transparent)`
}
