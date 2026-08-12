# Getting Started

iptv-recorder is two Docker containers — a Fastify API (`server`) and an nginx-served
React SPA (`web`) that reverse-proxies `/api/` to it. There's no published image yet;
`docker compose` builds both from source.

## 1. Prerequisites

- Docker with the Compose plugin (`docker compose version` — v2+).
- Nothing else. SQLite, the web UI, and the scheduler all run inside the containers.

## 2. Configure

```
cp .env.example .env
```

Edit `.env` and fill in:

- **`ENCRYPTION_KEY`** — required, `docker compose up` refuses to start without it.
  Generate one with:
  ```
  openssl rand -base64 32
  ```
  This encrypts IPTV provider credentials (username/password) at rest — it's not a
  login password and nothing ever displays it back to you, so don't lose it (losing
  it makes existing stored provider credentials unrecoverable, though the recorder
  itself will still run — you'd just need to re-enter providers).
- **`WEB_PORT`** — host port the web UI listens on (default `8090`).
- **`API_PORT`** — host port the API listens on directly, not just via `web`'s
  `/api/` proxy (default `3300`). Client apps (Lao, iptv-scheduler, iptv-web-player)
  connect here, not through `WEB_PORT`.
- **`UI_URL`** — leave blank unless you're putting this behind a reverse proxy or a
  real domain; it's only used to tell *other* apps (Lao, iptv-scheduler,
  iptv-web-player) where to send someone back to manage settings.

## 3. Start it

```
docker compose up -d --build
```

First run takes a few minutes (compiling `better-sqlite3` from source — no prebuilt
binary matches every base image, so the build stage falls back to compiling it, which
is expected and not an error). Subsequent starts are seconds.

Visit `http://<this-host>:<WEB_PORT>` — you'll land on **Settings**. On a genuinely
fresh install (no client has ever been created) it shows **Set up this recorder**:
type a name, click **Get started**, and you're in — no CLI needed. This works exactly
once, for whoever gets there first, same as the first-run setup screen on virtually
every other self-hosted app; the moment that first client exists, this screen is gone
for good and every device/app after it gets issued a key from the **Clients** page
instead (complete with a QR code for pairing apps like Lao or iptv-web-player).

If you ever do need a client from the command line instead (scripted/headless
deploys, or you're stuck with no key and the setup screen has already been used by
something else):

```
docker compose exec server node dist/db/seed-client.js admin
```

This prints a key once — copy it and paste it into the Settings page's "paste an
admin-issued key" form.

## 4. Add a provider

**Providers** → add your IPTV account (Xtream API or a plain M3U/XMLTV URL). Then
**Recordings** or **Recurring Rules** to schedule.

## Operating notes

- **Data lives in `./data`** next to `docker-compose.yml` — the SQLite database and
  recorded files. Back this directory up; nothing outside it is stateful.
- **Restart / stop**: `docker compose restart` / `docker compose down` — run from the
  directory with your `.env` in it (compose loads it automatically).
- **Upgrade**: `git pull && docker compose up -d --build`. Database migrations run
  automatically on every boot — no separate migrate step.
- **Timezone**: the scheduler runs in UTC internally regardless of the host's
  timezone (`recurring_rules.startMinuteOfDay` is UTC, enforced at boot). The web UI
  displays times in your browser's local timezone; only raw API calls need to think
  in UTC.
- **QR client pairing URL wrong or missing a port?** Settings → Config → "Public API
  URL" lets you set it explicitly instead of relying on auto-detection — click **Test**
  to confirm the value you enter is actually reachable before saving. This is the
  simplest fix, and the one you'll need if you front `web` with any reverse proxy: a
  proxy that only forwards a path-prefixed API (`/api/...`) rather than the API's own
  origin makes auto-detection produce a URL that doesn't work at all, which is exactly
  what happened pairing through `iptv-recorder.pelorus.org` in this repo's own PLAN.md.
- **Exposing beyond localhost**: if you put a reverse proxy in front of `web` (Caddy,
  Traefik, nginx, ...), it should forward `X-Forwarded-Proto`/`X-Forwarded-Host` for
  auto-detection to have a chance of being right at all (see above for when to just
  override it instead). `web/nginx.conf` only trusts those headers from one hardcoded
  IP (this deployment's own reverse proxy); if you're running this outside that exact
  setup, update the `geo` block at the top of that file to your proxy's source IP
  before rebuilding.

## More detail

`PLAN.md` in this repo is the full design log — API shapes, decisions, and why things
are built the way they are, including a "Deployment" section on how this Docker setup
itself came together.
