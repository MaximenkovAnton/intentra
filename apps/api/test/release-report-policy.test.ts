import { desc, eq } from 'drizzle-orm';
import type { SseEvent } from '@intentra/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  type Harness,
} from './harness.js';
import { MANIFEST, SIGNATURE, bearer, bindRunner, seedRunner } from './release-helpers.js';
import { auditLog, runnerUpdateEvents, runners } from '../src/db/schema.js';

const PUBLISH_TOKEN = 'test-publish-token';

describe.skipIf(!hasDatabase)('release reports and update policy', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN });
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const publishFixture = async (): Promise<void> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/releases',
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: { manifest: MANIFEST, signature: SIGNATURE },
    });
    expect(response.statusCode).toBe(201);
  };

  const setup = async () => {
    const owner = await seedUser(harness.db, { name: 'Owner' });
    const project = await seedProject(harness.db, owner.id, 'acme');
    const runner = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    await bindRunner(harness.db, project.id, runner.runner.id);
    const cookie = authCookie(await seedSession(harness.db, owner.id));
    return { owner, project, runner, cookie };
  };

  const report = (token: string, payload: object) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/runners/update/report',
      headers: bearer(token),
      payload,
    });

  const changePolicy = (runnerId: string, cookie: Record<string, string>, payload: object) =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/runners/${runnerId}/update-policy`,
      headers: cookie,
      payload,
    });

  const listRunners = (cookie: Record<string, string>) =>
    harness.app.inject({ method: 'GET', url: '/api/runners', headers: cookie });

  const captureEvents = (): SseEvent[] => {
    const seen: SseEvent[] = [];
    harness.events.subscribe((event) => seen.push(event));
    return seen;
  };

  it('records an update report and publishes runner.updated', async () => {
    const { owner, project, runner } = await setup();
    const extra = await seedProject(harness.db, owner.id, 'beta');
    await bindRunner(harness.db, extra.id, runner.runner.id);
    const events = captureEvents();

    const response = await report(runner.token, {
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      status: 'applied',
    });
    expect(response.statusCode).toBe(204);

    const [row] = await harness.db.select().from(runnerUpdateEvents);
    expect(row).toMatchObject({
      runnerId: runner.runner.id,
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      status: 'applied',
      reason: null,
    });

    const updates = events.filter((event) => event.type === 'runner.updated');
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((event) => event.projectId))).toEqual(new Set([project.id, extra.id]));
    for (const event of updates) {
      expect(event.data).toEqual({ runnerId: runner.runner.id, version: '0.2.0', status: 'applied' });
    }
  });

  it('rejects an invalid update report', async () => {
    const { runner } = await setup();
    const response = await report(runner.token, { fromVersion: '0.1.0', toVersion: '0.2.0', status: 'ok' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
    expect(await harness.db.select().from(runnerUpdateEvents)).toHaveLength(0);
  });

  it('lets the owner and an admin change the update policy and records the audit', async () => {
    const { owner, runner, cookie } = await setup();
    const admin = await seedUser(harness.db, { isAdmin: true, name: 'Admin' });
    const adminCookie = authCookie(await seedSession(harness.db, admin.id));

    expect((await changePolicy(runner.runner.id, cookie, { pinnedVersion: '0.1.0', autoUpdate: false })).statusCode).toBe(
      204,
    );
    expect(
      (await changePolicy(runner.runner.id, adminCookie, { pinnedVersion: '0.1.0', autoUpdate: false })).statusCode,
    ).toBe(204);

    const [row] = await harness.db.select().from(runners).where(eq(runners.id, runner.runner.id));
    expect(row?.pinnedVersion).toBe('0.1.0');
    expect(row?.autoUpdate).toBe(false);

    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'runner.update_policy'))
      .orderBy(desc(auditLog.at));
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({ actorKind: 'user', target: runner.runner.id });
      expect(audit.meta).toEqual({ pinnedVersion: '0.1.0', autoUpdate: false });
    }
    expect(new Set(audits.map((audit) => audit.actorId))).toEqual(new Set([owner.id, admin.id]));
  });

  it('refuses a policy change from a foreign user', async () => {
    const { runner } = await setup();
    const outsider = await seedUser(harness.db);
    const outsiderCookie = authCookie(await seedSession(harness.db, outsider.id));
    const response = await changePolicy(runner.runner.id, outsiderCookie, {
      pinnedVersion: '0.1.0',
      autoUpdate: false,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await harness.db.select().from(runners).where(eq(runners.id, runner.runner.id));
    expect(row?.pinnedVersion).toBeNull();
    expect(row?.autoUpdate).toBe(true);
  });

  it('rejects an invalid update policy', async () => {
    const { runner, cookie } = await setup();
    for (const payload of [{ pinnedVersion: 'v0.1.0', autoUpdate: true }, { pinnedVersion: null }]) {
      const response = await changePolicy(runner.runner.id, cookie, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION' });
    }
  });

  it('publishes runner.updated when the policy changes', async () => {
    const { project, runner, cookie } = await setup();
    const events = captureEvents();
    const response = await changePolicy(runner.runner.id, cookie, { pinnedVersion: '0.1.0', autoUpdate: false });
    expect(response.statusCode).toBe(204);
    const updates = events.filter((event) => event.type === 'runner.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.projectId).toBe(project.id);
    expect(updates[0]?.data).toEqual({ runnerId: runner.runner.id, pinnedVersion: '0.1.0', autoUpdate: false });
  });

  it('returns the update read model for each runner', async () => {
    await publishFixture();
    const { runner, cookie } = await setup();

    const before = await listRunners(cookie);
    expect(before.statusCode).toBe(200);
    const [listed] = before.json<{ items: Record<string, unknown>[] }>().items;
    expect(listed).toMatchObject({
      id: runner.runner.id,
      pinnedVersion: null,
      autoUpdate: true,
      latestVersion: '0.2.0',
      updateAvailable: true,
      lastUpdate: null,
    });

    expect(
      (await report(runner.token, { fromVersion: '0.1.0', toVersion: '0.2.0', status: 'applied' })).statusCode,
    ).toBe(204);

    const after = await listRunners(cookie);
    const [updated] = after.json<{ items: { lastUpdate: Record<string, unknown> }[] }>().items;
    expect(updated?.lastUpdate).toMatchObject({
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      status: 'applied',
      reason: null,
    });
    const createdAt = updated?.lastUpdate.createdAt;
    expect(typeof createdAt).toBe('string');
    expect(new Date(String(createdAt)).toISOString()).toBe(createdAt);
  });

  it('keeps latestVersion independent of the pin', async () => {
    await publishFixture();
    const { runner, cookie } = await setup();
    expect(
      (await changePolicy(runner.runner.id, cookie, { pinnedVersion: '0.1.0', autoUpdate: true })).statusCode,
    ).toBe(204);

    const response = await listRunners(cookie);
    const [listed] = response.json<{ items: Record<string, unknown>[] }>().items;
    expect(listed).toMatchObject({
      pinnedVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: false,
    });
  });
});
