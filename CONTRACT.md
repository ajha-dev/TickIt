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
4. Server port **3002**.
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
- `POST /api/events` `{ id?, trackerId, startAt?, values?, note? }` → `Event` `201`
  **`id` is an optional client-supplied UUID**, so an offline queue can retry
  safely. A dropped response is indistinguishable from a dropped request, so a
  retry carrying an id the server already has means "did you get this?", not
  "log another one": the existing row is returned with **200** instead of a
  second event being created. Verified — three sends of one id leave exactly one
  event, with the original `startAt` intact.

  The id is checked before the running-span check, so replaying a queued start
  whose span has since been stopped is recognised rather than answered with 409.
  It does not survive the tracker being deleted — that cascades the event away,
  and the replay 404s, which clients must treat as permanent.
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

## Reminders

Two kinds, and they answer different questions.

- **`IDLE`** — "nothing logged on this tracker for N hours". Reactive: the clock
  is reset by *logging*. This is the feeding case.
- **`SCHEDULE`** — "remind me at these times on these days". Absolute: it fires
  whether or not anything was ever logged. This is the medicine case, and it is
  what an ordinary reminders app does.

A tracker has **at most one reminder**, of one kind. They are alternatives, not
layers.

```ts
Reminder { id, trackerId, profileId,
           kind,                // 'IDLE' | 'SCHEDULE'
           timeZone,            // IANA name — both kinds
           enabled, lastFiredAt,
           createdAt, updatedAt,

           // kind = 'IDLE' only, null otherwise
           afterMs,             // idle threshold
           quietFromMin,        // null, or minutes past LOCAL midnight
           quietToMin,          // null, or minutes past local midnight; may wrap

           // kind = 'SCHEDULE' only, null otherwise
           days,                // int[] of 0..6, 0 = Sunday (JS getDay order)
           timesMin }           // int[] of 0..1439, minutes past local midnight

PushSub  { id, endpoint, p256dh, auth, createdAt, lastSeenAt }
```

### SCHEDULE rules

- `days` — 1–7 entries, unique, each 0–6. Empty is rejected (`DAYS_REQUIRED`); a
  schedule that never occurs is a bug, not a preference.
- `timesMin` — 1–8 entries, unique, each 0–1439, stored sorted ascending.
  Rejected empty (`TIMES_REQUIRED`) or over the cap (`TOO_MANY_TIMES`).
- An occurrence is a `(day, time)` pair resolved in the reminder's `timeZone`.
  Two doses at 09:00 and 21:00 on weekdays is 10 occurrences a week.

**Quiet hours do not apply to `SCHEDULE`**, and the fields are rejected on it
(`QUIET_HOURS_NOT_ALLOWED`). Quiet hours exist because an idle reminder fires at
a time nobody chose; a scheduled one fires at a time you picked deliberately.
Silencing it would be overriding an explicit instruction with an implicit one,
and a missed 22:00 dose is exactly the failure the reminder was set to prevent.

**Staleness, not queueing.** A scheduled occurrence fires only if it came due
within the last **60 minutes**. An older one is marked consumed and dropped
silently. If the Pi was off overnight, waking to "Medication — due at 09:00"
at 3pm is worse than useless: it says something false about now, and acting on
it means a double dose. The window is generous enough to survive a reboot or a
sleeping phone, short enough that a notification always means *roughly now*.

**Once per occurrence.** `lastFiredAt` is set to the occurrence's own timestamp,
not to the moment of sending, so a later sweep in the same minute cannot re-fire
it and a clock adjustment cannot resurrect it.

DST is resolved through the stored `timeZone`, so 09:00 stays 09:00 across a
transition rather than drifting by an hour.

- `GET /api/reminders?profileId=…` → `Reminder[]`
- `POST /api/reminders` → `Reminder`
  - `IDLE`: `{ trackerId, kind: 'IDLE', afterMs, quietFromMin?, quietToMin?, timeZone }`
  - `SCHEDULE`: `{ trackerId, kind: 'SCHEDULE', days, timesMin, timeZone }`
  - `kind` may be omitted and defaults to `IDLE`, so existing clients keep working.
- `PATCH /api/reminders/:id` — any of the above fields, plus `enabled`.
  **Changing `kind` is allowed**, and clears the fields belonging to the kind
  being left, so a reminder cannot hold a stale threshold and a stale schedule
  at once. `lastFiredAt` is reset on a kind change: the new kind has never
  fired.
- `DELETE /api/reminders/:id` → `204`
- `GET /api/push/key` → `{ publicKey }` (VAPID public key)
- `POST /api/push/subscribe` `{ endpoint, keys: { p256dh, auth } }` → `204`, idempotent
- `POST /api/push/unsubscribe` `{ endpoint }` → `204`

**One tracker, one reminder** — 409 `REMINDER_EXISTS` on a duplicate.
`afterMs` is clamped to 5 minutes … 48 hours.

### Firing rules

A sweep runs every 60s. For each enabled reminder:

- **Anchor** = the tracker's most recent activity, `max(endAt ?? startAt)` across
  its events, or the reminder's `createdAt` if it has never been used. A
  brand-new reminder on a dormant tracker must not fire instantly.
- Fire when `now - anchor >= afterMs`.
- **Fire once per idle period**, not every sweep: skip if
  `lastFiredAt >= anchor`. Logging an event moves the anchor forward and re-arms
  the reminder. A tracker nobody touches must go quiet after one notification,
  never nag every minute.
- **Quiet hours hold the idle period, they do not consume it.** A reminder due
  at 03:10 inside a 01:00–07:00 window stays silent and `lastFiredAt` is *not*
  stamped, so it fires once at 07:00 when the window closes. The body is
  recomputed at send time — "Nothing logged for 10h" — so nothing stale is ever
  delivered. Consuming the period instead would mean sleeping through the night
  and being told nothing at all in the morning, which is the failure this
  feature exists to prevent. Still exactly one notification per idle period.
- A dead push subscription (`404`/`410` from the push service) is deleted.

**This is the one place the server does local-time arithmetic**, and it is why
`timeZone` is stored on the reminder. Everywhere else the server handles only
UTC epoch millis and the client resolves local time — see the top of this file.
Quiet hours are inherently a wall-clock concept, so the exception is unavoidable;
it is confined to evaluating the quiet window and nothing else.

### Delivery

Web Push with VAPID. Requires HTTPS and a service worker, so it only works once
the app is installed and served over TLS — on iOS, Web Push is available *only*
to a PWA added to the Home Screen (16.4+). The Pi needs outbound internet to
reach the push services.

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
