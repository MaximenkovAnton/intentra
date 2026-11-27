import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  sha256,
  type Harness,
} from './harness.js';
import { auditLog, projectRunners, runnerRegistrationTokens, runners } from '../src/db/schema.js';

describe.skipIf(!hasDatabase)('runner registry', () => {
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

  const setup = async () => {
    const admin = await seedUser(harness.db, { isAdmin: true, name: 'Admin' });
    const project = await seedProject(harness.db, admin.id, 'acme');
    const cookie = authCookie(await seedSession(harness.db, admin.id));
    return { admin, project, cookie };
  };

  const createRegistrationToken = async (cookie: Record<string, string>): Promise<string> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/runners/registration-token',
      headers: cookie,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ token: string }>().token;
  };

  const register = async (registrationToken: string, name = 'laptop') =>
    harness.app.inject({
      method: 'POST',
      url: '/api/runners/register',
      payload: {
        registrationToken,
        name,
        os: 'linux',
        arch: 'x86_64',
        version: '0.1.0',
        capabilities: ['dsh'],
      },
    });

  it('issues a one-time registration token and stores only its hash', async () => {
    const { cookie } = await setup();
    const token = await createRegistrationToken(cookie);
    const rows = await harness.db.select().from(runnerRegistrationTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(sha256(token));
    expect(rows[0]?.tokenHash).not.toBe(token);
    expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]?.usedAt).toBeNull();
  });

  it('registers a runner once, returns the token once and stores only its hash', async () => {
    const { admin, project, cookie } = await setup();
    const registrationToken = await createRegistrationToken(cookie);
    const response = await register(registrationToken);
    expect(response.statusCode).toBe(201);
    const body = response.json<{ runnerId: string; token: string }>();
    expect(body.token).toHaveLength(43);

    const [runner] = await harness.db.select().from(runners).where(eq(runners.id, body.runnerId));
    expect(runner?.tokenHash).toBe(sha256(body.token));
    expect(runner?.tokenHash).not.toBe(body.token);
    expect(runner?.ownerUserId).toBe(admin.id);
    expect(runner?.status).toBe('offline');

    const bindings = await harness.db
      .select()
      .from(projectRunners)
      .where(eq(projectRunners.runnerId, body.runnerId));
    expect(bindings).toEqual([{ projectId: project.id, runnerId: body.runnerId }]);

    const second = await register(registrationToken);
    expect(second.statusCode).toBe(401);
    expect(second.json()).toMatchObject({ code: 'AUTH_REQUIRED' });

    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'runner.register'))
      .orderBy(desc(auditLog.at));
    expect(audits).toHaveLength(1);
  });

  it('rejects expired or forged registration tokens', async () => {
    const { cookie } = await setup();
    const registrationToken = await createRegistrationToken(cookie);
    await harness.db
      .update(runnerRegistrationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await register(registrationToken);
    expect(expired.statusCode).toBe(401);
    const forged = await register('not-a-token');
    expect(forged.statusCode).toBe(401);
  });

  it('lists runners for project members only', async () => {
    const { project, cookie } = await setup();
    const registrationToken = await createRegistrationToken(cookie);
    const registered = await register(registrationToken);
    expect(registered.statusCode).toBe(201);
    const adminList = await harness.app.inject({ method: 'GET', url: '/api/runners', headers: cookie });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toEqual(['laptop']);

    const outsider = await seedUser(harness.db);
    const outsiderCookie = authCookie(await seedSession(harness.db, outsider.id));
    const outsiderList = await harness.app.inject({
      method: 'GET',
      url: '/api/runners',
      headers: outsiderCookie,
    });
    expect(outsiderList.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect(project.id).toBeTruthy();
  });

  it('paginates runners with the shared opaque cursor encoding', async () => {
    const { cookie } = await setup();
    for (const name of ['alpha', 'bravo', 'charlie']) {
      const registered = await register(await createRegistrationToken(cookie), name);
      expect(registered.statusCode).toBe(201);
    }
    const first = await harness.app.inject({
      method: 'GET',
      url: '/api/runners?limit=2',
      headers: cookie,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.nextCursor).not.toBe(firstPage.items[1]?.id);

    const second = await harness.app.inject({
      method: 'GET',
      url: `/api/runners?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      headers: cookie,
    });
    const secondPage = second.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((runner) => runner.id))).toHaveLength(3);
  });

  it('rotates and revokes the runner token and audits both', async () => {
    const { cookie } = await setup();
    const registrationToken = await createRegistrationToken(cookie);
    const registered = await register(registrationToken);
    const runnerId = registered.json<{ runnerId: string }>().runnerId;

    const rotated = await harness.app.inject({
      method: 'POST',
      url: `/api/runners/${runnerId}/rotate-token`,
      headers: cookie,
    });
    expect(rotated.statusCode).toBe(200);
    const newToken = rotated.json<{ token: string }>().token;
    const [rotatedRow] = await harness.db.select().from(runners).where(eq(runners.id, runnerId));
    expect(rotatedRow?.tokenHash).toBe(sha256(newToken));

    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `/api/runners/${runnerId}`,
      headers: cookie,
    });
    expect(revoked.statusCode).toBe(204);
    const [revokedRow] = await harness.db.select().from(runners).where(eq(runners.id, runnerId));
    expect(revokedRow?.status).toBe('revoked');
    expect(revokedRow?.revokedAt).toBeInstanceOf(Date);

    const rotateRevoked = await harness.app.inject({
      method: 'POST',
      url: `/api/runners/${runnerId}/rotate-token`,
      headers: cookie,
    });
    expect(rotateRevoked.statusCode).toBe(409);

    const actions = await harness.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .orderBy(desc(auditLog.at));
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'runner.registration_token.create',
        'runner.register',
        'runner.rotate_token',
        'runner.revoke',
      ]),
    );
  });

  it('refuses a registration token for a non-owner', async () => {
    await setup();
    const outsider = await seedUser(harness.db);
    const outsiderCookie = authCookie(await seedSession(harness.db, outsider.id));
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/runners/registration-token',
      headers: outsiderCookie,
    });
    expect(response.statusCode).toBe(403);
  });
});
