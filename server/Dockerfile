# Build context is the repo root (see docker-compose.yml's `context: .`) —
# the server package alone isn't buildable in isolation because pnpm needs
# every workspace member's package.json to resolve the shared lockfile.

FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
WORKDIR /app

# Full workspace install (incl. devDependencies) — used to compile the
# server's TypeScript. python3/make/g++ back better-sqlite3's native build
# in case no prebuilt binary matches this image; harmless if one did.
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY server server
RUN pnpm --filter server build

# Production-only node_modules, built separately from `deps` so devDependencies
# (typescript, tsx, drizzle-kit, ...) never reach the runtime image.
FROM base AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --prod --filter server...

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server
# gosu: lets docker-entrypoint.sh start as root just long enough to fix the
# bind-mounted data dir's ownership, then drop to the unprivileged `node`
# user for everything else — see docker-entrypoint.sh for why.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist ./dist
COPY server/drizzle ./drizzle
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3300
# Migrations are idempotent (drizzle tracks what's already applied), so
# running them on every boot — rather than requiring a separate `db:migrate`
# step — is what lets a first-time deploy be just `docker compose up`.
ENTRYPOINT ["docker-entrypoint.sh"]
