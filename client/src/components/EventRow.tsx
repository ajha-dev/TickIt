import { ValueChips } from './ValueChips.tsx'
import { safeColour } from '../lib/colours.ts'
import { formatClock, formatDuration, formatStopwatch, useElapsed } from '../lib/time.ts'
import type { Event, Tracker } from '../types.ts'

/**
 * One logged occurrence, on the timeline's rail.
 *
 * The rail is the spine of the screen: a 1px hairline running the full height of
 * a day's rows, with the tracker's colour marking each event on it. A Moment is
 * a dot — a single instant. A Span is a capsule, drawn downward, so length on
 * the page reads as length in time without a chart. Full chroma stays inside
 * those nine pixels, which is the only place THEME.md allows it.
 *
 * Time sits left of the rail in mono digits so a column of them scans as a
 * column. Everything else — duration, values, note, the "edited" marker — hangs
 * to the right at the quiet end of the contrast range.
 */
export function EventRow({
  event,
  tracker,
  onOpen,
  above,
  below,
}: {
  event: Event
  tracker: Tracker | undefined
  onOpen: () => void
  /** "started yesterday" — a span whose beginning is off the top of this day. */
  above?: string
  /** "continues into tomorrow" / "still running" — its end is off the bottom. */
  below?: string
}) {
  const colour = safeColour(tracker?.colour)
  // A tracker deleted out from under its events is a real state, not a crash:
  // the row still says when it happened and still opens for deletion.
  const orphaned = tracker === undefined
  const name = tracker?.name ?? 'Deleted tracker'

  const isSpan = event.type === 'INTERVAL'
  const running = isSpan && event.endAt === null
  const wasEdited = event.updatedAt !== event.createdAt

  const count = event.ticks?.length ?? null
  /**
   * A span that ended where it started took no time, and `formatDuration(0)`
   * answers "0s" — which is a claim about something that did happen, and a
   * false one. One kick is an instant, not a zero-length session.
   *
   * Suppressed for *any* such span, not only a counted one: an end dragged back
   * onto the start in the edit sheet has exactly the same problem.
   */
  const instantaneous = event.endAt === event.startAt

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${name} at ${formatClock(event.startAt)}. Edit`}
      className="tap flex w-full items-stretch gap-3 rounded-xl py-2.5 pr-2 pl-1 text-left active:bg-ink-850"
    >
      <span
        className={`digits w-[42px] shrink-0 pt-[3px] text-[13px] tracking-[-0.02em] ${
          running ? 'text-mauve' : 'text-text-dim'
        }`}
      >
        {formatClock(event.startAt)}
      </span>

      {/* The negative margin is what makes the rail continuous: it reaches out
          through the row's own padding so consecutive rows draw one unbroken
          line rather than a dashed one. */}
      <span aria-hidden className="relative -my-2.5 flex w-[9px] shrink-0 justify-center self-stretch">
        <span className="absolute inset-y-0 w-px bg-ink-700" />
        <span
          className={`absolute top-[15px] w-[9px] rounded-full ring-4 ring-ink-900 ${
            running ? 'anim-pulse' : ''
          }`}
          style={{
            background: colour,
            // Length on the rail means length in time, so a span with no length
            // draws as a dot — the instant it actually is — rather than a
            // capsule claiming twenty pixels of duration it never had.
            height: isSpan && !instantaneous ? 20 : 9,
            opacity: orphaned ? 0.45 : 1,
            boxShadow: orphaned ? 'none' : `0 0 12px ${colour}`,
          }}
        />
      </span>

      <span className="min-w-0 flex-1 pb-0.5">
        {/* A span can begin before this day starts or end after it finishes. The
            row shows its real start time either way; these two lines are what
            stop that time reading as a time on *this* day. */}
        {above ? <span className="stencil mb-1.5 block text-mauve/75">{above}</span> : null}

        <span className="flex items-baseline gap-2.5">
          <span
            className={`min-w-0 flex-1 truncate text-[17px] leading-tight font-medium tracking-[-0.02em] ${
              orphaned ? 'text-text-dim italic' : ''
            }`}
          >
            {name}
          </span>

          {running ? (
            <RunningReadout startAt={event.startAt} colour={colour} count={count} />
          ) : count !== null || (isSpan && event.endAt !== null && !instantaneous) ? (
            /* "×12 · 4m 12s" — the count first, because it is what the session
               was about, and the duration only when there is one. */
            <span
              className="digits shrink-0 text-[13px] text-text-dim"
              aria-label={
                count !== null
                  ? `${count} ${count === 1 ? 'count' : 'counts'}${
                      isSpan && event.endAt !== null && !instantaneous
                        ? `, ${formatDuration(event.endAt - event.startAt)}`
                        : ''
                    }`
                  : undefined
              }
            >
              {count !== null ? <span aria-hidden>×{count}</span> : null}
              {count !== null && isSpan && event.endAt !== null && !instantaneous ? (
                <span aria-hidden className="opacity-55">
                  {' · '}
                </span>
              ) : null}
              {isSpan && event.endAt !== null && !instantaneous ? (
                <span aria-hidden={count !== null}>
                  {formatDuration(event.endAt - event.startAt)}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>

        <ValueChips fields={tracker?.fields} values={event.values} className="mt-1.5" />

        {event.note ? (
          <span className="mt-1.5 block text-[13px] leading-snug text-text-dim">{event.note}</span>
        ) : null}

        {/* The whole audit story, and deliberately the quietest thing on the
            row: enough to tell a reconstructed time from a recorded one, never
            enough to distract from the log itself. */}
        {below ? <span className="stencil mt-1.5 block text-mauve/75">{below}</span> : null}

        {wasEdited ? <span className="stencil mt-1.5 block opacity-70">edited</span> : null}
      </span>
    </button>
  )
}

/** Only running rows tick, so only running rows subscribe to the clock. */
function RunningReadout({
  startAt,
  colour,
  count,
}: {
  startAt: number
  colour: string
  /** Non-null on a counted span — shown ahead of the clock, as it is elsewhere. */
  count: number | null
}) {
  const elapsed = useElapsed(startAt)
  return (
    <span
      className="digits shrink-0 text-[13px] tracking-[-0.02em]"
      style={{ color: colour }}
      aria-label={`${count !== null ? `${count} so far, ` : ''}running for ${formatDuration(elapsed)}`}
    >
      {count !== null ? <span aria-hidden>×{count} · </span> : null}
      <span aria-hidden>{formatStopwatch(elapsed)}</span>
    </span>
  )
}
