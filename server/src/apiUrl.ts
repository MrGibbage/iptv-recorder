import type { FastifyRequest } from "fastify";
import { PORT } from "./config.js";

// Extracted from routes/clients.ts (2026-08-01/02) — the request-derived
// guess at this recorder's externally-reachable API origin, used both as
// POST /clients's apiUrl fallback and as GET /config/api-url's
// suggestedDefault (TODO8). Trusts X-Forwarded-Host/-Proto when a reverse
// proxy sets them, otherwise falls back to this server's own known real
// PORT rather than whatever port the request nominally arrived on — but
// that fallback assumes the host-published port matches PORT 1:1, which
// docker-compose.yml's API_PORT (defaults to PORT, but is independently
// overridable) can break. GET/PUT /config/api-url exists precisely to let
// an operator correct either case rather than living with this guess.
export function deriveApiUrl(request: FastifyRequest): string {
  const forwardedHost = request.headers["x-forwarded-host"];
  const forwarded = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const host = forwarded ?? `${request.hostname}:${PORT}`;
  return `${request.protocol}://${host}`;
}
