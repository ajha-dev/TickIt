/**
 * The drag-to-reorder *gesture*, shared by every list that has one.
 *
 * There are two reorderable things in the app now — the Log grid of tiles and
 * the CHOICE options inside the tracker sheet — and they want the same
 * interaction and completely different geometry. This module owns the half that
 * must not diverge:
 *
 * - **An explicit grip.** Nothing is armed by touching the row itself, so a
 *   press on an option's text field is still a press on a text field.
 * - **Pointer Events**, one capture per gesture, one commit on release. Never
 *   one write per pointermove.
 * - **Arrow keys on the focused grip**, which is the whole keyboard story: a
 *   pointer gesture nobody can perform without a pointer is not accessible.
 * - **`touch-action: none` on the grip and on nothing else.** This is the rule
 *   the whole file exists to keep in one place. Put it on the row and the
 *   scrolling ancestor — a bottom sheet, in the options case — stops scrolling
 *   under the thumb, which is a far worse bug than a fiddly drag.
 *
 * Callers supply the geometry: how to pick the nearest slot to a point, and how
 * to draw the gap. See `gridReorder.ts` (2-D) and `listReorder.ts` (1-D).
 *
 * Coordinates are *content* coordinates of the nearest scrolling ancestor —
 * client position plus that element's scroll offset — so slots measured when
 * the finger went down survive the container auto-scrolling underneath it.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { hapticLog, hapticStop } from './haptics.ts'

/** Drag within this of the scroller's edge and it follows. */
const EDGE_PX = 90
const EDGE_MAX_SPEED = 14

/** An item's slot, in the scroller's content coordinates. */
export interface Slot {
  x: number
  y: number
  w: number
  h: number
}

export interface ActiveDrag {
  pointerId: number
  from: number
  /** Where the finger went down. */
  startDoc: { x: number; y: number }
  /** Where the finger is now. */
  doc: { x: number; y: number }
  slots: Slot[]
}

/**
 * Whatever is doing the scrolling — the page, or a sheet. The two differ only
 * in where the offset lives and what "the visible band" means.
 */
interface ScrollHost {
  offset: () => { x: number; y: number }
  /** The band, in client coordinates, whose edges trigger auto-scroll. */
  band: () => { top: number; bottom: number }
  /** Scroll by `dy`, and report how far it actually went. */
  scrollBy: (dy: number) => number
}

const pageHost: ScrollHost = {
  offset: () => ({ x: window.scrollX, y: window.scrollY }),
  band: () => ({ top: 0, bottom: window.innerHeight }),
  scrollBy: (dy) => {
    const before = window.scrollY
    window.scrollBy(0, dy)
    return window.scrollY - before
  },
}

function elementHost(el: HTMLElement): ScrollHost {
  return {
    offset: () => ({ x: el.scrollLeft, y: el.scrollTop }),
    band: () => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    },
    scrollBy: (dy) => {
      const before = el.scrollTop
      el.scrollTop = before + dy
      return el.scrollTop - before
    },
  }
}

/**
 * The nearest scrolling ancestor, or the page.
 *
 * Resolved per gesture rather than once, because the same component is mounted
 * inside a sheet in one place and on the page in another, and the answer is the
 * difference between auto-scroll working and auto-scroll moving the wrong
 * thing.
 */
function scrollHostFor(node: HTMLElement | null): ScrollHost {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) {
      return elementHost(el)
    }
  }
  return pageHost
}

export interface ReorderGesture {
  /** Put this on the element whose children are the reorderable items. */
  containerRef: (node: HTMLElement | null) => void
  /** The gesture in flight, or null. Consumers read it to draw the gap. */
  active: ActiveDrag | null
  /** The index the item would land on if released now, or null. */
  targetIndex: number | null
  /** Spread onto each item's wrapper — swallows the click that ends a drag. */
  itemGuardProps: {
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => void
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
 * @param length  how many items there are, in render order
 * @param nearest which slot a point is over — the caller's geometry
 * @param onMove  called once, on release (or on an arrow key), with the move
 * @param enabled false and nothing is armed at all
 */
export function useReorderGesture({
  length,
  nearest,
  onMove,
  enabled,
}: {
  length: number
  nearest: (slots: Slot[], point: { x: number; y: number }) => number
  onMove: (from: number, to: number) => void
  enabled: boolean
}): ReorderGesture {
  const [active, setActive] = useState<ActiveDrag | null>(null)

  const container = useRef<HTMLElement | null>(null)
  const host = useRef<ScrollHost>(pageHost)
  const lengthRef = useRef(length)
  lengthRef.current = length

  /**
   * Belt and braces. The grip is its own button, so a drag's click can no
   * longer reach the row — but a swallowed click costs nothing and a phantom
   * 3am feed logged by a stray gesture would cost a great deal.
   */
  const swallowClick = useRef(false)
  const clientY = useRef(0)

  const isDragging = active !== null

  // Nothing survives being disarmed mid-gesture.
  useEffect(() => {
    if (!enabled) setActive(null)
  }, [enabled])

  // Hold the scroller still, but *only* while something is actually in hand.
  useEffect(() => {
    if (!isDragging) return
    const block = (e: TouchEvent) => e.preventDefault()
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [isDragging])

  // Drag toward an edge and the scroller comes with you, so a list taller than
  // its container is still reorderable with one thumb.
  useEffect(() => {
    if (!isDragging) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const y = clientY.current
      const { top, bottom } = host.current.band()
      let step = 0
      if (y < top + EDGE_PX) step = -Math.ceil(((top + EDGE_PX - y) / EDGE_PX) * EDGE_MAX_SPEED)
      else if (y > bottom - EDGE_PX) {
        step = Math.ceil(((y - (bottom - EDGE_PX)) / EDGE_PX) * EDGE_MAX_SPEED)
      }
      if (step === 0) return

      const moved = host.current.scrollBy(step)
      if (moved === 0) return
      // The finger has not moved, but the content under it has.
      setActive((a) => (a ? { ...a, doc: { x: a.doc.x, y: a.doc.y + moved } } : a))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isDragging])

  const targetIndex = active && active.slots.length > 0 ? nearest(active.slots, active.doc) : null

  const step = useCallback(
    (from: number, delta: number) => {
      const to = from + delta
      if (to < 0 || to >= lengthRef.current) return
      hapticLog()
      onMove(from, to)
    },
    [onMove],
  )

  // Stable: the handler only ever reads a ref, so it never needs rebuilding.
  const itemGuardProps = useMemo(
    () => ({
      onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      },
    }),
    [],
  )

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (!enabled || lengthRef.current < 2) return
        if (e.pointerType === 'mouse' && e.button !== 0) return

        const parent = container.current
        if (!parent) return
        host.current = scrollHostFor(parent)
        const { x: ox, y: oy } = host.current.offset()
        const slots = Array.from(parent.children).map((child) => {
          const r = child.getBoundingClientRect()
          return { x: r.x + ox, y: r.y + oy, w: r.width, h: r.height }
        })
        if (slots.length !== lengthRef.current) return

        clientY.current = e.clientY
        swallowClick.current = true
        hapticStop()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* the pointer is already gone */
        }
        const doc = { x: e.clientX + ox, y: e.clientY + oy }
        setActive({ pointerId: e.pointerId, from: index, startDoc: doc, doc, slots })
      },

      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        clientY.current = e.clientY
        const { x: ox, y: oy } = host.current.offset()
        setActive((a) => {
          if (!a || a.pointerId !== e.pointerId) return a
          const doc = { x: e.clientX + ox, y: e.clientY + oy }
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
        const to = nearest(active.slots, active.doc)
        const from = active.from
        setActive(null)
        // One write, on release. Never one per pixel.
        if (to !== from) {
          hapticLog()
          onMove(from, to)
        }
      },

      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
        setActive((a) => (a && a.pointerId === e.pointerId ? null : a))
      },

      /**
       * The accessible half. The arrows move the item one place earlier or
       * later in the stored order — exactly what a drag does, without a
       * pointer. Left/right are included because a grid has no single "up".
       */
      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
        if (!enabled) return
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          step(index, -1)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          step(index, 1)
        }
      },

      onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
        e.preventDefault()
      },

      // The ONLY element that gives up touch-action. Scrolling the page — or
      // the sheet this list is sitting inside — keeps working everywhere else.
      style: { touchAction: 'none' } as CSSProperties,
    }),
    [active, enabled, nearest, onMove, step],
  )

  return {
    containerRef: (node) => {
      container.current = node
    },
    active,
    targetIndex,
    itemGuardProps,
    handleProps,
  }
}

/** Shared by both geometries: don't let the thing in hand leave its own list. */
export function boundsOf(slots: Slot[]): {
  left: number
  right: number
  top: number
  bottom: number
} {
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
  return { left, right, top, bottom }
}
