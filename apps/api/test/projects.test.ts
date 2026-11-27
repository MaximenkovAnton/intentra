import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { authCookie, createHarness, hasDatabase, resetDatabase, seedSession, seedUser, type Harness } from './harness.js';
import { auditLog, projects } from '../src/db/schema.js';
import { encodeCursor } from '../src/pagination.js';

describe.skipIf(!hasDatabase)('projects CRUD and audit', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const sessionFor = async (isAdmin = false) => {
    const user = await seedUser(harness.db, { isAdmin });
    return { user, cookie: authCookie(await seedSession(harness.db, user.id)) };
  };

  it('creates a project, makes the creator owner and audits it', async () => {
    const { user, cookie } = await sessionFor();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: cookie,
      payload: { key: 'intentra', name: 'Intentra', description: 'Control plane' },
    });
    expect(response.statusCode).toBe(201);
    const project = response.json<{ key: string; name: string; createdBy: string; archivedAt: null }>();
    expect(project).toMatchObject({ key: 'intentra', name: 'Intentra', createdBy: user.id, archivedAt: null });

    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'project.create'))
      .orderBy(desc(auditLog.at));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(user.id);
    expect(audits[0]?.target).toBe('intentra');
  });

  it('rejects a duplicate key with CONFLICT', async () => {
    const { cookie } = await sessionFor();
    await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: cookie,
      payload: { key: 'intentra', name: 'Intentra' },
    });
    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: cookie,
      payload: { key: 'intentra', name: 'Other' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'CONFLICT' });
  });

  it('lists projects page by page with a cursor', async () => {
    const { cookie } = await sessionFor();
    for (const key of ['alpha', 'bravo', 'charlie']) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: cookie,
        payload: { key, name: key },
      });
    }
    const firstPage = await harness.app.inject({
      method: 'GET',
      url: '/api/projects?limit=2',
      headers: cookie,
    });
    expect(firstPage.statusCode).toBe(200);
    const first = firstPage.json<{ items: { key: string }[]; nextCursor: string | null }>();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const secondPage = await harness.app.inject({
      method: 'GET',
      url: `/api/projects?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      headers: cookie,
    });
    const second = secondPage.json<{ items: { key: string }[]; nextCursor: string | null }>();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((item) => item.key).sort()).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  it('paginates rows created within the same millisecond without losing one', async () => {
    const { user, cookie } = await sessionFor(true);
    await harness.db.insert(projects).values({
      key: 'alpha',
      name: 'Alpha',
      createdBy: user.id,
      createdAt: sql`'2026-01-01 00:00:00.123100+00'::timestamptz`,
    });
    await harness.db.insert(projects).values({
      key: 'bravo',
      name: 'Bravo',
      createdBy: user.id,
      createdAt: sql`'2026-01-01 00:00:00.123900+00'::timestamptz`,
    });
    const first = await harness.app.inject({ method: 'GET', url: '/api/projects?limit=1', headers: cookie });
    const firstPage = first.json<{ items: { key: string }[]; nextCursor: string | null }>();
    expect(firstPage.items.map((item) => item.key)).toEqual(['bravo']);
    expect(firstPage.nextCursor).not.toBeNull();
    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/projects?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      headers: cookie,
    });
    const secondPage = second.json<{ items: { key: string }[]; nextCursor: string | null }>();
    expect(secondPage.items.map((item) => item.key)).toEqual(['alpha']);
  });

  it('rejects a cursor whose id half is not a UUID with VALIDATION', async () => {
    const { cookie } = await sessionFor();
    const forged = encodeCursor({ createdAt: '2026-01-01T00:00:00.123100Z', id: 'not-a-uuid' });
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/projects?cursor=${encodeURIComponent(forged)}`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('archives instead of deleting and hides the project from the list', async () => {
    const { cookie } = await sessionFor();
    await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: cookie,
      payload: { key: 'intentra', name: 'Intentra' },
    });
    const archived = await harness.app.inject({
      method: 'DELETE',
      url: '/api/projects/intentra',
      headers: cookie,
    });
    expect(archived.statusCode).toBe(204);

    const [row] = await harness.db.select().from(projects).where(eq(projects.key, 'intentra'));
    expect(row?.archivedAt).toBeInstanceOf(Date);

    const list = await harness.app.inject({ method: 'GET', url: '/api/projects', headers: cookie });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
    const again = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/intentra',
      headers: cookie,
    });
    expect(again.statusCode).toBe(403);
  });

  it('shows all projects to an org-admin', async () => {
    const owner = await seedUser(harness.db);
    const ownerCookie = authCookie(await seedSession(harness.db, owner.id));
    await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: ownerCookie,
      payload: { key: 'owned', name: 'Owned' },
    });
    const { cookie: adminCookie } = await sessionFor(true);
    const list = await harness.app.inject({ method: 'GET', url: '/api/projects', headers: adminCookie });
    expect(list.json<{ items: { key: string }[] }>().items.map((item) => item.key)).toEqual(['owned']);
  });
});
