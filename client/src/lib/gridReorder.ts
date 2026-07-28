/**
 * Drag-to-reorder for a two-dimensional grid, driven by an explicit handle.
 *
 * This is edit-mode only, and that is the whole design. PLAN's first principle
 * is that **one tap logs**; the Log grid's tiles are log targets, so as long as
 * the screen is in its normal mode nothing here is armed at all — no timer, no
 * gesture arbitration, no way for tidying the grid to write an event. Reorder
 * lives behind the pencil, where a tile is a thing to manage rather than a
 * thing to press.
 *
 * The gesture itself — the grip, the pointer capture, the arrow keys, and the
 * rule that the grip is the only element to give up `touch-action` — lives in
 * `reorderGesture.ts` and is shared with the one-dimensional list. What is left
 * here is the part that is genuinely 2-D: nearest slot by distance, clamping
 * the tile to the grid's box, and the reflow.
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

function nearestSlot(slots: Slot[], point: { x: number; y: number }): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i]
    if (!s) continue
    const dx = s.x + s.w / 2 - point.x
    const dy = s.y + s.h / 2 - point.y
    const d = dx * dx + dy * dy
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

export interface GridReorder {
  /** Put this on the element whose children are the reorderable tiles. */
  containerRef: (node: HTMLElement | null) => void
  dragging: boolean
  /** Index of the tile currently in hand, or null. */
  draggedIndex: number | null
  /** Index it would land on if released now, or null. */
  targetIndex: number | null
  /** Spread onto each tile's wrapper element. */
  itemProps: (index: number) => {
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
    style: CSSProperties
  }
  /** Spread onto the grip inside that wrapper. */
  handleProps: ReorderGesture['handleProps']
}

/**
 * @param ids     the tiles' ids, in the order they are rendered
 * @param onCommit called once, on release, with the new order
 * @param enabled false in normal mode — nothing is armed
 */
export function useGridReorder(
  ids: string[],
  onCommit: (next: string[]) => void,
  enabled: boolean,
): GridReorder {
  const onMove = useCallback(
    (from: number, to: number) => onCommit(arrayMove(ids, from, to)),
    [ids, onCommit],
  )

  const gesture = useReorderGesture({
    length: ids.length,
    nearest: nearestSlot,
    onMove,
    enabled,
  })

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
 * Keep the dragged tile inside the grid's bounding box.
 *
 * The pointer itself is never clamped — targeting still follows the finger
 * wherever it goes — so this only stops the *visual* from leaving the column.
 */
function clampToGrid(
  slots: Slot[],
  index: number,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const own = slots[index]
  if (!own) return { dx, dy }
  const { left, right, top, bottom } = boundsOf(slots)

  return {
    dx: Math.max(left - own.x, Math.min(right - (own.x + own.w), dx)),
    dy: Math.max(top - own.y, Math.min(bottom - (own.y + own.h), dy)),
  }
}

/**
 * Where a tile sits right now.
 *
 * The DOM order never changes mid-drag: the tile in hand follows the finger,
 * and every other tile is translated from its own slot to the slot it would
 * occupy if the drop happened now. That is what makes the grid reflow around
 * the gap without a single reparent — and because the slots were measured in
 * the scroller's content coordinates, it survives auto-scrolling underneath.
 */
function styleFor(index: number, active: ActiveDrag | null, target: number | null): CSSProperties {
  if (!active || target === null) return {}

  if (index === active.from) {
    // The tile keeps the point you grabbed it by under your finger — but it is
    // clamped to the grid's own bounds, so grabbing a grip in the top-right
    // corner never swings the tile off the side of a 390px screen.
    const { dx, dy } = clampToGrid(
      active.slots,
      active.from,
      active.doc.x - active.startDoc.x,
      active.doc.y - active.startDoc.y,
    )
    return {
      transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.05)`,
      transition: 'none',
      zIndex: 30,
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
      // Matches --radius-tile, so the ring sits exactly on the tile's edge.
      // Mauve is THEME's "selected / in hand", and the tile is lifted off the
      // field rather than dimmed — a dimmed tile reads as disabled.
      borderRadius: 20,
      boxShadow: '0 0 0 1.5px var(--color-mauve), 0 26px 46px -14px rgba(0,0,0,0.95)',
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

  const dx = to.x - from.x
  const dy = to.y - from.y
  return {
    transform: dx === 0 && dy === 0 ? undefined : `translate3d(${dx}px, ${dy}px, 0)`,
    transition: 'transform 190ms cubic-bezier(0.2, 0.9, 0.25, 1)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  }
}
