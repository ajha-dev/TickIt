import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export type TrackerType = 'INSTANT' | 'INTERVAL'
export type FieldKind = 'CHOICE' | 'NUMBER' | 'BOOL' | 'TEXT'

export interface FieldDef {
  id: string
  label: string
  kind: FieldKind
  unit?: string
  options?: string[]
  defaultValue?: string | number | boolean
}

export type EventValues = Record<string, string | number | boolean>

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  colour: text('colour').notNull(),
  icon: text('icon').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: integer('archived_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const trackers = sqliteTable(
  'trackers',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').$type<TrackerType>().notNull(),
    colour: text('colour').notNull(),
    icon: text('icon').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    fields: text('fields', { mode: 'json' })
      .$type<FieldDef[]>()
      .notNull()
      .default(sql`'[]'`),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('trackers_profile_id_idx').on(t.profileId)],
)

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    trackerId: text('tracker_id')
      .notNull()
      .references(() => trackers.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: text('type').$type<TrackerType>().notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at'),
    values: text('values', { mode: 'json' })
      .$type<EventValues>()
      .notNull()
      .default(sql`'{}'`),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('events_profile_start_idx').on(t.profileId, t.startAt),
    index('events_tracker_idx').on(t.trackerId),
    index('events_running_idx').on(t.profileId, t.type, t.endAt),
  ],
)

export type ReminderKind = 'IDLE' | 'SCHEDULE'

/**
 * A reminder, of one of two kinds. They answer different questions and are
 * alternatives, not layers — a tracker has at most one reminder.
 *
 * - `IDLE` — "nothing logged on this tracker for `afterMs`". Reactive: logging
 *   resets the clock. `afterMs` / `quietFromMin` / `quietToMin` belong to it and
 *   are null on a `SCHEDULE`.
 * - `SCHEDULE` — "remind me at `timesMin` on `days`". Absolute: it fires whether
 *   or not anything was ever logged. `days` / `timesMin` belong to it and are
 *   null on an `IDLE`.
 *
 * The kind-specific columns are nullable rather than split into two tables: one
 * tracker has one reminder either way, and a join for a row that is never
 * ambiguous buys nothing. The route is what keeps the halves from being set at
 * once, and it clears the other half on a kind change.
 *
 * `timeZone` is the one place the server stores a wall-clock concept. It exists
 * only so the sweep can evaluate the quiet window and resolve schedule
 * occurrences in the user's local time; everything else in this schema is UTC
 * epoch millis and stays that way.
 */
export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    // One tracker, one reminder — enforced in the database, not just the route.
    trackerId: text('tracker_id')
      .notNull()
      .references(() => trackers.id, { onDelete: 'cascade' }),
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    /**
     * Defaulted to 'IDLE' so every row that existed before SCHEDULE was a thing
     * migrates to exactly what it already was.
     */
    kind: text('kind').$type<ReminderKind>().notNull().default('IDLE'),
    /** IDLE only: the idle threshold. Null on a SCHEDULE. */
    afterMs: integer('after_ms'),
    /** IDLE only: minutes past LOCAL midnight, or null for "no quiet hours". */
    quietFromMin: integer('quiet_from_min'),
    /** IDLE only: minutes past local midnight; may be less than `quietFromMin` (wraps). */
    quietToMin: integer('quiet_to_min'),
    /** SCHEDULE only: days of the week, 0..6, 0 = Sunday (JS `getDay` order). */
    days: text('days', { mode: 'json' }).$type<number[]>(),
    /** SCHEDULE only: minutes past local midnight, 0..1439, stored ascending. */
    timesMin: text('times_min', { mode: 'json' }).$type<number[]>(),
    /** IANA name, e.g. "Asia/Kolkata". */
    timeZone: text('time_zone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * IDLE: when this reminder last consumed an idle period — the sweep skips
     * while `lastFiredAt >= anchor`, which is what makes it fire once per idle
     * period instead of once every 60 seconds.
     *
     * SCHEDULE: the timestamp of the last occurrence dealt with — *the
     * occurrence's own* timestamp, not the moment of sending, so a second sweep
     * in the same minute cannot re-fire it and a clock adjustment cannot
     * resurrect it.
     */
    lastFiredAt: integer('last_fired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('reminders_tracker_idx').on(t.trackerId),
    index('reminders_profile_idx').on(t.profileId),
    index('reminders_enabled_idx').on(t.enabled),
  ],
)

/** A browser's Web Push subscription. Keyed by endpoint — subscribing twice with
 * the same endpoint refreshes the row rather than adding one. */
export const pushSubs = sqliteTable(
  'push_subs',
  {
    id: text('id').primaryKey(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [uniqueIndex('push_subs_endpoint_idx').on(t.endpoint)],
)

export type ProfileRow = typeof profiles.$inferSelect
export type TrackerRow = typeof trackers.$inferSelect
export type EventRow = typeof events.$inferSelect
export type ReminderRow = typeof reminders.$inferSelect
export type PushSubRow = typeof pushSubs.$inferSelect
