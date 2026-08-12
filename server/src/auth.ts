import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
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

// True once any client row has ever existed — checked against every row,
// not just active/non-revoked ones, so revoking your only client can never
// reopen the unauthenticated bootstrap window below.
export function hasAnyClient(): boolean {
  const [row] = db.select({ n: sql<number>`count(*)` }).from(clients).all();
  return (row?.n ?? 0) > 0;
}

// User-requested 2026-08-02, replacing the CLI-only seed-client.ts
// bootstrap for first-run setup: POST /clients allows exactly one
// unauthenticated call, only while the clients table has never had a row
// — the same "first to reach the setup screen wins" model virtually every
// self-hosted app's first-run wizard already uses (Home Assistant,
// Nextcloud, Jellyfin, ...). The moment any client exists, this
// permanently falls through to the normal requireApiKey check — there is
// no way to reopen it short of restoring an empty clients table.
// server/src/db/seed-client.ts remains as a CLI alternative (e.g. for
// scripted/headless deploys), unaffected by this.
//
// Accepted race: two concurrent POST /clients requests can both observe
// hasAnyClient() === false before either INSERT commits, creating two
// bootstrap clients instead of one. Narrower than the threat this already
// accepts (whoever reaches the setup screen first), not worth a
// transaction/lock for.
export async function requireApiKeyUnlessFirstClient(request: FastifyRequest, reply: FastifyReply) {
  if (!hasAnyClient()) {
    return;
  }
  return requireApiKey(request, reply);
}
