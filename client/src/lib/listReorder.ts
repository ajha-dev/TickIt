/**
 * Drag-to-reorder for a vertical list, on a local array.
 *
 * The Log grid reorders trackers and persists a `sortOrder` per row; this one
 * reorders whatever the caller hands it and persists nothing — the CHOICE
 * options it was built for are a plain `string[]` inside an unsaved draft, and
 * they reach the server only when Save is pressed, as part of the field.
 *
 * The gesture is `reorderGesture.ts`, unchanged and unforked. What is here is
 * the one-dimensional geometry: nearest slot by *row*, and a reflow that only
 * ever moves things up and down.
 *
 * This list lives inside a scrolling bottom sheet, which is why the gesture
 * hook resolves its scroller per gesture and why `touch-action: none` stays on
 * the grip. A row that gave up touch-action would take the sheet's scrolling
 * with it.
 */

import { useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'

import {
  boundsOf,
  useReorderGesture,
  type ActiveDrag,
  type ReorderGesture,
  type Slot,
} from './reorderGesture.ts'
import { arrayMove } from './trackerOrder.ts'

/** Which row a point is on: bands, not centres, so the ends stay reachable. */
function nearestRow(slots: Slot[], point: { x: number; y: number }): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]
    if (!s) continue
    const d = Math.abs(s.y + s.h / 2 - point.y)
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

export interface ListReorder {
  /** Put this on the element whose children are the reorderable rows. */
  containerRef: (node: HTMLElement | null) => void
  dragging: boolean
  draggedIndex: number | null
  targetIndex: number | null
  /** Spread onto each row. */
  itemProps: (index: number) => {
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
    style: CSSProperties
  }
  /** Spread onto the grip inside that row. */
  handleProps: ReorderGesture['handleProps']
}

/**
 * @param length  how many rows there are
 * @param onMove  called with (from, to) on release, or on an arrow key
 * @param enabled false and nothing is armed
 */
export function useListReorder(
  length: number,
  onMove: (from: number, to: number) => void,
  enabled = true,
): ListReorder {
  const gesture = useReorderGesture({ length, nearest: nearestRow, onMove, enabled })
  const { active, targetIndex, itemGuardProps } = gesture

  const itemProps = useCallback(
    (index: number) => ({
      ...itemGuardProps,
      style: styleFor(index, active, targetIndex),
    }),
    [active, targetIndex, itemGuardProps],
  )

  return {
    containerRef: gesture.containerRef,
    dragging: active !== null,
    draggedIndex: active?.from ?? null,
    targetIndex,
    itemProps,
    handleProps: gesture.handleProps,
  }
}

/**
 * Where a row sits right now. The DOM order never changes mid-drag: the row in
 * hand follows the finger vertically, and the rows it has passed slide into the
 * gap it left.
 */
function styleFor(index: number, active: ActiveDrag | null, target: number | null): CSSProperties {
  if (!active || target === null) return {}

  if (index === active.from) {
    const own = active.slots[active.from]
    const { top, bottom } = boundsOf(active.slots)
    const raw = active.doc.y - active.startDoc.y
    // Clamped to the list's own box: a row never floats out over the field
    // above or the Save button below.
    const dy = own ? Math.max(top - own.y, Math.min(bottom - (own.y + own.h), raw)) : raw
    return {
      transform: `translate3d(0, ${dy}px, 0) scale(1.02)`,
      transition: 'none',
      zIndex: 30,
      position: 'relative',
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
      // Mauve is THEME's "selected / in hand"; the row is lifted off the card
      // rather than dimmed, because a dimmed row reads as disabled.
      borderRadius: 12,
      boxShadow: '0 0 0 1.5px var(--color-mauve), 0 18px 30px -12px rgba(0,0,0,0.95)',
    }
  }

  const slotOfIndex = arrayMove(
    active.slots.map((_, i) => i),
    active.from,
    target,
  ).indexOf(index)
  const from = active.slots[index]
  const to = active.slots[slotOfIndex]
  if (!from || !to) return {}

  const dy = to.y - from.y
  return {
    transform: dy === 0 ? undefined : `translate3d(0, ${dy}px, 0)`,
    transition: 'transform 180ms cubic-bezier(0.2, 0.9, 0.25, 1)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  }
}
