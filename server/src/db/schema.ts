import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

// Per-client API keys (PLAN.md "Auth: per-client API keys" — already decided).
// Remaining tables (providers, recurring_rules, recordings) land once their
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
