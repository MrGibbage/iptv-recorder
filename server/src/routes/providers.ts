import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { providers, recordings } from "../db/schema.js";
import { encrypt } from "../crypto.js";
import { requireApiKey } from "../auth.js";
import { checkProviderAuth, checkXtreamAuth, checkM3uPlaylist } from "../worker/xtreamAuth.js";
import { resolveProviderConnection } from "../worker/providerShape.js";

// type is immutable after creation (see updateBodySchema — it has no `type`
// property at all): converting an existing Xtream provider into an M3U one
// isn't a real workflow, and supporting it would mean every update also has
// to juggle which of the *other* fields are now valid. Delete/recreate
// covers the (unheard-of) case where a provider genuinely switches shape.
const createBodySchema = {
  type: "object",
  required: ["name", "type", "maxConcurrentStreams"],
  properties: {
    name: { type: "string", minLength: 1 },
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    playlistUrl: { type: "string", minLength: 1 },
    epgUrl: { type: "string", minLength: 1 },
    maxConcurrentStreams: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
  },
  allOf: [
    { if: { properties: { type: { const: "xtream" } } }, then: { required: ["baseUrl", "username", "password"] } },
    { if: { properties: { type: { const: "m3u" } } }, then: { required: ["playlistUrl"] } },
  ],
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
    playlistUrl: { type: "string", minLength: 1 },
    epgUrl: { type: "string", minLength: 1 },
    maxConcurrentStreams: { type: "integer", minimum: 1 },
    enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  name: string;
  type: "xtream" | "m3u";
  baseUrl?: string;
  username?: string;
  password?: string;
  playlistUrl?: string;
  epgUrl?: string;
  maxConcurrentStreams: number;
  enabled?: boolean;
};

type UpdateBody = {
  name?: string;
  baseUrl?: string;
  username?: string;
  password?: string;
  playlistUrl?: string;
  epgUrl?: string;
  maxConcurrentStreams?: number;
  enabled?: boolean;
};

const testBodySchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: "string", minLength: 1 },
    username: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 1 },
    playlistUrl: { type: "string", minLength: 1 },
  },
  allOf: [
    { if: { properties: { type: { const: "xtream" } } }, then: { required: ["baseUrl", "username", "password"] } },
    { if: { properties: { type: { const: "m3u" } } }, then: { required: ["playlistUrl"] } },
  ],
  additionalProperties: false,
} as const;

type TestBody =
  | { type: "xtream"; baseUrl: string; username: string; password: string }
  | { type: "m3u"; playlistUrl: string };

// Credentials (username/password/playlistUrl/epgUrl) are intentionally
// absent — see redact() below, never returned in any response.
const providerSchema = {
  $id: "Provider",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: ["string", "null"] },
    maxConcurrentStreams: { type: "integer" },
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "type", "baseUrl", "maxConcurrentStreams", "enabled", "createdAt", "updatedAt"],
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
  const { usernameEncrypted, passwordEncrypted, playlistUrlEncrypted, epgUrlEncrypted, ...rest } = provider;
  return rest;
}

// GET /providers/{id}/connection is the deliberate, narrow exception to
// redact() above — see its route registration below and PLAN.md
// "Credentials Model" (2026-07-22 note) for why. Shape mirrors
// ProviderConnection in ../worker/providerShape.ts (type-discriminated:
// xtream returns baseUrl/username/password, m3u returns playlistUrl/epgUrl).
const providerConnectionSchema = {
  $id: "ProviderConnection",
  type: "object",
  properties: {
    type: { type: "string", enum: ["xtream", "m3u"] },
    baseUrl: { type: "string" },
    username: { type: "string" },
    password: { type: "string" },
    playlistUrl: { type: "string" },
    epgUrl: { type: ["string", "null"] },
  },
  required: ["type"],
} as const;

export async function providerRoutes(app: FastifyInstance) {
  app.addSchema(providerSchema);
  app.addSchema(authCheckResultSchema);
  app.addSchema(providerStatusSchema);
  app.addSchema(providerConnectionSchema);

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
        .values(
          body.type === "xtream"
            ? {
                name: body.name,
                type: "xtream",
                // Schema's allOf/if/then already guarantees these are
                // present when type = "xtream" (see createBodySchema).
                baseUrl: body.baseUrl!,
                usernameEncrypted: encrypt(body.username!),
                passwordEncrypted: encrypt(body.password!),
                maxConcurrentStreams: body.maxConcurrentStreams,
                enabled: body.enabled ?? true,
              }
            : {
                name: body.name,
                type: "m3u",
                playlistUrlEncrypted: encrypt(body.playlistUrl!),
                epgUrlEncrypted: body.epgUrl ? encrypt(body.epgUrl) : null,
                maxConcurrentStreams: body.maxConcurrentStreams,
                enabled: body.enabled ?? true,
              },
        )
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
      const body = request.body;
      const auth = body.type === "xtream" ? await checkXtreamAuth(body) : await checkM3uPlaylist(body.playlistUrl);
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

  // PLAN.md "Credentials Model" (2026-07-22 note) — the one deliberate
  // exception to "credentials redacted in every response". iptv-scheduler
  // (a separate service owning EPG ingestion) needs the raw connection info
  // to hit each provider directly — player_api.php for xtream, the playlist
  // (and optional XMLTV epgUrl) for m3u; iptv-recorder stays the single
  // source of truth for credentials rather than a second copy or a third
  // "account manager" service existing. Xtream URLs and m3u playlist links
  // already embed credentials as standard practice (see
  // ../worker/streamUrl.ts), so handing this back to an authenticated
  // client isn't a new class of exposure — it's the same shape of
  // information the client immediately turns into a URL itself.
  // Gated by the same requireApiKey hook as every other route in this
  // file — no separate admin tier, matching the "any valid client API key"
  // precedent already documented in PLAN.md's Clients / API keys section.
  app.get<{ Params: { id: string } }>(
    "/providers/:id/connection",
    {
      schema: {
        tags: ["providers"],
        summary: "Get raw provider connection info",
        description:
          "Returns UNREDACTED connection info for direct provider access by trusted clients (e.g. iptv-scheduler's EPG ingestion) — type-discriminated: {type:'xtream', baseUrl, username, password} or {type:'m3u', playlistUrl, epgUrl}. Every other /providers endpoint redacts credentials — this one deliberately does not; see PLAN.md Credentials Model.",
        response: { 200: { $ref: "ProviderConnection#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [row] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!row) {
        return reply.code(404).send({ error: "provider not found" });
      }
      return resolveProviderConnection(row);
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateBody }>(
    "/providers/:id",
    {
      schema: {
        tags: ["providers"],
        summary: "Update a provider",
        description: "type is immutable — the body has no type field, only the fields belonging to the provider's existing type are accepted.",
        body: updateBodySchema,
        response: { 200: { $ref: "Provider#" }, 400: { $ref: "Error#" }, 404: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(providers).where(eq(providers.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "provider not found" });
      }

      const body = request.body;
      // type is immutable (see updateBodySchema) — reject fields that don't
      // belong to this provider's existing type rather than silently
      // ignoring them, since a client sending e.g. playlistUrl for an
      // xtream provider is almost certainly a mistake worth surfacing.
      if (existing.type === "xtream" && (body.playlistUrl !== undefined || body.epgUrl !== undefined)) {
        return reply.code(400).send({ error: "playlistUrl/epgUrl only apply to m3u providers" });
      }
      if (existing.type === "m3u" && (body.baseUrl !== undefined || body.username !== undefined || body.password !== undefined)) {
        return reply.code(400).send({ error: "baseUrl/username/password only apply to xtream providers" });
      }

      const updates: Partial<typeof providers.$inferInsert> = { updatedAt: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.maxConcurrentStreams !== undefined) {
        updates.maxConcurrentStreams = body.maxConcurrentStreams;
      }
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (existing.type === "xtream") {
        if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl;
        if (body.username !== undefined) updates.usernameEncrypted = encrypt(body.username);
        if (body.password !== undefined) updates.passwordEncrypted = encrypt(body.password);
      } else {
        if (body.playlistUrl !== undefined) updates.playlistUrlEncrypted = encrypt(body.playlistUrl);
        if (body.epgUrl !== undefined) updates.epgUrlEncrypted = body.epgUrl ? encrypt(body.epgUrl) : null;
      }

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
      reply.code(204).send();
    },
  );
}
