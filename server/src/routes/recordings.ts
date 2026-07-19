import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, statSync } from "node:fs";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { checkHardReject } from "../hardReject.js";
import { cancelActiveWorker } from "../worker/dispatch.js";
import { parseRange } from "../httpRange.js";

const RECORDING_STATUSES = ["scheduled", "recording", "completed", "failed", "cancelled"] as const;
type RecordingStatus = (typeof RECORDING_STATUSES)[number];

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
    if (existing.status !== "scheduled" && existing.status !== "recording") {
      return reply.code(409).send({ error: "recording already finished" });
    }

    // Set status before touching the worker: cancelActiveWorker's process
    // 'close' handler checks a flag it sets itself, not this row, so there's
    // no race between this write and that handler either way.
    db.update(recordings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(recordings.id, id))
      .run();

    if (existing.status === "recording") {
      cancelActiveWorker(id);
    }

    reply.code(204);
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
    if (recording.status !== "completed" || !recording.filePath) {
      return reply.code(409).send({ error: "recording is not completed" });
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
