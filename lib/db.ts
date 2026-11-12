import { Pool, type QueryResultRow } from "pg";

// Reuse one pool across hot reloads in dev.
const globalForDatabase = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForDatabase.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDatabase.pgPool = pool;

export type Queryable = {
  query<Row extends QueryResultRow = any>(sqlText: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

export function query<Row extends QueryResultRow = any>(sqlText: string, params?: unknown[]) {
  return pool.query<Row>(sqlText, params);
}
