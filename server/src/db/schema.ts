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

/**
 * An idle reminder: "nothing logged on this tracker for `afterMs`".
 *
 * `timeZone` is the one place the server stores a wall-clock concept. It exists
 * only so the sweep can evaluate the quiet window in the user's local time;
 * everything else in this schema is UTC epoch millis and stays that way.
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
    afterMs: integer('after_ms').notNull(),
    /** Minutes past LOCAL midnight, or null for "no quiet hours". */
    quietFromMin: integer('quiet_from_min'),
    /** Minutes past local midnight; may be less than `quietFromMin` (wraps). */
    quietToMin: integer('quiet_to_min'),
    /** IANA name, e.g. "Asia/Kolkata". */
    timeZone: text('time_zone').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * When this reminder last consumed an idle period. The sweep skips while
     * `lastFiredAt >= anchor`, which is what makes it fire once per idle period
     * instead of once every 60 seconds.
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
