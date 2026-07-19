import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers } from "../db/schema.js";
import { encrypt } from "../crypto.js";
import { requireApiKey } from "../auth.js";

const createBodySchema = {
  type: "object",
  required: ["name", "baseUrl", "username", "password", "maxConcurrentStreams"],
  properties: {
    name: { type: "string", minLength: 1 },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    maxConcurrentStreams: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const updateBodySchema = {
  type: "object",
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1 },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    maxConcurrentStreams: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  name: string;
  baseUrl: string;
  username: string;
  password: string;
  maxConcurrentStreams: number;
  enabled?: boolean;
};

type UpdateBody = Partial<CreateBody>;

// Credentials never leave this module in plaintext or ciphertext form —
// every response is redacted down to what a client is allowed to see.
function redact(provider: typeof providers.$inferSelect) {
  const { usernameEncrypted, passwordEncrypted, ...rest } = provider;
  return rest;
}

export async function providerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/providers",
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body;
      const [created] = db
        .insert(providers)
        .values({
          name: body.name,
          baseUrl: body.baseUrl,
          usernameEncrypted: encrypt(body.username),
          passwordEncrypted: encrypt(body.password),
          maxConcurrentStreams: body.maxConcurrentStreams,
          enabled: body.enabled ?? true,
        })
        .returning()
        .all();
      reply.code(201);
      return redact(created);
    },
  );

  app.get("/providers", async () => {
    return db.select().from(providers).all().map(redact);
  });

  app.get<{ Params: { id: string } }>("/providers/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [row] = db.select().from(providers).where(eq(providers.id, id)).all();
    if (!row) {
      return reply.code(404).send({ error: "provider not found" });
    }
    return redact(row);
  });

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    "/providers/:id",
    { schema: { body: updateBodySchema } },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "provider not found" });
      }

      const body = request.body;
      const updates: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
      if (body.username !== undefined) updates.usernameEncrypted = encrypt(body.username);
      if (body.password !== undefined) updates.passwordEncrypted = encrypt(body.password);
      if (body.maxConcurrentStreams !== undefined) {
        updates.maxConcurrentStreams = body.maxConcurrentStreams;
      }
      if (body.enabled !== undefined) updates.enabled = body.enabled;

      const [updated] = db
        .update(providers)
        .set(updates)
        .where(eq(providers.id, id))
        .returning()
        .all();
      return redact(updated);
    },
  );

  app.delete<{ Params: { id: string } }>("/providers/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const [existing] = db.select().from(providers).where(eq(providers.id, id)).all();
    if (!existing) {
      return reply.code(404).send({ error: "provider not found" });
    }
    // No recordings table yet to cascade against (PLAN.md "Provider delete
    // cascade" is still open) — plain delete is the whole story for now.
    db.delete(providers).where(eq(providers.id, id)).run();
    reply.code(204);
  });
}
