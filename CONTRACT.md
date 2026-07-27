# TickIt — Phase 1 contract

The interface the client and server are built against. Both sides implement this
exactly; do not invent, rename, or "improve" endpoints or field names.

## Repo layout

```
TickIt/
  package.json          # npm workspaces: ["server", "client"]
  justfile
  server/
    package.json
    src/
      index.ts          # Hono app, static serving, listen
      db/
        schema.ts       # Drizzle schema
        client.ts       # better-sqlite3 + drizzle instance, WAL pragma
        seed.ts         # default profile on first boot
      routes/
        health.ts  profiles.ts  trackers.ts  events.ts
      lib/
        ids.ts          # uuidv7
        validate.ts     # zod schemas
    drizzle.config.ts
    drizzle/            # generated migrations, committed
  client/
    package.json
    index.html
    src/
      main.tsx  App.tsx
      api.ts            # typed fetch wrappers
      types.ts          # mirrors this contract
      screens/  components/  lib/
  docker/
    Dockerfile  entrypoint.sh  litestream.yml
  docker-compose.yml        # local dev
  docker-compose.prod.yml   # Pi
```

## Rules that are not negotiable

1. **All timestamps are UTC epoch milliseconds**, stored as SQLite `INTEGER`.
   The server never formats a date, never parses a local date string, and never
   computes a day boundary. The client does all of that in the device zone.
2. **Hard deletes.** No `deletedAt` anywhere. `ON DELETE CASCADE` on foreign
   keys, with `PRAGMA foreign_keys = ON`.
3. **`archivedAt` is not deletion** — it hides a tracker/profile from the home
   grid. Archived rows are still returned by list endpoints; the client filters.
4. Server port **3002** (savethisread already occupies 3001 on the Pi).
5. API is mounted under `/api`. Everything else serves the built SPA.

## Types

```ts
type TrackerType = 'INSTANT' | 'INTERVAL'
type FieldKind   = 'CHOICE' | 'NUMBER' | 'BOOL' | 'TEXT'

interface FieldDef {
  id: string
  label: string
  kind: FieldKind
  unit?: string
  options?: string[]
  defaultValue?: string | number | boolean
}

interface Profile {
  id: string; name: string; colour: string; icon: string
  sortOrder: number
  archivedAt: number | null
  createdAt: number; updatedAt: number
}

interface Tracker {
  id: string; profileId: string; name: string
  type: TrackerType
  colour: string; icon: string
  sortOrder: number
  fields: FieldDef[]          // JSON column; [] in Phase 1
  archivedAt: number | null
  createdAt: number; updatedAt: number
}

interface Event {
  id: string; trackerId: string; profileId: string
  type: TrackerType           // denormalised from tracker — see note
  startAt: number             // always set
  endAt: number | null        // null = INSTANT, or a RUNNING interval
  values: Record<string, string | number | boolean>   // JSON column; {} in Phase 1
  note: string | null
  createdAt: number; updatedAt: number
}
```

**Why `type` is denormalised onto Event:** `endAt === null` is ambiguous on its
own — it means both "this is a Moment" and "this Span is still running". With
`type` on the row, *running* is `type = 'INTERVAL' AND endAt IS NULL`: one
indexed query, no join, and the Dashboard can decide bar-vs-tick straight from
the event. `profileId` is denormalised for the same reason.

## Endpoints

All responses are JSON. Errors: `{ error: string }` with 400 / 404 / 409.

### Health
- `GET /api/health` → `{ ok: true }`

### Profiles
- `GET /api/profiles` → `Profile[]` (sorted by `sortOrder`, then `createdAt`)
- `POST /api/profiles` `{ name, colour?, icon? }` → `Profile`
- `PATCH /api/profiles/:id` `{ name?, colour?, icon?, sortOrder?, archivedAt? }` → `Profile`
- `DELETE /api/profiles/:id` → `204`
- `GET /api/profiles/:id/delete-preview` → `{ trackers: number, events: number }`

### Trackers
- `GET /api/trackers?profileId=…` → `Tracker[]` (sorted by `sortOrder`, then `createdAt`)
- `POST /api/trackers` `{ profileId, name, type, colour?, icon?, fields? }` → `Tracker`
- `PATCH /api/trackers/:id` `{ name?, colour?, icon?, sortOrder?, archivedAt?, fields? }` → `Tracker`
- `DELETE /api/trackers/:id` → `204`
- `GET /api/trackers/:id/delete-preview` → `{ events: number }`

### Events
- `GET /api/events?profileId=…&from=…&to=…&limit=…` → `Event[]`
  `from`/`to` are UTC epoch ms, both optional, filter on `startAt`.
  Sorted `startAt DESC`. `limit` defaults to 200, max 1000.
- `GET /api/events/running?profileId=…` → `Event[]`
  `type = 'INTERVAL' AND endAt IS NULL`, sorted `startAt ASC`.
- `POST /api/events` `{ trackerId, startAt?, values?, note? }` → `Event` `201`
  `startAt` defaults to now. Server reads the tracker to set `type` and
  `profileId`. For `INSTANT`, `endAt` stays null forever. For `INTERVAL`, this
  starts a run.
  **409** if the tracker is `INTERVAL` and already has a running event — body
  `{ error: 'ALREADY_RUNNING', eventId }`. The client turns that into the
  stop-first prompt.
- `POST /api/events/:id/stop` `{ endAt? }` → `Event`
  `endAt` defaults to now. **400** if the event is `INSTANT` or already stopped.
  **400** if `endAt < startAt`.
- `PATCH /api/events/:id` `{ startAt?, endAt?, values?, note? }` → `Event`
  **400** if the result would have `endAt < startAt`.
- `DELETE /api/events/:id` → `204`

`updatedAt` is set on every mutation **except `POST /events/:id/stop`** —
stopping is how a Span normally completes, not a correction to it. If stop
bumped `updatedAt`, the client's "edited" marker would appear on every Span ever
finished and mean nothing. The client shows that marker when
`updatedAt !== createdAt`.

`PATCH /api/events/:id` returns **400 `NOT_AN_INTERVAL`** if it would set a
non-null `endAt` on an `INSTANT` event — that would silently turn a Moment into
a Span whose tracker still says `INSTANT`.

## Field definitions and values

`Tracker.fields` is a `FieldDef[]` holding **at most one field**. The cap is a
design decision, not a storage limit: the field is answered in the half-second
after a tap, and one question is answerable in that window while several are a
form. It stays an array so the shape never needs a migration if that changes.

Over the cap → 400 `TOO_MANY_FIELDS`. Validation on create/patch:

- `label` — 1–24 chars, required, unique within the tracker (case-insensitive).
- `kind` — one of `CHOICE | NUMBER | BOOL | TEXT`.
- `options` — **required and non-empty for `CHOICE`** (2–6 entries, each 1–16
  chars), rejected with 400 `OPTIONS_REQUIRED` / `OPTIONS_NOT_ALLOWED` for any
  other kind.
- `unit` — optional, `NUMBER` only, ≤ 8 chars. 400 `UNIT_NOT_ALLOWED` otherwise.
- `defaultValue` — optional; must typecheck against `kind`, and for `CHOICE`
  must be one of `options`.
- `id` — server-assigned uuidv7 if absent on create. **Editing a tracker
  preserves existing field ids**; a field whose id matches an existing one is
  updated in place, so already-logged values stay attached.

`Event.values` is a `Record<fieldId, value>` validated against the tracker's
current fields on `POST /api/events` and `PATCH /api/events/:id`:

- Unknown `fieldId` → 400 `UNKNOWN_FIELD`.
- Wrong type for the field's `kind` → 400 `BAD_FIELD_VALUE`.
- `CHOICE` value not in `options` → 400 `BAD_FIELD_VALUE`.
- **The field is optional.** `{}` is always valid, for every tracker. Nothing
  is ever required at log time — this is the app's first principle and the
  server must not undermine it.

The client never renders a save or cancel control on the capture sheet. For
`CHOICE` and `BOOL` the pick itself commits and closes; for `NUMBER` and `TEXT`
the keyboard's return key commits, and dismissing the sheet commits whatever was
typed rather than discarding it.

**Deleting a field from a tracker does not touch logged events.** Their `values`
keep the orphaned key; the client simply stops rendering it. Rewriting history
to match a definition change would be a silent data edit.

**On `PATCH /api/events/:id`, only new or changed values are validated.** A value
byte-identical to what is already stored passes untouched, even if its field has
since been deleted or had its `kind` changed. Otherwise deleting a field would
quietly make every event that ever used it uneditable — the client PATCHes an
event by sending its `values`, the orphaned key comes back, and the whole edit is
rejected. Correcting a mistimed feed would fail because of an unrelated
definition change made months later.

The rule: you may not *add* data for a field that no longer exists, but echoing
back history is not adding data. Verified — echoing an orphaned value returns
200; changing that same orphaned value returns 400 `UNKNOWN_FIELD`.

## Seeding

On boot, if the `profiles` table is empty, insert one profile:
`{ name: 'Personal', colour: '#6366f1', icon: 'circle', sortOrder: 0 }`.
No trackers are seeded — the user defines their own.

## Stack pins

- Node 20+ · TypeScript · ESM (`"type": "module"`)
- Server: `hono`, `@hono/node-server`, `better-sqlite3`, `drizzle-orm`,
  `drizzle-kit`, `zod`, `uuid` (v7 via `import { v7 as uuidv7 } from 'uuid'`)
- Client: `vite`, `react`, `react-dom`, `typescript`, `tailwindcss` v4,
  `@tanstack/react-query`, `wouter` (routing — small, hook-based)
- Dev: server on 3002, Vite on 5173 proxying `/api` → `http://localhost:3002`
- Prod: server serves `client/dist` for all non-`/api` routes
