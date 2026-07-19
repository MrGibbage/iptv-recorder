import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { clients } from "../db/schema.js";
import { requireApiKey } from "../auth.js";

const createBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  name: string;
};

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// The raw key only ever exists at issuance time — every other response is
// redacted down to what's safe to hand back (never the hash, which is
// still sensitive as a bearer-equivalent lookup value, and never a key
// that's already been shown once).
function redact(client: typeof clients.$inferSelect) {
  const { apiKeyHash, ...rest } = client;
  return rest;
}

// PLAN.md "Clients / API keys" — admin-initiated issuance only, no
// self-registration. This endpoint itself requires a valid API key, so the
// very first client still has to come from src/db/seed-client.ts (CLI) to
// break the chicken-and-egg problem; every client after that can be issued
// by any existing one.
//
// Rotation flow (PLAN.md Open Questions, "API key rotation"): decided as
// revoke + reissue, not in-place refresh — DELETE /clients/{id} to revoke
// the old key, POST /clients for a new one. No separate rotate endpoint;
// the two primitives already cover it without adding a third.
export async function clientRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/clients",
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const apiKey = crypto.randomBytes(32).toString("base64url");
      const [created] = db
        .insert(clients)
        .values({ name: request.body.name, apiKeyHash: hashKey(apiKey) })
        .returning()
        .all();
      reply.code(201);
      // apiKey is shown exactly once, in this response — it is never
      // recoverable afterward, only the hash is stored.
      return { ...redact(created), apiKey };
    },
  );

  app.get("/clients", async () => {
    return db.select().from(clients).all().map(redact);
  });

  app.delete<{ Params: { id: string } }>("/clients/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [existing] = db.select().from(clients).where(eq(clients.id, id)).all();
    if (!existing) {
      return reply.code(404).send({ error: "client not found" });
    }
    if (existing.revokedAt) {
      return reply.code(409).send({ error: "client already revoked" });
    }

    const [updated] = db
      .update(clients)
      .set({ revokedAt: new Date() })
      .where(eq(clients.id, id))
      .returning()
      .all();
    return redact(updated);
  });
}
