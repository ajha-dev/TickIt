/**
 * The reminders half of the API, plus the query hooks that sit on it.
 *
 * This is deliberately self-contained rather than an extension of `api.ts` /
 * `queries.ts`: the offline outbox owns those files, and a reminder is not a
 * log. Losing a reminder edit to a flat network is an annoyance you can retry;
 * losing a 3am feed is the failure the outbox exists to prevent. They do not
 * belong on the same queue.
 *
 * Mirrors CONTRACT.md's Reminders section exactly.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'

/**
 * `IDLE` is reactive — the clock is reset by logging. `SCHEDULE` is absolute —
 * it fires at the times you picked whether or not anything was logged. A
 * tracker has at most one reminder, of one kind: they are alternatives, not
 * layers, so exactly one half of the fields below is ever populated.
 */
export type ReminderKind = 'IDLE' | 'SCHEDULE'

export interface Reminder {
  id: string
  trackerId: string
  profileId: string
  kind: ReminderKind
  /** IDLE only. Idle threshold in ms — "nothing logged for N hours". */
  afterMs: number | null
  /** IDLE only. Minutes past LOCAL midnight, or null. Both ends or neither. */
  quietFromMin: number | null
  /** IDLE only. Minutes past local midnight, or null. May wrap past midnight. */
  quietToMin: number | null
  /** SCHEDULE only. 0..6, **0 = Sunday** — JS `getDay()` order. */
  days: number[] | null
  /** SCHEDULE only. Minutes past local midnight, 0..1439, stored ascending. */
  timesMin: number[] | null
  /** IANA name — the server resolves both kinds' local time in it. */
  timeZone: string
  enabled: boolean
  lastFiredAt: number | null
  createdAt: number
  updatedAt: number
}

/** Contract: `afterMs` is clamped to 5 minutes … 48 hours. */
export const MIN_AFTER_MS = 5 * 60_000
export const MAX_AFTER_MS = 48 * 60 * 60_000
export const MINUTES_PER_DAY = 1440
/** Contract: `timesMin` holds 1–8 unique entries. */
export const MAX_TIMES = 8
/** 0 = Sunday, so the index into this is the stored day number itself. */
export const DAY_COUNT = 7

export class ReminderApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'ReminderApiError'
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body } = opts

  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ReminderApiError(0, 'NETWORK')
  }

  if (res.status === 204) {
    // Drain the empty body, or Chrome reports a perfectly good DELETE as
    // net::ERR_ABORTED after the fact.
    await res.arrayBuffer().catch(() => undefined)
    return undefined as T
  }

  const payload = (await res.json().catch(() => null)) as unknown

  if (!res.ok) {
    const record = (payload ?? {}) as Record<string, unknown>
    const code = typeof record.error === 'string' ? record.error : `HTTP_${res.status}`
    throw new ReminderApiError(res.status, code)
  }

  return payload as T
}

/**
 * The device's IANA zone. Sent on create and refreshed on every edit, because
 * quiet hours are a wall-clock concept and the server evaluates them in this
 * zone — a phone carried across a timezone must not keep its old window.
 */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/* ------------------------------------------------------------------ http -- */

export function listReminders(profileId: string): Promise<Reminder[]> {
  return request(`/reminders?profileId=${encodeURIComponent(profileId)}`)
}

/**
 * Both bodies are unions on `kind`, not one wide optional record, because the
 * server rejects a field belonging to the other kind rather than ignoring it —
 * `quietFromMin` sent with a SCHEDULE is a 400, not a no-op. A shape that
 * cannot express `{ kind: 'SCHEDULE', afterMs }` is what keeps a stale
 * threshold from riding along with a new schedule.
 */
export type CreateReminderInput =
  | {
      trackerId: string
      kind: 'IDLE'
      afterMs: number
      quietFromMin: number | null
      quietToMin: number | null
      timeZone: string
    }
  | {
      trackerId: string
      kind: 'SCHEDULE'
      days: number[]
      timesMin: number[]
      timeZone: string
    }

export type ReminderPatch =
  | {
      kind: 'IDLE'
      afterMs: number
      quietFromMin: number | null
      quietToMin: number | null
      timeZone: string
      enabled: boolean
    }
  | {
      kind: 'SCHEDULE'
      days: number[]
      timesMin: number[]
      timeZone: string
      enabled: boolean
    }

export function createReminder(input: CreateReminderInput): Promise<Reminder> {
  return request('/reminders', { method: 'POST', body: input })
}

export function patchReminder(id: string, patch: ReminderPatch): Promise<Reminder> {
  return request(`/reminders/${id}`, { method: 'PATCH', body: patch })
}

export function removeReminder(id: string): Promise<void> {
  return request(`/reminders/${id}`, { method: 'DELETE' })
}

/* ----------------------------------------------------------------- hooks -- */

export const reminderKeys = {
  list: (profileId: string) => ['reminders', profileId] as const,
}

export function useReminders(profileId: string | undefined): UseQueryResult<Reminder[]> {
  return useQuery({
    queryKey: reminderKeys.list(profileId ?? ''),
    queryFn: () => listReminders(profileId as string),
    enabled: Boolean(profileId),
    staleTime: 30_000,
  })
}

export function useCreateReminder(
  profileId: string,
): UseMutationResult<Reminder, Error, Parameters<typeof createReminder>[0]> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createReminder,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reminderKeys.list(profileId) })
    },
  })
}

export function useUpdateReminder(
  profileId: string,
): UseMutationResult<
  Reminder,
  Error,
  { id: string; patch: Parameters<typeof patchReminder>[1] }
> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }) => patchReminder(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reminderKeys.list(profileId) })
    },
  })
}

export function useDeleteReminder(profileId: string): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: removeReminder,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reminderKeys.list(profileId) })
    },
  })
}

/* ------------------------------------------------------ format + validate -- */

/** "45m", "3h", "1h 30m". Short enough to sit inside a row's stencil line. */
export function formatAfter(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/** Minutes past midnight → the `HH:MM` an `<input type="time">` wants. */
export function minutesToTime(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** `HH:MM` → minutes past midnight, or null if the field is empty/garbage. */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/**
 * A local midnight + `minutes`, in the user's own clock convention. The stored
 * value is always minutes past *local* midnight, so a fixed date is enough —
 * nothing here is a real instant, and 12-hour locales must see "9:00 PM" rather
 * than the 21:00 the field holds.
 */
export function formatTimeMin(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60)
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(d)
}

/** Ascending regardless of the order they were entered in. "9:00 AM, 9:00 PM". */
export function formatTimes(timesMin: number[]): string {
  return sortTimes(timesMin).map(formatTimeMin).join(', ')
}

/** The same list as a sentence: "9:00 AM and 9:00 PM". */
export function formatTimesPhrase(timesMin: number[]): string {
  const parts = sortTimes(timesMin).map(formatTimeMin)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** Contract: stored ascending. The client sorts too, so display never depends on it. */
export function sortTimes(timesMin: number[]): number[] {
  return [...timesMin].sort((a, b) => a - b)
}

/**
 * Localised weekday names for 0..6 with 0 = Sunday. 2024-01-07 was a Sunday, so
 * the offset is the day number itself.
 */
export function dayName(day: number, width: 'short' | 'long' = 'short'): string {
  const d = new Date(2024, 0, 7 + day)
  return new Intl.DateTimeFormat(undefined, { weekday: width }).format(d)
}

export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS = [1, 2, 3, 4, 5]
export const WEEKENDS = [0, 6]

function sameDays(a: number[], b: number[]): boolean {
  const set = new Set(a)
  return set.size === b.length && b.every((d) => set.has(d))
}

/**
 * "every day", "weekdays", "weekends", or the days themselves. The named cases
 * exist because that is how a dosing instruction is actually said — "weekdays"
 * is checkable at a glance in a way that five separate chips are not.
 */
export function formatDays(days: number[]): string {
  if (days.length === 0) return 'no days'
  if (sameDays(days, EVERY_DAY)) return 'every day'
  if (sameDays(days, WEEKDAYS)) return 'weekdays'
  if (sameDays(days, WEEKENDS)) return 'weekends'
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => dayName(d))
    .join(', ')
}

/**
 * "9:00 AM, 9:00 PM · weekdays" — the compact form, for a summary row.
 *
 * Long lists collapse to a count. Eight times spelled out is 70-odd characters,
 * which wraps a 60px row into three lines at 390px and stops being scannable
 * long before that; "8 times a day · every day" still says what it is.
 */
export function formatSchedule(timesMin: number[], days: number[], separator = ' · '): string {
  const when = timesMin.length > 3 ? `${timesMin.length} times a day` : formatTimes(timesMin)
  // A named set ("weekdays") always survives; only a spelled-out list collapses.
  const named = formatDays(days)
  const on = named.includes(',') && days.length > 3 ? `${days.length} days` : named
  return `${when}${separator}${on}`
}

/** What a reminder is, in one phrase, whichever kind it is. */
export function summariseReminder(reminder: Reminder): string {
  if (reminder.kind === 'SCHEDULE') {
    return formatSchedule(reminder.timesMin ?? [], reminder.days ?? [])
  }
  return `after ${formatAfter(reminder.afterMs ?? 0)}`
}

/* ---------------------------------------------------------------- drafts -- */

export type ReminderDraft =
  | {
      kind: 'IDLE'
      afterMs: number | null
      quietOn: boolean
      quietFromMin: number | null
      quietToMin: number | null
    }
  | {
      kind: 'SCHEDULE'
      days: number[]
      /** `HH:MM` as typed, so a half-entered field is representable. */
      times: string[]
    }

/**
 * The contract's limits, checked here so the user gets an answer under their
 * thumb instead of a 400 after a round trip. Same rules, same order as
 * `server/src/lib/validate.ts` and `routes/reminders.ts`.
 */
export function validateDraft(draft: ReminderDraft): string | null {
  if (draft.kind === 'SCHEDULE') {
    if (draft.days.length === 0) return 'Pick at least one day.'
    if (draft.times.length === 0) return 'Add at least one time.'
    if (draft.times.length > MAX_TIMES) return `A schedule holds at most ${MAX_TIMES} times.`

    const minutes: number[] = []
    for (const time of draft.times) {
      const value = timeToMinutes(time)
      if (value === null) return 'Every time needs a value.'
      if (minutes.includes(value)) return `${formatTimeMin(value)} is already on the list.`
      minutes.push(value)
    }
    return null
  }

  if (draft.afterMs === null) return 'Enter how long the tracker may stay quiet.'
  if (draft.afterMs < MIN_AFTER_MS) return 'The shortest reminder is 5 minutes.'
  if (draft.afterMs > MAX_AFTER_MS) return 'The longest reminder is 48 hours.'

  if (draft.quietOn) {
    // Quiet hours are all-or-nothing: half a window is not a window.
    if (draft.quietFromMin === null || draft.quietToMin === null) {
      return 'Quiet hours need both a start and an end.'
    }
    if (draft.quietFromMin === draft.quietToMin) {
      return 'Quiet hours must start and end at different times.'
    }
  }
  return null
}

/** A valid draft's times as stored minutes, ascending. */
export function draftTimesMin(times: string[]): number[] {
  return sortTimes(times.map(timeToMinutes).filter((m): m is number => m !== null))
}

/**
 * Draft → request body. Both builders go through the draft's `kind`, so the
 * fields of the kind being *left* cannot survive a switch: the server clears
 * them on its side, and nothing stale is sent from this one.
 *
 * Callers must have run `validateDraft` first — these assume a valid draft.
 */
export function draftToCreate(
  trackerId: string,
  draft: ReminderDraft,
  timeZone: string,
): CreateReminderInput {
  if (draft.kind === 'SCHEDULE') {
    return {
      trackerId,
      kind: 'SCHEDULE',
      days: [...draft.days].sort((a, b) => a - b),
      timesMin: draftTimesMin(draft.times),
      timeZone,
    }
  }
  return {
    trackerId,
    kind: 'IDLE',
    afterMs: draft.afterMs ?? 0,
    quietFromMin: draft.quietOn ? draft.quietFromMin : null,
    quietToMin: draft.quietOn ? draft.quietToMin : null,
    timeZone,
  }
}

export function draftToPatch(
  draft: ReminderDraft,
  timeZone: string,
  enabled: boolean,
): ReminderPatch {
  const created = draftToCreate('', draft, timeZone)
  if (created.kind === 'SCHEDULE') {
    return { kind: 'SCHEDULE', days: created.days, timesMin: created.timesMin, timeZone, enabled }
  }
  return {
    kind: 'IDLE',
    afterMs: created.afterMs,
    quietFromMin: created.quietFromMin,
    quietToMin: created.quietToMin,
    timeZone,
    enabled,
  }
}
