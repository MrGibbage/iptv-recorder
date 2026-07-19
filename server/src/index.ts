import "dotenv/config";
import Fastify from "fastify";
import { db } from "./db/client.js";
import { clients } from "./db/schema.js";
import { providerRoutes } from "./routes/providers.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/health/db", async () => {
  const rows = db.select().from(clients).all();
  return { status: "ok", clients: rows.length };
});

await app.register(providerRoutes);

const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
