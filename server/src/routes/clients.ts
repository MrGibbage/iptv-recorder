import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { clients } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { PORT } from "../config.js";

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

const clientSchema = {
  $id: "Client",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    revokedAt: { type: "string", nullable: true, format: "date-time" },
  },
  required: ["id", "name", "createdAt", "revokedAt"],
} as const;

const clientCreatedSchema = {
  $id: "ClientCreated",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    revokedAt: { type: "string", nullable: true, format: "date-time" },
    apiKey: { type: "string", description: "Shown exactly once — only its hash is stored, it cannot be recovered later." },
    apiUrl: { type: "string", description: "This recorder's own base URL, derived from the request that created this client — for a client app to auto-configure its connection (e.g. QR-code pairing) instead of the operator typing it in by hand." },
  },
  required: ["id", "name", "createdAt", "revokedAt", "apiKey", "apiUrl"],
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

  app.addHook("onRequest", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/clients",
    {
      schema: {
        tags: ["clients"],
        summary: "Issue a new client API key",
        body: createBodySchema,
        response: { 201: { $ref: "ClientCreated#" } },
      },
    },
    async (request, reply) => {
      const apiKey = crypto.randomBytes(32).toString("base64url");
      const [created] = db
        .insert(clients)
        .values({ name: request.body.name, apiKeyHash: hashKey(apiKey) })
        .returning()
        .all();
      reply.code(201);
      // Derived from the request itself, not the browser's window.location
      // (the web UI's own requests go through Vite's dev proxy, so its
      // origin isn't the API's). request.protocol is trustProxy-aware
      // (honors X-Forwarded-Proto).
      //
      // Host handling has two cases:
      //  - A real reverse proxy set X-Forwarded-Host (Caddy, once fronted):
      //    trust it as-is, no port override — that's the public-facing
      //    name, typically on the standard 80/443 port.
      //  - No forwarded host: the request either hit this server directly,
      //    or came through an intermediary that preserves the original
      //    Host header unchanged rather than rewriting it — Vite's dev
      //    proxy fronting this same web UI does exactly that (confirmed
      //    live: a client created by browsing the UI on :5174 got back
      //    apiUrl: http://localhost:5174, since Fastify only ever sees the
      //    browser's original :5174 Host with nothing to say otherwise).
      //    Trusting the header's port blindly is therefore wrong; the
      //    server always knows its own real port (PORT, ../config.js), so
      //    the hostname is kept from the header but the port is always
      //    overridden to it. Verified live: hitting :3300 directly, and
      //    hitting :5174 through Vite's proxy (both localhost and the LAN
      //    IP), all three now correctly resolve to the real :3300.
      const forwardedHost = request.headers["x-forwarded-host"];
      const forwarded = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
      const host = forwarded ?? `${request.hostname}:${PORT}`;
      const apiUrl = `${request.protocol}://${host}`;
      // apiKey is shown exactly once, in this response — it is never
      // recoverable afterward, only the hash is stored.
      return { ...redact(created), apiKey, apiUrl };
    },
  );

  app.get(
    "/clients",
    {
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
