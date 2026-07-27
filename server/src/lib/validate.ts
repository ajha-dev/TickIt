import { z } from 'zod'

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
})

export const patchTrackerSchema = z.object({
  name: nonEmpty.optional(),
  colour: z.string().min(1).max(64).optional(),
  icon: z.string().min(1).max(64).optional(),
  sortOrder: z.number().int().optional(),
  archivedAt: epochMs.nullable().optional(),
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

/** Turn a ZodError into the contract's flat `{ error }` message. */
export function zodMessage(error: z.ZodError): string {
  const first = error.issues[0]
  if (!first) return 'INVALID_BODY'
  const path = first.path.join('.')
  return path ? `${path}: ${first.message}` : first.message
}
