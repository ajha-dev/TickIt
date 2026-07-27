# TickIt.

# Development — server on 3002, Vite on 5173 proxying /api
dev:
    npm run dev

# Build client + server
build:
    npm run build

# Typecheck both workspaces
typecheck:
    npm run typecheck

# Docker — Dev (builds locally, no Litestream)
docker:
    docker-compose build

docker-up:
    docker-compose up -d

docker-down:
    docker-compose down

docker-logs:
    docker-compose logs -f tickit

# Build and push the ARM64 image for the Pi
docker-publish:
    docker buildx build --platform linux/arm64 -f docker/Dockerfile -t ghcr.io/ajha-dev/tickit:latest --push .

# Docker — Prod (published image, R2, 1Password secrets)
prod-up:
    op run --env-file=.env.prod -- docker-compose -f docker-compose.prod.yml up -d

prod-down:
    docker-compose -f docker-compose.prod.yml down

prod-pull:
    docker-compose -f docker-compose.prod.yml pull

prod-logs:
    docker-compose -f docker-compose.prod.yml logs -f tickit

# Clean
clean:
    rm -rf node_modules server/node_modules server/dist client/node_modules client/dist
