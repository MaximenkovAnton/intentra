import { describe, expect, it } from 'vitest';
import { openMigrationDatabase } from '../src/db/migrate.js';
import { hasDatabase, TEST_DATABASE_URL } from './harness.js';

describe.skipIf(!hasDatabase)('migration client', () => {
  it('disables the interactive statement timeout for one-shot migrations', async () => {
    const { pool } = openMigrationDatabase(TEST_DATABASE_URL ?? '');
    try {
      const result = await pool.query<{ statement_timeout: string }>(
        "select current_setting('statement_timeout') as statement_timeout",
      );
      expect(result.rows[0]?.statement_timeout).toBe('0');
    } finally {
      await pool.end();
    }
  });

  it('the 0005 migration adds the release tables and the runner policy columns', async () => {
    const { pool } = openMigrationDatabase(TEST_DATABASE_URL ?? '');
    try {
      const tables = await pool.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('releases', 'runner_update_events') order by table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(['releases', 'runner_update_events']);

      const columns = await pool.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
        "select column_name, column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'runners' and column_name in ('auto_update', 'pinned_version') order by column_name",
      );
      expect(columns.rows).toEqual([
        { column_name: 'auto_update', column_default: 'true', is_nullable: 'NO' },
        { column_name: 'pinned_version', column_default: null, is_nullable: 'YES' },
      ]);
    } finally {
      await pool.end();
    }
  });
});
