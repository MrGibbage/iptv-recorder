import { unlinkSync } from "node:fs";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { recordings } from "../db/schema.js";
import { getRetentionConfig } from "../db/settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// PLAN.md "Retention policy" — TTL only (decided 2026-07-19, not a storage
// cap or per-channel rules): a completed recording's file is deleted once
// its start_time is older than retention_config.ttlDays. The row itself is
// kept (file_path cleared) — still visible in GET /recordings history, just
// no longer playable (GET /recordings/{id}/file returns 410 for this case).
// Runs every scheduler tick alongside materialization/dispatch (see
// ../scheduler/index.ts); ttlDays === null means retention is disabled —
// nothing is ever auto-deleted until explicitly configured.
export function runRetentionSweep(now: Date = new Date()): void {
  const config = getRetentionConfig();
  if (config.ttlDays === null) {
    return;
  }

  const cutoff = new Date(now.getTime() - config.ttlDays * DAY_MS);

  const expired = db
    .select()
    .from(recordings)
    .where(and(eq(recordings.status, "completed"), isNotNull(recordings.filePath), lt(recordings.startTime, cutoff)))
    .all();

  for (const recording of expired) {
    if (recording.filePath) {
      try {
        unlinkSync(recording.filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
    db.update(recordings).set({ filePath: null, updatedAt: new Date() }).where(eq(recordings.id, recording.id)).run();
  }
}
