import type {
  DeletePreviewProfile,
  DeletePreviewTracker,
  Event,
  FieldDefInput,
  Profile,
  Tracker,
  TrackerType,
} from './types.ts'

const BASE = '/api'

/** Any non-2xx response from the API. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message?: string) {
    super(message ?? code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/**
 * 409 from `POST /api/events` when an INTERVAL tracker already has a running
 * event. Carries the id of the event that is already running so the client can
 * offer "stop that one first" — the only modal in the logging path.
 */
export class AlreadyRunningError extends ApiError {
  readonly eventId: string

  constructor(eventId: string) {
    super(409, 'ALREADY_RUNNING', 'That tracker is already running.')
    this.name = 'AlreadyRunningError'
    this.eventId = eventId
  }
}

export function isAlreadyRunning(e: unknown): e is AlreadyRunningError {
  return e instanceof AlreadyRunningError
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = opts

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server.')
  }

  if (res.status === 204) return undefined as T

  const payload = (await res.json().catch(() => null)) as unknown

  if (!res.ok) {
    const record = (payload ?? {}) as Record<string, unknown>
    const code = typeof record.error === 'string' ? record.error : `HTTP_${res.status}`

    if (res.status === 409 && code === 'ALREADY_RUNNING' && typeof record.eventId === 'string') {
      throw new AlreadyRunningError(record.eventId)
    }
    throw new ApiError(res.status, code)
  }

  return payload as T
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const s = search.toString()
  return s ? `?${s}` : ''
}

/* ---------------------------------------------------------------- health -- */

export function getHealth(): Promise<{ ok: true }> {
  return request('/health')
}

/* -------------------------------------------------------------- profiles -- */

export function listProfiles(): Promise<Profile[]> {
  return request('/profiles')
}

export function createProfile(input: {
  name: string
  colour?: string
  icon?: string
}): Promise<Profile> {
  return request('/profiles', { method: 'POST', body: input })
}

export function updateProfile(
  id: string,
  patch: {
    name?: string
    colour?: string
    icon?: string
    sortOrder?: number
    archivedAt?: number | null
  },
): Promise<Profile> {
  return request(`/profiles/${id}`, { method: 'PATCH', body: patch })
}

export function deleteProfile(id: string): Promise<void> {
  return request(`/profiles/${id}`, { method: 'DELETE' })
}

export function previewProfileDelete(id: string): Promise<DeletePreviewProfile> {
  return request(`/profiles/${id}/delete-preview`)
}

/* -------------------------------------------------------------- trackers -- */

export function listTrackers(profileId: string): Promise<Tracker[]> {
  return request(`/trackers${query({ profileId })}`)
}

export function createTracker(input: {
  profileId: string
  name: string
  type: TrackerType
  colour?: string
  icon?: string
  fields?: FieldDefInput[]
}): Promise<Tracker> {
  return request('/trackers', { method: 'POST', body: input })
}

export function updateTracker(
  id: string,
  patch: {
    name?: string
    colour?: string
    icon?: string
    sortOrder?: number
    archivedAt?: number | null
    /** Send the *whole* list. Fields carrying an existing id are updated in
     *  place; fields without one are created. Omitted fields are removed —
     *  which does not touch values already logged against them. */
    fields?: FieldDefInput[]
  },
): Promise<Tracker> {
  return request(`/trackers/${id}`, { method: 'PATCH', body: patch })
}

export function deleteTracker(id: string): Promise<void> {
  return request(`/trackers/${id}`, { method: 'DELETE' })
}

export function previewTrackerDelete(id: string): Promise<DeletePreviewTracker> {
  return request(`/trackers/${id}/delete-preview`)
}

/* ---------------------------------------------------------------- events -- */

export function listEvents(params: {
  profileId: string
  from?: number
  to?: number
  limit?: number
}): Promise<Event[]> {
  return request(`/events${query({ ...params })}`)
}

export function listRunning(profileId: string): Promise<Event[]> {
  return request(`/events/running${query({ profileId })}`)
}

/** Logs a Moment, or starts a Span. Throws `AlreadyRunningError` on 409. */
export function createEvent(input: {
  trackerId: string
  startAt?: number
  values?: Record<string, string | number | boolean>
  note?: string
}): Promise<Event> {
  return request('/events', { method: 'POST', body: input })
}

export function stopEvent(id: string, endAt?: number): Promise<Event> {
  return request(`/events/${id}/stop`, {
    method: 'POST',
    body: endAt === undefined ? {} : { endAt },
  })
}

export function updateEvent(
  id: string,
  patch: {
    startAt?: number
    endAt?: number | null
    values?: Record<string, string | number | boolean>
    note?: string | null
  },
): Promise<Event> {
  return request(`/events/${id}`, { method: 'PATCH', body: patch })
}

export function deleteEvent(id: string): Promise<void> {
  return request(`/events/${id}`, { method: 'DELETE' })
}
