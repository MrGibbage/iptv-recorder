# iptv-recorder — Plan

## Overview

A standalone recording/scheduling backend for IPTV DVR functionality, consumed by [Laomedeia](https://github.com/MrGibbage/laomedeia) (and potentially other client apps later). The service owns scheduling and disk storage of recordings; it does **not** transcode. Playback clients pull the recorded file and handle decode/transcode themselves, the same way they already do for live streams.

Runs on docker-server or smavm — host TBD (see Open Questions).

A separate companion **scheduler app** (web service, own project) is expected to sit in front of this as one possible client — see Relationship to Companion Scheduler App below for the division of responsibility. The recorder API itself must stay generic enough for any client (web, desktop, mobile) to drive directly, not just the companion app.

## Goals

- Accept recording requests (one-off and recurring) from client apps over an HTTP API.
- Own recurring-schedule primitives (e.g. "same time, same channel, every week") — pure calendar mechanics, no content awareness required, so this keeps working even if a smarter client/scheduler app is offline.
- Enforce each provider's configured max concurrent streams at request time — reject any schedule/record request that would push a provider over its limit, rather than queuing or best-effort attempting it.
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
iptv-recorder API  ──schedules──▶  recording worker  ──writes──▶  disk (remuxed files)
   │                                     │
   │                          looks up stored credentials
   │                          for provider_id, connects to
   │                          that Xtream provider
   └──serves recorded file──▶  Laomedeia (client transcodes/plays)
```

- **API service** — accepts schedule/record/list/delete requests, manages the schedule store, exposes config endpoints (including provider management).
- **Recording worker** — pulls from the IPTV provider at scheduled times using stored credentials, remuxes to disk, writes metadata (start/end, channel, provider used).
- **Storage** — plain files on disk; retention policy prunes old recordings per config.
- **Config/admin surface** — a backend settings page covering: one or more IPTV provider configs (name, Xtream URL, credentials), storage location(s), retention policy, other operational options.

## Credentials Model

Decided: the service **does** store IPTV provider credentials server-side, configured through a settings page. One or more providers can be added; each gets a `provider_id`. This solves the scheduled-recording problem from the earlier draft — the service can trigger a recording on schedule without Lao needing to be open or reachable at that moment.

Provider setup also requires a **max concurrent streams** value (matches the limit most Xtream provider accounts enforce). The recorder tracks active streams per provider and rejects any new schedule/record request that would exceed it — a hard rejection, not a queue.

Open question this raises: **how does a request indicate which configured provider to use?** Leaning toward having Lao pass a `provider_id` explicitly with every request — Lao is already the one presenting the channel/guide UI, so it already knows which provider a given channel came from. The alternative (server matches/fails-over across providers automatically) would only matter if the same channel exists on multiple configured providers, which isn't a case that exists yet — not worth designing for until it does.

## API Design

**Resource model: flat.** Recurring recordings are not a separate resource tree. `POST /recordings` accepts an optional recurrence pattern; the recorder expands it internally, and every generated occurrence (recurring or one-off) is just a normal row in the `recordings` collection, filterable by `recurring_rule_id`. This means every other endpoint (list, cancel, fetch-file) behaves identically regardless of whether a recording originated from a rule or a single request — cancelling one occurrence (e.g. because iptv-scheduler determined it's a duplicate) is always `DELETE /recordings/{id}`, never a special nested-resource call.

**Auth: per-client API keys.** Every client (Lao, iptv-scheduler, any future client) gets its own key rather than a single shared secret. Requests are attributable to a specific client in logs/history — matters once more than one client is calling the API concurrently.

**Endpoints (draft):**

*Providers*
- `POST /providers` — add (name, Xtream base URL, credentials, `max_concurrent_streams`)
- `GET /providers` / `GET /providers/{id}` — list/detail, credentials redacted in the response
- `PUT /providers/{id}` — update
- `DELETE /providers/{id}` — remove (cascade behavior TBD, see Open Questions)
- `GET /providers/{id}/status` — live auth check + current active stream count vs. max

*Recordings*
- `POST /recordings` — schedule (one-off, or recurring via an optional recurrence pattern)
- `GET /recordings` — list/filter: `provider_id`, `channel_id`, `status` (`scheduled | recording | completed | failed | cancelled`), `start_after`/`start_before`, `recurring_rule_id`
- `GET /recordings/{id}` — detail
- `DELETE /recordings/{id}` — cancel a single recording/occurrence
- `DELETE /recordings/recurring/{rule_id}` — cancel an entire recurring rule (stops generating future occurrences)
- `GET /recordings/{id}/file` — fetch the completed file

*Config*
- `GET` / `PUT /config/storage` — storage location(s)
- `GET` / `PUT /config/retention` — retention policy

*Clients / API keys*
- `POST /clients` — issue a new API key for a client
- `GET /clients` / `DELETE /clients/{id}` — list/revoke

## Open Questions

- **Host:** docker-server vs smavm — which has the storage headroom for recordings?
- **Provider selection:** confirm `provider_id` passed explicitly by the client is sufficient, vs. needing server-side matching later.
- **Remux vs raw store:** confirm remux-on-record is the right call vs. storing raw TS as-is.
- **Retention policy shape:** per-recording TTL? Total storage cap with LRU eviction? Per-channel rules?
- **Provider delete cascade:** does `DELETE /providers/{id}` block if there are future scheduled recordings against it, or cascade-cancel them?
- **API key issuance/rotation:** manual admin action only, or self-service rotation per client?
- **Conflict handling:** what happens when two scheduled recordings overlap on the *same channel*? (Concurrent-stream limit across different channels is now decided — hard rejection at request time.)
- **Rejection UX:** when a request is rejected for exceeding concurrent-stream limits, what does the client see — just a 4xx with a reason, or does the recorder suggest alternatives (e.g. next available slot)?
- **Credential storage security:** provider credentials at rest need to be encrypted/secured on disk, not plaintext config — mirrors the same concern Lao's own docs raise about not writing credentials to disk in logs.

## Open Items

- [ ] **TODO1:** Design provider settings page/API (add/edit/remove provider, `provider_id` assignment, max-concurrent-streams field).
- [ ] **TODO2:** Design recurring-schedule primitive (rule shape, occurrence expansion, cancel/skip a single occurrence).
- [ ] **TODO1:** Decide host (docker-server vs smavm) based on available storage.
- [ ] **TODO2:** Decide remux vs raw storage format.
- [ ] **TODO2:** Decide how stored provider credentials are secured at rest.
- [ ] **TODO2:** Decide provider-delete cascade behavior and API key issuance/rotation flow.
- [ ] **TODO3:** Design exact request/response schemas and error shapes for the drafted endpoints.
- [ ] **TODO3:** Design retention policy config (TTL vs cap vs per-channel rules).
