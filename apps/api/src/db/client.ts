import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseClient {
  readonly db: Database;
  readonly pool: Pool;
}

export function createDatabase(connectionString: string, statementTimeoutMs = 15_000): DatabaseClient {
  const pool = new Pool({
    connectionString,
    max: 10,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
