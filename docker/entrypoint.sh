#!/bin/sh
set -e

if [ -n "$LITESTREAM_REPLICA_BUCKET" ]; then
    if [ ! -f /app/data/tickit.db ]; then
        echo "Attempting to restore database from Litestream replica..."
        litestream restore -config /etc/litestream.yml /app/data/tickit.db \
            && echo "Database restored." \
            || echo "No replica found, starting fresh."
    fi
    exec litestream replicate -config /etc/litestream.yml -exec "node /app/server/dist/index.js"
else
    exec node /app/server/dist/index.js
fi
