import { z } from 'zod'
import type { FieldDef } from '../db/schema.js'

/** UTC epoch milliseconds. The server never parses or formats a date. */
const epochMs = z.number().int().finite()

const nonEmpty = z.string().min(1).max(200)

export const trackerTypeSchema = z.enum(['INSTANT', 'INTERVAL'])

export const valuesSchema = z.record(z.union([z.string(), z.number(), z.boolean()]))

/* ------------------------------------------------------------------ profiles */

export const createProfileSchema = z.object({
  name: nonEmpty,
  colour: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(64).optional(),
})

export const patchProfileSchema = z.object({
  name: nonEmpty.optional(),
  colour: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(64).optional(),
  sortOrder: z.number().int().optional(),
  archivedAt: epochMs.nullable().optional(),
})

/* -------------------------------------------------------------------- fields */

export const MAX_FIELDS = 1

export const fieldKindSchema = z.enum(['CHOICE', 'NUMBER', 'BOOL', 'TEXT'])

/**
 * One field definition as it arrives from the client. `id` is optional — the
 * server assigns a uuidv7 when it is absent. When it is present and matches an
 * existing field on the tracker, that field is updated in place and keeps its
 * id, so values already logged against it stay attached.
 */
const fieldDefInputSchema = z
  .object({
    id: z.string().min(1).max(64).optional(),
    label: z.string().min(1, 'BAD_FIELD_LABEL').max(24, 'BAD_FIELD_LABEL'),
    kind: fieldKindSchema,
    unit: z.string().min(1).max(8, 'UNIT_NOT_ALLOWED').optional(),
    options: z.array(z.string()).optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })

    if (f.kind === 'CHOICE') {
      if (!f.options || f.options.length === 0) return fail('OPTIONS_REQUIRED')
      if (f.options.length < 2 || f.options.length > 6) return fail('OPTIONS_REQUIRED')
      if (f.options.some((o) => o.length < 1 || o.length > 16)) return fail('OPTIONS_REQUIRED')
    } else if (f.options !== undefined) {
      return fail('OPTIONS_NOT_ALLOWED')
    }

    // `unit` only means something on a number. Carrying it on a BOOL or a
    // CHOICE would be a definition the client could never render.
    if (f.unit !== undefined && f.kind !== 'NUMBER') return fail('UNIT_NOT_ALLOWED')

    if (f.defaultValue !== undefined && !valueMatchesKind(f, f.defaultValue)) {
      return fail('BAD_DEFAULT_VALUE')
    }
  })

export const fieldsSchema = z
  .array(fieldDefInputSchema)
  .max(MAX_FIELDS, 'TOO_MANY_FIELDS')
  .superRefine((list, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })

    const labels = new Set<string>()
    for (const f of list) {
      const key = f.label.trim().toLowerCase()
      if (labels.has(key)) return fail('DUPLICATE_FIELD_LABEL')
      labels.add(key)
    }

    const ids = new Set<string>()
    for (const f of list) {
      if (f.id === undefined) continue
      if (ids.has(f.id)) return fail('DUPLICATE_FIELD_ID')
      ids.add(f.id)
    }
  })

export type FieldDefInput = z.infer<typeof fieldsSchema>[number]

/** Does `value` typecheck against the kind of `field`? */
export function valueMatchesKind(
  field: { kind: FieldDef['kind']; options?: string[] },
  value: unknown,
): boolean {
  switch (field.kind) {
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value)
    case 'BOOL':
      return typeof value === 'boolean'
    case 'TEXT':
      return typeof value === 'string'
    case 'CHOICE':
      return typeof value === 'string' && (field.options ?? []).includes(value)
  }
}

/**
 * Validate `Event.values` against a tracker's current fields.
 *
 * Every field is optional — `{}` is valid for every tracker, always. Nothing is
 * ever required at log time; the server must not undermine that.
 *
 * Returns an error code, or `null` when the values are acceptable.
 */
export function validateEventValues(
  fields: FieldDef[],
  values: Record<string, string | number | boolean> | undefined,
): 'UNKNOWN_FIELD' | 'BAD_FIELD_VALUE' | null {
  if (!values) return null
  const byId = new Map(fields.map((f) => [f.id, f]))
  for (const [fieldId, value] of Object.entries(values)) {
    const field = byId.get(fieldId)
    if (!field) return 'UNKNOWN_FIELD'
    if (!valueMatchesKind(field, value)) return 'BAD_FIELD_VALUE'
  }
  return null
}

/* ------------------------------------------------------------------ trackers */

export const listTrackersQuerySchema = z.object({
  profileId: z.string().min(1),
})

export const createTrackerSchema = z.object({
  profileId: z.string().min(1),
  name: nonEmpty,
  type: trackerTypeSchema,
  colour: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(64).optional(),
  fields: fieldsSchema.optional(),
})

export const patchTrackerSchema = z.object({
  name: nonEmpty.optional(),
  colour: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(64).optional(),
  sortOrder: z.number().int().optional(),
  archivedAt: epochMs.nullable().optional(),
  fields: fieldsSchema.optional(),
})

/* -------------------------------------------------------------------- events */

const numericString = z
  .string()
  .regex(/^-?\d+$/, 'must be an integer')
  .transform(Number)

export const listEventsQuerySchema = z.object({
  profileId: z.string().min(1),
  from: numericString.optional(),
  to: numericString.optional(),
  limit: numericString.pipe(z.number().int().min(1).max(1000)).optional(),
})

export const runningEventsQuerySchema = z.object({
  profileId: z.string().min(1),
})

export const createEventSchema = z.object({
  // Optional client-supplied id, so an offline queue can retry safely: if the
  // response is lost after the server committed, the replay carries the same id
  // and is recognised rather than inserted twice. UUIDv7 keeps ids
  // time-sortable however they were minted.
  id: z.string().uuid().optional(),
  trackerId: z.string().min(1),
  startAt: epochMs.optional(),
  values: valuesSchema.optional(),
  note: z.string().max(4000).nullable().optional(),
})

export const stopEventSchema = z.object({
  endAt: epochMs.optional(),
})

export const patchEventSchema = z.object({
  startAt: epochMs.optional(),
  endAt: epochMs.nullable().optional(),
  values: valuesSchema.optional(),
  note: z.string().max(4000).nullable().optional(),
})

/* ----------------------------------------------------------------- reminders */

/** Contract: `afterMs` is bounded to 5 minutes … 48 hours. */
export const MIN_AFTER_MS = 5 * 60_000
export const MAX_AFTER_MS = 48 * 60 * 60_000

const MINUTES_PER_DAY = 1440

const afterMsSchema = z
  .number()
  .int()
  .min(MIN_AFTER_MS, 'AFTER_MS_OUT_OF_RANGE')
  .max(MAX_AFTER_MS, 'AFTER_MS_OUT_OF_RANGE')

/** Minutes past local midnight. 0 … 1439. */
const quietMinSchema = z
  .number()
  .int()
  .min(0, 'BAD_QUIET_HOURS')
  .max(MINUTES_PER_DAY - 1, 'BAD_QUIET_HOURS')
  .nullable()

/**
 * Is `zone` a real IANA time zone name?
 *
 * `Intl.supportedValuesOf` is the cheap exact answer where it exists; the
 * `DateTimeFormat` construction is the fallback, and it throws a RangeError for
 * anything the runtime does not recognise. Both reject "UTC+5" style offsets,
 * which is what we want: the sweep needs a zone with DST rules, not an offset.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const timeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'BAD_TIME_ZONE')

/**
 * Quiet hours are all-or-nothing: a window needs both ends. A single endpoint
 * describes no window at all, and silently ignoring the half that was sent
 * would leave the user believing they had configured quiet hours.
 *
 * `from === to` is rejected too — it is unreadable as either an empty window or
 * a whole day, and the user meant one of them.
 */
function refineQuietHours(
  value: { quietFromMin?: number | null; quietToMin?: number | null },
  ctx: z.RefinementCtx,
): void {
  const from = value.quietFromMin ?? null
  const to = value.quietToMin ?? null
  if ((from === null) !== (to === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'QUIET_HOURS_INCOMPLETE' })
    return
  }
  if (from !== null && to !== null && from === to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'BAD_QUIET_HOURS' })
  }
}

export const reminderKindSchema = z.enum(['IDLE', 'SCHEDULE'], {
  errorMap: () => ({ message: 'BAD_REMINDER_KIND' }),
})

/** Contract: `timesMin` is capped at 8 entries. */
export const MAX_TIMES = 8

/** 0..6, 0 = Sunday, in JS `getDay` order. */
const daySchema = z.number().int().min(0, 'BAD_DAY').max(6, 'BAD_DAY')

/** Minutes past local midnight, 0..1439. */
const timeMinSchema = z.number().int().min(0, 'BAD_TIME').max(MINUTES_PER_DAY - 1, 'BAD_TIME')

/**
 * `days` — 1–7 unique entries. Empty is rejected rather than treated as "every
 * day": a schedule that never occurs is a bug, not a preference, and guessing
 * which of the two the user meant is worse than saying so.
 */
export const daysSchema = z
  .array(daySchema)
  .min(1, 'DAYS_REQUIRED')
  .max(7, 'TOO_MANY_DAYS')
  .refine((d) => new Set(d).size === d.length, 'DUPLICATE_DAYS')

/**
 * `timesMin` — 1–8 unique entries. Sorting is left to the caller (see
 * `sortTimes`) so the stored order is always ascending regardless of what the
 * client sent.
 */
export const timesMinSchema = z
  .array(timeMinSchema)
  .min(1, 'TIMES_REQUIRED')
  .max(MAX_TIMES, 'TOO_MANY_TIMES')
  .refine((t) => new Set(t).size === t.length, 'DUPLICATE_TIMES')

/** Stored ascending, so the client never has to sort and diffs stay readable. */
export function sortTimes(times: number[]): number[] {
  return [...times].sort((a, b) => a - b)
}

/**
 * The kind decides which fields are allowed, and the rejection is loud in both
 * directions. Quietly ignoring a `quietFromMin` sent with a SCHEDULE would
 * leave the user believing they had silenced a reminder that the contract says
 * must never be silenced.
 */
function refineByKind(
  value: {
    kind?: 'IDLE' | 'SCHEDULE'
    afterMs?: number
    quietFromMin?: number | null
    quietToMin?: number | null
    days?: number[]
    timesMin?: number[]
  },
  ctx: z.RefinementCtx,
): void {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })

  if (value.kind === 'SCHEDULE') {
    // Quiet hours exist because an idle reminder fires at a time nobody chose;
    // a scheduled one fires at a time you picked deliberately.
    if (value.quietFromMin !== undefined || value.quietToMin !== undefined) {
      return fail('QUIET_HOURS_NOT_ALLOWED')
    }
    if (value.afterMs !== undefined) return fail('AFTER_MS_NOT_ALLOWED')
    return
  }

  // IDLE — the schedule fields have no meaning here.
  if (value.days !== undefined) return fail('DAYS_NOT_ALLOWED')
  if (value.timesMin !== undefined) return fail('TIMES_NOT_ALLOWED')
  refineQuietHours(value, ctx)
}

export const listRemindersQuerySchema = z.object({
  profileId: z.string().min(1),
})

export const createReminderSchema = z
  .object({
    trackerId: z.string().min(1),
    // Defaults to IDLE so clients written before SCHEDULE existed keep working
    // unchanged.
    kind: reminderKindSchema.default('IDLE'),
    afterMs: afterMsSchema.optional(),
    quietFromMin: quietMinSchema.optional(),
    quietToMin: quietMinSchema.optional(),
    days: daysSchema.optional(),
    timesMin: timesMinSchema.optional(),
    timeZone: timeZoneSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message })

    // On create, the kind's own fields are required — a reminder with no
    // threshold and no schedule can never fire.
    if (v.kind === 'SCHEDULE') {
      if (v.days === undefined) return fail('DAYS_REQUIRED')
      if (v.timesMin === undefined) return fail('TIMES_REQUIRED')
    } else if (v.afterMs === undefined) {
      return fail('AFTER_MS_REQUIRED')
    }

    refineByKind(v, ctx)
  })

/**
 * PATCH validates against the *merged* row, not the body alone: sending only
 * `timesMin` to an existing SCHEDULE is a legitimate edit, and only the route
 * knows what the row already holds. What this schema can say on its own is that
 * the body does not mix the two kinds' fields — `kind` here is the kind the row
 * will END UP as, which the route resolves before calling `patchReminderFields`.
 */
export const patchReminderSchema = z
  .object({
    kind: reminderKindSchema.optional(),
    afterMs: afterMsSchema.optional(),
    quietFromMin: quietMinSchema.optional(),
    quietToMin: quietMinSchema.optional(),
    days: daysSchema.optional(),
    timesMin: timesMinSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

/**
 * Does a body's field set belong to `kind`? Used by PATCH, where the kind may
 * be coming from the existing row rather than the body, so the check cannot
 * live inside the schema.
 *
 * Only *presence* is judged here — the ranges were already enforced by the
 * schema. Returns an error code or null.
 */
export function reminderFieldsForKindError(
  kind: 'IDLE' | 'SCHEDULE',
  body: {
    afterMs?: number
    quietFromMin?: number | null
    quietToMin?: number | null
    days?: number[]
    timesMin?: number[]
  },
): string | null {
  if (kind === 'SCHEDULE') {
    if (body.quietFromMin !== undefined || body.quietToMin !== undefined) {
      return 'QUIET_HOURS_NOT_ALLOWED'
    }
    if (body.afterMs !== undefined) return 'AFTER_MS_NOT_ALLOWED'
    return null
  }
  if (body.days !== undefined) return 'DAYS_NOT_ALLOWED'
  if (body.timesMin !== undefined) return 'TIMES_NOT_ALLOWED'
  return null
}

/* --------------------------------------------------------------------- push */

export const subscribePushSchema = z
  .object({
    endpoint: z.string().url('BAD_ENDPOINT').max(2000),
    keys: z.object({
      p256dh: z.string().min(1).max(400),
      auth: z.string().min(1).max(400),
    }),
  })
  .strict()

export const unsubscribePushSchema = z
  .object({
    endpoint: z.string().min(1).max(2000),
  })
  .strict()

/** Turn a ZodError into the contract's flat `{ error }` message. */
export function zodMessage(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'INVALID_BODY'
  // A message that is already an error code is the contract's own vocabulary —
  // return it bare so clients can switch on it, rather than burying it behind
  // a path prefix.
  if (/^[A-Z][A-Z0-9_]*$/.test(first.message)) return first.message
  const path = first.path.join('.')
  return path ? `${path}: ${first.message}` : first.message
}
