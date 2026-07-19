import { mkdirSync } from "node:fs";
import { db } from "./client.js";
import { storageConfig, retentionConfig } from "./schema.js";

const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

// Both config tables are singletons: exactly one row, created with sane
// defaults the first time anything asks for it, rather than requiring the
// admin to PUT before the recorder can run at all.

export function getStorageConfig(): typeof storageConfig.$inferSelect {
  const [existing] = db.select().from(storageConfig).all();
  if (existing) {
    return existing;
  }
  // Seeds from RECORDINGS_DIR (the old placeholder default) so upgrading
  // doesn't change where files land until someone explicitly reconfigures
  // it via PUT /config/storage.
  const [created] = db
    .insert(storageConfig)
    .values({
      directory: process.env.RECORDINGS_DIR ?? "./data/recordings",
      minFreeBytes: DEFAULT_MIN_FREE_BYTES,
    })
    .returning()
    .all();
  return created;
}

export function ensureStorageDirectory(config: typeof storageConfig.$inferSelect): void {
  mkdirSync(config.directory, { recursive: true });
}

export function getRetentionConfig(): typeof retentionConfig.$inferSelect {
  const [existing] = db.select().from(retentionConfig).all();
  if (existing) {
    return existing;
  }
  const [created] = db.insert(retentionConfig).values({ ttlDays: null }).returning().all();
  return created;
}
