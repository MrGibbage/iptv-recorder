import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db, sqlite } from "./client.js";

// SQLite has no ALTER COLUMN, so a migration that changes a column's
// nullability/constraints (e.g. 0005, splitting `providers` into
// xtream/m3u-shaped columns) recreates the table via DROP + rename. Any
// `PRAGMA foreign_keys=OFF` inside such a migration file is a no-op — SQLite
// ignores changes to that pragma once a transaction is open, and drizzle's
// migrate() wraps the whole file in one. Toggling it here, around the
// transaction instead of inside it, is what actually lets the DROP succeed
// despite recordings/recurring_rules holding live FKs into providers.
sqlite.pragma("foreign_keys = OFF");
migrate(db, { migrationsFolder: "./drizzle" });
sqlite.pragma("foreign_keys = ON");
console.log("Migrations applied.");
