import { ValueChips } from './ValueChips.tsx'
import { safeColour, tintedBorder, tintedSurface } from '../lib/colours.ts'
// Stop's own haptic fires in Home, where stopping is orchestrated — the two
// controls below are the only ones this card owns.
import { hapticLog, hapticUndo } from '../lib/haptics.ts'
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
 *
 * A **counted** span rearranges all of that, because it is a different job. See
 * `CountedActions` below: the card grows a second row, the count takes the
 * headline off the stopwatch, and + becomes roughly three times Stop's area
 * because it is the button that gets pressed forty times.
 */
export function RunningCard({
  event,
  tracker,
  onStop,
  onCount,
  pending,
}: {
  event: Event
  tracker: Tracker | undefined
  onStop: () => void
  /**
   * The whole tick array this card wants the event to have — absolute, never a
   * delta, so + and Undo are the same call with different arrays. Only ever
   * invoked for a counted span.
   */
  onCount: (ticks: number[]) => void
  /**
   * Still only on this device — queued in the outbox, not yet on the Pi.
   *
   * Purely a visual hint. It deliberately does NOT disable Stop: the event's id
   * is minted at tap time and is the id the server will store, so a stop queues
   * straight behind its own create and the two replay in order. Disabling would
   * mean a feed you can start at 3am with no signal but cannot finish, which is
   * worse than not being able to start it at all.
   *
   * The same argument disables nothing on the counted row either. A session you
   * can start with no signal must be one you can count and finish.
   */
  pending: boolean
}) {
  const elapsed = useElapsed(event.startAt)
  const colour = safeColour(tracker?.colour)
  const name = tracker?.name ?? 'Unknown tracker'

  // `ticks !== null` is the whole test. An uncounted span renders exactly the
  // card it always did, down to the pixel — nothing below branches on the
  // tracker's `counter` flag, which can be turned off under a running session.
  const ticks = event.ticks
  const counted = ticks !== null

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

      <div className={counted ? 'py-4 pr-4 pl-5' : 'flex items-stretch gap-3 py-4 pr-4 pl-5'}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              aria-hidden
              className="anim-pulse size-[7px] rounded-full"
              style={{ background: colour, boxShadow: `0 0 10px ${colour}` }}
            />
            <span className="stencil" style={{ color: colour }}>
              Running
            </span>
            <span className="stencil">since {formatClock(event.startAt)}</span>
            {/* Elapsed is demoted to the metadata row on a counted span: the
                session is about how many, not how long, and the duration is not
                even final until the last tap decides it. */}
            {counted ? (
              <span className="stencil digits tracking-[-0.02em]">{formatStopwatch(elapsed)}</span>
            ) : null}
            {pending ? <span className="stencil text-lavender">· on this phone</span> : null}
          </div>

          <h2 className="mt-2 truncate text-[21px] leading-tight font-semibold tracking-[-0.02em]">
            {name}
          </h2>

          {counted ? (
            <p
              className="digits mt-1.5 flex items-baseline gap-1.5 text-[38px] leading-none font-light tracking-[-0.04em]"
              style={{ color: colour }}
              aria-label={`${ticks.length} ${ticks.length === 1 ? 'count' : 'counts'}`}
            >
              <span aria-hidden>{ticks.length}</span>
              <span aria-hidden className="text-[15px] font-normal tracking-[0.04em] opacity-70">
                ×
              </span>
            </p>
          ) : (
            <p
              className="digits mt-1.5 text-[38px] leading-none font-light tracking-[-0.04em]"
              style={{ color: colour }}
            >
              {formatStopwatch(elapsed)}
            </p>
          )}

          <ValueChips fields={tracker?.fields} values={event.values} className="mt-2.5" />
        </div>

        {counted ? (
          <CountedActions
            name={name}
            colour={colour}
            ticks={ticks}
            onCount={onCount}
            onStop={onStop}
          />
        ) : (
          <button
            type="button"
            onClick={onStop}
            aria-label={`Stop ${name}`}
            className="tap flex size-[84px] shrink-0 flex-col items-center justify-center gap-1.5 self-center rounded-2xl border border-ember/35 bg-ember/12 text-ember disabled:opacity-45"
          >
            <span aria-hidden className="size-5 rounded-[5px] bg-ember" />
            <span className="text-[11px] font-semibold tracking-[0.16em] uppercase">Stop</span>
          </button>
        )}
      </div>
    </article>
  )
}

/**
 * The counted span's action row, and the reason the card has two rows at all.
 *
 * The old layout pinned an 84px Stop beside the text, which caps *any* button
 * at 84px — fine when the card has one control pressed once. + is pressed
 * forty times, so it gets its own full-width row and grows to 104px tall and
 * whatever width is left: roughly three times Stop's area, and on the left,
 * which is the thumb side of a phone held in either hand.
 *
 * Stop keeps its exact colours. It is findable because it is the only warm
 * thing on an entirely cool screen, not because it is big — and shrinking it
 * costs nothing, because it is pressed once.
 *
 * Undo sits **above** Stop rather than beside +, for two reasons. Stop keeps
 * the corner it has always had, and the thing between the giant + and Stop
 * becomes the harmless one: a slip off + lands on Undo, which takes back the
 * tap you just made, not on Stop, which ends the session.
 */
function CountedActions({
  name,
  colour,
  ticks,
  onCount,
  onStop,
}: {
  name: string
  colour: string
  ticks: number[]
  onCount: (ticks: number[]) => void
  onStop: () => void
}) {
  // Tap 1 *is* the span's start. Removing it would not undo a count, it would
  // delete the event — which is the Timeline's job, with a confirm, not a
  // 44px control on the logging path.
  const canUndo = ticks.length > 1

  const add = () => {
    hapticLog()
    // Non-strict ascending: two taps inside one millisecond are physically
    // possible and both count.
    const now = Date.now()
    const last = ticks[ticks.length - 1] ?? now
    onCount([...ticks, Math.max(now, last)])
  }

  const undo = () => {
    if (!canUndo) return
    hapticUndo()
    onCount(ticks.slice(0, -1))
  }

  return (
    <div className="mt-3.5 flex items-stretch gap-2.5">
      <button
        type="button"
        onClick={add}
        aria-label={`Count another ${name}. ${ticks.length} so far`}
        className="tap flex h-[104px] min-w-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-2xl border"
        style={{
          borderColor: tintedBorder(colour, 45),
          background: tintedSurface(colour, 14),
          color: colour,
        }}
      >
        <span aria-hidden className="text-[34px] leading-none font-light">
          +
        </span>
        <span className="text-[11px] font-semibold tracking-[0.16em] uppercase">Count</span>
      </button>

      <div className="flex shrink-0 flex-col gap-2">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label={
            canUndo ? 'Undo the last count' : 'Undo the last count — nothing to take back'
          }
          className="tap flex h-[44px] w-[84px] items-center justify-center rounded-xl border border-ink-600 bg-ink-800 text-[12px] font-medium tracking-[0.08em] text-text-dim uppercase disabled:opacity-35"
        >
          Undo
        </button>

        <button
          type="button"
          onClick={onStop}
          aria-label={`Stop ${name}`}
          className="tap flex h-[52px] w-[84px] flex-col items-center justify-center gap-1 rounded-2xl border border-ember/35 bg-ember/12 text-ember"
        >
          <span aria-hidden className="size-[13px] rounded-[4px] bg-ember" />
          <span className="text-[10px] font-semibold tracking-[0.16em] uppercase">Stop</span>
        </button>
      </div>
    </div>
  )
}
