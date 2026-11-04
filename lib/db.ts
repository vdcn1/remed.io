import { Pool, type QueryResultRow } from "pg";

// Reuse one pool across hot reloads in dev.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDb.pgPool = pool;

export type Queryable = {
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
};

export function query<R extends QueryResultRow = any>(text: string, params?: unknown[]) {
  return pool.query<R>(text, params);
}
