# TickIt — Plan

A personal event logger. You define what you want to track per context, then log
occurrences in one tap. Not a work-time tracker, not a productivity dashboard.

The API contract the code is built against lives in [CONTRACT.md](./CONTRACT.md).

## Principles

1. **One tap to log.** Every design decision loses to this one. If logging a
   3am feed takes more than a tap from the home screen, the app has failed.
2. **Phone-first.** Installable PWA, large touch targets, dark by default,
   works with no network. Desktop is a courtesy, not a target.
3. **You define the trackers.** The app ships with zero opinions about
   pregnancy, feeding, or running. It ships with the ability to describe them.
4. **Editable, but marked.** Events can be corrected freely. An event whose
   `updatedAt` differs from its `createdAt` renders with a small "edited" marker,
   so a reconstructed time is distinguishable from one recorded live. No audit
   log beyond that.
5. **Self-hosted.** A single SQLite database on a Raspberry Pi on the home
   network. The data is yours, on hardware you own. No account, no cloud, no
   third party holding a health log.

## Concepts

```
Profile  →  Tracker  →  Event
```

- **Profile** — a context. "Pregnancy", "Feeding", "Training". Profiles are
  fully independent: separate trackers, separate events, no roll-up between them.
  Switching profile changes the entire home screen.
- **Tracker** — the *definition* of a thing worth logging. Has a name, an icon,
  a colour, a type, and optional fields.
- **Event** — one logged occurrence of a tracker.

### The two tracker types

| Type | Code | Shape | Examples |
|---|---|---|---|
| **Moment** | `INSTANT` | one timestamp | fetal movement, medication taken, contraction felt |
| **Span** | `INTERVAL` | start + end timestamp | baby feed, a run, a nap |

A Span with no end time is **running**. Running spans are pinned to the top of
the home screen with a live elapsed counter.

### Fields

A tracker may define a small set of optional fields, captured at log time.

| Kind | Renders as | Example |
|---|---|---|
| `CHOICE` | segmented buttons | Feed side: Left / Right / Both |
| `NUMBER` | numeric pad, with a unit | Distance: 5 km |
| `BOOL` | toggle | Assisted: yes/no |
| `TEXT` | free text | note |

Fields are **always optional at log time.** One tap logs the event with no
fields; the detail sheet stays open for a few seconds so values can be added
without a second navigation. Never block a log on data entry.

## Data model

All ids are UUIDv7 (time-sortable, collision-free, sync-ready). All records carry
`createdAt` / `updatedAt`. **Deletes are real deletes** — no `deletedAt`, no
tombstones, no filtering every query.

```ts
Profile  { id, name, colour, icon, sortOrder, archivedAt,
           createdAt, updatedAt }

Tracker  { id, profileId, name, type: 'INSTANT' | 'INTERVAL',
           colour, icon, sortOrder, fields: FieldDef[], archivedAt,
           createdAt, updatedAt }

FieldDef { id, label, kind: 'CHOICE'|'NUMBER'|'BOOL'|'TEXT',
           unit?, options?: string[], defaultValue? }

Event    { id, trackerId, profileId,
           type,                     // denormalised from Tracker
           startAt,                  // always set
           endAt,                    // null for INSTANT; null for a running SPAN
           values: Record<fieldId, string|number|boolean>,
           note?,
           createdAt, updatedAt }
```

Notes on the shape:

- `Event` is one table for both types. An `INSTANT` is just a `SPAN` that never
  ends. This keeps the timeline query trivial (one sort on `startAt`) and avoids
  duplicating the edit and delete surface twice.
- `profileId` and `type` are denormalised onto `Event`. `profileId` so the
  timeline never needs a join; `type` because `endAt IS NULL` is otherwise
  ambiguous — it means both "this is a Moment" and "this Span is still running".
  With `type` on the row, *running* is `type = 'INTERVAL' AND endAt IS NULL`:
  one indexed query, and the Dashboard picks bar-vs-tick straight from the event.
- Concurrent running spans are allowed *across* trackers (a nap and a feed can
  overlap), but starting a tracker that is already running prompts to stop it
  first. That prompt is the only modal in the logging path.
- **`archivedAt` is not a soft delete.** It means "stop showing this on the home
  grid" — a tracker you have finished with, a profile from last year. The data
  stays fully queryable and visible in the Dashboard and Timeline. Deleting is a
  separate, destructive action.
- **Deleting cascades, and says so.** Deleting a tracker destroys its events;
  deleting a profile destroys its trackers and their events. `ON DELETE CASCADE`
  in the schema, and the confirm dialog must state the exact count — *"Delete
  Feeding? This permanently deletes 428 events."* With no soft delete and no
  export, that dialog is the only thing standing between a mis-tap and real data
  loss, so it must never be a bare "Are you sure?".

## Screens

**Home** — the only screen that matters.
- Profile switcher in the header (tap to cycle, long-press for the list).
- Any running spans pinned at the top, each with live elapsed time and a big
  Stop button.
- A grid of tracker buttons below. Tap a Moment tracker → logged, with a brief
  undo affordance. Tap a Span tracker → starts, moves to the pinned area.
- Nothing else. No stats, no nav bar competing for the thumb.

**Timeline** — reverse-chronological list, grouped by day, current profile only.
Tap an event to edit time, fields, or note. Swipe to delete. This is where
"the feed actually started at 3:40" gets fixed.

**Trackers** — manage the current profile's trackers and their fields. Reorder
by drag; that order is the home grid order.

**Profiles** — create, rename, recolour, archive.

**Dashboard** — per profile, the read side of the app. Two levels:

*Month* — a calendar grid. Each day cell carries a compact density indicator
(a small stacked bar or dot row, coloured by tracker) so a month of feeding or
training reads at a glance. Tap a day to open it.

*Day* — the point of the whole section. A 24-hour ribbon with one lane per
tracker: Spans draw as bars, Moments as ticks. Overnight feeds, nap lengths, and
the gaps between them become visible in a way a list never shows. Swipe
left/right to move between days. Below the ribbon, a summary per tracker:

- count
- total duration and average duration (Spans only)
- longest gap between events — the genuinely useful number for feeding
- time since the last event

Rules: the ribbon always shows the full 24 hours, never auto-crops to
"interesting" hours, or nights stop being comparable across days. Colour comes
from the tracker, so the legend is the tracker list itself. Tap any bar or tick
to jump to that event in the Timeline.

No trend lines, no week-over-week comparisons, no charts beyond the ribbon until
real data proves which one is wanted.

**No export screen.** Litestream keeps a continuous replica, and the Dashboard's
day view is what you would actually show a doctor. If a CSV is ever genuinely
needed it is one `sqlite3 -csv` away on the Pi — that does not need a UI.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Client | Vite + React + TypeScript | Fast, boring, well-trodden |
| Styling | Tailwind | Mobile layout without a CSS architecture debate |
| PWA | `vite-plugin-pwa` | Installable to the home screen |
| Server | Hono on Node 20+ | Tiny, typed, fast to start; serves API *and* the built client |
| DB | SQLite via `better-sqlite3` | One file, synchronous, more than fast enough for one human |
| Migrations | Drizzle ORM + drizzle-kit | Typed schema, real migration files, no hand-written SQL drift |
| Backup | Litestream → Cloudflare R2 | Continuous replication, restore-on-empty |
| Packaging | Docker, multi-stage, single image | Same pattern as `savethisread` |
| Host | Raspberry Pi on the home network | Self-owned, always on, silent |

One process, one port, one SQLite file. The server serves the API under `/api`
and the built SPA for everything else, so there is no CORS story and no second
deployment.

### Why SQLite is enough

Single user, a few thousand rows a year, no concurrent writers of consequence.
`better-sqlite3` in WAL mode handles this without breaking a sweat. Do not
reach for Postgres.

## Deployment

Follow the `savethisread` pattern — it is already proven on this Pi, so there is
nothing to invent here.

**One multi-stage image.** Stage 1 builds the client with Vite, stage 2 installs
production server deps, the final stage copies both plus the Litestream binary.
The server serves `/api` and the built SPA from the same process and port.

- Base images from `mirror.gcr.io` to avoid Docker Hub rate limits.
- `ARG TARGETARCH` and `docker buildx --platform linux/arm64`, since the Pi is
  ARM64 and the build machine is not.
- `better-sqlite3` is a native module: build it inside the ARM64 stage, never
  copy a `node_modules` built on the Mac into the image.

**Compose**, mirroring `docker-compose.prod.yml`: published image, named volume
at `/app/data`, `restart: unless-stopped`, a `/api/health` healthcheck, and
`json-file` logging capped at `max-size: 10m` / `max-file: 3` so logs cannot
fill the SD card.

**Litestream replaces the backup cron.** Same shape as `docker/entrypoint.sh`
there — if the database file is missing on boot, `litestream restore` pulls it
from R2 first; then `litestream replicate -exec` runs the server as a child so
replication and process lifetime are the same thing. Continuous replication to
Cloudflare R2 beats a nightly `.backup`: a dead SD card costs seconds of data,
not up to a day. Snapshot hourly, and set retention well above the 24h used for
savethisread — this log is small and the history is the point.

**Secrets** via `op run --env-file=.env.prod` as in the existing `justfile`.
There is only really one secret set here (the R2 keys), but consistency beats a
second mechanism.

**A `justfile` with the same verbs** — `docker-up`, `prod-up`, `prod-pull`,
`prod-logs` — so muscle memory carries across projects.

**Reach.** The Pi is only on the home network, which means the app is unusable
away from home unless something is done about it. Two layers:

1. **Tailscale on the Pi host** (not in the container — same as savethisread).
   Reachable from any device on the tailnet, from anywhere, without
   port-forwarding, a public hostname, or exposing anything to the open
   internet. This is config, not code, and it is the single highest value hour
   in the whole project.
2. **Outbox queue in the client.** Every log writes to IndexedDB first and is
   POSTed to the Pi in the background, retrying until it lands. Logging then
   never fails — no signal, Pi rebooting, router down, it does not matter. This
   is real work, so it lands in Phase 6 rather than up front.

**Backups are not optional here**, and with no soft delete and no export they
are the *only* recovery path. Raspberry Pi SD cards fail completely, not
gracefully. Litestream ships in Phase 1, not "later" — and the restore path must
be tested once, deliberately, by deleting the volume and watching it come back.
An untested restore is not a backup.

## Authentication — none, deliberately

**The tailnet is the security boundary.** No login screen, no session, no user
table. Opening the app means you are already logging.

This was considered and rejected: a login is a step between the thumb and the
tap, and being bounced to an auth screen at 3am while holding a baby is a
product failure. Anyone on the tailnet is someone you handed a device to.

The consequence, stated plainly so it stays a conscious choice: **every device
that uses the app must be on the tailnet**, including a partner's phone. If that
ever becomes too much friction and the app gets exposed beyond Tailscale, auth
must be added *in the same change* — never a step on its own. This is a health
log.

## Build order

Each phase should end with something usable.

**Phase 1 — Log something.**
Drizzle schema + migrations, Hono API, one hardcoded profile, tracker CRUD
(name + type only, no fields), home grid, tap-to-log Moments, start/stop Spans
with live elapsed. Dockerfile, compose, Litestream to R2, and the `justfile`,
all running on the Pi from day one — deployment is not a later phase.
*Done when a feed can be timed end to end from a phone, and the database
survives deleting the volume.*

**Phase 2 — Trust it.**
Timeline grouped by day, "edited" markers, edit start/end, delete with a
counted confirm dialog.
*Done when a mistimed entry can be corrected.*

**Phase 3 — Make it real.**
Multiple profiles, profile switcher, per-profile trackers.
*Done when two contexts coexist without interfering.*

**Phase 4 — Fields.**
Field definitions on trackers, capture sheet at log time, values in the timeline.
*Done when feed side and run distance are recorded.*

**Phase 5 — Make it a phone app.**
PWA manifest, service worker, install prompt, dark theme, thumb-reachable
layout, haptics on log. Tailscale on the Pi so it works away from home.
Home-screen shortcuts that deep-link straight into a specific tracker.
*Done when it is on the home screen and works from outside the house.*

**Phase 6 — Offline outbox.**
Writes land in IndexedDB first and sync to the Pi in the background with retry.
*Done when logging works in airplane mode and shows up on the Pi later.*

**Phase 7 — Dashboard.**
Day ribbon first (it carries most of the value), then the month calendar above
it, then the per-tracker summary numbers.
*Done when a night's feeds can be read at a glance.*

## Decided

- **No starter templates.** Setting up four trackers takes two minutes, once,
  and shipping a prebuilt "Pregnancy" set edges toward looking like medical
  guidance.
- **Reminders are a later project.** "It's been 3h since the last feed" is
  probably the most valuable feature the app could have, and it is also the only
  one needing notification permissions and a server-side scheduler. It gets its
  own plan, after Phase 7.
- **No soft deletes.** Delete means delete. `archivedAt` covers "hide it from
  the home grid" and is a different thing.
- **No edit-history table.** `updatedAt != createdAt` renders an "edited" marker
  in the Timeline; that is the whole audit story.
- **No export UI.** Litestream is the durability story; `sqlite3 -csv` on the Pi
  covers the rare one-off.

- **Time is UTC in the database, local in the UI.** Every timestamp is stored as
  UTC epoch milliseconds. All formatting, day grouping, and the Dashboard's day
  boundaries resolve in the device's current zone at render time. No zone is
  stored on the event, and no date arithmetic happens server-side.
- **The database lives on the attached USB SSD**, not the SD card. The compose
  volume binds to a path on the SSD.

## Open questions

None outstanding.
