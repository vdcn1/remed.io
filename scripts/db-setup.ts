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
  const databaseClient = new Client({ connectionString: process.env.DATABASE_URL });
  await databaseClient.connect();
  try {
    await databaseClient.query(readFileSync(join(process.cwd(), "db/schema.sql"), "utf8"));
    await databaseClient.query("BEGIN");
    const seededCounts = await seed(databaseClient);
    await databaseClient.query("COMMIT");
    console.log("Database ready:", seededCounts);
  } catch (err) {
    await databaseClient.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await databaseClient.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
