import { sqliteTable, integer, text, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Per-client API keys (PLAN.md "Auth: per-client API keys" — already decided).
export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

// IPTV provider accounts (PLAN.md "Credentials Model"). Two shapes share
// this table, discriminated by `type`:
//   - xtream: baseUrl + username/password against a player_api.php panel.
//   - m3u: a single playlist URL (credentials, if any, are typically baked
//     into the URL itself — e.g. Apollo Group — rather than exposed as a
//     separate username/password), plus an optional XMLTV epgUrl since M3U
//     playlists carry no program data of their own (unlike Xtream, which
//     bundles EPG behind the same panel credentials).
// All secret-shaped fields are encrypted at rest (see ../crypto.ts) — never
// selected out as plaintext by application code outside that module.
// providersTypeShapeCheck below enforces that exactly the fields belonging
// to a row's `type` are populated, not a mix of both.
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type", { enum: ["xtream", "m3u"] })
      .notNull()
      .default("xtream"),
    // Xtream-only — null when type = 'm3u'.
    baseUrl: text("base_url"),
    usernameEncrypted: text("username_encrypted"),
    passwordEncrypted: text("password_encrypted"),
    // M3U-only — null when type = 'xtream'. playlistUrl is the sole
    // credential for M3U providers; epgUrl is optional (a provider may not
    // offer a guide at all).
    playlistUrlEncrypted: text("playlist_url_encrypted"),
    epgUrlEncrypted: text("epg_url_encrypted"),
    maxConcurrentStreams: integer("max_concurrent_streams").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    typeShapeCheck: check(
      "providers_type_shape",
      sql`
        (${table.type} = 'xtream'
          AND ${table.baseUrl} IS NOT NULL
          AND ${table.usernameEncrypted} IS NOT NULL
          AND ${table.passwordEncrypted} IS NOT NULL
          AND ${table.playlistUrlEncrypted} IS NULL)
        OR
        (${table.type} = 'm3u'
          AND ${table.playlistUrlEncrypted} IS NOT NULL
          AND ${table.baseUrl} IS NULL
          AND ${table.usernameEncrypted} IS NULL
          AND ${table.passwordEncrypted} IS NULL)
      `,
    ),
  }),
);

// Lightweight per-person attribution, Netflix-profile-style: a name only,
// no password/secret — not a security boundary (every client key can still
// see and act on every profile's recordings), just lets a shared household
// tell whose recording something is. Providers stay unscoped (shared
// subscription, same as a Netflix household shares one catalog).
export const profiles = sqliteTable("profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Recurring recording patterns (PLAN.md "Recurring occurrence
// materialization"). A rule is evaluated cron-like — the scheduler computes
// the next fire time rather than pre-expanding every future occurrence into
// rows. Materialized/one-off occurrences themselves live in `recordings`
// (not yet built), filterable by `recurring_rule_id`, per PLAN.md's flat
// resource model.
export const recurringRules = sqliteTable("recurring_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: integer("provider_id")
    .notNull()
    .references(() => providers.id),
  // Optional attribution — no ON DELETE behavior configured (SQLite default
  // NO ACTION), same as provider_id below: deleting a profile that any rule
  // still references is blocked (409), not cascaded (see DELETE /profiles/:id).
  profileId: integer("profile_id").references(() => profiles.id),
  // Opaque provider-side channel identifier — the recorder has no channel/EPG
  // table of its own (PLAN.md Non-goals), so this is just a string handed
  // back by whichever client scheduled the rule.
  channelId: text("channel_id").notNull(),
  // Bitmask of days this rule fires on: bit 0 = Monday .. bit 6 = Sunday.
  daysOfWeek: integer("days_of_week").notNull(),
  // Minutes since midnight, UTC (0-1439) — single-instance,
  // single-timezone deployment, so no explicit timezone field. Pinned to
  // UTC via TZ=UTC (server/.env, asserted at boot in src/index.ts) rather
  // than left to whatever the host happens to be set to.
  startMinuteOfDay: integer("start_minute_of_day").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  // Optional stop conditions — a rule with neither runs indefinitely.
  endDate: integer("end_date", { mode: "timestamp" }),
  maxOccurrences: integer("max_occurrences"),
  // Set to stop generating future occurrences (PLAN.md "DELETE
  // /recordings/recurring/{rule_id}"). The row itself is kept, not deleted,
  // so already-materialized recordings retain a valid recurring_rule_id.
  cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Skip exceptions for a single occurrence of a recurring rule — the
// iCalendar EXDATE equivalent (PLAN.md "Skipping/cancelling a single
// occurrence"). Only covers occurrences that haven't been materialized into
// a `recordings` row yet; once materialized, skipping is just `DELETE
// /recordings/{id}` against that row directly.
export const recurringRuleSkips = sqliteTable(
  "recurring_rule_skips",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => recurringRules.id),
    // ISO date (YYYY-MM-DD) of the skipped occurrence — a date, not a
    // timestamp, since a rule only ever fires once per calendar day.
    occurrenceDate: text("occurrence_date").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    ruleDateIdx: uniqueIndex("recurring_rule_skips_rule_date_idx").on(table.ruleId, table.occurrenceDate),
  }),
);

// Materialized recording occurrences (PLAN.md "Resource model: flat" and
// "Recurring occurrence materialization"). Every occurrence — one-off or a
// materialized instance of a recurring_rule — is a row here; there's no
// separate resource tree for recurring recordings. Occurrences further out
// than the materialization horizon are a computed projection, not a row
// (see MATERIALIZATION_HORIZON_MINUTES in ../config.ts).
//
// provider_id has no ON DELETE behavior configured, so SQLite's default
// (NO ACTION) applies: deleting a provider that any recording references
// fails outright rather than cascading — recording history is never
// silently destroyed by a provider deletion (see PLAN.md "Provider delete
// cascade").
export const recordings = sqliteTable(
  "recordings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id),
    // Optional attribution, inherited from recurring_rules.profile_id when
    // materialized from a rule (see scheduler/tick.ts). Same NO ACTION
    // delete-blocking behavior as provider_id.
    profileId: integer("profile_id").references(() => profiles.id),
    channelId: text("channel_id").notNull(),
    // Null for a one-off recording; set for a materialized recurring occurrence.
    recurringRuleId: integer("recurring_rule_id").references(() => recurringRules.id),
    startTime: integer("start_time", { mode: "timestamp" }).notNull(),
    endTime: integer("end_time", { mode: "timestamp" }).notNull(),
    status: text("status", {
      enum: ["scheduled", "recording", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("scheduled"),
    // Populated once the recording worker finishes writing the file.
    filePath: text("file_path"),
    // Populated when status = 'failed'.
    failureReason: text("failure_reason"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    endAfterStart: check("recordings_end_after_start", sql`${table.endTime} > ${table.startTime}`),
    // De-dupes materialization of the same rule's occurrence if the scheduler
    // tick loop ever overlaps or retries. NULLs (one-off recordings) are
    // never considered equal to each other in a SQLite unique index, so this
    // has no effect on one-off rows.
    ruleOccurrenceIdx: uniqueIndex("recordings_rule_start_idx").on(table.recurringRuleId, table.startTime),
  }),
);

// Singleton config rows (PLAN.md "GET/PUT /config/storage"). Always exactly
// one row, created on first read with defaults if missing — see
// ../db/settings.ts. Not a per-provider/per-location table: PLAN.md's
// "storage location(s)" plural is deferred until multiple locations are
// actually needed; this is one directory.
export const storageConfig = sqliteTable("storage_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  directory: text("directory").notNull(),
  // Hard-reject threshold for the storage-exhaustion check (checkHardReject
  // in ../hardReject.ts) — a schedule/record request is rejected if free
  // space on this directory's filesystem is already below this.
  minFreeBytes: integer("min_free_bytes").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Singleton config row (PLAN.md "GET/PUT /config/retention", "Retention
// policy shape" — decided 2026-07-19: TTL, not a storage cap or per-channel
// rules). ttlDays null means retention is disabled — nothing is ever
// auto-deleted until a TTL is explicitly configured.
export const retentionConfig = sqliteTable("retention_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ttlDays: integer("ttl_days"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
