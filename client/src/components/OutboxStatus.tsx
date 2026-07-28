import { useState } from 'react'

import { Sheet, SheetButton } from './Sheet.tsx'
import {
  dismissAllFailures,
  flush,
  useOutbox,
  type OutboxFailure,
} from '../lib/outbox.ts'

/**
 * The outbox's only permanent UI.
 *
 * It is a small pill floating below the header — deliberately not a banner, and
 * deliberately nowhere near the thumb. Logging must never acquire a step, and a
 * bar across the bottom of the Log screen would put sync status between the
 * thumb and the tracker grid, which is the one thing this whole feature exists
 * to protect.
 *
 * Pending writes are stated quietly and are not even tappable: there is nothing
 * to do about them, they resolve on their own. A *permanent* failure is the
 * opposite — the write is gone and nothing will bring it back — so that state
 * is warm, tappable, and says exactly what was lost.
 */
export function OutboxStatus() {
  const { pending, failures, syncing, stalled } = useOutbox()
  const [open, setOpen] = useState(false)

  if (pending === 0 && failures.length === 0) return null

  const broken = failures.length > 0

  return (
    <>
      <div
        className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
        style={{ top: 'calc(var(--safe-t) + 68px)' }}
      >
        <button
          type="button"
          role={broken ? undefined : 'status'}
          aria-live="polite"
          disabled={!broken}
          onClick={() => setOpen(true)}
          className={`tap flex h-[28px] max-w-full items-center gap-2 rounded-full border px-3 backdrop-blur-md ${
            broken
              ? 'pointer-events-auto border-ember/45 bg-ember/12'
              : 'border-ink-600 bg-ink-850/92'
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${syncing && !broken ? 'anim-pulse' : ''}`}
            style={{
              background: broken ? 'var(--ember)' : 'var(--color-lavender)',
            }}
          />
          <span className="stencil truncate" style={broken ? { color: 'var(--ember)' } : undefined}>
            {broken
              ? `${failures.length} not saved`
              : stalled
                ? `${pending} waiting to sync`
                : `${pending} syncing`}
          </span>
        </button>
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="could not be saved"
        title={
          failures.length === 1
            ? 'One write never reached the Pi'
            : `${failures.length} writes never reached the Pi`
        }
        body="The server refused these, so retrying would fail the same way forever. They are gone — log them again if they still matter."
      >
        <ul className="flex flex-col gap-2">
          {failures.map((failure) => (
            <li
              key={failure.key}
              className="rounded-2xl border border-ink-600 bg-ink-700 px-4 py-3 text-[15px] leading-snug"
            >
              <p className="font-medium">{describe(failure)}</p>
              <p className="stencil mt-1.5">{failure.code.toLowerCase().replace(/_/g, ' ')}</p>
            </li>
          ))}
        </ul>

        <SheetButton
          tone="primary"
          onClick={() => {
            void dismissAllFailures()
            setOpen(false)
          }}
        >
          Got it
        </SheetButton>

        {pending > 0 ? (
          <SheetButton
            tone="quiet"
            onClick={() => {
              void flush({ resetBackoff: true })
              setOpen(false)
            }}
          >
            Retry the {pending} still waiting
          </SheetButton>
        ) : null}
      </Sheet>
    </>
  )
}

/** One sentence naming what was lost and why, in the user's terms. */
function describe(failure: OutboxFailure): string {
  const { op, code } = failure
  const what =
    op.kind === 'create'
      ? `${op.label} at ${clock(op.startAt)}`
      : op.kind === 'count'
        ? `${op.label} — ${op.ticks.length} counts`
        : `${op.label} on an event`

  switch (code) {
    // A count that lost a race with Stop. The span closed at its previous last
    // tick and the tap is gone, which is a real loss — not a replay that
    // already landed — so it is named rather than swallowed.
    case 'ALREADY_STOPPED':
      return `${what} — the span had already been stopped, so the last counts were not recorded.`
    case 'NOT_COUNTED':
      return `${what} — that span does not have a counter.`
    case 'TICK_BEFORE_START':
      return `${what} — a count was timed before the span began.`
    case 'TICKS_NOT_ASCENDING':
      return `${what} — the counts were out of order.`
    case 'TICKS_REQUIRED':
      return `${what} — a counted span cannot have no counts at all.`
    case 'TOO_MANY_TICKS':
      return `${what} — that is more counts than one span can hold.`
    case 'BAD_TICKS':
      return `${what} — the server could not read the counts.`
    case 'COUNTER_NOT_ALLOWED':
      return `${what} — only a Span can count taps.`
    case 'TRACKER_NOT_FOUND':
      return `${what} — its tracker was deleted.`
    case 'ALREADY_RUNNING':
      return `${what} — that tracker was already running elsewhere.`
    case 'NOT_AN_INTERVAL':
      return `${what} — that event is a Moment, not a Span.`
    case 'UNKNOWN_FIELD':
    case 'BAD_FIELD_VALUE':
      return `${what} — its field no longer accepts that value.`
    case 'END_BEFORE_START':
      return `${what} — the end time was before the start.`
    default:
      return `${what} — the server rejected it.`
  }
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
