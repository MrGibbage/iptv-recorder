import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { checkHardReject } from "../hardReject.js";

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
}
