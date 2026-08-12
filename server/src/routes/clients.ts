import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { clients } from "../db/schema.js";
import { requireApiKey, requireApiKeyUnlessFirstClient, hasAnyClient } from "../auth.js";
import { getApiUrlConfig } from "../db/settings.js";
import { deriveApiUrl } from "../apiUrl.js";

// Comment is a free-text label only, to tell apart clients that share an
// app name (e.g. two "Lao" clients on different devices) — capped short
// since it's meant to be a glanceable tag on the Clients screen, not a
// description field.
const COMMENT_MAX_LENGTH = 20;

const createBodySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    comment: { type: "string", maxLength: COMMENT_MAX_LENGTH, nullable: true },
  },
  additionalProperties: false,
} as const;

type CreateBody = {
  name: string;
  comment?: string | null;
};

const clientSchema = {
  $id: "Client",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    comment: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    revokedAt: { type: "string", nullable: true, format: "date-time" },
  },
  required: ["id", "name", "comment", "createdAt", "revokedAt"],
} as const;

const clientCreatedSchema = {
  $id: "ClientCreated",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    comment: { type: "string", nullable: true },
    createdAt: { type: "string", format: "date-time" },
    revokedAt: { type: "string", nullable: true, format: "date-time" },
    apiKey: { type: "string", description: "Shown exactly once — only its hash is stored, it cannot be recovered later." },
    apiUrl: { type: "string", description: "This recorder's own base URL, derived from the request that created this client — for a client app to auto-configure its connection (e.g. QR-code pairing) instead of the operator typing it in by hand." },
  },
  required: ["id", "name", "comment", "createdAt", "revokedAt", "apiKey", "apiUrl"],
} as const;

const setupStatusSchema = {
  $id: "SetupStatus",
  type: "object",
  properties: {
    needsSetup: {
      type: "boolean",
      description: "True until the very first client is created — while true, POST /clients allows exactly one unauthenticated call, for the web UI's first-run setup screen.",
    },
  },
  required: ["needsSetup"],
} as const;

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
  app.addSchema(clientSchema);
  app.addSchema(clientCreatedSchema);
  app.addSchema(setupStatusSchema);

  // Unauthenticated (see hasAnyClient, ../auth.js) — the web UI's Settings
  // page checks this before deciding whether to show the first-run setup
  // screen or the normal "paste an admin-issued key" form.
  app.get(
    "/setup-status",
    {
      schema: {
        tags: ["clients"],
        summary: "Whether this recorder needs first-run setup",
        response: { 200: { $ref: "SetupStatus#" } },
      },
    },
    async () => ({ needsSetup: !hasAnyClient() }),
  );

  // No blanket onRequest hook — POST /clients needs different logic
  // (bootstrap-allowed vs normal) than GET/DELETE, so auth is applied per
  // route below instead.
  app.post<{ Body: CreateBody }>(
    "/clients",
    {
      preHandler: requireApiKeyUnlessFirstClient,
      schema: {
        tags: ["clients"],
        summary: "Issue a new client API key",
        description: "Requires an existing client's key — except the very first call ever, which bootstraps the recorder (see GET /setup-status).",
        body: createBodySchema,
        response: { 201: { $ref: "ClientCreated#" } },
      },
    },
    async (request, reply) => {
      const apiKey = crypto.randomBytes(32).toString("base64url");
      const [created] = db
        .insert(clients)
        .values({ name: request.body.name, comment: request.body.comment || null, apiKeyHash: hashKey(apiKey) })
        .returning()
        .all();
      reply.code(201);
      // GET/PUT /config/api-url (TODO8, ../db/settings.ts) lets an operator
      // override this outright — header-derivation (deriveApiUrl,
      // ../apiUrl.ts) breaks down once a reverse proxy fronts a
      // path-prefixed API rather than the API's own origin (found live
      // during the 2026-08-02 Docker cutover, see PLAN.md "Deployment").
      // null (the default) falls back to the request-derived guess exactly
      // as before that setting existed.
      const apiUrl = getApiUrlConfig().url ?? deriveApiUrl(request);
      // apiKey is shown exactly once, in this response — it is never
      // recoverable afterward, only the hash is stored.
      return { ...redact(created), apiKey, apiUrl };
    },
  );

  app.get(
    "/clients",
    {
      preHandler: requireApiKey,
      schema: {
        tags: ["clients"],
        summary: "List clients",
        response: { 200: { type: "array", items: { $ref: "Client#" } } },
      },
    },
    async () => {
      return db.select().from(clients).all().map(redact);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/clients/:id",
    {
      preHandler: requireApiKey,
      schema: {
        tags: ["clients"],
        summary: "Revoke a client's API key",
        description: "Soft-revoke (revokedAt is set, the row is kept). Rotation is revoke + POST /clients for a new key.",
        response: { 200: { $ref: "Client#" }, 404: { $ref: "Error#" }, 409: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
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
    },
  );
}
