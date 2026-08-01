import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { storageConfig, retentionConfig } from "../db/schema.js";
import { requireApiKey } from "../auth.js";
import { getStorageConfig, getRetentionConfig } from "../db/settings.js";

const storageUpdateSchema = {
  type: "object",
  properties: {
    directory: { type: "string", minLength: 1 },
    minFreeBytes: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
  minProperties: 1,
} as const;

type StorageUpdateBody = {
  directory?: string;
  minFreeBytes?: number;
};

const retentionUpdateSchema = {
  type: "object",
  required: ["ttlDays"],
  properties: {
    ttlDays: { type: ["integer", "null"], minimum: 1 },
  },
  additionalProperties: false,
} as const;

type RetentionUpdateBody = {
  ttlDays: number | null;
};

const storageConfigSchema = {
  $id: "StorageConfig",
  type: "object",
  properties: {
    id: { type: "integer" },
    directory: { type: "string" },
    minFreeBytes: { type: "integer", description: "Hard-reject threshold: requests are rejected if free space on this directory's filesystem is already below this." },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "directory", "minFreeBytes", "updatedAt"],
} as const;

const retentionConfigSchema = {
  $id: "RetentionConfig",
  type: "object",
  properties: {
    id: { type: "integer" },
    ttlDays: { type: "integer", nullable: true, description: "null disables retention — nothing is auto-deleted." },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "ttlDays", "updatedAt"],
} as const;

const uiUrlSchema = {
  $id: "UiUrl",
  type: "object",
  properties: {
    url: { type: "string", description: "Where the Settings UI is hosted. Defaults to the local Vite dev server; override via the UI_URL env var (e.g. in docker-compose) once the UI is deployed somewhere else." },
  },
  required: ["url"],
} as const;

// Matches the Vite dev server default (web/vite.config.ts has no `server.port`
// override) — so an unconfigured deployment reports exactly where the UI
// already runs today.
const DEFAULT_UI_URL = "http://localhost:5173";

// PLAN.md "GET/PUT /config/storage" and "GET/PUT /config/retention" — both
// backed by singleton config rows (server/src/db/settings.ts).
export async function configRoutes(app: FastifyInstance) {
  app.addSchema(storageConfigSchema);
  app.addSchema(retentionConfigSchema);
  app.addSchema(uiUrlSchema);

  app.addHook("onRequest", requireApiKey);

  app.get(
    "/config/storage",
    { schema: { tags: ["config"], summary: "Get storage config", response: { 200: { $ref: "StorageConfig#" } } } },
    async () => getStorageConfig(),
  );

  // Changing `directory` only affects where *future* recordings are
  // written — existing files already on disk under the old directory are
  // not moved. PLAN.md doesn't call for a migration step, and moving
  // potentially large video files is a meaningfully bigger, riskier feature
  // than this endpoint.
  app.put<{ Body: StorageUpdateBody }>(
    "/config/storage",
    {
      schema: {
        tags: ["config"],
        summary: "Update storage config",
        body: storageUpdateSchema,
        response: { 200: { $ref: "StorageConfig#" }, 400: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const current = getStorageConfig();
      const directory = request.body.directory ?? current.directory;
      const minFreeBytes = request.body.minFreeBytes ?? current.minFreeBytes;

      try {
        mkdirSync(directory, { recursive: true });
      } catch (err) {
        return reply.code(400).send({ error: `cannot use directory: ${(err as Error).message}` });
      }

      const [updated] = db
        .update(storageConfig)
        .set({ directory, minFreeBytes, updatedAt: new Date() })
        .where(eq(storageConfig.id, current.id))
        .returning()
        .all();
      return updated;
    },
  );

  app.get(
    "/config/retention",
    { schema: { tags: ["config"], summary: "Get retention config", response: { 200: { $ref: "RetentionConfig#" } } } },
    async () => getRetentionConfig(),
  );

  // ttlDays: null disables retention (the default) — an explicit null in
  // the body is how a client turns retention back off, not just omission.
  app.put<{ Body: RetentionUpdateBody }>(
    "/config/retention",
    {
      schema: {
        tags: ["config"],
        summary: "Update retention config",
        body: retentionUpdateSchema,
        response: { 200: { $ref: "RetentionConfig#" } },
      },
    },
    async (request) => {
      const current = getRetentionConfig();
      const [updated] = db
        .update(retentionConfig)
        .set({ ttlDays: request.body.ttlDays, updatedAt: new Date() })
        .where(eq(retentionConfig.id, current.id))
        .returning()
        .all();
      return updated;
    },
  );

  // Read-only, env-backed rather than a DB singleton like storage/retention
  // — this is a deployment-time fact (where the operator chose to host the
  // UI container/process), not something the UI itself should be able to
  // reconfigure. No env var set = current behavior (Vite dev default),
  // unchanged for existing deployments.
  app.get(
    "/config/ui-url",
    { schema: { tags: ["config"], summary: "Get the Settings UI's URL", response: { 200: { $ref: "UiUrl#" } } } },
    async () => ({ url: process.env.UI_URL ?? DEFAULT_UI_URL }),
  );
}
