import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

// Per-client API keys (PLAN.md "Auth: per-client API keys" — already decided).
// Remaining tables (recurring_rules, recordings) land once their
// schemas are designed (see PLAN.md TODO2).
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
