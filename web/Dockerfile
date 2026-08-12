# Build context is the repo root (see docker-compose.yml's `context: .`) —
# the web package alone isn't buildable in isolation because pnpm needs
# every workspace member's package.json to resolve the shared lockfile.

FROM node:24-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# --filter web... limits the install to web's own dependency subtree —
# without it, a plain `pnpm install` installs the *entire* workspace
# (including server's better-sqlite3, a native module this stage has no
# build toolchain for) since both workspace manifests are present.
RUN pnpm install --frozen-lockfile --filter web...
COPY tsconfig.base.json ./
COPY web web
RUN pnpm --filter web build

# nginx-unprivileged (not plain nginx): runs as a non-root user out of the
# box, listening on 8080 instead of 80 — lets this run under cap_drop: ALL
# in docker-compose.yml with no cap_add for NET_BIND_SERVICE.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
