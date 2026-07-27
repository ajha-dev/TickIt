# TickIt

A personal event logger, self-hosted on a Raspberry Pi.

You define what is worth tracking per context — *Pregnancy*, *Feeding*,
*Training* — and log occurrences in one tap. Two kinds of thing get logged:
a **Moment** (one timestamp: a contraction, a dose) and a **Span** (start and
end: a feed, a nap, a run). A Span with no end is running, pinned to the top of
the home screen with a live counter.

One SQLite file, one process, one port. No account, no cloud, no third party
holding a health log. See `PLAN.md` for the design and `CONTRACT.md` for the API.

**Stack:** Vite + React + Tailwind client · Hono on Node 20 · SQLite via
`better-sqlite3` · Drizzle migrations · Litestream to Cloudflare R2 · Docker.

## What's in it

Three tabs, and a fourth mode hiding inside the first.

**Log** — the only screen that matters. Running spans pinned at the top with a
live counter; a grid of tracker tiles below, bottom-anchored so they sit in the
thumb's arc. One tap logs. If a tracker defines a field, a sheet opens *after*
the event is already saved — a pick commits and closes it, and dismissing it is
a normal outcome. The profile switcher is in the header.

**Edit mode** (the pencil) turns the same grid into management: tap a tile for
its drawer (rename, recolour, field, reminder, archive, delete), drag the grip
to reorder, and archived trackers appear dimmed at the end. The plus creates
one. There is no separate Trackers screen — the grid you arrange is the grid you
log from.

**Timeline** — one local day at a time, newest first, with a calendar that dims
days holding nothing. Edit a time, a value, or a note; delete with a confirm
that names what goes. An event edited after the fact is marked; one merely
stopped is not.

**Dashboard** — one tracker, charted over time. Days across, 24 hours down,
every event a mark placed by when in the day it happened. "Feeds cluster at
02:00" becomes a band you can see. Colour comes from the tracker's choice field
where it has one.

**Reminders**, per tracker, of two kinds: *idle* ("nothing logged for 3h", with
optional quiet hours that hold rather than cancel) and *scheduled* (days of the
week × up to eight times a day — the medicine case). Delivered by Web Push.

**It works offline.** Every write goes to an IndexedDB outbox first and syncs
when it can, stamped with the time of the tap rather than the time of the sync.
Logging cannot fail. Installable to the home screen; the shell is cached, so it
opens with the Pi unreachable. Reads still fail honestly — stale health data
shown as current is worse than an error.

Field definitions, deletes and edits all have rules worth knowing before
changing them; `CONTRACT.md` states each with its reason.

## Local development

```sh
npm install
just dev          # server on :3002, Vite on :5173 proxying /api
```

`just typecheck` and `just build` cover both workspaces.

To run the real image locally (server serves the built SPA, no Litestream):

```sh
just docker && just docker-up
just docker-logs
# http://localhost:3002
just docker-down
```

The dev compose leaves `LITESTREAM_REPLICA_BUCKET` unset, so the container
skips restore and replication and writes to a throwaway named volume.

## Deploying to the Pi

The Pi is ARM64 and your laptop probably is not, so build for the target:

```sh
just docker-publish     # buildx --platform linux/arm64, pushes ajha2025/tickit:latest
```

`better-sqlite3` is a native module. Every build stage runs on the target
architecture and `node_modules` is in `.dockerignore`, so a binding compiled on
the Mac can never leak into the image.

On the Pi:

```sh
# 1. Data directory on the USB SSD — NOT the SD card.
sudo mkdir -p /mnt/ssd/tickit && sudo chown 1001:1001 /mnt/ssd/tickit   # uid of `tickit` in the image

# 2. .env.prod, from .env.example, with 1Password refs for the R2 keys.
just prod-pull
just prod-up
just prod-logs
```

Ports and names on the shared Pi (savethisread already lives there):

| | savethisread | TickIt |
|---|---|---|
| App port | 3001 | **3002** |
| Litestream metrics | 127.0.0.1:9090 | **127.0.0.1:9091** |
| Container | `savethisread` | `tickit` |
| Data | named volume | bind mount `${DATA_DIR:-/mnt/ssd/tickit}` |

**Reach:** run Tailscale on the Pi host, not in the container. The tailnet is
the security boundary — there is deliberately no login (see `PLAN.md`). Every
device that uses the app must be on the tailnet.

## Reminders and Web Push

Generate a VAPID keypair once and put it in `.env.prod`:

```sh
npm run vapid:generate --workspace=server
```

With the keys unset the server still boots normally, logs one line saying
reminders are disabled, and `GET /api/push/key` returns 503 — which the client
handles with its own copy rather than a broken permission prompt. Reminders can
still be created; they simply never fire.

**Web Push requires real HTTPS**, so this only works once the Pi is reachable
over TLS — `tailscale cert` on the `ts.net` hostname. It cannot be exercised
over plain HTTP on a LAN address. On iOS, Web Push is available *only* to a PWA
added to the Home Screen (16.4+), which is another reason the manifest and
icons matter.

A sweep runs every 60s. Firing rules — once per idle period, quiet hours that
hold rather than cancel, a 60-minute staleness window on scheduled occurrences —
are in `server/src/reminders/rules.ts` as pure functions with 28 assertions
behind them (`npm run test:reminders --workspace=server`). Change them there,
not in the sweep.

## Migrations

`server/drizzle/` is committed and applied at boot. **Review generated SQL
before trusting it.** SQLite cannot drop `NOT NULL`, so drizzle-kit emits a
create-copy-drop-rename; when new columns are involved its `INSERT … SELECT`
has selected columns that do not exist on the old table yet, which fails *after*
`DROP TABLE`. That happened here once (`0002`) and was caught only by rehearsing
the migration against a copy of a real database. Do that rehearsal every time:

```sh
cp server/data/tickit.db /tmp/rehearse.db
DATABASE_PATH=/tmp/rehearse.db PORT=3099 npx tsx server/src/index.ts
```

## Backups — Litestream

`docker/entrypoint.sh` is the whole story:

1. If `LITESTREAM_REPLICA_BUCKET` is unset, it just runs the server. No backups.
2. If it is set and `/app/data/tickit.db` does **not** exist, it runs
   `litestream restore` first. A missing replica is not fatal — it logs
   "No replica found, starting fresh" and continues, so a first boot works.
3. Then `litestream replicate -exec "node …"` runs the server as a child.
   Replication and process lifetime are the same thing: if replication dies,
   the container dies, and `restart: unless-stopped` brings both back.

Config is `docker/litestream.yml`: hourly snapshots, **720h (30 day) retention**
— deliberately far above savethisread's 24h. The database is tiny and the
history is the entire point; with no soft deletes and no export, point-in-time
recovery is the only way back from a cascading delete you notice a week later.

Metrics are on `:9090` in the container, published to `127.0.0.1:9091` on the
Pi.

## Restore drill

An untested restore is not a backup. Do this once, deliberately, on the Pi,
and again after any change to the Litestream config.

```sh
# 1. Log something you will recognise, then confirm it is replicated.
docker logs tickit 2>&1 | grep -i litestream        # expect sync/snapshot lines

# 2. Stop the app and DESTROY the local database.
just prod-down
sudo rm -rf /mnt/ssd/tickit/*        # db, -wal and -shm all go

# 3. Bring it back. The entrypoint sees no db file and restores from R2.
just prod-up
just prod-logs                       # expect "Database restored."

# 4. Verify in the app: the event you logged in step 1 is still there.
```

If step 3 prints "No replica found, starting fresh", the backup was **not**
working — check `LITESTREAM_REPLICA_BUCKET`, the endpoint URL (it must include
`https://`), the R2 keys, and that `LITESTREAM_REPLICA_PATH` matches what was
written.

To inspect the replica without touching the running database:

```sh
docker exec tickit litestream snapshots -config /etc/litestream.yml /app/data/tickit.db
docker exec tickit litestream restore -config /etc/litestream.yml -o /tmp/check.db /app/data/tickit.db
```

## Known gaps

Stated plainly rather than discovered later.

- **Nothing is deployed yet.** The image builds and runs locally; it has never
  run on the Pi, so the restore drill above has never been executed. With no
  soft deletes and no export, Litestream is the only recovery path — and an
  untested one.
- **No notification has ever been delivered.** Subscription, storage and the
  firing rules are tested; actual delivery needs the HTTPS hostname above.
- **Background Sync was only observed in Chrome.** iOS Safari lacks it; it is
  feature-detected and four other flush triggers cover that case, but the outbox
  has not been watched draining on an iPhone.
- **Tracker colours are assigned at creation.** The palette was later re-derived
  to pass colour-vision separation (see `THEME.md`), so trackers made before
  that keep their old, less distinguishable colours until recoloured by hand.
