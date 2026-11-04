// Applies db/schema.sql and seeds the curated dataset. Safe to re-run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { seed } from "../db/seed";

try {
  process.loadEnvFile(".env.local");
} catch {}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (see .env.example)");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(readFileSync(join(process.cwd(), "db/schema.sql"), "utf8"));
    await client.query("BEGIN");
    const counts = await seed(client);
    await client.query("COMMIT");
    console.log("Database ready:", counts);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
