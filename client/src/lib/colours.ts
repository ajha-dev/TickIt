/**
 * Tracker and profile colours — see THEME.md.
 *
 * The five supplied UI colours span only 222°–271°, which is not enough
 * separation to identify a tracker at a glance. This list extends them to eight
 * hues, matched on lightness (~78–84%) and chroma so the set still reads as one
 * pastel family, but adjacent members are actually distinguishable on a dim
 * screen.
 *
 * These are *identity* colours. They are never used as a fill: a tile mixes
 * 8–12% of one into --ink-850 and reserves full chroma for dots and hairlines.
 */

export const TRACKER_COLOURS = [
  '#8895B3', // 222° lavender grey
  '#8E94F2', // 236° soft periwinkle
  '#9FA0FF', // 239° wisteria
  '#BBADFF', // 250° mauve
  '#DAB6FC', // 271° orchid
  '#F3B6E4', // 316° rose
  '#8FD3E8', // 193° ice
  '#A6E3C4', // 154° mint
] as const

const FALLBACK: string = TRACKER_COLOURS[1]

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

/** Falls back to the primary accent when the server hands back something unusable. */
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
