import { safeColour } from '../lib/colours.ts'
import { formatClock, formatStopwatch, useElapsed } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * A running Span, pinned to the top of Home. The live readout is the whole
 * point of the card, so it gets the largest type in the app; the Stop button is
 * an 84px target on the right, reachable with the same thumb that started it.
 */
export function RunningCard({
  event,
  tracker,
  onStop,
  pending,
}: {
  event: Event
  tracker: Tracker | undefined
  onStop: () => void
  pending: boolean
}) {
  const elapsed = useElapsed(event.startAt)
  const colour = safeColour(tracker?.colour)
  const name = tracker?.name ?? 'Unknown tracker'

  return (
    <article
      className="anim-rise relative overflow-hidden rounded-tile border bg-ink-850"
      style={{
        borderColor: `color-mix(in oklab, ${colour} 34%, transparent)`,
        background: `linear-gradient(180deg, color-mix(in oklab, ${colour} 11%, var(--color-ink-850)), var(--color-ink-900))`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: colour, boxShadow: `0 0 22px ${colour}` }}
      />

      <div className="flex items-stretch gap-3 py-4 pl-5 pr-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="anim-pulse size-[7px] rounded-full"
              style={{ background: colour, boxShadow: `0 0 10px ${colour}` }}
            />
            <span className="stencil" style={{ color: colour }}>
              Running
            </span>
            <span className="stencil">since {formatClock(event.startAt)}</span>
          </div>

          <h2 className="mt-2 truncate text-[21px] leading-tight font-semibold tracking-[-0.02em]">
            {name}
          </h2>

          <p
            className="digits mt-1.5 text-[38px] leading-none font-light tracking-[-0.04em]"
            style={{ color: colour }}
          >
            {formatStopwatch(elapsed)}
          </p>
        </div>

        <button
          type="button"
          onClick={onStop}
          disabled={pending}
          aria-label={`Stop ${name}`}
          className="tap flex size-[84px] shrink-0 flex-col items-center justify-center gap-1.5 self-center rounded-2xl border border-ember/35 bg-ember/12 text-ember disabled:opacity-45"
        >
          <span aria-hidden className="size-5 rounded-[5px] bg-ember" />
          <span className="text-[11px] font-semibold tracking-[0.16em] uppercase">Stop</span>
        </button>
      </div>
    </article>
  )
}
