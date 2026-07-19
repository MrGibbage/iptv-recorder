import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { clients } from "./db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    client?: typeof clients.$inferSelect;
  }
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// PLAN.md "Auth: per-client API keys" — every request is attributable to the
// client whose key it carries. Keys are issued out-of-band (see
// src/db/seed-client.ts); there is no self-registration endpoint.
export async function requireApiKey(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!key) {
    return reply.code(401).send({ error: "missing API key" });
  }

  const [client] = db
    .select()
    .from(clients)
    .where(eq(clients.apiKeyHash, hashKey(key)))
    .all();

  if (!client || client.revokedAt) {
    return reply.code(401).send({ error: "invalid or revoked API key" });
  }

  request.client = client;
}
