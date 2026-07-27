/**
 * Tracker colours. Chosen for a dark room: mid-luminance, high chroma, no pure
 * white and no deep blue (blue is the worst thing to look at at 3am).
 */

export const TRACKER_COLOURS = [
  '#ffb020', // amber — the house colour
  '#ff7a45', // ember
  '#f2545b', // signal red
  '#c084fc', // orchid
  '#4ade80', // pale green
  '#38bdf8', // ice
  '#facc15', // sodium
  '#fb7185', // rose
] as const

/** Deterministic colour for a new tracker, cycling by position. */
export function nextColour(index: number): string {
  return TRACKER_COLOURS[index % TRACKER_COLOURS.length] ?? TRACKER_COLOURS[0]
}

/** Falls back to amber when the server hands back something unusable. */
export function safeColour(colour: string | null | undefined): string {
  if (typeof colour === 'string' && /^#[0-9a-f]{3,8}$/i.test(colour)) return colour
  return TRACKER_COLOURS[0]
}
