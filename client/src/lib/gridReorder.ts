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
 * The handle is the only element that gives up `touch-action`, so ordinary
 * scrolling through a long grid is untouched even while editing.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { hapticLog, hapticStop } from './haptics.ts'
import { arrayMove } from './trackerOrder.ts'

/** Drag within this of a screen edge and the page follows. */
const EDGE_PX = 90
const EDGE_MAX_SPEED = 14

/** A tile's slot, in document coordinates so page scrolling cannot stale it. */
interface Slot {
  x: number
  y: number
  w: number
  h: number
}

interface Active {
  pointerId: number
  from: number
  /** Where the finger went down, in document coordinates. */
  startDoc: { x: number; y: number }
  /** Where the finger is now, in document coordinates. */
  doc: { x: number; y: number }
  slots: Slot[]
}

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
  handleProps: (index: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
    style: CSSProperties
  }
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
  const [active, setActive] = useState<Active | null>(null)

  const container = useRef<HTMLElement | null>(null)
  const idsRef = useRef(ids)
  idsRef.current = ids

  /**
   * Belt and braces. The grip is its own button, so a drag's click can no
   * longer reach a tile — but a swallowed click costs nothing and a phantom
   * 3am feed logged by a stray gesture would cost a great deal.
   */
  const swallowClick = useRef(false)
  const clientY = useRef(0)

  const isDragging = active !== null

  // Nothing survives leaving edit mode mid-gesture.
  useEffect(() => {
    if (!enabled) setActive(null)
  }, [enabled])

  // Hold the page still, but *only* while a tile is actually in hand.
  useEffect(() => {
    if (!isDragging) return
    const block = (e: TouchEvent) => e.preventDefault()
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [isDragging])

  // Drag toward an edge and the page comes with you, so a grid taller than the
  // screen is still reorderable with one thumb.
  useEffect(() => {
    if (!isDragging) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const y = clientY.current
      const h = window.innerHeight
      let step = 0
      if (y < EDGE_PX) step = -Math.ceil(((EDGE_PX - y) / EDGE_PX) * EDGE_MAX_SPEED)
      else if (y > h - EDGE_PX) step = Math.ceil(((y - (h - EDGE_PX)) / EDGE_PX) * EDGE_MAX_SPEED)
      if (step === 0) return

      const before = window.scrollY
      window.scrollBy(0, step)
      const moved = window.scrollY - before
      if (moved === 0) return
      // The finger has not moved, but the document under it has.
      setActive((a) => (a ? { ...a, doc: { x: a.doc.x, y: a.doc.y + moved } } : a))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isDragging])

  const targetIndex =
    active && active.slots.length > 0 ? nearestSlot(active.slots, active.doc) : null

  const move = useCallback(
    (from: number, delta: number) => {
      const to = from + delta
      if (to < 0 || to >= idsRef.current.length) return
      hapticLog()
      onCommit(arrayMove(idsRef.current, from, to))
    },
    [onCommit],
  )

  const itemProps = useCallback(
    (index: number) => ({
      onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      },
      style: styleFor(index, active, targetIndex),
    }),
    [active, targetIndex],
  )

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || idsRef.current.length < 2) return
        if (e.pointerType === 'mouse' && e.button !== 0) return

        const parent = container.current
        if (!parent) return
        const slots = Array.from(parent.children).map((child) => {
          const r = child.getBoundingClientRect()
          return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }
        })
        if (slots.length !== idsRef.current.length) return

        clientY.current = e.clientY
        swallowClick.current = true
        hapticStop()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* the pointer is already gone */
        }
        const doc = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }
        setActive({ pointerId: e.pointerId, from: index, startDoc: doc, doc, slots })
      },

      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        clientY.current = e.clientY
        setActive((a) => {
          if (!a || a.pointerId !== e.pointerId) return a
          const doc = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }
          if (doc.x === a.doc.x && doc.y === a.doc.y) return a
          return { ...a, doc }
        })
      },

      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        if (!active || active.pointerId !== e.pointerId) return
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* already released */
        }
        const to = nearestSlot(active.slots, active.doc)
        const from = active.from
        setActive(null)
        // One write, on release. Never one per pixel.
        if (to !== from) {
          hapticLog()
          onCommit(arrayMove(idsRef.current, from, to))
        }
      },

      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
        setActive((a) => (a && a.pointerId === e.pointerId ? null : a))
      },

      /**
       * The accessible half. A grid has no single "up", so the arrows move the
       * tile one place earlier or later in the same order the server stores —
       * which is exactly what a drag does, without a pointer.
       */
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (!enabled) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          move(index, -1)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          move(index, 1)
        }
      },

      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        e.preventDefault()
      },

      // The ONLY element that gives up touch-action. Scrolling the grid with a
      // thumb anywhere else keeps working, edit mode or not.
      style: { touchAction: 'none' } as CSSProperties,
    }),
    [active, enabled, move, onCommit],
  )

  return {
    containerRef: (node) => {
      container.current = node
    },
    dragging: isDragging,
    draggedIndex: active?.from ?? null,
    targetIndex,
    itemProps,
    handleProps,
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

  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const s of slots) {
    left = Math.min(left, s.x)
    right = Math.max(right, s.x + s.w)
    top = Math.min(top, s.y)
    bottom = Math.max(bottom, s.y + s.h)
  }

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
 * document coordinates, it survives the page auto-scrolling underneath.
 */
function styleFor(index: number, active: Active | null, target: number | null): CSSProperties {
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
