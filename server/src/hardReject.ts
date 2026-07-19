import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "./db/client.js";
import { recordings, providers } from "./db/schema.js";

const ACTIVE_STATUSES: ("scheduled" | "recording")[] = ["scheduled", "recording"];

// Sweep-line max concurrency across a set of [start, end) intervals. Needed
// because a naive pairwise/count check isn't enough once more than two
// recordings can overlap the same instant — this finds the true peak
// simultaneous-stream count (PLAN.md "Enforce each provider's configured
// max concurrent streams at request time").
function maxConcurrentOverlap(intervals: { start: number; end: number }[]): number {
  const events: { t: number; delta: number }[] = [];
  for (const { start, end } of intervals) {
    events.push({ t: start, delta: 1 });
    events.push({ t: end, delta: -1 });
  }
  // Ends before starts at equal timestamps: a recording ending exactly when
  // another begins doesn't count as concurrent (half-open [start, end)).
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  let running = 0;
  let peak = 0;
  for (const event of events) {
    running += event.delta;
    peak = Math.max(peak, running);
  }
  return peak;
}

// Shared by POST /recordings and the scheduler tick (server/src/scheduler) so
// a request and a materializing recurring occurrence are hard-rejected by
// exactly the same rules (PLAN.md "Hard-reject schedule/record requests").
// Returns a rejection reason string, or null if the window is clear.
export function checkHardReject(
  provider: typeof providers.$inferSelect,
  startTime: Date,
  endTime: Date,
): string | null {
  if (!provider.enabled) {
    return "provider is disabled";
  }

  // Only recordings whose window overlaps the requested one can affect its
  // peak concurrency — recordings outside that window are irrelevant.
  const overlapping = db
    .select({ startTime: recordings.startTime, endTime: recordings.endTime })
    .from(recordings)
    .where(
      and(
        eq(recordings.providerId, provider.id),
        inArray(recordings.status, ACTIVE_STATUSES),
        lt(recordings.startTime, endTime),
        gt(recordings.endTime, startTime),
      ),
    )
    .all();

  const peak = maxConcurrentOverlap([
    ...overlapping.map((r) => ({ start: r.startTime.getTime(), end: r.endTime.getTime() })),
    { start: startTime.getTime(), end: endTime.getTime() },
  ]);
  if (peak > provider.maxConcurrentStreams) {
    return "would exceed provider's max concurrent streams";
  }

  return null;
}
