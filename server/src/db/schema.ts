import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Per-client API keys (PLAN.md "Auth: per-client API keys" — already decided).
// The `recordings` table (materialized/one-off occurrences) lands once the
// recording worker and materialization logic are built (see PLAN.md TODO2).
export const clients = sqliteTable("clients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

// IPTV provider accounts (PLAN.md "Credentials Model").
// username/password are encrypted at rest (see ../crypto.ts) — never
// selected out as plaintext by application code outside that module.
export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  usernameEncrypted: text("username_encrypted").notNull(),
  passwordEncrypted: text("password_encrypted").notNull(),
  maxConcurrentStreams: integer("max_concurrent_streams").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
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
  // Opaque provider-side channel identifier — the recorder has no channel/EPG
  // table of its own (PLAN.md Non-goals), so this is just a string handed
  // back by whichever client scheduled the rule.
  channelId: text("channel_id").notNull(),
  // Bitmask of days this rule fires on: bit 0 = Monday .. bit 6 = Sunday.
  daysOfWeek: integer("days_of_week").notNull(),
  // Minutes since midnight, server-local time (0-1439) — single-instance,
  // single-timezone deployment, so no explicit timezone field.
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
