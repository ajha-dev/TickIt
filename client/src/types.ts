/**
 * Mirrors CONTRACT.md exactly. Do not add, rename, or "improve" fields.
 * All timestamps are UTC epoch milliseconds.
 */

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

/**
 * A field as *sent* to the server. Identical to `FieldDef` except that `id` is
 * optional: a field without one is new, and the server mints a uuidv7 for it.
 * A field with one is an edit in place, which is what keeps values already
 * logged against that id attached to it.
 */
export type FieldDefInput = Omit<FieldDef, 'id'> & { id?: string }

export interface Profile {
  id: string
  name: string
  colour: string
  icon: string
  sortOrder: number
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Tracker {
  id: string
  profileId: string
  name: string
  type: TrackerType
  colour: string
  icon: string
  sortOrder: number
  fields: FieldDef[]
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Event {
  id: string
  trackerId: string
  profileId: string
  type: TrackerType
  startAt: number
  endAt: number | null
  values: Record<string, string | number | boolean>
  note: string | null
  createdAt: number
  updatedAt: number
}

export interface DeletePreviewTracker {
  events: number
}

export interface DeletePreviewProfile {
  trackers: number
  events: number
}
