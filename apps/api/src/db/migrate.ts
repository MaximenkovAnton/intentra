import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase, type Database, type DatabaseClient } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openMigrationDatabase(connectionString: string): DatabaseClient {
  return createDatabase(connectionString, 0);
}

const MigrationEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const parsed = MigrationEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write('migrate requires DATABASE_URL\n');
    process.exit(1);
  }
  const { db, pool } = openMigrationDatabase(parsed.data.DATABASE_URL);
  await runMigrations(db);
  await pool.end();
  process.stdout.write('migrations applied\n');
}
