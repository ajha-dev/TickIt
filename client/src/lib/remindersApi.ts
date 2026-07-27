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

export interface Reminder {
  id: string
  trackerId: string
  profileId: string
  /** Idle threshold in ms. "Nothing logged on this tracker for N hours." */
  afterMs: number
  /** Minutes past LOCAL midnight, or null. Both ends or neither. */
  quietFromMin: number | null
  /** Minutes past local midnight, or null. May wrap past midnight. */
  quietToMin: number | null
  /** IANA name — the server evaluates quiet hours in it. */
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

export function createReminder(input: {
  trackerId: string
  afterMs: number
  quietFromMin?: number | null
  quietToMin?: number | null
  timeZone: string
}): Promise<Reminder> {
  return request('/reminders', { method: 'POST', body: input })
}

export function patchReminder(
  id: string,
  patch: {
    afterMs?: number
    quietFromMin?: number | null
    quietToMin?: number | null
    timeZone?: string
    enabled?: boolean
  },
): Promise<Reminder> {
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

export interface ReminderDraft {
  afterMs: number | null
  quietOn: boolean
  quietFromMin: number | null
  quietToMin: number | null
}

/**
 * The contract's limits, checked here so the user gets an answer under their
 * thumb instead of a 400 after a round trip. Same rules, same order as
 * `server/src/lib/validate.ts` and `routes/reminders.ts`.
 */
export function validateDraft(draft: ReminderDraft): string | null {
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
