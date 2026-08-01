import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { profiles } from "../db/schema.js";
import { requireApiKey } from "../auth.js";

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

const profileSchema = {
  $id: "Profile",
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "createdAt"],
} as const;

// Netflix-profile-style attribution — no secret, no auth boundary (see
// schema.ts's comment on the `profiles` table). Simpler than clients.ts:
// no hash/redaction, no "shown once" handling, and delete is a hard delete
// rather than a soft-revoke since there's no security material to retain
// a record of.
export async function profileRoutes(app: FastifyInstance) {
  app.addSchema(profileSchema);

  app.addHook("onRequest", requireApiKey);

  app.post<{ Body: CreateBody }>(
    "/profiles",
    {
      schema: {
        tags: ["profiles"],
        summary: "Create a profile",
        body: createBodySchema,
        response: { 201: { $ref: "Profile#" } },
      },
    },
    async (request, reply) => {
      const [created] = db.insert(profiles).values({ name: request.body.name }).returning().all();
      reply.code(201);
      return created;
    },
  );

  app.get(
    "/profiles",
    {
      schema: {
        tags: ["profiles"],
        summary: "List profiles",
        response: { 200: { type: "array", items: { $ref: "Profile#" } } },
      },
    },
    async () => db.select().from(profiles).all(),
  );

  app.delete<{ Params: { id: string } }>(
    "/profiles/:id",
    {
      schema: {
        tags: ["profiles"],
        summary: "Delete a profile",
        description: "Blocked (409), not cascaded, if any recording or recurring rule references this profile.",
        response: { 404: { $ref: "Error#" }, 409: { $ref: "Error#" } },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      const [existing] = db.select().from(profiles).where(eq(profiles.id, id)).all();
      if (!existing) {
        return reply.code(404).send({ error: "profile not found" });
      }
      try {
        // Same NO ACTION FK pattern as DELETE /providers/:id — a reference
        // from recordings/recurring_rules surfaces as a clean 409 here
        // rather than an unhandled DB error or a silent cascade.
        db.delete(profiles).where(eq(profiles.id, id)).run();
      } catch (err) {
        if (err instanceof Database.SqliteError && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          return reply.code(409).send({ error: "profile has recordings; delete or reassign them first" });
        }
        throw err;
      }
      reply.code(204).send();
    },
  );
}
