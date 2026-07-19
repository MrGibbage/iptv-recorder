import type { FastifyInstance } from "fastify";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { requireApiKey } from "../auth.js";

const createBodySchema = {
  type: "object",
  required: ["providerId", "channelId", "startTime", "endTime"],
  properties: {
    providerId: { type: "integer" },
    channelId: { type: "string", minLength: 1 },
    startTime: { type: "string", minLength: 1 },
    endTime: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  providerId: number;
  channelId: string;
  startTime: string;
  endTime: string;
};

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

// One-off recordings only for now. Recurring-pattern creation needs a
// next-occurrence calculator and horizon-based materialization (the
// scheduler engine, not built yet) and is a deliberate follow-up rather than
// part of this endpoint (see PLAN.md "Recurring occurrence materialization").
export async function recordingRoutes(app: FastifyInstance) {
  // onRequest, not preHandler: Fastify validates the body schema before
  // preHandler runs, so an unauthenticated request with a malformed body
  // would otherwise get a 400 instead of a 401.
  app.addHook("onRequest", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/recordings",
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body;

      const startTime = new Date(body.startTime);
      const endTime = new Date(body.endTime);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        return reply.code(400).send({ error: "startTime/endTime must be valid dates" });
      }
      if (endTime <= startTime) {
        return reply.code(400).send({ error: "endTime must be after startTime" });
      }

      const [provider] = db.select().from(providers).where(eq(providers.id, body.providerId)).all();
      if (!provider) {
        return reply.code(404).send({ error: "provider not found" });
      }
      // PLAN.md "disabled provider" hard-reject rule.
      if (!provider.enabled) {
        return reply.code(409).send({ error: "provider is disabled" });
      }

      // Only recordings whose window overlaps the requested one can affect
      // its peak concurrency — recordings outside that window are irrelevant.
      const overlapping = db
        .select({ startTime: recordings.startTime, endTime: recordings.endTime })
        .from(recordings)
        .where(
          and(
            eq(recordings.providerId, body.providerId),
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
      // PLAN.md "concurrent stream limit" hard-reject rule.
      if (peak > provider.maxConcurrentStreams) {
        return reply.code(409).send({ error: "would exceed provider's max concurrent streams" });
      }

      const [created] = db
        .insert(recordings)
        .values({
          providerId: body.providerId,
          channelId: body.channelId,
          startTime,
          endTime,
        })
        .returning()
        .all();
      reply.code(201);
      return created;
    },
  );
}
