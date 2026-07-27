# TickIt — single multi-stage image (API + built SPA + Litestream)
#
# Target is a Raspberry Pi (ARM64). Build with:
#   docker buildx build --platform linux/arm64 -f docker/Dockerfile -t ajha2025/tickit:latest .
#
# better-sqlite3 is a NATIVE module: every stage below runs on the *target*
# architecture, so the binding shipped in the final image is always compiled
# (or prebuilt-fetched) for that arch. A node_modules built on the Mac is never
# copied in — see .dockerignore.

# Stage 0: shared toolchain — node + everything node-gyp needs for better-sqlite3
FROM mirror.gcr.io/node:20-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Workspace manifests only, so dependency layers cache independently of source
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/

# Stage 1: build the client (npm workspaces) -> client/dist
FROM base AS client-builder
RUN npm ci
COPY client/ ./client/
RUN npm run build --workspace=client

# Stage 2: build the server TypeScript -> server/dist
FROM base AS server-builder
RUN npm ci
COPY server/ ./server/
RUN npm run build --workspace=server
# Migrations are committed under server/drizzle; make sure the path always
# exists so the final stage's COPY cannot fail on a fresh checkout.
RUN mkdir -p /app/server/drizzle

# Stage 3: production dependencies only — better-sqlite3 compiled here, on the
# target arch, with the toolchain from `base` available.
FROM base AS prod-deps
RUN npm ci --omit=dev
# npm hoists most workspace deps to /app/node_modules, but anything it cannot
# hoist stays nested under the workspace. Guarantee the path exists so the
# final stage's COPY is unconditional.
RUN mkdir -p /app/server/node_modules

# Stage 4: runtime
FROM mirror.gcr.io/node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# uid pinned so the prod bind mount on the Pi's SSD can be chowned to a known
# owner (1000 is already taken by the `node` user in the base image).
RUN useradd -m -s /bin/bash -u 1001 tickit
WORKDIR /app

# Production node_modules (same arch as this image — native binding is valid)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server/package.json ./server/

# Server build + committed migrations
COPY --from=server-builder /app/server/dist ./server/dist
COPY --from=server-builder /app/server/drizzle ./server/drizzle

# Client build (served for every non-/api route)
COPY --from=client-builder /app/client/dist ./client/dist

# Litestream for streaming SQLite replication (download binary directly to avoid Docker Hub rate limits)
ARG TARGETARCH
RUN curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin/
COPY docker/litestream.yml /etc/litestream.yml
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create data directory for SQLite (bind-mounted to the USB SSD in prod)
RUN mkdir -p /app/data && chown -R tickit:tickit /app

USER tickit

EXPOSE 3002

ENV HOST=0.0.0.0
ENV PORT=3002
ENV DATABASE_PATH=/app/data/tickit.db
ENV CLIENT_DIST=/app/client/dist
ENV NODE_ENV=production

ENTRYPOINT ["/entrypoint.sh"]
