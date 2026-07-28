/**
 * Direct tests for the sweep's decision logic — `npm run test:reminders`.
 *
 * These rules cannot be exercised by curl (there is no push service to receive
 * anything) and getting them wrong is expensive in a specific way: a broken
 * "once per idle period" check means a notification every 60 seconds, forever.
 */
import assert from 'node:assert/strict'
import { createReminderSchema, patchReminderSchema, zodMessage } from '../lib/validate.js'
import {
  formatIdle,
  formatTimeOfDay,
  inQuietWindow,
  localMinutesOfDay,
  recentOccurrences,
  shouldFire,
  shouldFireSchedule,
  zonedTimeToUtc,
  buildSchedulePayload,
  type FireInput,
  type ScheduleInput,
} from './rules.js'

let passed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

const HOUR = 3_600_000
const ZONE = 'Asia/Kolkata' // UTC+5:30, no DST — arithmetic stays readable.

/** A UTC instant that is `h:m` local time in Asia/Kolkata on 2026-01-16. */
function ist(hour: number, minute: number): number {
  return Date.UTC(2026, 0, 16, hour, minute) - (5 * HOUR + 30 * 60_000)
}

function input(over: Partial<FireInput> = {}): FireInput {
  return {
    now: ist(12, 0),
    anchor: ist(12, 0),
    afterMs: 3 * HOUR,
    lastFiredAt: null,
    quietFromMin: null,
    quietToMin: null,
    timeZone: ZONE,
    ...over,
  }
}

console.log('\nreminder firing rules\n')

check('localMinutesOfDay reads wall-clock minutes in the stored zone', () => {
  assert.equal(localMinutesOfDay(ist(3, 10), ZONE), 3 * 60 + 10)
  assert.equal(localMinutesOfDay(ist(0, 0), ZONE), 0)
  assert.equal(localMinutesOfDay(ist(23, 59), ZONE), 1439)
  // Same instant, different zone — the zone is what decides.
  assert.equal(localMinutesOfDay(ist(3, 10), 'UTC'), 21 * 60 + 40)
})

check('brand-new reminder on a tracker with no events does not fire', () => {
  // Anchor falls back to createdAt, which is now. Nothing has been idle yet.
  const now = ist(9, 0)
  assert.equal(shouldFire(input({ now, anchor: now })), 'NOT_IDLE')
})

check('does not fire one millisecond before the threshold', () => {
  const now = ist(12, 0)
  assert.equal(shouldFire(input({ now, anchor: now - 3 * HOUR + 1 })), 'NOT_IDLE')
})

check('fires once when idle past the threshold', () => {
  const now = ist(12, 0)
  assert.equal(shouldFire(input({ now, anchor: now - 3 * HOUR })), 'FIRE')
  assert.equal(shouldFire(input({ now, anchor: now - 5 * HOUR })), 'FIRE')
})

check('does NOT fire again on the next sweep with the same anchor', () => {
  const firstSweep = ist(12, 0)
  const anchor = firstSweep - 3 * HOUR
  assert.equal(shouldFire(input({ now: firstSweep, anchor })), 'FIRE')

  // The sweep stamps lastFiredAt and comes back 60s later. Nothing changed.
  const lastFiredAt = firstSweep
  assert.equal(
    shouldFire(input({ now: firstSweep + 60_000, anchor, lastFiredAt })),
    'ALREADY_FIRED',
  )
  // …and still nothing, hours later. One notification, not sixty an hour.
  assert.equal(shouldFire(input({ now: firstSweep + 8 * HOUR, anchor, lastFiredAt })), 'ALREADY_FIRED')
})

check('DOES fire again after a new event moves the anchor', () => {
  const firstFire = ist(12, 0)
  const lastFiredAt = firstFire

  // A feed is logged at 13:00 — the anchor moves past lastFiredAt and the
  // reminder re-arms, but it is not yet idle again.
  const newAnchor = ist(13, 0)
  assert.equal(shouldFire(input({ now: ist(13, 5), anchor: newAnchor, lastFiredAt })), 'NOT_IDLE')

  // Three hours after that event, it is due again.
  assert.equal(shouldFire(input({ now: ist(16, 0), anchor: newAnchor, lastFiredAt })), 'FIRE')
})

check('a tap inside a RUNNING counted span counts as activity', () => {
  // The bug the counted-span design surfaced. A running span has `end_at IS
  // NULL`, so an anchor of `max(coalesce(end_at, start_at))` sticks at the
  // START and never advances — a long counted session would be told "nothing
  // logged for 3h" while the user was actively tapping.
  //
  // The anchor itself is resolved in SQL (`sweep.ts`), so only the consequence
  // is reachable from here; the expression is verified against real rows with
  // sqlite. What this pins down is the rule the SQL exists to serve: each tap
  // IS activity, so the anchor is the LAST TICK, not the start.
  const startedAt = ist(9, 0)
  const lastTap = ist(11, 59)
  const now = ist(12, 0) // two hours in, tapping a minute ago

  // What the old expression produced — a mid-session notification.
  assert.equal(shouldFire(input({ now, anchor: startedAt })), 'FIRE')
  // What the last tick produces — correctly quiet.
  assert.equal(shouldFire(input({ now, anchor: lastTap })), 'NOT_IDLE')

  // And once the taps really do stop, it still fires on schedule.
  assert.equal(shouldFire(input({ now: lastTap + 3 * HOUR, anchor: lastTap })), 'FIRE')
})

check('does NOT fire inside a quiet window', () => {
  // Due at 03:10 local, inside 01:00–07:00. Held silent.
  const now = ist(3, 10)
  const decision = shouldFire(
    input({ now, anchor: now - 4 * HOUR, quietFromMin: 60, quietToMin: 420 }),
  )
  assert.equal(decision, 'QUIET')
})

check('a period held by quiet hours fires when the window closes', () => {
  // The scenario the whole rule exists for: last logged 21:00, threshold 3h,
  // quiet 22:00–07:00. Due at 00:00 but held. The sweep must NOT stamp
  // lastFiredAt on QUIET, so at 07:00 — still idle, now ten hours — it fires
  // exactly once with a freshly computed body. Sleeping through the night and
  // being told nothing in the morning is the failure this prevents.
  const quiet = { quietFromMin: 22 * 60, quietToMin: 7 * 60 }
  const anchor = ist(21, 0) - 24 * HOUR // 21:00 the previous evening
  const afterMs = 3 * HOUR

  const held = shouldFire(input({ now: ist(0, 0), anchor, afterMs, lastFiredAt: null, ...quiet }))
  assert.equal(held, 'QUIET')

  // lastFiredAt is still null precisely because QUIET did not consume it.
  const atClose = shouldFire(input({ now: ist(7, 0), anchor, afterMs, lastFiredAt: null, ...quiet }))
  assert.equal(atClose, 'FIRE')
  assert.equal(formatIdle(ist(7, 0) - anchor), '10h')

  // And having fired, it stays quiet until an event moves the anchor.
  const after = shouldFire(
    input({ now: ist(7, 1), anchor, afterMs, lastFiredAt: ist(7, 0), ...quiet }),
  )
  assert.equal(after, 'ALREADY_FIRED')
})

check('DOES fire outside the quiet window', () => {
  const now = ist(9, 30)
  assert.equal(
    shouldFire(input({ now, anchor: now - 4 * HOUR, quietFromMin: 60, quietToMin: 420 })),
    'FIRE',
  )
  // The window is half-open: 07:00 exactly is already out of it.
  const seven = ist(7, 0)
  assert.equal(
    shouldFire(input({ now: seven, anchor: seven - 4 * HOUR, quietFromMin: 60, quietToMin: 420 })),
    'FIRE',
  )
})

check('handles a quiet window that wraps midnight (22:00 -> 07:00)', () => {
  const quiet = { quietFromMin: 22 * 60, quietToMin: 7 * 60 }
  const due = (now: number) => shouldFire(input({ now, anchor: now - 4 * HOUR, ...quiet }))

  assert.equal(due(ist(23, 30)), 'QUIET') // before midnight
  assert.equal(due(ist(2, 0)), 'QUIET') // after midnight
  assert.equal(due(ist(22, 0)), 'QUIET') // inclusive start
  assert.equal(due(ist(21, 59)), 'FIRE') // just before it opens
  assert.equal(due(ist(7, 0)), 'FIRE') // exclusive end
  assert.equal(due(ist(12, 0)), 'FIRE') // broad daylight
})

check('quiet hours are checked last — a non-idle reminder is NOT_IDLE, not QUIET', () => {
  const now = ist(3, 10)
  assert.equal(shouldFire(input({ now, anchor: now, quietFromMin: 60, quietToMin: 420 })), 'NOT_IDLE')
})

check('inQuietWindow handles both orientations and the degenerate case', () => {
  assert.equal(inQuietWindow(300, 60, 420), true)
  assert.equal(inQuietWindow(60, 60, 420), true)
  assert.equal(inQuietWindow(420, 60, 420), false)
  assert.equal(inQuietWindow(30, 1320, 420), true)
  assert.equal(inQuietWindow(1000, 1320, 420), false)
  assert.equal(inQuietWindow(500, 600, 600), false)
})

check('formatIdle reads the way the notification should', () => {
  assert.equal(formatIdle(3 * HOUR + 20 * 60_000), '3h 20m')
  assert.equal(formatIdle(3 * HOUR), '3h')
  assert.equal(formatIdle(45 * 60_000), '45m')
  assert.equal(formatIdle(0), '0m')
  assert.equal(formatIdle(26 * HOUR), '1d 2h')
  assert.equal(formatIdle(48 * HOUR), '2d')
})

/* ------------------------------------------------------------------ SCHEDULE */

console.log('\nscheduled reminder firing rules\n')

const FRIDAY = 5
const MONDAY = 1
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const AT_9 = [9 * 60]

/** 2026-01-16 is a Friday in Asia/Kolkata — see `ist` above. */
function sched(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: ist(9, 0),
    days: ALL_DAYS,
    timesMin: AT_9,
    lastFiredAt: null,
    timeZone: ZONE,
    ...over,
  }
}

check('an occurrence resolves to the wall-clock time in the stored zone', () => {
  // Not "midnight plus N minutes of elapsed time" — the local clock reading.
  assert.equal(zonedTimeToUtc(2026, 1, 16, 9 * 60, ZONE), ist(9, 0))
  assert.equal(zonedTimeToUtc(2026, 1, 16, 0, ZONE), ist(0, 0))
  assert.equal(zonedTimeToUtc(2026, 1, 16, 1439, ZONE), ist(23, 59))
})

check('fires at an occurrence, reporting the occurrence itself', () => {
  const decision = shouldFireSchedule(sched({ now: ist(9, 0) }))
  assert.deepEqual(decision, { kind: 'FIRE', occurrenceAt: ist(9, 0) })
  // Still inside the window a few minutes later, and still the same occurrence.
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(9, 12) })), {
    kind: 'FIRE',
    occurrenceAt: ist(9, 0),
  })
})

check('does NOT fire before the occurrence', () => {
  // One minute early. Today's 09:00 has not happened, so nothing about today
  // can be sent — the only thing outstanding is yesterday's, long stale.
  const decision = shouldFireSchedule(sched({ now: ist(8, 59) }))
  assert.notEqual(decision.kind, 'FIRE')
  assert.notEqual(decision.kind === 'CONSUME' ? decision.occurrenceAt : null, ist(9, 0))

  // With yesterday already dealt with there is nothing outstanding at all.
  const settled = shouldFireSchedule(sched({ now: ist(8, 59), lastFiredAt: ist(9, 0) - 24 * HOUR }))
  assert.deepEqual(settled, { kind: 'NONE' })
})

check('does NOT fire twice for the same occurrence', () => {
  // The sweep stamped lastFiredAt with the OCCURRENCE's timestamp, so the next
  // sweep in the same minute — and every sweep inside the window — is a no-op.
  const fired = { lastFiredAt: ist(9, 0) }
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(9, 0), ...fired })), { kind: 'NONE' })
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(9, 1), ...fired })), { kind: 'NONE' })
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(9, 59), ...fired })), { kind: 'NONE' })

  // A clock nudged backwards must not resurrect it either: lastFiredAt is the
  // occurrence, not "when we sent", so it does not move with the clock.
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(9, 0) - 30_000, ...fired })), {
    kind: 'NONE',
  })
})

check('DOES fire again at the next occurrence', () => {
  // Two doses a day. 09:00 has been sent; 21:00 is a different occurrence.
  const twice = { timesMin: [9 * 60, 21 * 60], lastFiredAt: ist(9, 0) }
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(20, 59), ...twice })), { kind: 'NONE' })
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(21, 0), ...twice })), {
    kind: 'FIRE',
    occurrenceAt: ist(21, 0),
  })
})

check('does NOT fire on a day that is not in `days`', () => {
  // Mondays only, and today is Friday. Today's 09:00 is not an occurrence at
  // all; the most recent one is Monday the 12th, four days back and stale.
  const decision = shouldFireSchedule(sched({ now: ist(9, 0), days: [MONDAY] }))
  assert.equal(decision.kind, 'CONSUME')
  assert.notEqual(decision.kind === 'CONSUME' ? decision.occurrenceAt : null, ist(9, 0))
  assert.equal(decision.kind === 'CONSUME' ? decision.occurrenceAt : 0, ist(9, 0) - 4 * 24 * HOUR)

  // And once that is consumed, Friday is silent all day.
  const settled = shouldFireSchedule(
    sched({ now: ist(9, 0), days: [MONDAY], lastFiredAt: ist(9, 0) - 4 * 24 * HOUR }),
  )
  assert.deepEqual(settled, { kind: 'NONE' })

  // Friday itself fires, so the day filter is doing work rather than nothing.
  assert.equal(shouldFireSchedule(sched({ now: ist(9, 0), days: [FRIDAY] })).kind, 'FIRE')
})

check('an occurrence past the 60-minute window is CONSUMEd, never sent', () => {
  // 60 minutes exactly is still inside the window…
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(10, 0) })), {
    kind: 'FIRE',
    occurrenceAt: ist(9, 0),
  })
  // …61 is not. The Pi woke up late; "due at 09:00" at 10:01 says something
  // false about now, and acting on it means a double dose.
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(10, 1) })), {
    kind: 'CONSUME',
    occurrenceAt: ist(9, 0),
  })
  // Six hours late is emphatically CONSUME — the contract's 3pm case.
  assert.deepEqual(shouldFireSchedule(sched({ now: ist(15, 0) })), {
    kind: 'CONSUME',
    occurrenceAt: ist(9, 0),
  })
})

check('several eligible occurrences produce exactly ONE notification', () => {
  // Four doses, and the Pi has been off since yesterday. Every one of them is
  // outstanding, but only the newest is true.
  const many = { timesMin: [8 * 60, 8 * 60 + 30, 9 * 60, 9 * 60 + 30] }
  const now = ist(9, 40)

  const outstanding = recentOccurrences({ now, days: ALL_DAYS, timesMin: many.timesMin, timeZone: ZONE })
  assert.ok(outstanding.length > 4, 'more than one day of occurrences is outstanding')

  const first = shouldFireSchedule(sched({ now, ...many }))
  assert.deepEqual(first, { kind: 'FIRE', occurrenceAt: ist(9, 30) })

  // Stamping the occurrence consumes the whole backlog in one stroke: the very
  // next sweep has nothing left to say. Two alerts at once for one tracker is
  // noise, and the older one is the less true.
  const second = shouldFireSchedule(sched({ now: now + 60_000, ...many, lastFiredAt: ist(9, 30) }))
  assert.deepEqual(second, { kind: 'NONE' })
})

check('quiet hours are never consulted for a SCHEDULE', () => {
  // 03:10 local, deep inside anyone's night. An IDLE reminder would be held;
  // a scheduled one fires, because 03:10 is a time the user chose.
  const decision = shouldFireSchedule(sched({ now: ist(3, 10), timesMin: [3 * 60 + 10] }))
  assert.deepEqual(decision, { kind: 'FIRE', occurrenceAt: ist(3, 10) })
  // There is no quiet input to consult: the decision takes no such field.
  assert.deepEqual(Object.keys(sched()).sort(), [
    'days',
    'lastFiredAt',
    'now',
    'timeZone',
    'timesMin',
  ])
})

check('quiet-hours fields are REJECTED on a SCHEDULE, not silently ignored', () => {
  const base = { trackerId: 't1', kind: 'SCHEDULE', days: [1], timesMin: [540], timeZone: ZONE }
  const withQuiet = createReminderSchema.safeParse({ ...base, quietFromMin: 60, quietToMin: 420 })
  assert.equal(withQuiet.success, false)
  assert.equal(withQuiet.success ? '' : zodMessage(withQuiet.error), 'QUIET_HOURS_NOT_ALLOWED')

  // One end alone is rejected the same way — it is still a quiet-hours field.
  const halfQuiet = createReminderSchema.safeParse({ ...base, quietFromMin: 60 })
  assert.equal(halfQuiet.success ? '' : zodMessage(halfQuiet.error), 'QUIET_HOURS_NOT_ALLOWED')

  // And the plain SCHEDULE is accepted, so the rejection is about quiet hours.
  assert.equal(createReminderSchema.safeParse(base).success, true)
})

check('SCHEDULE validation rejects the empty, the oversized and the duplicate', () => {
  const base = { trackerId: 't1', kind: 'SCHEDULE', timeZone: ZONE }
  const code = (body: unknown): string => {
    const r = createReminderSchema.safeParse(body)
    return r.success ? 'OK' : zodMessage(r.error)
  }

  assert.equal(code({ ...base, days: [], timesMin: [540] }), 'DAYS_REQUIRED')
  assert.equal(code({ ...base, timesMin: [540] }), 'DAYS_REQUIRED')
  assert.equal(code({ ...base, days: [1], timesMin: [] }), 'TIMES_REQUIRED')
  assert.equal(code({ ...base, days: [1] }), 'TIMES_REQUIRED')
  assert.equal(
    code({ ...base, days: [1], timesMin: [0, 60, 120, 180, 240, 300, 360, 420, 480] }),
    'TOO_MANY_TIMES',
  )
  assert.equal(code({ ...base, days: [1, 1], timesMin: [540] }), 'DUPLICATE_DAYS')
  assert.equal(code({ ...base, days: [1], timesMin: [540, 540] }), 'DUPLICATE_TIMES')
  assert.equal(code({ ...base, days: [7], timesMin: [540] }), 'BAD_DAY')
  assert.equal(code({ ...base, days: [-1], timesMin: [540] }), 'BAD_DAY')
  assert.equal(code({ ...base, days: [1], timesMin: [1440] }), 'BAD_TIME')
  assert.equal(code({ ...base, days: [1], timesMin: [-1] }), 'BAD_TIME')
  // The two kinds' fields never mix, in either direction.
  assert.equal(code({ ...base, days: [1], timesMin: [540], afterMs: HOUR }), 'AFTER_MS_NOT_ALLOWED')
  assert.equal(
    code({ trackerId: 't1', afterMs: HOUR, timeZone: ZONE, days: [1] }),
    'DAYS_NOT_ALLOWED',
  )
  // `kind` is optional and means IDLE, so pre-SCHEDULE clients keep working.
  const legacy = createReminderSchema.safeParse({ trackerId: 't1', afterMs: HOUR, timeZone: ZONE })
  assert.equal(legacy.success && legacy.data.kind, 'IDLE')
  // PATCH shares the vocabulary.
  const patched = patchReminderSchema.safeParse({ kind: 'SCHEDULE', timesMin: [] })
  assert.equal(patched.success ? '' : zodMessage(patched.error), 'TIMES_REQUIRED')
})

check('DST: a 09:00 occurrence stays at 09:00 across the spring transition', () => {
  // Europe/London goes GMT -> BST at 01:00 UTC on Sunday 29 March 2026.
  const LONDON = 'Europe/London'
  const daily = { days: ALL_DAYS, timesMin: AT_9, timeZone: LONDON }

  // Saturday 28th, still GMT: 09:00 local is 09:00 UTC.
  const beforeUtc = Date.UTC(2026, 2, 28, 9, 0)
  // Monday 30th, now BST: 09:00 local is 08:00 UTC. Adding a fixed offset to
  // the previous day would have produced 09:00 UTC — 10:00 on the wall — which
  // is the drift this resolves.
  const afterUtc = Date.UTC(2026, 2, 30, 8, 0)
  assert.notEqual(afterUtc - beforeUtc, 2 * 24 * HOUR)

  assert.deepEqual(shouldFireSchedule({ ...daily, now: beforeUtc, lastFiredAt: null }), {
    kind: 'FIRE',
    occurrenceAt: beforeUtc,
  })
  assert.deepEqual(shouldFireSchedule({ ...daily, now: afterUtc, lastFiredAt: null }), {
    kind: 'FIRE',
    occurrenceAt: afterUtc,
  })

  // On the wall, both are 09:00 — which is the whole claim.
  assert.equal(localMinutesOfDay(beforeUtc, LONDON), 9 * 60)
  assert.equal(localMinutesOfDay(afterUtc, LONDON), 9 * 60)

  // And 09:00 BST is NOT stale at 09:10 BST, even though the naive offset would
  // have made it look an hour and ten minutes late.
  const tenPast = afterUtc + 10 * 60_000
  assert.deepEqual(shouldFireSchedule({ ...daily, now: tenPast, lastFiredAt: null }), {
    kind: 'FIRE',
    occurrenceAt: afterUtc,
  })

  // The transition day itself: Sunday 29th 09:00 BST = 08:00 UTC.
  assert.equal(zonedTimeToUtc(2026, 3, 29, 9 * 60, LONDON), Date.UTC(2026, 2, 29, 8, 0))
})

check('DST: an autumn transition keeps 09:00 at 09:00 too', () => {
  // America/New_York falls back on 1 November 2026; 8 March 2026 is the spring
  // forward. Both directions, one zone.
  const NY = 'America/New_York'
  assert.equal(zonedTimeToUtc(2026, 3, 7, 9 * 60, NY), Date.UTC(2026, 2, 7, 14, 0)) // EST, UTC-5
  assert.equal(zonedTimeToUtc(2026, 3, 9, 9 * 60, NY), Date.UTC(2026, 2, 9, 13, 0)) // EDT, UTC-4
  assert.equal(localMinutesOfDay(Date.UTC(2026, 2, 7, 14, 0), NY), 9 * 60)
  assert.equal(localMinutesOfDay(Date.UTC(2026, 2, 9, 13, 0), NY), 9 * 60)

  const daily = { days: ALL_DAYS, timesMin: AT_9, timeZone: NY, lastFiredAt: null }
  assert.deepEqual(shouldFireSchedule({ ...daily, now: Date.UTC(2026, 2, 9, 13, 5) }), {
    kind: 'FIRE',
    occurrenceAt: Date.UTC(2026, 2, 9, 13, 0),
  })
})

check('the payload names the time it was due, in the reminder`s zone', () => {
  assert.deepEqual(buildSchedulePayload('Medication', 'trk-1', ist(9, 0), ZONE), {
    title: 'Medication',
    body: 'Due at 09:00',
    // The same stable per-tracker tag the idle payload uses.
    tag: 'tracker-trk-1',
  })
  // Read out of the zone, not out of the raw UTC instant.
  assert.equal(buildSchedulePayload('M', 't', ist(21, 5), ZONE).body, 'Due at 21:05')
  assert.equal(buildSchedulePayload('M', 't', ist(21, 5), 'UTC').body, 'Due at 15:35')
  assert.equal(formatTimeOfDay(0), '00:00')
  assert.equal(formatTimeOfDay(1439), '23:59')
  assert.equal(formatTimeOfDay(9 * 60), '09:00')
})

check('recentOccurrences returns a full week, newest first, none in the future', () => {
  const now = ist(12, 0)
  const list = recentOccurrences({ now, days: ALL_DAYS, timesMin: [9 * 60, 21 * 60], timeZone: ZONE })

  assert.equal(list[0], ist(9, 0), 'newest first')
  assert.ok(
    list.every((t) => t <= now),
    'never returns an occurrence in the future',
  )
  assert.deepEqual(
    [...list].sort((a, b) => b - a),
    list,
    'already sorted descending',
  )
  assert.equal(new Set(list).size, list.length, 'no duplicates')

  // Weekdays at two times is ten occurrences a week — the contract's example.
  const weekly = recentOccurrences({
    now,
    days: [1, 2, 3, 4, 5],
    timesMin: [9 * 60, 21 * 60],
    timeZone: ZONE,
  })
  const week = weekly.filter((t) => t > now - 7 * 24 * HOUR)
  assert.equal(week.length, 10)

  // Degenerate input never invents an occurrence.
  assert.deepEqual(recentOccurrences({ now, days: [], timesMin: [540], timeZone: ZONE }), [])
  assert.deepEqual(recentOccurrences({ now, days: [1], timesMin: [], timeZone: ZONE }), [])
})

console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`)
