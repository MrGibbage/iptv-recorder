import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings, recurringRules, recurringRuleSkips } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { checkHardReject } from "../hardReject.js";
import { cancelActiveWorker } from "../worker/dispatch.js";
import { parseRange } from "../httpRange.js";
import { occurrenceWindowForDay } from "../scheduler/occurrence.js";

const RECORDING_STATUSES = ["scheduled", "recording", "completed", "failed", "cancelled"] as const;
type RecordingStatus = (typeof RECORDING_STATUSES)[number];

const recurrenceSchema = {
  type: "object",
  required: ["daysOfWeek", "startMinuteOfDay", "durationMinutes"],
  properties: {
    // Bitmask, bit 0 = Monday .. bit 6 = Sunday (recurring_rules.daysOfWeek).
    daysOfWeek: { type: "integer", minimum: 1, maximum: 127 },
    startMinuteOfDay: { type: "integer", minimum: 0, maximum: 1439 },
    durationMinutes: { type: "integer", minimum: 1 },
    endDate: { type: "string", minLength: 1 },
    maxOccurrences: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

const createBodySchema = {
  type: "object",
  required: ["providerId", "channelId"],
  properties: {
    providerId: { type: "integer" },
    channelId: { type: "string", minLength: 1 },
    startTime: { type: "string", minLength: 1 },
    endTime: { type: "string", minLength: 1 },
    recurrence: recurrenceSchema,
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  providerId: number;
  channelId: string;
  startTime?: string;
  endTime?: string;
  recurrence?: {
    daysOfWeek: number;
    startMinuteOfDay: number;
    durationMinutes: number;
    endDate?: string;
    maxOccurrences?: number;
  };
};

const listQuerySchema = {
  type: "object",
  properties: {
    providerId: { type: "integer" },
    channelId: { type: "string" },
    status: { type: "string", enum: RECORDING_STATUSES },
    startAfter: { type: "string" },
    startBefore: { type: "string" },
    recurringRuleId: { type: "integer" },
  },
  additionalProperties: false,
} as const;

type ListQuery = {
  providerId?: number;
  channelId?: string;
  status?: RecordingStatus;
  startAfter?: string;
  startBefore?: string;
  recurringRuleId?: number;
};

const skipBodySchema = {
  type: "object",
  required: ["date"],
  properties: {
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
  additionalProperties: false,
} as const;

type SkipBody = { date: string };

// Shared by DELETE /recordings/{id} and the skip endpoint below — both
// "cancel this specific occurrence" operations need the same race-safe
// handling of an actively-recording row (see cancelActiveWorker in
// ../worker/dispatch.ts). Returns null if the row isn't in a cancellable
// state (already terminal), otherwise the updated row.
function cancelRecordingRow(
  recording: typeof recordings.$inferSelect,
): typeof recordings.$inferSelect | null {
  if (recording.status !== "scheduled" && recording.status !== "recording") {
    return null;
  }

  const [updated] = db
    .update(recordings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(recordings.id, recording.id))
    .returning()
    .all();

  if (recording.status === "recording") {
    cancelActiveWorker(recording.id);
  }

  return updated;
}

export async function recordingRoutes(app: FastifyInstance) {
  // onRequest, not preHandler: Fastify validates the body schema before
  // preHandler runs, so an unauthenticated request with a malformed body
  // would otherwise get a 400 instead of a 401.
  app.addHook("onRequest", requireApiKey);

  // Accepts either a one-off time range (startTime/endTime) or a recurrence
  // pattern — mutually exclusive, exactly one required (PLAN.md "Resource
  // model: flat" / "POST /recordings accepts an optional recurrence
  // pattern"). A recurring request creates a recurring_rules row, not a
  // recordings row: the scheduler tick (server/src/scheduler/) materializes
  // its actual occurrences once each is within the materialization horizon,
  // same as any other rule — this endpoint doesn't pre-materialize a first
  // occurrence itself, to keep "when does an occurrence get created" logic
  // in exactly one place.
  app.post<{ Body: CreateBody }>(
    "/recordings",
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const hasOneOff = body.startTime !== undefined || body.endTime !== undefined;
      const hasRecurrence = body.recurrence !== undefined;

      if (hasOneOff && hasRecurrence) {
        return reply.code(400).send({ error: "specify either startTime/endTime or recurrence, not both" });
      }
      if (!hasOneOff && !hasRecurrence) {
        return reply.code(400).send({ error: "must specify either startTime/endTime or a recurrence pattern" });
      }

      const [provider] = db.select().from(providers).where(eq(providers.id, body.providerId)).all();
      if (!provider) {
        return reply.code(404).send({ error: "provider not found" });
      }

      if (hasRecurrence) {
        const recurrence = body.recurrence!;

        // Only what's checkable without a concrete time window — the
        // per-occurrence concurrent-stream/storage checks (checkHardReject)
        // already run again at materialization time for each occurrence via
        // the scheduler tick, since those depend on conditions at the time
        // an occurrence actually fires, not at rule-creation time.
        if (!provider.enabled) {
          return reply.code(409).send({ error: "provider is disabled" });
        }

        let endDate: Date | undefined;
        if (recurrence.endDate !== undefined) {
          endDate = new Date(recurrence.endDate);
          if (Number.isNaN(endDate.getTime())) {
            return reply.code(400).send({ error: "recurrence.endDate must be a valid date" });
          }
        }

        const [createdRule] = db
          .insert(recurringRules)
          .values({
            providerId: body.providerId,
            channelId: body.channelId,
            daysOfWeek: recurrence.daysOfWeek,
            startMinuteOfDay: recurrence.startMinuteOfDay,
            durationMinutes: recurrence.durationMinutes,
            endDate,
            maxOccurrences: recurrence.maxOccurrences,
          })
          .returning()
          .all();
        reply.code(201);
        return createdRule;
      }

      if (body.startTime === undefined || body.endTime === undefined) {
        return reply.code(400).send({ error: "both startTime and endTime are required for a one-off recording" });
      }
      const startTime = new Date(body.startTime);
      const endTime = new Date(body.endTime);
      if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
        return reply.code(400).send({ error: "startTime/endTime must be valid dates" });
      }
      if (endTime <= startTime) {
        return reply.code(400).send({ error: "endTime must be after startTime" });
      }

      const rejection = checkHardReject(provider, startTime, endTime);
      if (rejection) {
        return reply.code(409).send({ error: rejection });
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

  // include_projected (computed-but-not-yet-materialized future occurrences
  // of recurring rules) is deferred — it needs its own multi-day projection
  // logic distinct from the scheduler's "is today due" check. This only
  // lists rows that already exist.
  app.get<{ Querystring: ListQuery }>(
    "/recordings",
    { schema: { querystring: listQuerySchema } },
    async (request, reply) => {
      const q = request.query;
      const conditions = [];

      if (q.providerId !== undefined) conditions.push(eq(recordings.providerId, q.providerId));
      if (q.channelId !== undefined) conditions.push(eq(recordings.channelId, q.channelId));
      if (q.status !== undefined) conditions.push(eq(recordings.status, q.status));
      if (q.recurringRuleId !== undefined) conditions.push(eq(recordings.recurringRuleId, q.recurringRuleId));

      if (q.startAfter !== undefined) {
        const d = new Date(q.startAfter);
        if (Number.isNaN(d.getTime())) {
          return reply.code(400).send({ error: "startAfter must be a valid date" });
        }
        conditions.push(gte(recordings.startTime, d));
      }
      if (q.startBefore !== undefined) {
        const d = new Date(q.startBefore);
        if (Number.isNaN(d.getTime())) {
          return reply.code(400).send({ error: "startBefore must be a valid date" });
        }
        conditions.push(lte(recordings.startTime, d));
      }

      return conditions.length > 0
        ? db
            .select()
            .from(recordings)
            .where(and(...conditions))
            .all()
        : db.select().from(recordings).all();
    },
  );

  app.get<{ Params: { id: string } }>("/recordings/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [row] = db.select().from(recordings).where(eq(recordings.id, id)).all();
    if (!row) {
      return reply.code(404).send({ error: "recording not found" });
    }
    return row;
  });

  // Soft-cancel (status='cancelled'), not a row delete — a cancelled
  // occurrence stays visible in history/list queries like any other
  // terminal status, consistent with PLAN.md's flat resource model.
  app.delete<{ Params: { id: string } }>("/recordings/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [existing] = db.select().from(recordings).where(eq(recordings.id, id)).all();
    if (!existing) {
      return reply.code(404).send({ error: "recording not found" });
    }
    if (!cancelRecordingRow(existing)) {
      return reply.code(409).send({ error: "recording already finished" });
    }
    reply.code(204);
  });

  // Skip a single occurrence by date, materialized or not (PLAN.md
  // "mirrors the iCalendar RRULE+EXDATE pattern"): cancels the recordings
  // row if that date has already been materialized, otherwise records a
  // skip exception so the scheduler tick never materializes it. Idempotent
  // — skipping an already-skipped date just returns the existing exception.
  app.post<{ Params: { ruleId: string }; Body: SkipBody }>(
    "/recordings/recurring/:ruleId/skip",
    { schema: { body: skipBodySchema } },
    async (request, reply) => {
      const ruleId = Number(request.params.ruleId);
      const [rule] = db.select().from(recurringRules).where(eq(recurringRules.id, ruleId)).all();
      if (!rule) {
        return reply.code(404).send({ error: "recurring rule not found" });
      }
      if (rule.cancelledAt) {
        return reply.code(409).send({ error: "recurring rule is cancelled" });
      }

      const day = new Date(`${request.body.date}T00:00:00`);
      // Date silently rolls invalid components over into a valid date
      // (e.g. "2026-02-30" becomes March 2) rather than rejecting them —
      // reconstructing and comparing catches that instead of just NaN.
      const reconstructed = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      if (Number.isNaN(day.getTime()) || reconstructed !== request.body.date) {
        return reply.code(400).send({ error: "date must be a valid calendar date" });
      }

      const { start } = occurrenceWindowForDay(rule, day);

      const [existingRecording] = db
        .select()
        .from(recordings)
        .where(and(eq(recordings.recurringRuleId, ruleId), eq(recordings.startTime, start)))
        .all();

      if (existingRecording) {
        const cancelled = cancelRecordingRow(existingRecording);
        if (!cancelled) {
          return reply.code(409).send({ error: "occurrence already finished" });
        }
        return cancelled;
      }

      const [createdSkip] = db
        .insert(recurringRuleSkips)
        .values({ ruleId, occurrenceDate: request.body.date })
        .onConflictDoNothing()
        .returning()
        .all();
      if (createdSkip) {
        reply.code(201);
        return createdSkip;
      }

      // Already skipped — idempotent, return the existing exception.
      const [existingSkip] = db
        .select()
        .from(recurringRuleSkips)
        .where(and(eq(recurringRuleSkips.ruleId, ruleId), eq(recurringRuleSkips.occurrenceDate, request.body.date)))
        .all();
      return existingSkip;
    },
  );

  // Cancels the whole rule going forward. Stops both future generation and
  // any not-yet-started materialized occurrence (PLAN.md: "stops generating
  // future occurrences, materialized or projected"). Deliberately leaves an
  // already-`recording` occurrence to finish — cancelling future episodes of
  // a season pass isn't the same request as stopping tonight's in-progress
  // one, and PLAN.md's wording is about *future* occurrences.
  app.delete<{ Params: { ruleId: string } }>("/recordings/recurring/:ruleId", async (request, reply) => {
    const ruleId = Number(request.params.ruleId);
    const [rule] = db.select().from(recurringRules).where(eq(recurringRules.id, ruleId)).all();
    if (!rule) {
      return reply.code(404).send({ error: "recurring rule not found" });
    }
    if (rule.cancelledAt) {
      return reply.code(409).send({ error: "recurring rule already cancelled" });
    }

    const [updatedRule] = db
      .update(recurringRules)
      .set({ cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(recurringRules.id, ruleId))
      .returning()
      .all();

    const futureScheduled = db
      .select()
      .from(recordings)
      .where(and(eq(recordings.recurringRuleId, ruleId), eq(recordings.status, "scheduled")))
      .all();
    for (const recording of futureScheduled) {
      db.update(recordings).set({ status: "cancelled", updatedAt: new Date() }).where(eq(recordings.id, recording.id)).run();
    }

    return { ...updatedRule, cancelledRecordings: futureScheduled.length };
  });

  // Range support (206 partial content) so video players can seek without
  // downloading from the start each time — see PLAN.md "Serve recorded
  // files back to clients for playback."
  app.get<{ Params: { id: string } }>("/recordings/:id/file", async (request, reply) => {
    const id = Number(request.params.id);
    const [recording] = db.select().from(recordings).where(eq(recordings.id, id)).all();
    if (!recording) {
      return reply.code(404).send({ error: "recording not found" });
    }
    if (recording.status !== "completed") {
      return reply.code(409).send({ error: "recording is not completed" });
    }
    if (!recording.filePath) {
      // Distinct from the 500 below: this is retention having done its job
      // (see ../retention/sweep.ts), not an unexpected anomaly.
      return reply.code(410).send({ error: "recording file has been removed by retention" });
    }
    if (!existsSync(recording.filePath)) {
      return reply.code(500).send({ error: "recording file is missing on disk" });
    }

    const { size } = statSync(recording.filePath);
    const range = parseRange(request.headers.range, size);

    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "video/mp4");

    if (range === "unsatisfiable") {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.code(416).send();
    }

    if (range === null) {
      reply.header("Content-Length", size);
      return reply.send(createReadStream(recording.filePath));
    }

    reply.code(206);
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    reply.header("Content-Length", range.end - range.start + 1);
    return reply.send(createReadStream(recording.filePath, { start: range.start, end: range.end }));
  });
}
