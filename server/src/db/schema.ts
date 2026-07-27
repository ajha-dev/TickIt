import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

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

export type ProfileRow = typeof profiles.$inferSelect
export type TrackerRow = typeof trackers.$inferSelect
export type EventRow = typeof events.$inferSelect
