/**
 * Long-press-then-drag reordering for a two-dimensional grid.
 *
 * Built for the Log screen, where the primary gesture is already taken: PLAN's
 * first principle is that **one tap logs**, so reordering has to be a different
 * gesture entirely and must not put a single millisecond in front of a tap.
 *
 * The rules that follow from that, all of them load-bearing:
 *
 * - **A tap logs immediately.** Nothing here delays, debounces or intercepts a
 *   short press; the tile's own `onClick` fires exactly as it did before.
 * - **A drag never logs.** Once the long press has armed, the click that
 *   inevitably follows the release is swallowed in the capture phase, before it
 *   can reach the tile. A phantom feed logged every time you tidy the grid
 *   would be worse than not having reordering at all.
 * - **Movement before the timer cancels the press.** Sliding a thumb over a
 *   tile is a scroll, not a pickup, so any real movement inside the long-press
 *   window abandons it and the page scrolls normally.
 * - **The page holds still during a drag** — a non-passive `touchmove`
 *   preventDefault, attached only while a drag is live. Outside a drag,
 *   scrolling is completely untouched.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import { hapticLog, hapticStop } from './haptics.ts'
import { arrayMove } from './trackerOrder.ts'

/** Long enough not to fire on a fumbled tap, short enough not to feel stuck. */
const LONG_PRESS_MS = 420
/** Past this, the finger is scrolling and the pickup is abandoned. */
const MOVE_TOLERANCE_PX = 10
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
  /** Index of the tile currently under the finger, or null. */
  draggedIndex: number | null
  /** Index the tile would land on if released now, or null. */
  targetIndex: number | null
  /** Spread onto each tile's wrapper element. */
  itemProps: (index: number) => {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
    style: CSSProperties
  }
}

/**
 * @param ids   the tiles' ids, in the order they are rendered
 * @param onCommit called once, on release, with the new order
 */
export function useGridReorder(ids: string[], onCommit: (next: string[]) => void): GridReorder {
  const [active, setActive] = useState<Active | null>(null)

  const container = useRef<HTMLElement | null>(null)
  const idsRef = useRef(ids)
  idsRef.current = ids

  /** The armed-but-not-yet-fired long press. */
  const pending = useRef<{
    pointerId: number
    index: number
    x: number
    y: number
    timer: ReturnType<typeof setTimeout>
    el: HTMLElement
  } | null>(null)

  /** Set the moment a drag arms; consumed by the click that follows release. */
  const swallowClick = useRef(false)
  const clientY = useRef(0)

  const cancelPending = useCallback(() => {
    if (pending.current) clearTimeout(pending.current.timer)
    pending.current = null
  }, [])

  useEffect(() => () => cancelPending(), [cancelPending])

  const isDragging = active !== null

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

  const itemProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        if (idsRef.current.length < 2) return
        swallowClick.current = false
        cancelPending()

        const el = e.currentTarget
        const pointerId = e.pointerId
        const x = e.clientX
        const y = e.clientY
        clientY.current = y

        const timer = setTimeout(() => {
          pending.current = null

          const parent = container.current
          if (!parent) return
          const slots = Array.from(parent.children).map((child) => {
            const r = child.getBoundingClientRect()
            return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height }
          })
          if (slots.length !== idsRef.current.length) return

          // Now, and only now, is this no longer a tap. The heavier haptic is
          // the signal that the app has left logging mode.
          hapticStop()
          swallowClick.current = true
          try {
            el.setPointerCapture(pointerId)
          } catch {
            /* the pointer is already gone */
          }
          const doc = { x: x + window.scrollX, y: y + window.scrollY }
          setActive({ pointerId, from: index, startDoc: doc, doc, slots })
        }, LONG_PRESS_MS)

        pending.current = { pointerId, index, x, y, timer, el }
      },

      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        clientY.current = e.clientY

        const p = pending.current
        if (p && p.pointerId === e.pointerId) {
          // Movement before the timer means this was a scroll all along.
          if (Math.abs(e.clientX - p.x) > MOVE_TOLERANCE_PX || Math.abs(e.clientY - p.y) > MOVE_TOLERANCE_PX) {
            cancelPending()
          }
          return
        }

        setActive((a) => {
          if (!a || a.pointerId !== e.pointerId) return a
          const doc = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }
          if (doc.x === a.doc.x && doc.y === a.doc.y) return a
          return { ...a, doc }
        })
      },

      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
        cancelPending()
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
        cancelPending()
        setActive((a) => (a && a.pointerId === e.pointerId ? null : a))
      },

      // A long press on a tile must not raise the platform's own menu.
      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        if (swallowClick.current || active) e.preventDefault()
      },

      // The one line that stops a reorder from logging a phantom event.
      onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      },

      style: styleFor(index, active, targetIndex),
    }),
    [active, targetIndex, cancelPending, onCommit],
  )

  return {
    containerRef: (node) => {
      container.current = node
    },
    dragging: isDragging,
    draggedIndex: active?.from ?? null,
    targetIndex,
    itemProps,
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
    return {
      transform: `translate3d(${active.doc.x - active.startDoc.x}px, ${active.doc.y - active.startDoc.y}px, 0) scale(1.05)`,
      transition: 'none',
      zIndex: 30,
      position: 'relative',
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none',
      // Matches --radius-tile, so the ring sits exactly on the tile's edge.
      // Mauve is THEME's "selected / in hand", and the tile is lifted off the
      // field rather than dimmed — a dimmed tile reads as disabled.
      borderRadius: 20,
      boxShadow:
        '0 0 0 1.5px var(--color-mauve), 0 26px 46px -14px rgba(0,0,0,0.95)',
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
