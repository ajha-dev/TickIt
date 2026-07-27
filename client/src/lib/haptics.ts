/**
 * Tap confirmation you can feel without looking at the screen. Android/Chrome
 * only — iOS Safari has no Vibration API, so every call is best-effort.
 */

type Pattern = number | number[]

function buzz(pattern: Pattern): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch {
    /* vibration is a nicety, never a failure path */
  }
}

/** A Moment landed, or a Span started. */
export const hapticLog = (): void => buzz(18)

/** A Span was stopped — a heavier, two-part thud. */
export const hapticStop = (): void => buzz([14, 40, 26])

/** Something was undone or destroyed. */
export const hapticUndo = (): void => buzz([8, 30, 8])
