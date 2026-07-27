import { ValueChips } from './ValueChips.tsx'
import { safeColour, tintedBorder, tintedSurface } from '../lib/colours.ts'
import { formatClock, formatStopwatch, useElapsed } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * A running Span, pinned to the top of Home. The live readout is the whole
 * point of the card, so it gets the largest type in the app; the Stop button is
 * an 84px target on the right, reachable with the same thumb that started it.
 *
 * The digits carry full chroma — they are the one place THEME.md explicitly
 * allows it at size, because a live counter *is* the indicator. Stop stays warm
 * (--ember): against an entirely cool palette it is the only control a
 * half-asleep person can find without reading it.
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
  /**
   * Still only on this device — queued in the outbox, not yet on the Pi.
   *
   * Purely a visual hint. It deliberately does NOT disable Stop: the event's id
   * is minted at tap time and is the id the server will store, so a stop queues
   * straight behind its own create and the two replay in order. Disabling would
   * mean a feed you can start at 3am with no signal but cannot finish, which is
   * worse than not being able to start it at all.
   */
  pending: boolean
}) {
  const elapsed = useElapsed(event.startAt)
  const colour = safeColour(tracker?.colour)
  const name = tracker?.name ?? 'Unknown tracker'

  return (
    <article
      className="anim-rise relative overflow-hidden rounded-tile border"
      style={{
        borderColor: tintedBorder(colour, 32),
        background: `linear-gradient(180deg, ${tintedSurface(colour, 12)}, var(--ink-900))`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: colour, boxShadow: `0 0 22px ${colour}` }}
      />

      <div className="flex items-stretch gap-3 py-4 pr-4 pl-5">
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
            {pending ? <span className="stencil text-lavender">· on this phone</span> : null}
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

          <ValueChips fields={tracker?.fields} values={event.values} className="mt-2.5" />
        </div>

        <button
          type="button"
          onClick={onStop}
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
