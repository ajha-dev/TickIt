/**
 * Direct tests for the sweep's decision logic — `npm run test:reminders`.
 *
 * These rules cannot be exercised by curl (there is no push service to receive
 * anything) and getting them wrong is expensive in a specific way: a broken
 * "once per idle period" check means a notification every 60 seconds, forever.
 */
import assert from 'node:assert/strict'
import { formatIdle, inQuietWindow, localMinutesOfDay, shouldFire, type FireInput } from './rules.js'

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

console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`)
