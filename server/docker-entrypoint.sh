#!/bin/sh
set -e

# Runs as root initially specifically for this line: docker-compose.yml's
# `./data` bind mount is created root-owned by Docker itself if the host
# directory doesn't already exist, which the unprivileged `node` user (see
# below) can't write a database file into. Fixing it here means
# `docker compose up` works regardless of what created the host directory
# or with what ownership — no manual `chown` step required. Non-recursive:
# RECORDINGS_DIR/DB_PATH subdirectories the app creates afterward are
# already made as `node`, so they're already correctly owned; a recursive
# chown here would get slower every restart as recordings accumulate.
data_dir="$(dirname "${DB_PATH:-./data/dev.sqlite}")"
mkdir -p "$data_dir"
chown node:node "$data_dir"

gosu node node dist/db/migrate.js
exec gosu node node dist/index.js
