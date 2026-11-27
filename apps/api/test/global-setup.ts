import { openMigrationDatabase, runMigrations } from '../src/db/migrate.js';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const { db, pool } = openMigrationDatabase(url);
  try {
    await runMigrations(db);
  } finally {
    await pool.end();
  }
}
