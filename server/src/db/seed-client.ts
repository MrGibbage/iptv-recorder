import "dotenv/config";
import crypto from "node:crypto";
import { db } from "./client.js";
import { clients } from "./schema.js";

// Stand-in for the not-yet-built POST /clients endpoint (PLAN.md "Clients /
// API keys"). Prints the raw key once — only its hash is ever stored.
const name = process.argv[2];
if (!name) {
  console.error("Usage: pnpm db:seed-client <client-name>");
  process.exit(1);
}

const apiKey = crypto.randomBytes(32).toString("base64url");
const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

db.insert(clients).values({ name, apiKeyHash }).run();

console.log(`Client "${name}" created.`);
console.log(`API key (shown once — store it now): ${apiKey}`);
