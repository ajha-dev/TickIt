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
