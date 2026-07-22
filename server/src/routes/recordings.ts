import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { and, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings, recurringRules, recurringRuleSkips } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { checkHardReject } from "../hardReject.js";
import { cancelActiveWorker, deleteRecordingFile } from "../worker/dispatch.js";
import { parseRange } from "../httpRange.js";
import { occurrenceWindowForDay } from "../scheduler/occurrence.js";
import { projectOccurrences } from "../scheduler/projection.js";

const RECORDING_STATUSES = ["scheduled", "recording", "completed", "failed", "cancelled"] as const;
type RecordingStatus = (typeof RECORDING_STATUSES)[number];

// GET /recordings/:id/file's Content-Type, keyed by the recorded file's
// extension rather than hardcoded to one format — the worker has written
// MPEG-TS (.ts) since 2026-07-20 (see ffmpegRemux.ts), but recordings made
// before that switch are still fragmented MP4 (.mp4) and remain on disk
// until retention clears them, so both must keep working.
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".ts": "video/mp2t",
  ".mp4": "video/mp4",
};
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const recurrenceSchema = {
  type: "object",
  required: ["daysOfWeek", "startMinuteOfDay", "durationMinutes"],
  properties: {
    // Bitmask, bit 0 = Monday .. bit 6 = Sunday (recurring_rules.daysOfWeek).
    // Both daysOfWeek and startMinuteOfDay are in UTC — the server has no
    // per-rule timezone field (single-instance, single-timezone deployment,
    // pinned to TZ=UTC), so a client must convert from the user's local
    // time itself before sending this.
    daysOfWeek: { type: "integer", minimum: 1, maximum: 127 },
    startMinuteOfDay: { type: "integer", minimum: 0, maximum: 1439, description: "Minutes since midnight, UTC." },
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
    includeProjected: { type: "boolean" },
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
  includeProjected?: boolean;
};

const recurringListQuerySchema = {
  type: "object",
  properties: {
    providerId: { type: "integer" },
    cancelled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type RecurringListQuery = {
  providerId?: number;
  cancelled?: boolean;
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

const recordingSchema = {
  $id: "Recording",
  type: "object",
  properties: {
    id: { type: "integer" },
    providerId: { type: "integer" },
    channelId: { type: "string" },
    recurringRuleId: { type: "integer", nullable: true, description: "Null for a one-off recording; set for a materialized recurring occurrence." },
    startTime: { type: "string", format: "date-time" },
    endTime: { type: "string", format: "date-time" },
    status: { type: "string", enum: RECORDING_STATUSES },
    filePath: { type: "string", nullable: true, description: "Set once the worker finishes writing the file; cleared again by retention." },
    failureReason: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    projected: {
      type: "boolean",
      description: "Only present when the request set includeProjected=true — false for every real, materialized row returned alongside projected ones.",
    },
  },
  required: ["id", "providerId", "channelId", "recurringRuleId", "startTime", "endTime", "status", "filePath", "failureReason", "createdAt", "updatedAt"],
} as const;

// GET /recordings?includeProjected=true — a computed-but-not-yet-
// materialized future occurrence of a recurring rule (see
// ../scheduler/projection.ts). Never a standalone resource — always an
// element of that endpoint's response array alongside real Recording rows.
const projectedOccurrenceSchema = {
  $id: "ProjectedOccurrence",
  type: "object",
  properties: {
    recurringRuleId: { type: "integer" },
    providerId: { type: "integer" },
    channelId: { type: "string" },
    startTime: { type: "string", format: "date-time" },
    endTime: { type: "string", format: "date-time" },
    status: { type: "string", const: "scheduled" },
    projected: { type: "boolean", const: true },
  },
  required: ["recurringRuleId", "providerId", "channelId", "startTime", "endTime", "status", "projected"],
} as const;

const recurringRuleSchema = {
  $id: "RecurringRule",
  type: "object",
  properties: {
    id: { type: "integer" },
    providerId: { type: "integer" },
    channelId: { type: "string" },
    daysOfWeek: { type: "integer", description: "Bitmask: bit 0 = Monday .. bit 6 = Sunday." },
    startMinuteOfDay: { type: "integer", description: "Minutes since midnight, UTC (server is pinned to TZ=UTC; see index.ts's boot-time check)." },
    durationMinutes: { type: "integer" },
    endDate: { type: "string", nullable: true, format: "date-time" },
    maxOccurrences: { type: "integer", nullable: true },
    cancelledAt: { type: "string", nullable: true, format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "providerId", "channelId", "daysOfWeek", "startMinuteOfDay", "durationMinutes", "endDate", "maxOccurrences", "cancelledAt", "createdAt", "updatedAt"],
} as const;

// DELETE /recordings/recurring/{ruleId} — the cancelled rule plus how many
// not-yet-started materialized occurrences it took down with it. Inlined
// rather than composed with RecurringRule via allOf, to keep every
// response schema in this file resolvable the same simple way.
const recurringRuleCancelResultSchema = {
  $id: "RecurringRuleCancelResult",
  type: "object",
  properties: {
    id: { type: "integer" },
    providerId: { type: "integer" },
    channelId: { type: "string" },
    daysOfWeek: { type: "integer" },
    startMinuteOfDay: { type: "integer", description: "Minutes since midnight, UTC." },
    durationMinutes: { type: "integer" },
    endDate: { type: "string", nullable: true, format: "date-time" },
    maxOccurrences: { type: "integer", nullable: true },
    cancelledAt: { type: "string", nullable: true, format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    cancelledRecordings: { type: "integer", description: "Count of scheduled (not yet started) occurrences cancelled along with the rule." },
  },
  required: [
    "id", "providerId", "channelId", "daysOfWeek", "startMinuteOfDay", "durationMinutes",
    "endDate", "maxOccurrences", "cancelledAt", "createdAt", "updatedAt", "cancelledRecordings",
  ],
} as const;

// POST /recordings/recurring/{ruleId}/skip — the EXDATE-equivalent
// exception row, only ever created when the target date hasn't already
// materialized into a Recording (see the route itself).
const skipExceptionSchema = {
  $id: "SkipException",
  type: "object",
  properties: {
    id: { type: "integer" },
    ruleId: { type: "integer" },
    occurrenceDate: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "ruleId", "occurrenceDate", "createdAt"],
} as const;

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
  app.addSchema(recordingSchema);
  app.addSchema(projectedOccurrenceSchema);
  app.addSchema(recurringRuleSchema);
  app.addSchema(recurringRuleCancelResultSchema);
  app.addSchema(skipExceptionSchema);

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
    {
      schema: {
        tags: ["recordings"],
        summary: "Schedule a recording",
        description: "Exactly one of startTime/endTime (one-off) or recurrence (recurring) must be given.",
        body: createBodySchema,
        response: {
          201: { oneOf: [{ $ref: "Recording#" }, { $ref: "RecurringRule#" }] },
          400: { $ref: "Error#" },
          404: { $ref: "Error#" },
          409: { $ref: "Error#" },
        },
      },
    },
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
        // per-occurrence concurrent-stream/storage/same-channel-conflict
        // checks (checkHardReject) already run again at materialization
        // time for each occurrence via the scheduler tick, since those
        // depend on conditions at the time an occurrence actually fires,
        // not at rule-creation time.
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

      const rejection = checkHardReject(provider, startTime, endTime, body.channelId);
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

  app.get<{ Querystring: ListQuery }>(
    "/recordings",
    {
      schema: {
        tags: ["recordings"],
        summary: "List/filter recordings",
        querystring: listQuerySchema,
        response: {
          200: { type: "array", items: { oneOf: [{ $ref: "Recording#" }, { $ref: "ProjectedOccurrence#" }] } },
          400: { $ref: "Error#" },
        },
      },
    },
    async (request, reply) => {
      const q = request.query;
      const conditions = [];

      if (q.providerId !== undefined) conditions.push(eq(recordings.providerId, q.providerId));
      if (q.channelId !== undefined) conditions.push(eq(recordings.channelId, q.channelId));
      if (q.status !== undefined) conditions.push(eq(recordings.status, q.status));
      if (q.recurringRuleId !== undefined) conditions.push(eq(recordings.recurringRuleId, q.recurringRuleId));

      let startAfter: Date | undefined;
      if (q.startAfter !== undefined) {
        startAfter = new Date(q.startAfter);
        if (Number.isNaN(startAfter.getTime())) {
          return reply.code(400).send({ error: "startAfter must be a valid date" });
        }
        conditions.push(gte(recordings.startTime, startAfter));
      }
      let startBefore: Date | undefined;
      if (q.startBefore !== undefined) {
        startBefore = new Date(q.startBefore);
        if (Number.isNaN(startBefore.getTime())) {
          return reply.code(400).send({ error: "startBefore must be a valid date" });
        }
        conditions.push(lte(recordings.startTime, startBefore));
      }

      const rows = conditions.length > 0
        ? db.select().from(recordings).where(and(...conditions)).all()
        : db.select().from(recordings).all();

      if (!q.includeProjected) {
        return rows;
      }

      // Projected occurrences (PLAN.md "include_projected ... clearly
      // distinguished from materialized ones") are always hypothetically
      // "scheduled" — nothing else to project, no such thing as a projected
      // completed/failed/cancelled occurrence — so a status filter for
      // anything else means there's nothing to add.
      type ProjectedRow = ReturnType<typeof projectOccurrences>[number] & { status: "scheduled"; projected: true };
      type MaterializedRow = (typeof rows)[number] & { projected: false };
      const projected: ProjectedRow[] = [];

      if (q.status === undefined || q.status === "scheduled") {
        const ruleConditions = [isNull(recurringRules.cancelledAt)];
        if (q.providerId !== undefined) ruleConditions.push(eq(recurringRules.providerId, q.providerId));
        if (q.recurringRuleId !== undefined) ruleConditions.push(eq(recurringRules.id, q.recurringRuleId));

        const now = new Date();
        const rules = db.select().from(recurringRules).where(and(...ruleConditions)).all();
        for (const rule of rules) {
          if (q.channelId !== undefined && rule.channelId !== q.channelId) continue;

          for (const occurrence of projectOccurrences(rule, now)) {
            if (startAfter !== undefined && occurrence.startTime < startAfter) continue;
            if (startBefore !== undefined && occurrence.startTime > startBefore) continue;
            projected.push({ ...occurrence, status: "scheduled", projected: true });
          }
        }
      }

      const combined: (MaterializedRow | ProjectedRow)[] = [
        ...rows.map((r): MaterializedRow => ({ ...r, projected: false })),
        ...projected,
      ];
      combined.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      return combined;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/recordings/:id",
    {
      schema: {
        tags: ["recordings"],
        summary: "Get a recording",
        response: { 200: { $ref: "Recording#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [row] = db.select().from(recordings).where(eq(recordings.id, id)).all();
      if (!row) {
        return reply.code(404).send({ error: "recording not found" });
      }
      return row;
    },
  );

  // Two different operations behind one verb, split by status: an active
  // (scheduled/recording) occurrence gets the soft-cancel (status=
  // 'cancelled', row kept — consistent with PLAN.md's flat resource model,
  // same as cancelRecordingRow's other caller below). A terminal one
  // (completed/failed/cancelled) has nothing left to "cancel", so this
  // hard-deletes it instead — row and file (if any) — since without this
  // a failed recording had no way to ever be removed (retention's TTL
  // sweep only ever looks at 'completed' rows, see ../retention/sweep.ts).
  app.delete<{ Params: { id: string } }>(
    "/recordings/:id",
    {
      schema: {
        tags: ["recordings"],
        summary: "Cancel or delete a recording",
        description: "Cancels an in-progress/scheduled recording (soft, row kept), or hard-deletes a completed/failed/cancelled one (row and file, if any).",
        // No 204 entry: it has no body, same reasoning as DELETE
        // /providers/{id} in ./providers.ts.
        response: { 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(recordings).where(eq(recordings.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "recording not found" });
      }
      if (existing.status === "scheduled" || existing.status === "recording") {
        cancelRecordingRow(existing);
        return reply.code(204).send();
      }
      if (existing.filePath) {
        deleteRecordingFile(existing.filePath);
      }
      db.delete(recordings).where(eq(recordings.id, id)).run();
      reply.code(204).send();
    },
  );

  // Not in PLAN.md's original endpoint list — the flat resource model never
  // called for a way to enumerate recurring_rules directly, but a UI (or
  // any client) that wants to manage rules has to be able to see them
  // first. Filters mirror what the skip/cancel-rule endpoints need to look
  // rules up by.
  app.get<{ Querystring: RecurringListQuery }>(
    "/recordings/recurring",
    {
      schema: {
        tags: ["recurring-rules"],
        summary: "List recurring rules",
        querystring: recurringListQuerySchema,
        response: { 200: { type: "array", items: { $ref: "RecurringRule#" } } },
      },
    },
    async (request) => {
      const q = request.query;
      const conditions = [];
      if (q.providerId !== undefined) conditions.push(eq(recurringRules.providerId, q.providerId));
      if (q.cancelled !== undefined) {
        conditions.push(q.cancelled ? isNotNull(recurringRules.cancelledAt) : isNull(recurringRules.cancelledAt));
      }
      return conditions.length > 0
        ? db
            .select()
            .from(recurringRules)
            .where(and(...conditions))
            .all()
        : db.select().from(recurringRules).all();
    },
  );

  app.get<{ Params: { ruleId: string } }>(
    "/recordings/recurring/:ruleId",
    {
      schema: {
        tags: ["recurring-rules"],
        summary: "Get a recurring rule",
        response: { 200: { $ref: "RecurringRule#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const ruleId = Number(request.params.ruleId);
      const [rule] = db.select().from(recurringRules).where(eq(recurringRules.id, ruleId)).all();
      if (!rule) {
        return reply.code(404).send({ error: "recurring rule not found" });
      }
      return rule;
    },
  );

  // Skip a single occurrence by date, materialized or not (PLAN.md
  // "mirrors the iCalendar RRULE+EXDATE pattern"): cancels the recordings
  // row if that date has already been materialized, otherwise records a
  // skip exception so the scheduler tick never materializes it. Idempotent
  // — skipping an already-skipped date just returns the existing exception.
  app.post<{ Params: { ruleId: string }; Body: SkipBody }>(
    "/recordings/recurring/:ruleId/skip",
    {
      schema: {
        tags: ["recurring-rules"],
        summary: "Skip a single occurrence",
        description: "Cancels the materialized row if that date already exists, otherwise records a skip exception. Idempotent.",
        body: skipBodySchema,
        response: {
          200: { oneOf: [{ $ref: "Recording#" }, { $ref: "SkipException#" }] },
          201: { $ref: "SkipException#" },
          400: { $ref: "Error#" },
          404: { $ref: "Error#" },
          409: { $ref: "Error#" },
        },
      },
    },
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
  app.delete<{ Params: { ruleId: string } }>(
    "/recordings/recurring/:ruleId",
    {
      schema: {
        tags: ["recurring-rules"],
        summary: "Cancel a recurring rule",
        description: "Stops future generation and cancels any not-yet-started materialized occurrence. An in-progress occurrence is left to finish.",
        response: { 200: { $ref: "RecurringRuleCancelResult#" }, 404: { $ref: "Error#" }, 409: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
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
    },
  );

  // Range support (206 partial content) so video players can seek without
  // downloading from the start each time — see PLAN.md "Serve recorded
  // files back to clients for playback."
  app.get<{ Params: { id: string } }>(
    "/recordings/:id/file",
    {
      schema: {
        tags: ["recordings"],
        summary: "Download the recorded file",
        description: "Supports HTTP Range requests (single range only) for seeking. No 200/206 schema declared here — the body is a raw video stream (Content-Type varies by recorded format, see CONTENT_TYPE_BY_EXTENSION), not JSON.",
        // No 200/206/416 entries: 200/206 are a raw video stream, not JSON,
        // and 416 (like the 204s elsewhere in this file) has no body.
        response: { 404: { $ref: "Error#" }, 409: { $ref: "Error#" }, 410: { $ref: "Error#" }, 500: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
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
      reply.header("Content-Type", CONTENT_TYPE_BY_EXTENSION[extname(recording.filePath)] ?? DEFAULT_CONTENT_TYPE);

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
    },
  );
}
