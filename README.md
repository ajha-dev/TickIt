# TickIt

A personal event logger you host yourself.

You define what is worth tracking per context — *Pregnancy*, *Feeding*,
*Training* — and log occurrences in one tap. Two kinds of thing get logged:
a **Moment** (one timestamp: a contraction, a dose) and a **Span** (start and
end: a feed, a nap, a run). A Span with no end is running, pinned to the top of
the home screen with a live counter.

One SQLite file, one process, one port. No account, no cloud, no third party
holding a health log. See `PLAN.md` for the design and `CONTRACT.md` for the API.

**Stack:** Vite + React + Tailwind client · Hono on Node 20 · SQLite via
`better-sqlite3` · Drizzle migrations · Litestream for backups · Docker.

> **There is no authentication.** That is deliberate, not an oversight — the
> app is built to sit on a private network where the network *is* the security
> boundary, and a login screen between a thumb and a 3am feed is a cost with no
> matching benefit there. **Do not expose it to the public internet as-is.**
> `PLAN.md` records the reasoning; if you put it on the open web, add auth in
> the same change.

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
opens with the server unreachable. Reads still fail honestly — stale health data
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

## Deploying

It is one container. Anywhere that runs Docker will do — a spare box, a NAS, a
VPS, a Raspberry Pi. It needs a persistent volume for `/app/data` and a way to
reach it; nothing else.

```sh
docker run -d --name tickit \
  -p 3002:3002 \
  -v tickit-data:/app/data \
  --restart unless-stopped \
  ghcr.io/ajha-dev/tickit:latest
```

That is a complete, working install. Everything below is optional and each part
earns its place separately.

`docker-compose.prod.yml` is a fuller example with Litestream, healthcheck and
log rotation. Build your own image with `just docker` if you would rather not
pull a published one — the Dockerfile is multi-stage and needs no arguments.

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3002` | Server port |
| `DATABASE_PATH` | `/app/data/tickit.db` | SQLite file. Put it on a volume. |
| `VAPID_PUBLIC_KEY` | — | Web Push. Unset ⇒ reminders disabled, app fine. |
| `VAPID_PRIVATE_KEY` | — | " |
| `VAPID_SUBJECT` | — | A **real** `mailto:` or `https:` URL — see below |
| `LITESTREAM_REPLICA_BUCKET` | — | Unset ⇒ no backups, app fine |
| `LITESTREAM_REPLICA_ENDPOINT` | — | S3-compatible endpoint |
| `LITESTREAM_ACCESS_KEY_ID` | — | " |
| `LITESTREAM_SECRET_ACCESS_KEY` | — | " |

Every optional feature degrades rather than failing: with no VAPID keys the
server boots, logs one line saying reminders are disabled, and serves a 503 from
`GET /api/push/key` which the client handles with its own copy instead of a
broken permission prompt.

### Getting to it from a phone

The app is a PWA and wants to be installed to the home screen. That requires
**real HTTPS** — and so does Web Push, so reminders will not fire over plain
HTTP no matter how correct the server is. Any of these work: a reverse proxy
with a certificate (Caddy, nginx, Traefik), a tunnel (Cloudflare Tunnel,
`tailscale serve`), or a VPN with TLS. Pick whichever suits your network.

On iOS, Web Push is available **only** to a PWA added to the Home Screen
(16.4+), and only when launched from that icon rather than from Safari.

## CI/CD

`.github/workflows/ci.yml`. On every push and PR: typecheck both workspaces, run
the reminder-rule assertions, build both workspaces. On `main` and `v*` tags it
then builds `linux/amd64` and `linux/arm64` **each on its own native runner** and
joins them into one multi-arch manifest on GHCR.

Native runners, not QEMU, because `better-sqlite3` is a native module —
cross-building it under emulation is slow and is precisely the step that fails
quietly. The reminder rules gate the build for a specific reason: getting
"once per idle period" wrong means a notification every 60 seconds, forever.

**No registry secrets to configure.** GHCR, so the workflow authenticates with
the built-in `GITHUB_TOKEN` and a `packages: write` permission. If you fork
this, change `IMAGE_NAME` in the workflow to your own namespace.

`.github/workflows/security.yml` runs secret scanning over full history,
CodeQL, and dependency review.

**Deployment is not automatic.** CI publishes an image; something else pulls it
when you decide. Automating the last hop means either a self-hosted runner or
credentials to reach your host from CI, and neither belongs in a repo other
people fork.

## Reminders and Web Push

Generate a VAPID keypair once:

```sh
npm run vapid:generate --workspace=server
```

`VAPID_SUBJECT` must be a **real, routable** `mailto:` or `https:` URL. Apple's
push service validates the JWT's `sub` claim and rejects placeholders — a value
like `mailto:tickit@localhost` fails every push to an iPhone, and the failure
arrives as an opaque status with nothing explaining it. This bit us; the log now
names the likely cause on a 403.

Rotating the keypair invalidates every existing subscription. Devices keep
working, they just stop receiving notifications until they re-subscribe — the
client detects the key mismatch and replaces the subscription automatically the
next time a reminder is saved.

A sweep runs every 60s. The firing rules — once per idle period, quiet hours
that hold rather than cancel, a 60-minute staleness window on scheduled
occurrences — are pure functions in `server/src/reminders/rules.ts` with 28
assertions behind them (`npm run test:reminders --workspace=server`). Change
them there, not in the sweep.

## Migrations

`server/drizzle/` is committed and applied at boot. **Review generated SQL
before trusting it.** SQLite cannot drop `NOT NULL`, so drizzle-kit emits a
create-copy-drop-rename; when new columns are involved its `INSERT … SELECT` has
selected columns that do not exist on the old table yet, which fails *after*
`DROP TABLE`. That happened here once and was caught only by rehearsing the
migration against a copy of a real database. Do that rehearsal every time:

```sh
cp /path/to/tickit.db /tmp/rehearse.db
DATABASE_PATH=/tmp/rehearse.db PORT=3099 npx tsx server/src/index.ts
```

## Backups — Litestream

Optional, and the only recovery path if you use it: there are no soft deletes
and no export, so a cascading delete noticed a week later comes back from the
replica or not at all.

`docker/entrypoint.sh` is the whole story:

1. If `LITESTREAM_REPLICA_BUCKET` is unset, it just runs the server. No backups.
2. If it is set and the database does **not** exist, it runs `litestream
   restore` first. A missing replica is not fatal — it logs "No replica found,
   starting fresh" and continues, so a first boot works.
3. Then `litestream replicate -exec "node …"` runs the server as a child.
   Replication and process lifetime are the same thing: if replication dies, the
   container dies, and `restart: unless-stopped` brings both back.

Config is `docker/litestream.yml`: hourly snapshots, 30-day retention, and a
**hardcoded replica path**. That path is deliberately not configurable — it was
`${LITESTREAM_REPLICA_PATH:-db}`, and Litestream expands only plain `${VAR}`
with no `:-default` support, so the whole token resolved to an *empty* path and
the database replicated to the bucket root. If you share a bucket between
databases, restore takes the newest generation under the configured path and can
hand you the wrong database entirely. If you change it, change it to a literal.

### Restore drill

An untested restore is not a backup. Do this once, deliberately, and again after
any change to the Litestream config.

Non-destructively, which is enough to prove the replica is complete:

```sh
docker exec tickit litestream restore -config /etc/litestream.yml \
  -o /tmp/verify.db /app/data/tickit.db
# then compare row counts against the live database
```

Destructively, which additionally proves the entrypoint's restore path:

```sh
docker compose down
docker volume rm tickit_tickit-data      # or delete the bind-mounted directory
docker compose up -d
docker compose logs -f tickit            # expect "Database restored."
```

If that prints "No replica found, starting fresh", the backup was **not**
working — check the bucket, the endpoint URL (it must include `https://`), the
keys, and that the replica path matches what was written.

## Known gaps

Stated plainly rather than discovered later.

- **Background Sync was only observed in Chrome.** iOS Safari lacks it; it is
  feature-detected and four other flush triggers cover that case, but the outbox
  has not been watched draining on an iPhone.
- **Tracker colours are assigned at creation.** The palette was later re-derived
  to pass colour-vision separation (see `THEME.md`), so trackers made before that
  keep their old, less distinguishable colours until recoloured by hand.
- **No export UI.** Deliberate — `sqlite3 -csv` covers the rare one-off and the
  replica covers durability — but it does mean the app has no "give me my data"
  button.

---

## Appendix: how I run it

Not a recommendation, just the concrete setup this was built against. Substitute
freely — none of it is required.

A Raspberry Pi 5 booting from NVMe, running this alongside a handful of other
containers. Each app lives in `~/<name>/` with its own `docker-compose.yml` and
an `.env.tpl` of 1Password references, started with:

```sh
op run --env-file=.env.tpl -- docker compose up -d
```

`.env.tpl` is committed (see the file in this repo) because it holds only
`op://` references and no values — it is the deploy contract, not a secret.

**Reach** is [Tailscale](https://tailscale.com), running on the host rather than
in the container, with `tailscale serve` terminating TLS using the tailnet's own
Let's Encrypt certificate:

```sh
sudo tailscale serve --service=svc:tickit --https=443 http://127.0.0.1:3002
```

That gives the app its own hostname on the tailnet — its own origin at the root
path, which matters because a PWA's service worker scope, manifest `start_url`
and asset paths all assume `/`. Serving it under a sub-path would mean
rebuilding the client with a `base`. Hosting a Tailscale *Service* requires the
node to be tagged, which transfers the machine's ownership from the user to the
tailnet; on a box running other things, that is worth understanding before you
do it.

**Backups** go to Cloudflare R2, sharing a bucket with another app and separated
only by the replica path — see the warning above about what happens when that
path resolves empty.

**Storage**: the database sits on a named Docker volume. An earlier version of
this repo insisted it live on `/mnt/ssd` to keep SQLite's writes off an SD card;
that reasoning does not apply to a machine that boots from NVMe, and it is worth
checking which one you actually have before copying anyone's advice.
