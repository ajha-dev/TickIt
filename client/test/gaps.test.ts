/**
 * Direct tests for contraction gaps — `npm test --workspace=client`.
 *
 * Kept outside `src/` so the browser build never sees `node:assert`, and in the
 * same hand-rolled style as the server's reminder tests: there is no framework
 * on either side, and these are pure functions.
 *
 * Getting these wrong is quietly expensive — "every 5m" is the number someone
 * reads out on the phone to decide when to go in.
 */
import assert from 'node:assert/strict'
import { GAP_BREAK_MS, gapsByEvent, recentStats } from '../src/lib/gaps.ts'
import type { Event, Tracker } from '../src/types.ts'

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

const SEC = 1_000
const MIN = 60 * SEC
const T0 = Date.UTC(2026, 10, 3, 22, 0) // 22:00 UTC, an evening

function tracker(id: string, over: Partial<Tracker> = {}): Tracker {
  return {
    id,
    profileId: 'p',
    name: id,
    type: 'INTERVAL',
    colour: '#fff',
    icon: 'dot',
    sortOrder: 0,
    fields: [],
    counter: false,
    gaps: true,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

let seq = 0
function span(trackerId: string, startAt: number, endAt: number | null): Event {
  seq += 1
  return {
    id: `e${seq}`,
    trackerId,
    profileId: 'p',
    type: 'INTERVAL',
    startAt,
    endAt,
    values: {},
    note: null,
    ticks: null,
    createdAt: startAt,
    updatedAt: startAt,
  }
}

const byId = (...ts: Tracker[]) => new Map(ts.map((t) => [t.id, t]))

check('frequency is start to start, rest is end to start', () => {
  const a = span('c', T0, T0 + MIN)
  const b = span('c', T0 + 5 * MIN, T0 + 6 * MIN)
  const gaps = gapsByEvent([b, a], byId(tracker('c')))
  assert.equal(gaps.has(a.id), false, 'the first one has no predecessor')
  assert.deepEqual(gaps.get(b.id), { frequency: 5 * MIN, rest: 4 * MIN })
})

check('order of input does not matter', () => {
  const a = span('c', T0, T0 + MIN)
  const b = span('c', T0 + 4 * MIN, T0 + 5 * MIN)
  const c = span('c', T0 + 7 * MIN, T0 + 8 * MIN)
  const gaps = gapsByEvent([c, a, b], byId(tracker('c')))
  assert.equal(gaps.get(b.id)?.frequency, 4 * MIN)
  assert.equal(gaps.get(c.id)?.frequency, 3 * MIN)
  assert.equal(gaps.get(c.id)?.rest, 2 * MIN)
})

check('a gap reaches across midnight', () => {
  const midnight = Date.UTC(2026, 10, 4)
  const a = span('c', midnight - 3 * MIN, midnight - 2 * MIN)
  const b = span('c', midnight + 2 * MIN, null)
  assert.equal(gapsByEvent([a, b], byId(tracker('c'))).get(b.id)?.frequency, 5 * MIN)
})

check('a running predecessor rests for zero, not a negative', () => {
  const a = span('c', T0, null)
  const b = span('c', T0 + 3 * MIN, null)
  assert.deepEqual(gapsByEvent([a, b], byId(tracker('c'))).get(b.id), { frequency: 3 * MIN, rest: 0 })
})

check('an overlap left by an edit rests for zero', () => {
  const a = span('c', T0, T0 + 4 * MIN)
  const b = span('c', T0 + 3 * MIN, T0 + 5 * MIN)
  assert.equal(gapsByEvent([a, b], byId(tracker('c'))).get(b.id)?.rest, 0)
})

check('beyond the break it is a new session, not a gap', () => {
  const a = span('c', T0, T0 + MIN)
  const b = span('c', T0 + GAP_BREAK_MS, T0 + GAP_BREAK_MS + MIN)
  const c = span('c', T0 + GAP_BREAK_MS + 1 + 10 * MIN, null)
  const gaps = gapsByEvent([a, b, c], byId(tracker('c')))
  assert.equal(gaps.get(b.id)?.frequency, GAP_BREAK_MS, 'exactly the break still counts')
  assert.equal(gaps.get(c.id)?.frequency, 10 * MIN + 1)

  const far = span('c', T0 + GAP_BREAK_MS + 1, null)
  assert.equal(gapsByEvent([a, far], byId(tracker('c'))).has(far.id), false)
})

check('trackers without gaps, other trackers, and moments are ignored', () => {
  const off = tracker('off', { gaps: false })
  const c = tracker('c')
  const a = span('off', T0, T0 + MIN)
  const b = span('off', T0 + 5 * MIN, T0 + 6 * MIN)
  const other = span('c', T0 + 2 * MIN, T0 + 3 * MIN)
  const moment = { ...span('c', T0 + 4 * MIN, null), type: 'INSTANT' as const }
  const gaps = gapsByEvent([a, b, other, moment], byId(off, c))
  assert.equal(gaps.size, 0, 'one span per gaps tracker, and a moment is not a span')
})

check('recentStats averages the last hour', () => {
  const now = T0 + 60 * MIN
  const old = span('c', T0 - 30 * MIN, T0 - 29 * MIN) // before the hour
  const a = span('c', T0 + 30 * MIN, T0 + 31 * MIN) // 60s
  const b = span('c', T0 + 36 * MIN, T0 + 36 * MIN + 30 * SEC) // 30s
  const c = span('c', T0 + 42 * MIN, null) // running
  const s = recentStats([c, old, b, a], 'c', now)
  assert.equal(s.count, 3)
  assert.equal(s.avgDuration, 45 * SEC, 'only finished ones have a length')
  assert.equal(s.avgFrequency, 6 * MIN)
  assert.equal(s.last?.id, c.id)
})

check('recentStats with one span has no rhythm yet', () => {
  const a = span('c', T0, T0 + MIN)
  const s = recentStats([a], 'c', T0 + 2 * MIN)
  assert.equal(s.count, 1)
  assert.equal(s.avgFrequency, null)
})

check('recentStats forgets the last one after the break', () => {
  const a = span('c', T0, T0 + MIN)
  assert.equal(recentStats([a], 'c', T0 + GAP_BREAK_MS + 1).last, null)
  assert.equal(recentStats([], 'c', T0).avgDuration, null)
})

console.log(`\n${passed} passed`)
