import "dotenv/config";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { db } from "./db/client.js";
import { clients } from "./db/schema.js";
import { providerRoutes } from "./routes/providers.js";
import { recordingRoutes } from "./routes/recordings.js";
import { configRoutes } from "./routes/config.js";
import { clientRoutes } from "./routes/clients.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";

// recurring_rules.startMinuteOfDay has no per-rule timezone field (PLAN.md
// "single-instance, single-timezone deployment") — pinned to UTC via
// server/.env's TZ=UTC rather than left to whatever the host happens to be
// set to. Failing fast here turns a silent, host-dependent shift in what
// every recurring rule's schedule actually means into a boot-time error
// instead of a support puzzle.
const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (serverTimeZone !== "UTC") {
  throw new Error(
    `Server timezone must be UTC (recurring_rules.startMinuteOfDay assumes it), got "${serverTimeZone}". Set TZ=UTC in server/.env.`,
  );
}

const app = Fastify({ logger: true });

// PLAN.md TODO4 — OpenAPI docs, generated from the same JSON-schema body/
// querystring/response definitions each route already carries for
// validation (see route files under ./routes). "bearerAuth" mirrors
// PLAN.md "Auth: per-client API keys" (Authorization: Bearer <key>); it's
// the document-level default so every route requires it unless a route
// overrides `schema.security` (only /health and /health/db do, below).
await app.register(swagger, {
  openapi: {
    info: {
      title: "iptv-recorder API",
      description: "Recording/scheduling backend for IPTV DVR functionality. See PLAN.md in the repo for design rationale.",
      version: "0.1.0",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Per-client API key (see POST /clients)" },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  // Default resolver names components "def-0", "def-1", ... and stashes the
  // schema's $id in `title` instead — using $id directly makes the
  // generated document actually readable (Provider, Recording, ...).
  refResolver: {
    buildLocalReference(json: { $id?: string }, _baseUri: unknown, _fragment: unknown, i: number) {
      return json.$id ?? `def-${i}`;
    },
  },
});
await app.register(swaggerUi, { routePrefix: "/documentation" });

// Shared response-shape components (TODO3: "exact request/response schemas
// and error shapes for the drafted endpoints") — registered once here,
// referenced by $ref from each route file's own schema so the shape is
// defined in exactly one place per resource.
app.addSchema({
  $id: "Error",
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
});

app.get("/health", { schema: { security: [] } }, async () => {
  return { status: "ok" };
});

app.get("/health/db", { schema: { security: [] } }, async () => {
  const rows = db.select().from(clients).all();
  return { status: "ok", clients: rows.length };
});

await app.register(providerRoutes);
await app.register(recordingRoutes);
await app.register(configRoutes);
await app.register(clientRoutes);

app.addHook("onClose", async () => {
  stopScheduler();
});

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

startScheduler();
