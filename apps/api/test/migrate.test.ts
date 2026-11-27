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
});
