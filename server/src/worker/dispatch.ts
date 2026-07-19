import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { and, eq, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { buildStreamUrl } from "./streamUrl.js";
import { startRemux } from "./ffmpegRemux.js";

// Mirrors DB_PATH's pattern in ../db/client.ts. A dedicated config/storage
// table (location(s), min-free-space threshold) is still PLAN.md TODO3 —
// this is a placeholder single-location default, not that design.
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? "./data/recordings";
mkdirSync(RECORDINGS_DIR, { recursive: true });

// recordingId -> in-flight ffmpeg process. Prevents re-dispatching a row a
// later tick would otherwise still see as due, and lets shutdown clean up.
const activeWorkers = new Map<number, ChildProcessWithoutNullStreams>();

function fail(recordingId: number, reason: string): void {
  db.update(recordings)
    .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
    .where(eq(recordings.id, recordingId))
    .run();
}

// PLAN.md "hands off any materialized occurrence whose start time has
// arrived to the recording worker" — called from the scheduler tick
// alongside runSchedulerTick (see ../scheduler/index.ts).
export function dispatchDueRecordings(now: Date = new Date()): void {
  const due = db
    .select()
    .from(recordings)
    .where(and(eq(recordings.status, "scheduled"), lte(recordings.startTime, now)))
    .all();

  for (const recording of due) {
    if (activeWorkers.has(recording.id)) {
      continue;
    }

    if (now.getTime() >= recording.endTime.getTime()) {
      // Whole window elapsed before we ever got to start it (e.g. the
      // process was down) — same "no backfill" stance as the scheduler tick.
      fail(recording.id, "recording window elapsed before it could start");
      continue;
    }

    const [provider] = db.select().from(providers).where(eq(providers.id, recording.providerId)).all();
    if (!provider) {
      // FK guarantees this can't happen in practice; defensive only.
      fail(recording.id, "provider no longer exists");
      continue;
    }

    // Record only what's left of the window if we're starting a bit late
    // (tick granularity), not the full original duration.
    const durationSeconds = Math.ceil((recording.endTime.getTime() - now.getTime()) / 1000);
    const outputPath = join(RECORDINGS_DIR, `${recording.id}.mp4`);
    const inputUrl = buildStreamUrl(provider, recording.channelId);

    // Flip to 'recording' before spawning: dispatchDueRecordings queries by
    // status='scheduled', so this must land before the next tick's query.
    db.update(recordings)
      .set({ status: "recording", updatedAt: new Date() })
      .where(eq(recordings.id, recording.id))
      .run();

    const { process, getStderrTail } = startRemux(inputUrl, outputPath, durationSeconds);
    activeWorkers.set(recording.id, process);

    process.on("close", (code, signal) => {
      activeWorkers.delete(recording.id);
      if (code === 0) {
        db.update(recordings)
          .set({ status: "completed", filePath: outputPath, updatedAt: new Date() })
          .where(eq(recordings.id, recording.id))
          .run();
      } else {
        const reason = signal
          ? `ffmpeg terminated by signal ${signal}`
          : `ffmpeg exited with code ${code}: ${getStderrTail().trim().slice(-500)}`;
        fail(recording.id, reason);
      }
    });
  }
}

// Graceful shutdown — SIGTERM in-flight ffmpeg processes rather than
// leaving orphans running past the server that started them.
export function stopAllWorkers(): void {
  for (const child of activeWorkers.values()) {
    child.kill("SIGTERM");
  }
  activeWorkers.clear();
}
