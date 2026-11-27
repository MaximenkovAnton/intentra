import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  waitForLockWaiters,
  type Harness,
} from './harness.js';
import { projectMembers } from '../src/db/schema.js';

describe.skipIf(!hasDatabase)('RBAC', () => {
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

  const setupProject = async () => {
    const owner = await seedUser(harness.db, { name: 'Owner' });
    const viewer = await seedUser(harness.db, { name: 'Viewer' });
    const editor = await seedUser(harness.db, { name: 'Editor' });
    const outsider = await seedUser(harness.db, { name: 'Outsider' });
    const admin = await seedUser(harness.db, { name: 'Admin', isAdmin: true });
    const project = await seedProject(harness.db, owner.id, 'acme');
    await harness.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: viewer.id, role: 'viewer' });
    await harness.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: editor.id, role: 'editor' });
    return { owner, viewer, editor, outsider, admin, project };
  };

  it('rejects a cookie-authenticated mutation from a foreign origin', async () => {
    const { owner } = await setupProject();
    const token = await seedSession(harness.db, owner.id);
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/projects/acme',
      headers: { cookie: `intentra_session=${token}`, origin: 'https://evil.example.com' },
      payload: { name: 'CSRF' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a viewer read but not mutate', async () => {
    const { viewer } = await setupProject();
    const token = await seedSession(harness.db, viewer.id);
    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/acme',
      headers: authCookie(token),
    });
    expect(read.statusCode).toBe(200);
    const write = await harness.app.inject({
      method: 'PATCH',
      url: '/api/projects/acme',
      headers: authCookie(token),
      payload: { name: 'Renamed' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires owner for settings and editor for nothing in this increment', async () => {
    const { editor, owner } = await setupProject();
    const editorToken = await seedSession(harness.db, editor.id);
    const editorPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/projects/acme',
      headers: authCookie(editorToken),
      payload: { name: 'Editor rename' },
    });
    expect(editorPatch.statusCode).toBe(403);

    const ownerToken = await seedSession(harness.db, owner.id);
    const ownerPatch = await harness.app.inject({
      method: 'PATCH',
      url: '/api/projects/acme',
      headers: authCookie(ownerToken),
      payload: { name: 'Owner rename' },
    });
    expect(ownerPatch.statusCode).toBe(200);
    expect(ownerPatch.json<{ name: string }>().name).toBe('Owner rename');
  });

  it('answers 403 for a non-member without leaking whether the project exists', async () => {
    const { outsider } = await setupProject();
    const token = await seedSession(harness.db, outsider.id);
    const existing = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/acme',
      headers: authCookie(token),
    });
    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/does-not-exist',
      headers: authCookie(token),
    });
    expect(existing.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(existing.json()).toEqual(missing.json());
  });

  it('lets an org-admin read any project and returns 404 for missing ones', async () => {
    const { admin } = await setupProject();
    const token = await seedSession(harness.db, admin.id);
    const existing = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/acme',
      headers: authCookie(token),
    });
    expect(existing.statusCode).toBe(200);
    const missing = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/does-not-exist',
      headers: authCookie(token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lets an owner add and remove members and refuses to remove the last owner', async () => {
    const { owner, viewer, project } = await setupProject();
    const token = await seedSession(harness.db, owner.id);
    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/acme/members',
      headers: authCookie(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: { role: string }[] }>().items.map((item) => item.role).sort()).toEqual([
      'editor',
      'owner',
      'viewer',
    ]);

    const removeViewer = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/acme/members/${viewer.id}`,
      headers: authCookie(token),
    });
    expect(removeViewer.statusCode).toBe(204);

    const removeOwner = await harness.app.inject({
      method: 'DELETE',
      url: `/api/projects/acme/members/${owner.id}`,
      headers: authCookie(token),
    });
    expect(removeOwner.statusCode).toBe(409);
    expect(removeOwner.json()).toMatchObject({ code: 'CONFLICT' });

    const addBack = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/members',
      headers: authCookie(token),
      payload: { email: viewer.email, role: 'editor' },
    });
    expect(addBack.statusCode).toBe(201);
    expect(addBack.json<{ role: string; userId: string }>()).toMatchObject({
      role: 'editor',
      userId: viewer.id,
    });

    const duplicate = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/members',
      headers: authCookie(token),
      payload: { email: viewer.email, role: 'viewer' },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknownEmail = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/members',
      headers: authCookie(token),
      payload: { email: 'nobody@example.com', role: 'viewer' },
    });
    expect(unknownEmail.statusCode).toBe(404);
    expect(project.id).toBeTruthy();
  });

  it('keeps one owner when two owner removals race', async () => {
    const { admin, owner, project } = await setupProject();
    const secondOwner = await seedUser(harness.db, { name: 'Second Owner' });
    await harness.db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: secondOwner.id, role: 'owner' });
    const headers = authCookie(await seedSession(harness.db, admin.id));
    const client = await harness.pool.connect();
    const observer = await harness.pool.connect();
    await client.query('begin');
    await client.query('select 1 from projects where id = $1 for update', [project.id]);
    const removals = Promise.all([
      harness.app.inject({ method: 'DELETE', url: `/api/projects/acme/members/${owner.id}`, headers }),
      harness.app.inject({ method: 'DELETE', url: `/api/projects/acme/members/${secondOwner.id}`, headers }),
    ]);
    try {
      await waitForLockWaiters(observer, 2);
    } finally {
      await client.query('rollback');
      client.release();
      observer.release();
    }
    const responses = await removals;
    expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 409]);
    const owners = await harness.db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.role, 'owner')));
    expect(owners).toHaveLength(1);
  });
});
