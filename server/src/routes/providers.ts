import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { encrypt } from "../crypto.js";
import { requireApiKey } from "../auth.js";
import { checkProviderAuth, checkXtreamAuth } from "../worker/xtreamAuth.js";

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

const testBodySchema = {
  type: "object",
  required: ["baseUrl", "username", "password"],
  properties: {
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type TestBody = {
  baseUrl: string;
  username: string;
  password: string;
};

// Credentials (username/password) are intentionally absent — see redact()
// below, never returned in any response.
const providerSchema = {
  $id: "Provider",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    baseUrl: { type: "string" },
    maxConcurrentStreams: { type: "integer" },
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "baseUrl", "maxConcurrentStreams", "enabled", "createdAt", "updatedAt"],
} as const;

// Shared shape for "did this auth check pass" — used standalone by
// POST /providers/test and nested (as `auth`) in ProviderStatus below.
const authCheckResultSchema = {
  $id: "AuthCheckResult",
  type: "object",
  properties: {
    ok: { type: "boolean" },
    error: { type: "string", description: "Present only when ok is false." },
    checkedAt: { type: "string", format: "date-time" },
  },
  required: ["ok", "checkedAt"],
} as const;

const providerStatusSchema = {
  $id: "ProviderStatus",
  type: "object",
  properties: {
    id: { type: "integer" },
    enabled: { type: "boolean" },
    activeStreams: { type: "integer", description: "Recordings currently in progress against this provider." },
    maxConcurrentStreams: { type: "integer" },
    auth: { $ref: "AuthCheckResult#" },
  },
  required: ["id", "enabled", "activeStreams", "maxConcurrentStreams", "auth"],
} as const;

// Credentials never leave this module in plaintext or ciphertext form —
// every response is redacted down to what a client is allowed to see.
function redact(provider: typeof providers.$inferSelect) {
  const { usernameEncrypted, passwordEncrypted, ...rest } = provider;
  return rest;
}

export async function providerRoutes(app: FastifyInstance) {
  app.addSchema(providerSchema);
  app.addSchema(authCheckResultSchema);
  app.addSchema(providerStatusSchema);

  // onRequest, not preHandler: Fastify validates the body schema before
  // preHandler runs, so an unauthenticated request with a malformed body
  // would otherwise get a 400 instead of a 401.
  app.addHook("onRequest", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/providers",
    {
      schema: {
        tags: ["providers"],
        summary: "Add a provider",
        body: createBodySchema,
        response: { 201: { $ref: "Provider#" } },
      },
    },
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

  // Tests credentials before they're ever saved — lets the admin UI gate
  // its "Add provider" save button on a passing test (per user request),
  // without needing a provider row (and its id) to already exist. Never
  // touches the database; the credentials are only ever held in memory for
  // the duration of the request.
  app.post<{ Body: TestBody }>(
    "/providers/test",
    {
      schema: {
        tags: ["providers"],
        summary: "Test provider credentials",
        description: "Live auth check against the given credentials, without creating or storing a provider.",
        body: testBodySchema,
        response: { 200: { $ref: "AuthCheckResult#" } },
      },
    },
    async (request) => {
      const auth = await checkXtreamAuth(request.body);
      return { ...auth, checkedAt: new Date().toISOString() };
    },
  );

  app.get(
    "/providers",
    {
      schema: {
        tags: ["providers"],
        summary: "List providers",
        response: { 200: { type: "array", items: { $ref: "Provider#" } } },
      },
    },
    async () => {
      return db.select().from(providers).all().map(redact);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Get a provider",
        response: { 200: { $ref: "Provider#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [row] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!row) {
        return reply.code(404).send({ error: "provider not found" });
      }
      return redact(row);
    },
  );

  // PLAN.md "GET /providers/{id}/status" — deferred at scaffolding time
  // pending a recordings table and an Xtream HTTP client; both now exist.
  // activeStreams counts rows currently mid-recording, not the sweep-line
  // peak-overlap math in ../hardReject.ts (that's about a *hypothetical*
  // future window at request time; this is "what's happening right now").
  app.get<{ Params: { id: string } }>(
    "/providers/:id/status",
    {
      schema: {
        tags: ["providers"],
        summary: "Live provider status",
        description: "Live auth check against the provider plus current active-stream count vs. max.",
        response: { 200: { $ref: "ProviderStatus#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
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
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Update a provider",
        body: updateBodySchema,
        response: { 200: { $ref: "Provider#" }, 404: { $ref: "Error#" } },
      },
    },
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

  app.delete<{ Params: { id: string } }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Delete a provider",
        description: "Blocked (409), not cascaded, if any recording references this provider.",
        // No 204 entry: it has no body, and declaring one risks Fastify
        // trying to serialize the empty reply against it (see the plain
        // `reply.code(204)`, no `.send()`, below).
        response: { 404: { $ref: "Error#" }, 409: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
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
    },
  );
}
