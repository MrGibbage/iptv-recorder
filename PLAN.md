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

  **Implemented 2026-07-19** (`server/src/scheduler/`): `setInterval` tick every `SCHEDULER_TICK_INTERVAL_MS` (30s, `src/config.ts`), started on server boot. Each tick considers only "today" per non-cancelled rule (no backfill for occurrences missed while the process was down — same as a VCR that was unplugged, nothing retroactively records); checks skip-exceptions, `end_date`, and `max_occurrences` (all materialized rows count against the cap regardless of eventual status, skips don't); then runs the same `checkHardReject` (`src/hardReject.ts`, shared with `POST /recordings`) as a live request would. **Materialization conflict decided:** if a due occurrence currently fails a hard-reject check, it retries every tick rather than failing immediately — only once the occurrence's own end time has also passed does it materialize as `status: "failed"` with a `failureReason`, so a transient conflict (e.g. another recording finishing minutes later) gets a chance to clear, but a genuinely missed occurrence still leaves a visible record instead of silently vanishing. Still not built: recurring-pattern acceptance in `POST /recordings` (needs this next-occurrence logic wired into that endpoint).
- **Recording worker** — pulls from the IPTV provider at scheduled times using stored credentials, remuxes to disk, writes metadata (start/end, channel, provider used).

  **Implemented 2026-07-19** (`server/src/worker/`): each scheduler tick also calls `dispatchDueRecordings`, which picks up any `recordings` row with `status: "scheduled"` and `start_time` already reached, builds the stream URL (`streamUrl.ts` — assumes the standard Xtream Codes convention `{baseUrl}/live/{username}/{password}/{channelId}.ts`, decrypting credentials via `../crypto.ts`; unverified against a real provider, easy to adjust once one is available), and spawns `ffmpeg -c copy -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof` (`ffmpegRemux.ts`) with `-t` set to the *remaining* window so a late start still ends on time. Flips the row to `recording` synchronously before spawning (so the next tick's query can't double-dispatch it), then to `completed` (with `file_path` set) or `failed` (with a `failure_reason` built from the exit signal/code and a tail of stderr) when the process exits. In-flight processes are tracked in memory and sent `SIGTERM` on server shutdown. Verified against a local synthetic MPEG-TS stream (ffmpeg lavfi `testsrc`/`sine` served over HTTP, standing in for a real Xtream provider) end-to-end: correct status transitions, a valid fragmented-MP4 file of the expected duration (confirmed via `ffprobe`), and the failure path (unreachable provider → `failed` with a reason) — then removed the throwaway test harness. ffmpeg installed via `apt-get install ffmpeg` on docker-server (wasn't present before). File storage is a flat `RECORDINGS_DIR` (env var, `./data/recordings` default) — a placeholder, not the multi-location `config/storage` design in TODO3. Not built: `GET /recordings/{id}/file` to actually serve the resulting file back to a client.
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

  **Implemented 2026-07-19** (`web/src/`): react-router-dom SPA with five pages — Settings (paste an admin-issued API key, matching the "no self-registration" auth model exactly: `pnpm --filter server db:seed-client` issues it, the UI just stores it in `localStorage` and sends it as the Bearer token; a 401 anywhere clears it and bounces back to Settings), Providers (full CRUD + enabled toggle), Recordings (list/filter, one-off scheduling, cancel, download-via-authenticated-blob-fetch — a plain `<a href>` or `<video src>` can't carry the Bearer header, and putting the key in the URL as a query param instead would leak it into server logs/browser history, so download-only rather than in-page streaming playback for now), Recurring Rules (list/create with day-of-week checkboxes building the bitmask/skip-a-date/cancel-rule), and Config (storage + retention). Added `GET /recordings/recurring` (list) and `GET /recordings/recurring/{id}` (detail) along the way — PLAN.md's flat resource model never called for enumerating `recurring_rules` directly, but a UI managing rules has to be able to see them first.

  Verified end-to-end in a real headless-Chromium session (Playwright, installed temporarily for this — not a project dependency, removed after) rather than just typechecked: connect → add/edit/toggle/delete a provider → schedule a one-off recording → filter by status → create a recurring rule → follow its "Occurrences" link into a filtered Recordings view → edit Storage/Retention config, all against the real API with zero browser console errors. Also checked dark mode. Along the way, scheduling a recording initially 409'd with "insufficient storage space" — not a UI bug, the hard-reject check working correctly: docker-server was down to ~550MB free against the 1 GiB default `minFreeBytes`, and the disk turned out to be genuinely near capacity host-wide (99-100% used) independent of this project. Lowered the threshold to verify the rest of the flow, then reset it back afterward.
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
- `GET /providers/{id}/status` — live auth check + current active stream count vs. max + `enabled` state. **Implemented 2026-07-19** (`server/src/routes/providers.ts`, live check in `server/src/worker/xtreamAuth.ts`): 404 if the provider doesn't exist. `activeStreams` counts rows currently `status: "recording"` for that provider — "what's happening right now," distinct from the sweep-line peak-overlap math in `hardReject.ts` (which answers "would a hypothetical future window exceed the limit"). The live check hits the standard Xtream Codes `{baseUrl}/player_api.php?username=...&password=...` endpoint and treats `user_info.auth === 1` as success — same unverified-against-a-real-provider caveat as `streamUrl.ts`'s stream-URL convention, since no real Xtream provider has been available to test against yet. Never throws on a bad/unreachable provider: connection errors, non-2xx responses, and a 5s timeout (`PROVIDER_STATUS_CHECK_TIMEOUT_MS`, `src/config.ts`) all resolve to `auth: { ok: false, error, checkedAt }` rather than a 500. Verified against a local fake `player_api.php` stub (plain Node `http` server, removed after) covering all three paths: valid credentials (`ok: true`), a provider actively rejecting credentials (`auth: 0` in the response body), and a genuinely unreachable host (connection refused, resolves fast rather than waiting out the timeout) — plus the 404 case.

*Recordings*
- `POST /recordings` — schedule (one-off, or recurring via an optional recurrence pattern; recurring rules run indefinitely unless `end_date`/`max_occurrences` is set). **Implemented 2026-07-19** (`server/src/routes/recordings.ts`): validates `providerId`/`channelId`, then either `startTime`/`endTime` or a `recurrence` object (`daysOfWeek`, `startMinuteOfDay`, `durationMinutes`, optional `endDate`/`maxOccurrences`) — mutually exclusive, exactly one required, 400 otherwise. One-off requests hard-reject a disabled provider or a request that would push the provider's peak simultaneous-stream count (sweep-line over overlapping `scheduled`/`recording` rows, not just a pairwise check) past `max_concurrent_streams` (409); storage-exhaustion also applies (see Config endpoints). A recurring request only checks what's knowable without a concrete time window (provider exists, provider enabled) and creates a `recurring_rules` row directly — it does **not** pre-materialize a first occurrence itself, deliberately leaving "when does an occurrence get created" logic in exactly one place (the scheduler tick's `checkHardReject` call handles the per-occurrence storage/concurrency checks once each occurrence is actually due). Verified end-to-end live: created a rule via this endpoint for later the same day, polled `GET /recordings?recurringRuleId=`, and confirmed the scheduler materialized the correct `recordings` row (right provider/channel/window) without any other code changes.
- `GET /recordings` — list/filter: `provider_id`, `channel_id`, `status` (`scheduled | recording | completed | failed | cancelled`), `start_after`/`start_before`, `recurring_rule_id`, `include_projected` (also return computed-but-not-yet-materialized future occurrences of recurring rules, flagged as projected). **Implemented 2026-07-19** minus `include_projected` (`server/src/routes/recordings.ts`) — that needs its own multi-day projection logic distinct from the scheduler's "is today due" check, deferred as a separate piece.
- `GET /recordings/{id}` — detail. **Implemented 2026-07-19.**
- `DELETE /recordings/{id}` — cancel a single, already-materialized recording/occurrence. **Implemented 2026-07-19** as a soft-cancel (`status: "cancelled"`, row kept — consistent with the flat resource model, not a hard delete). Rejects with 409 if the recording is already in a terminal state. If it's actively `recording`, also signals the in-flight ffmpeg process to stop (`worker/dispatch.ts`'s `cancelActiveWorker`) — the route sets `status: "cancelled"` before touching the worker, and the worker's own process-exit handler checks a `cancelled` flag it set itself so it never clobbers that with `failed`. Verified against a real in-progress recording (a real-time-paced synthetic stream, cancelled mid-flight, confirmed the status held after the process actually exited) — an earlier attempt using ffmpeg's `-listen` mode and an unpaced source gave a false pass by finishing almost instantly, so this took two tries to verify properly.
- `POST /recordings/recurring/{rule_id}/skip` — skip a single occurrence by date, materialized or not (cancels the row if it exists, else adds a skip exception to the rule). **Implemented 2026-07-19** (`server/src/routes/recordings.ts`): 404 if the rule doesn't exist, 409 if the rule is already cancelled. Rejects a date that doesn't round-trip through `Date` unchanged (catches `Date`'s silent day/month rollover, e.g. `"2026-02-30"` → March 2, which a plain `isNaN` check wouldn't catch). Idempotent — skipping an already-skipped date returns the existing exception (`onConflictDoNothing` against the `(rule_id, occurrence_date)` unique index) rather than erroring. If the date has already materialized, cancels that row via the same `cancelRecordingRow` helper `DELETE /recordings/{id}` uses (409 if it's already in a terminal state) — including stopping an actively-`recording` process if that occurrence happens to be in progress.
- `DELETE /recordings/recurring/{rule_id}` — cancel an entire recurring rule (stops generating future occurrences, materialized or projected). **Implemented 2026-07-19**: 404/409 (already cancelled) as above. Sets `cancelled_at`, then bulk-cancels every not-yet-started (`status: "scheduled"`) materialized occurrence for the rule — per PLAN's own wording, "materialized or projected" future occurrences both stop. Deliberately leaves an already-`recording` occurrence to finish (not covered by PLAN.md's wording, which is specifically about *future* occurrences — treated as a judgment call: cancelling a season pass isn't the same request as stopping tonight's in-progress episode). Response includes `cancelledRecordings` (count) alongside the updated rule. Verified live including the selective-cancellation behavior (a `scheduled` row got cancelled, a `recording` row was left untouched) and that the scheduler stops materializing new occurrences immediately (already guaranteed by the existing `cancelled_at IS NULL` filter in the tick).
- `GET /recordings/{id}/file` — fetch the completed file. **Implemented 2026-07-19** (`server/src/routes/recordings.ts`, range parsing in `server/src/httpRange.ts`): 404 if the recording doesn't exist, 409 if it's not `status: "completed"`, 500 if the row says completed but the file is missing from `RECORDINGS_DIR` on disk. Supports HTTP Range requests (206 partial content, single range only — `bytes=start-end`, an open-ended `start-`, or a suffix `-N` — no multipart/multi-range, since no seeking client sends one) so video players can seek without downloading from the start; 416 on a malformed or out-of-bounds range. Verified byte-for-byte (`cmp`) against a real file produced by the worker pipeline: full download, a mid-file range, a suffix range, an open-ended range, and both 416 cases, plus the 409 and 500 paths.

*Config*
- `GET` / `PUT /config/storage` — storage location(s) and minimum-free-space threshold (used for the storage-exhaustion rejection check). **Implemented 2026-07-19** (`server/src/routes/config.ts`, singleton row in `server/src/db/settings.ts`) as a single location, not PLAN.md's original "location(s)" plural — no allocation policy across multiple disks has ever been needed, so multi-location support is deferred until it actually is. Seeded from the old `RECORDINGS_DIR` env var on first read; `PUT` only changes where *future* recordings are written, it doesn't migrate existing files. `minFreeBytes` (default 1 GiB) is now enforced by `checkHardReject` (`server/src/hardReject.ts`) via `fs.statfsSync` on the configured directory — the storage-exhaustion hard-reject rule from Goals, previously deferred, is now wired in alongside the disabled-provider and concurrent-stream checks. Verified live: forced an absurdly high threshold, confirmed `POST /recordings` 409s with "insufficient storage space", reset it, confirmed the request then succeeds.
- `GET` / `PUT /config/retention` — retention policy. **Implemented 2026-07-19** as TTL only (see Retention policy shape below) — `retention_config` singleton, `ttlDays: null` (default) disables retention entirely. Swept every scheduler tick (`server/src/retention/sweep.ts`, called from `server/src/scheduler/index.ts` alongside materialization/dispatch): a `completed` recording whose `start_time` is older than the TTL has its file deleted and `file_path` cleared, but the row is kept — still visible in `GET /recordings` history, just no longer playable. `GET /recordings/{id}/file` now returns 410 (distinct from the existing 500 "file missing unexpectedly") once retention has cleared a recording's file. Verified: an old completed recording gets cleaned up, a recent one doesn't, and sweeping with retention disabled touches nothing.

  Building this surfaced a real gap: a cancelled or failed-after-starting recording never gets `file_path` set, but ffmpeg may already have written a partial file — which retention couldn't ever see or clean up. Fixed in `server/src/worker/dispatch.ts`: both the cancel path and the post-start failure path now best-effort delete that partial file directly (verified against a real in-progress recording: confirmed the partial file existed mid-recording, then confirmed it was gone after cancellation).

*Clients / API keys*
- `POST /clients` — issue a new API key for a client. **Implemented 2026-07-19** (`server/src/routes/clients.ts`): itself gated by `requireApiKey` like every other route, so the very first client still has to come from `server/src/db/seed-client.ts` (CLI) to break the chicken-and-egg problem — every client after that can be issued by any existing one, matching the "admin-initiated, no self-registration" model (no separate admin role exists; any valid client key can issue another). Returns the raw key exactly once, in the creation response body — only its SHA-256 hash is stored, same as `seed-client.ts` already did.
- `GET /clients` / `DELETE /clients/{id}` — list/revoke. **Implemented 2026-07-19**: list is redacted (never returns `apiKeyHash`). `DELETE` is a soft-revoke (`revokedAt` set, row kept, consistent with the soft-cancel pattern used elsewhere — e.g. `DELETE /recordings/{id}`), 404 if the client doesn't exist, 409 if already revoked. Verified end-to-end against a running server: issued a client, listed it, issued a second, revoked it, confirmed its key then gets a 401 from `requireApiKey` on any other endpoint, confirmed double-revoke 409s and an unknown id 404s.

  **API key rotation — decided 2026-07-19:** revoke + reissue, not in-place key refresh. `DELETE /clients/{id}` to revoke the old key, `POST /clients` for a new one; no separate rotate endpoint, since the two primitives already cover it.

## Open Questions

- **Provider selection:** confirm `provider_id` passed explicitly by the client is sufficient, vs. needing server-side matching later.
- **Remux vs raw store:** decided 2026-07-19 — remux, not raw. See Recording worker above.
- **Retention policy shape:** decided 2026-07-19 — TTL, not a storage cap or per-channel rules. See Config endpoints above.
- **Provider delete cascade:** decided — block, not cascade. `recordings.provider_id` is a plain FK (`ON DELETE NO ACTION`, SQLite's default), so a provider referenced by any recording (scheduled or historical) can't be deleted; `DELETE /providers/{id}` returns 409 in that case rather than leaking a raw DB error or silently destroying recording history.
- **API key rotation:** `POST /clients` issuance is decided as admin-initiated only (no self-registration endpoint from the client side — same passive-downloader relationship as SABnzbd/Sonarr: the recorder never reaches out to or "discovers" a scheduler, it just issues a key that gets pasted into whatever client's config). Rotation flow: decided 2026-07-19 — revoke + reissue. See Clients / API keys above.
- **Conflict handling:** what happens when two scheduled recordings overlap on the *same channel*? (Concurrent-stream limit across different channels is now decided — hard rejection at request time.)
- **Rejection UX:** when a request is rejected (concurrent-stream limit, storage exhaustion, or disabled provider), what does the client see — just a 4xx with a reason, or does the recorder suggest alternatives (e.g. next available slot)?
- **Credential storage security:** decided — AES-256-GCM (Node's built-in `crypto`), key in `ENCRYPTION_KEY` (`server/.env`, gitignored, never committed). Implemented in `server/src/crypto.ts`; `providers.usernameEncrypted`/`passwordEncrypted` store ciphertext only, redacted out of every API response.

## Open Items

- [x] **TODO1:** Design provider settings page/API (add/edit/remove provider, `provider_id` assignment, max-concurrent-streams field, `enabled` toggle). Done 2026-07-19 — `providers` table + `/providers` CRUD (`server/src/routes/providers.ts`), gated by the per-client API key middleware (`server/src/auth.ts`). `GET /providers/{id}/status`'s live fields (active stream count, live auth check) were deferred pending a recordings table and an Xtream HTTP client — both now exist; see the endpoint's own entry under API Design → Providers for the completed implementation.
- [x] **TODO2:** Design exact recurring-rule schema (pattern fields, optional `end_date`/`max_occurrences`, skip-exception list) and the materialization horizon (how far ahead of an occurrence's start time the recorder creates its `recordings` row). Done 2026-07-19 — `recurring_rules`/`recurring_rule_skips` tables, horizon in `src/config.ts`, materialization logic in `server/src/scheduler/`.
- [x] **TODO2:** Decide remux vs raw storage format. Done 2026-07-19 — remux; see Recording worker above.
- [x] **TODO2:** Decide how stored provider credentials are secured at rest. Done 2026-07-19 — see Credential storage security above.
- [x] **TODO2:** Decide provider-delete cascade behavior. Done 2026-07-19 — see Provider delete cascade above.
- [x] **TODO2:** Decide API key issuance/rotation flow. Done 2026-07-19 — `POST /clients` / `GET /clients` / `DELETE /clients/{id}` built (`server/src/routes/clients.ts`); rotation is revoke + reissue. `server/src/db/seed-client.ts` remains as the CLI bootstrap for a repo's very first client (nothing else can call the now-auth-gated `POST /clients` before one exists).
- [x] **TODO1:** Add `.gitignore` for real config/secrets + a placeholder `.env.example` before any real config file is created. Done as part of scaffolding — `.env.example` lives in `server/.env.example` (not repo root), since `dotenv/config`'s default lookup is relative to `process.cwd()`, which is `server/` when run via `pnpm --filter server`.
- [ ] **TODO3:** Design exact request/response schemas and error shapes for the drafted endpoints.
- [x] **TODO3:** Design retention policy config (TTL vs cap vs per-channel rules) and the minimum-free-space threshold used for the storage-exhaustion rejection check. Done 2026-07-19 — see Config endpoints above.
- [ ] **TODO4:** Add Swagger/OpenAPI docs for the full API surface — user request, 2026-07-19. Deferred until the API surface is considered complete (this project **and** iptv-scheduler — see the mirrored note in [iptv-scheduler's PLAN.md](/srv/iptv-scheduler/PLAN.md)), not started now. Likely `@fastify/swagger` + `@fastify/swagger-ui`, matching the existing Fastify stack — each route's existing JSON-schema `body`/`querystring` definitions (already written for validation) should mostly double as the OpenAPI schema source with little rework.
