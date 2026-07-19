import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { encrypt } from "../crypto.js";
import { requireApiKey } from "../auth.js";
import { checkProviderAuth } from "../worker/xtreamAuth.js";

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
  // onRequest, not preHandler: Fastify validates the body schema before
  // preHandler runs, so an unauthenticated request with a malformed body
  // would otherwise get a 400 instead of a 401.
  app.addHook("onRequest", requireApiKey);

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

  // PLAN.md "GET /providers/{id}/status" — deferred at scaffolding time
  // pending a recordings table and an Xtream HTTP client; both now exist.
  // activeStreams counts rows currently mid-recording, not the sweep-line
  // peak-overlap math in ../hardReject.ts (that's about a *hypothetical*
  // future window at request time; this is "what's happening right now").
  app.get<{ Params: { id: string } }>("/providers/:id/status", async (request, reply) => {
    const id = Number(request.params.id);
    const [provider] = db.select().from(providers).where(eq(providers.id, id)).all();
    if (!provider) {
      return reply.code(404).send({ error: "provider not found" });
    }

    const activeStreams = db
      .select()
      .from(recordings)
      .where(and(eq(recordings.providerId, id), eq(recordings.status, "recording")))
      .all().length;

    const auth = await checkProviderAuth(provider);

    return {
      id: provider.id,
      enabled: provider.enabled,
      activeStreams,
      maxConcurrentStreams: provider.maxConcurrentStreams,
      auth: { ...auth, checkedAt: new Date().toISOString() },
    };
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
    try {
      // PLAN.md "Provider delete cascade" — decided as a block, not a
      // cascade: the recordings.provider_id FK (ON DELETE NO ACTION, the
      // SQLite default) already enforces this at the DB level, so any
      // recording referencing this provider surfaces as a clean 409 here
      // rather than an unhandled DB error or a silent cascade.
      db.delete(providers).where(eq(providers.id, id)).run();
    } catch (err) {
      if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return reply.code(409).send({ error: "provider has recordings; delete or reassign them first" });
      }
      throw err;
    }
    reply.code(204);
  });
}
