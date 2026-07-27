# 1Password references, resolved at run time. Same shape as savethisread's:
#
#   op run --env-file=.env.tpl -- docker compose up -d
#
# Nothing secret lives in this file — it is safe to commit. The values sit in
# the `tickit-prod-env` item in the `prod` vault.

# --- Reminders / Web Push -------------------------------------------------
# Generate with: npm run vapid:generate --workspace=server
# Rotating these invalidates every existing push subscription: devices go on
# working, they just stop receiving notifications until they re-subscribe.
VAPID_PUBLIC_KEY=op://prod/tickit-prod-env/VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=op://prod/tickit-prod-env/VAPID_PRIVATE_KEY
VAPID_SUBJECT=op://prod/tickit-prod-env/VAPID_SUBJECT

# --- Litestream → Cloudflare R2 -------------------------------------------
# The ONLY recovery path: there are no soft deletes and no export, so a
# cascading delete noticed a week later is recoverable from here or not at all.
#
# The bucket and keys can be the same ones savethisread uses — REPLICA_PATH is
# what keeps the two databases apart, so it must differ from savethisread's.
LITESTREAM_REPLICA_BUCKET=op://prod/tickit-prod-env/LITESTREAM_REPLICA_BUCKET
LITESTREAM_REPLICA_ENDPOINT=op://prod/tickit-prod-env/LITESTREAM_REPLICA_ENDPOINT
LITESTREAM_REPLICA_PATH=op://prod/tickit-prod-env/LITESTREAM_REPLICA_PATH
LITESTREAM_ACCESS_KEY_ID=op://prod/tickit-prod-env/LITESTREAM_ACCESS_KEY_ID
LITESTREAM_SECRET_ACCESS_KEY=op://prod/tickit-prod-env/LITESTREAM_SECRET_ACCESS_KEY
