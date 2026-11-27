import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { EventBus } from '../src/events/bus.js';
import { createMemory, type MemoryApi } from '../src/memory/index.js';
import { createOidcService, type OidcService } from '../src/auth/oidc.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { provisionUser } from '../src/auth/provisioning.js';
import { projectMembers, projects, users, type ProjectRow, type UserRow } from '../src/db/schema.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL.length > 0;

const SESSION_SECRET = 'test-session-secret-0123456789abcdef';

export function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgres://intentra:intentra@localhost:55432/intentra_test',
    SESSION_SECRET,
    PUBLIC_URL: 'http://localhost:5173',
    AUTH_MODE: 'dev',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly pool: Pool;
  readonly config: AppConfig;
  readonly oidc: OidcService | null;
  readonly events: EventBus;
  readonly memory: MemoryApi;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly memory?: MemoryApi;
}

export async function createHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<Harness> {
  const config = loadConfig(baseEnv(overrides));
  const { db, pool } = createDatabase(config.databaseUrl);
  const oidc = config.oidc ? await createOidcService(config.oidc, config.publicUrl) : null;
  const events = new EventBus();
  const owned = options.memory === undefined ? createMemory({ config, db, logger: createLogger('silent'), now: () => new Date() }) : null;
  let memory: MemoryApi;
  if (options.memory !== undefined) memory = options.memory;
  else if (owned !== null) memory = owned;
  else throw new Error('memory services are required');
  const app = await buildApp({
    config,
    db,
    pool,
    logger: createLogger('silent'),
    oidc,
    events,
    memory,
    now: () => new Date(),
  });
  return {
    app,
    db,
    pool,
    config,
    oidc,
    events,
    memory,
    async close() {
      await app.close();
      if (owned !== null) await owned.stop();
      await pool.end();
    },
  };
}

export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    sql`DO $$ DECLARE r record; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END $$;`,
  );
}

export async function waitForLockWaiters(client: PoolClient, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%for update%'",
    );
    if (Number(result.rows[0]?.count) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} backend(s) to block on a row lock`);
}

export async function seedUser(
  db: Database,
  overrides: Partial<Pick<UserRow, 'email' | 'name' | 'isAdmin' | 'locale'>> = {},
): Promise<UserRow> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [row] = await db
    .insert(users)
    .values({
      idpSubject: `subject-${suffix}`,
      email: overrides.email ?? `user-${suffix}@example.com`,
      name: overrides.name ?? 'Test User',
      avatarUrl: null,
      groups: [],
      locale: overrides.locale ?? 'ru',
      isAdmin: overrides.isAdmin ?? false,
      status: 'active',
    })
    .returning();
  if (!row) throw new Error('seedUser: insert returned no row');
  return row;
}

export async function seedSession(db: Database, userId: string): Promise<string> {
  const session = await createSession(db, {
    userId,
    authMethod: 'dev',
    ip: null,
    userAgent: 'vitest',
    now: new Date(),
  });
  return session.token;
}

export async function seedProject(
  db: Database,
  ownerId: string,
  key = 'intentra',
): Promise<ProjectRow> {
  const [project] = await db
    .insert(projects)
    .values({ key, name: 'Intentra', description: null, repoUrl: null, defaultBranch: 'main', createdBy: ownerId })
    .returning();
  if (!project) throw new Error('seedProject: insert returned no row');
  await db.insert(projectMembers).values({ projectId: project.id, userId: ownerId, role: 'owner' });
  return project;
}

export const authCookie = (token: string): { cookie: string; origin: string } => ({
  cookie: `${SESSION_COOKIE}=${token}`,
  origin: 'http://localhost:5173',
});

export const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export async function provisionTestUser(
  db: Database,
  identity: {
    subject: string;
    email: string;
    name: string;
    groups: string[];
    emailVerified?: boolean;
  },
  adminGroup = 'intentra-admins',
): Promise<UserRow> {
  return provisionUser(db, { emailVerified: true, avatarUrl: null, ...identity }, adminGroup);
}
