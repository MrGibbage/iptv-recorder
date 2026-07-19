# iptv-recorder — Plan

## Overview

A standalone recording/scheduling backend for IPTV DVR functionality, consumed by [Laomedeia](https://github.com/MrGibbage/laomedeia) (and potentially other client apps later). The service owns scheduling and disk storage of recordings; it does **not** transcode. Playback clients pull the recorded file and handle decode/transcode themselves, the same way they already do for live streams.

Runs on docker-server or smavm — host TBD (see Open Questions).

A separate companion **scheduler app** (web service, own project) is expected to sit in front of this as one possible client — see Relationship to Companion Scheduler App below for the division of responsibility. The recorder API itself must stay generic enough for any client (web, desktop, mobile) to drive directly, not just the companion app.

## Goals

- Accept recording requests (one-off and recurring) from client apps over an HTTP API.
- Own recurring-schedule primitives (e.g. "same time, same channel, every week") — pure calendar mechanics, no content awareness required, so this keeps working even if a smarter client/scheduler app is offline. Recurring rules run indefinitely by default (cron-like, no mandatory end date) — an end date/occurrence cap is optional, not required.
- Hard-reject schedule/record requests at request time (never queue, never best-effort attempt) when: a provider's configured max concurrent streams would be exceeded; available disk space is already below a configured minimum-free-space threshold; or the target provider is disabled/paused.
- Record IPTV streams to disk. Likely a remux (TS → fragmented MP4) rather than a raw copy or a real transcode — cheap CPU-wise, but gives a saner, seekable file than raw MPEG-TS.
- Serve recorded files back to clients for playback. No server-side transcoding, ever.
- Expose a config surface (see below) for provider accounts, storage locations, and retention policy.

## Non-goals

- No server-side transcoding, live or on playback.
- No EPG/guide data ownership — that's the client's job (Lao already builds a guide from the Xtream provider).
- No built-in playback client — service only ever hands back a file/stream, never renders anything.
- No content intelligence: duplicate detection, keyword/genre filtering, and automatic discovery of new things to record are the companion scheduler app's job, not the recorder's. The recorder has no concept of "show" or "episode" — only channel + time range (recurring or one-off).

## Relationship to Companion Scheduler App

A planned separate project: a web service that handles advanced filtering and automatic discovery of new things to record (e.g. keyword/genre rules against EPG data, dedup against what's already recorded or scheduled). It would be a client of this API, same as Lao — not a component of iptv-recorder itself.

Division of responsibility:
- **iptv-recorder (this project):** mechanical scheduling primitives (one-off + recurring), provider credential/account management, concurrent-stream enforcement, storage, retention. No content awareness.
- **Scheduler app (separate project):** EPG ingestion, filter rules, discovery, duplicate detection against content identity (show/episode) — decides *what* to record, then calls this API's schedule endpoint to make it happen.

Implication for a recurring-vs-duplicate conflict: since the recorder has no concept of "this episode already aired and was recorded," the scheduler app is responsible for actively cancelling/skipping a specific recurring occurrence through the API if it determines that occurrence would be a duplicate. The recorder will never infer that on its own.

## Prior Art

Checked for existing open source that already does this — nothing matches the shape exactly:

| Project | What it does | Why it doesn't fit |
|---|---|---|
| TVHeadend | EPG + scheduler + recorder, IPTV/M3U input | Monolithic; credentials stored server-side; owns its own client protocol (HTSP) and streaming pipeline |
| NextPVR | Same shape as TVHeadend | Same issue — server-stored credentials, own client apps |
| Jellyfin Live TV & DVR | M3U tuner + XMLTV EPG, records to file, can direct-play without transcode | Closest in spirit, but it's a bolted-on plugin of a general media server, not a standalone recording API |
| xTeVe / Threadfin | M3U/EPG proxy/multiplexer | No scheduler, no recording at all |
| ErsatzTV | Simulates a linear channel from a local VOD library | Solves the opposite problem |

The credential-passthrough model below (server never stores provider credentials) isn't something any of these do — worth building as its own thing rather than bending an existing PVR backend into it.

## Architecture (draft)

```
Laomedeia (client)
   │  request carries a provider_id, not credentials
   ▼
iptv-recorder API ──stores rules/occurrences──▶  DB (providers, rules, recordings)
   │                                                       ▲
   │                                                       │ polls every ~30-60s
   │                                                 scheduler loop
   │                                        (materializes due occurrences,
   │                                         fires imminent ones)
   │                                                       │
   │                                                       ▼
   │                                              recording worker ──writes──▶ disk (remuxed files)
   │                                                       │
   │                                          looks up stored credentials
   │                                          for provider_id, connects to
   │                                          that Xtream provider
   └──serves recorded file──▶  Laomedeia (client transcodes/plays)
```

- **API service** — accepts schedule/record/list/delete requests, writes rules and materialized occurrences to the database, exposes config endpoints (including provider management).
- **Scheduler engine** — an in-process background loop (not OS cron), ticking every ~30–60s against the same database as everything else. Each tick: materializes a recurring rule's next occurrence once it's within the materialization horizon (applying any skip-exception first), and hands off any materialized occurrence whose start time has arrived to the recording worker. Not OS cron — cron entries are static and would need to be rewritten on every rule create/update/delete via the API, and it has no way to represent materialization horizon, skip-exceptions, or concurrent-stream checks. Keeping this in-process means "what's scheduled" is always just a query against the same DB, no second source of truth to keep in sync. See API Design → Recurring occurrence materialization for the full model.
- **Recording worker** — pulls from the IPTV provider at scheduled times using stored credentials, remuxes to disk, writes metadata (start/end, channel, provider used).
- **Storage** — plain files on disk; retention policy prunes old recordings per config.
- **Config/admin surface** — a backend settings page covering: one or more IPTV provider configs (name, Xtream URL, credentials), storage location(s), retention policy, other operational options.

## Secrets Handling

This repo is **public**. That constrains how provider credentials, API keys, and any other secret are handled, on top of the at-rest storage question below:

- No real credentials, API keys, tokens, or `.env` files with live values are ever committed. Config with real values lives outside the repo (or in a git-ignored file); only a `.env.example`/template with placeholder values is tracked.
- `.gitignore` must cover the real config/secrets file(s) from day one of actual implementation, not added after the fact.
- Real credentials, API keys, or tokens for this project should not be pasted into Claude chat sessions either — describe config by shape/placeholder when asking for help, not by real value. Chat history isn't the right place for secrets any more than the repo is.
- This is separate from the encryption-at-rest question in Credentials Model below — that's about how the *running service* stores what it's holding; this is about what never enters version control or conversation history in the first place.

## Tech Stack

Decided:
- **Backend:** Node.js + TypeScript, Fastify for the HTTP layer (schema validation/serialization fits the drafted endpoint shapes; lighter than Express for a small service).
- **Database:** SQLite via Drizzle ORM + better-sqlite3 — typed, SQL-like, has a real migration story without Prisma's generated-client/engine overhead.
- **Settings UI:** React + Vite SPA, served as static files (built and hosted alongside/by the API service). Dev-mode Vite proxies `/api` to the Fastify server.
- **Package manager:** pnpm (workspace with `server/` + `web/` packages).
- **Host:** docker-server.

**Repo layout:** pnpm workspace root (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) with `server/` (Fastify + Drizzle, entry `server/src/index.ts`) and `web/` (Vite React app) as workspace packages. Each package's own `.env`/`.env.example` lives inside `server/` — `dotenv/config`'s default lookup is relative to `process.cwd()`, which is the package directory (not the repo root) when run via `pnpm --filter server dev`; a root-level `.env` is silently never loaded. Scaffolded and verified booting end-to-end (health check + DB round-trip + Vite API proxy) 2026-07-19.

## Credentials Model

Decided: the service **does** store IPTV provider credentials server-side, configured through a settings page. One or more providers can be added; each gets a `provider_id`. This solves the scheduled-recording problem from the earlier draft — the service can trigger a recording on schedule without Lao needing to be open or reachable at that moment.

Provider setup also requires a **max concurrent streams** value (matches the limit most Xtream provider accounts enforce). The recorder tracks active streams per provider and rejects any new schedule/record request that would exceed it — a hard rejection, not a queue.

Provider setup also includes an **enabled** flag (default on). A provider can be paused without deleting it — deleting orphans its existing schedules (see Provider delete cascade in Open Questions), pausing does not. Any new schedule/record request against a disabled provider is rejected the same way, at request time.

Open question this raises: **how does a request indicate which configured provider to use?** Leaning toward having Lao pass a `provider_id` explicitly with every request — Lao is already the one presenting the channel/guide UI, so it already knows which provider a given channel came from. The alternative (server matches/fails-over across providers automatically) would only matter if the same channel exists on multiple configured providers, which isn't a case that exists yet — not worth designing for until it does.

## API Design

**Resource model: flat.** Recurring recordings are not a separate resource tree. `POST /recordings` accepts an optional recurrence pattern; every occurrence — recurring or one-off — is addressable as a normal row in the `recordings` collection, filterable by `recurring_rule_id`. Every other endpoint (list, cancel, fetch-file) behaves identically regardless of whether a recording originated from a rule or a single request.

**Recurring occurrence materialization: cron-like, not pre-expanded.** A recurring rule is a stored pattern (channel, day/time, duration, provider), evaluated the way a cron job is — the recorder computes the next fire time rather than expanding every future occurrence into rows up front. This is what makes an end date unnecessary by default: an indefinite rule costs nothing to keep around, the same way a cron entry does. `end_date`/`max_occurrences` are supported as optional fields for rules that do want a stop condition, not required.

Concretely:
- A `recordings` row is only materialized (created with real status `scheduled`) once an occurrence is imminent or has started — not the moment the rule is created.
- Occurrences further out than that horizon are a computed projection off the rule's pattern, not stored data. `GET /recordings?recurring_rule_id={id}` can include these projected future occurrences on request, clearly distinguished from materialized ones.
- Skipping/cancelling a single occurrence works whether or not it's been materialized yet: `POST /recordings/recurring/{rule_id}/skip` (body: the occurrence date) cancels the row if one exists, or adds a skip exception to the rule if it doesn't — mirrors the iCalendar RRULE+EXDATE pattern. `DELETE /recordings/{id}` still works directly once a row is materialized.
- `DELETE /recordings/recurring/{rule_id}` cancels the whole rule going forward (no more occurrences generated, materialized or projected).

**Auth: per-client API keys.** Every client (Lao, iptv-scheduler, any future client) gets its own key rather than a single shared secret. Requests are attributable to a specific client in logs/history — matters once more than one client is calling the API concurrently.

**Endpoints (draft):**

*Providers*
- `POST /providers` — add (name, Xtream base URL, credentials, `max_concurrent_streams`, `enabled` (default true))
- `GET /providers` / `GET /providers/{id}` — list/detail, credentials redacted in the response
- `PUT /providers/{id}` — update, including toggling `enabled`
- `DELETE /providers/{id}` — remove (cascade behavior TBD, see Open Questions)
- `GET /providers/{id}/status` — live auth check + current active stream count vs. max + `enabled` state

*Recordings*
- `POST /recordings` — schedule (one-off, or recurring via an optional recurrence pattern; recurring rules run indefinitely unless `end_date`/`max_occurrences` is set). **Implemented 2026-07-19 for one-off recordings only** (`server/src/routes/recordings.ts`): validates `providerId`/`channelId`/`startTime`/`endTime`, hard-rejects a disabled provider (409) or a request that would push the provider's peak simultaneous-stream count (sweep-line over overlapping `scheduled`/`recording` rows, not just a pairwise check) past `max_concurrent_streams` (409). Storage-exhaustion check deferred until `config/storage` exists. Recurring-pattern acceptance deferred until the next-occurrence calculator (scheduler engine) exists.
- `GET /recordings` — list/filter: `provider_id`, `channel_id`, `status` (`scheduled | recording | completed | failed | cancelled`), `start_after`/`start_before`, `recurring_rule_id`, `include_projected` (also return computed-but-not-yet-materialized future occurrences of recurring rules, flagged as projected)
- `GET /recordings/{id}` — detail
- `DELETE /recordings/{id}` — cancel a single, already-materialized recording/occurrence
- `POST /recordings/recurring/{rule_id}/skip` — skip a single occurrence by date, materialized or not (cancels the row if it exists, else adds a skip exception to the rule)
- `DELETE /recordings/recurring/{rule_id}` — cancel an entire recurring rule (stops generating future occurrences, materialized or projected)
- `GET /recordings/{id}/file` — fetch the completed file

*Config*
- `GET` / `PUT /config/storage` — storage location(s) and minimum-free-space threshold (used for the storage-exhaustion rejection check)
- `GET` / `PUT /config/retention` — retention policy

*Clients / API keys*
- `POST /clients` — issue a new API key for a client
- `GET /clients` / `DELETE /clients/{id}` — list/revoke

## Open Questions

- **Provider selection:** confirm `provider_id` passed explicitly by the client is sufficient, vs. needing server-side matching later.
- **Remux vs raw store:** confirm remux-on-record is the right call vs. storing raw TS as-is.
- **Retention policy shape:** per-recording TTL? Total storage cap with LRU eviction? Per-channel rules?
- **Provider delete cascade:** decided — block, not cascade. `recordings.provider_id` is a plain FK (`ON DELETE NO ACTION`, SQLite's default), so a provider referenced by any recording (scheduled or historical) can't be deleted; `DELETE /providers/{id}` returns 409 in that case rather than leaking a raw DB error or silently destroying recording history.
- **API key rotation:** `POST /clients` issuance is decided as admin-initiated only (no self-registration endpoint from the client side — same passive-downloader relationship as SABnzbd/Sonarr: the recorder never reaches out to or "discovers" a scheduler, it just issues a key that gets pasted into whatever client's config). Rotation flow specifically (revoke + reissue vs. in-place key refresh) still TBD.
- **Conflict handling:** what happens when two scheduled recordings overlap on the *same channel*? (Concurrent-stream limit across different channels is now decided — hard rejection at request time.)
- **Rejection UX:** when a request is rejected (concurrent-stream limit, storage exhaustion, or disabled provider), what does the client see — just a 4xx with a reason, or does the recorder suggest alternatives (e.g. next available slot)?
- **Credential storage security:** decided — AES-256-GCM (Node's built-in `crypto`), key in `ENCRYPTION_KEY` (`server/.env`, gitignored, never committed). Implemented in `server/src/crypto.ts`; `providers.usernameEncrypted`/`passwordEncrypted` store ciphertext only, redacted out of every API response.

## Open Items

- [x] **TODO1:** Design provider settings page/API (add/edit/remove provider, `provider_id` assignment, max-concurrent-streams field, `enabled` toggle). Done 2026-07-19 — `providers` table + `/providers` CRUD (`server/src/routes/providers.ts`), gated by the per-client API key middleware (`server/src/auth.ts`). `GET /providers/{id}/status`'s live fields (active stream count, live auth check) are deferred until the recordings table and an Xtream HTTP client exist — nothing to compute them from yet.
- [ ] **TODO2:** Design exact recurring-rule schema (pattern fields, optional `end_date`/`max_occurrences`, skip-exception list) and the materialization horizon (how far ahead of an occurrence's start time the recorder creates its `recordings` row).
- [ ] **TODO2:** Decide remux vs raw storage format.
- [x] **TODO2:** Decide how stored provider credentials are secured at rest. Done 2026-07-19 — see Credential storage security above.
- [x] **TODO2:** Decide provider-delete cascade behavior. Done 2026-07-19 — see Provider delete cascade above.
- [ ] **TODO2:** Decide API key issuance/rotation flow (`POST /clients` itself isn't built yet either — `server/src/db/seed-client.ts` is a CLI stand-in).
- [x] **TODO1:** Add `.gitignore` for real config/secrets + a placeholder `.env.example` before any real config file is created. Done as part of scaffolding — `.env.example` lives in `server/.env.example` (not repo root), since `dotenv/config`'s default lookup is relative to `process.cwd()`, which is `server/` when run via `pnpm --filter server`.
- [ ] **TODO3:** Design exact request/response schemas and error shapes for the drafted endpoints.
- [ ] **TODO3:** Design retention policy config (TTL vs cap vs per-channel rules) and the minimum-free-space threshold used for the storage-exhaustion rejection check.
