import { useEffect } from 'react'

import { ValueChips } from './ValueChips.tsx'
import type { FieldDef } from '../types.ts'

export interface ToastState {
  /** Local key so a repeated tap restarts the timer instead of stacking. */
  key: number
  trackerName: string
  colour: string
  /** Local wall-clock time the Moment was logged at. */
  clock: string
  /** Null until the server has answered; Undo needs a real id. */
  eventId: string | null
  /** The tracker's fields, so anything captured can be echoed back here. */
  fields?: FieldDef[]
  values?: Record<string, string | number | boolean>
  failed?: boolean
}

const LIFETIME_MS = 5200

/**
 * The undo affordance for a Moment. It sits directly above the thumb — but
 * above the tab bar, not on it — is wide enough to hit blind, and drains a
 * hairline so the remaining time is visible without reading anything.
 */
export function UndoToast({
  toast,
  onUndo,
  onDismiss,
}: {
  toast: ToastState
  onUndo: () => void
  onDismiss: () => void
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [toast.key, onDismiss])

  return (
    <div
      role="status"
      aria-live="polite"
      className="pad-safe-x inset-tabs pointer-events-none fixed inset-x-0 z-40 flex justify-center"
    >
      <div
        key={toast.key}
        className="anim-toast pointer-events-auto relative w-full max-w-md overflow-hidden rounded-[18px] border border-ink-600 bg-ink-850/95 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)] backdrop-blur-md"
      >
        <div className="flex items-center gap-3 py-3 pr-2 pl-4">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: toast.colour, boxShadow: `0 0 12px ${toast.colour}` }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] leading-tight font-medium">
              {toast.failed ? 'Could not log' : 'Logged'} {toast.trackerName}
            </p>
            <p className="stencil mt-1">{toast.failed ? 'tap the tile to retry' : toast.clock}</p>
            <ValueChips fields={toast.fields} values={toast.values} className="mt-1.5" />
          </div>

          <button
            type="button"
            onClick={onUndo}
            disabled={!toast.eventId}
            className="tap h-12 shrink-0 rounded-xl px-4 text-[13px] font-semibold tracking-[0.1em] text-periwinkle uppercase disabled:text-text-dim"
          >
            Undo
          </button>
        </div>

        <span
          key={`bar-${toast.key}`}
          aria-hidden
          className="anim-drain absolute inset-x-0 bottom-0 h-px bg-lavender/40"
          style={{ animationDuration: `${LIFETIME_MS}ms` }}
        />
      </div>
    </div>
  )
}
