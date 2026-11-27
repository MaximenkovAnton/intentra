import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, hasDatabase, resetDatabase, seedUser, type Harness } from './harness.js';
import { MANIFEST, SIGNATURE, manifestWith, seedRunner, signManifest } from './release-helpers.js';
import { releases, runners } from '../src/db/schema.js';

const PUBLISH_TOKEN = 'test-publish-token';

describe.skipIf(!hasDatabase)('release policy', () => {
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

  const publish = (body: object) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/admin/releases',
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: body,
    });

  const publishFixture = async (): Promise<void> => {
    expect((await publish({ manifest: MANIFEST, signature: SIGNATURE })).statusCode).toBe(201);
  };

  const publishVersion = async (version: string, channel: 'stable' | 'beta'): Promise<void> => {
    const body = signManifest(manifestWith({ version, channel }));
    expect((await publish(body)).statusCode).toBe(201);
  };

  const yank = async (version: string): Promise<void> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/admin/releases/${version}/yank`,
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: { yanked: true },
    });
    expect(response.statusCode).toBe(204);
  };

  const update = (token: string, query = '') =>
    harness.app.inject({
      method: 'GET',
      url: `/api/runners/update${query}`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('offers the newest stable release to an unknown version', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: 'unknown' });
    const response = await update(token);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      available: true,
      channel: 'stable',
      latestVersion: '0.2.0',
      pinnedVersion: null,
      autoUpdate: true,
    });
    expect(body.manifest).toBe(MANIFEST);
    expect(body.signature).toBe(SIGNATURE);
    expect(body).not.toHaveProperty('reason');
  });

  it.each([
    {
      case: 'a newer stable release outranks a beta release in the beta channel',
      stable: '0.4.0',
      beta: '0.3.0-beta.1',
      channel: 'beta' as const,
      expected: '0.4.0',
    },
    {
      case: 'a newer beta release outranks a stable release in the beta channel',
      stable: '0.2.0',
      beta: '0.3.0-beta.1',
      channel: 'beta' as const,
      expected: '0.3.0-beta.1',
    },
    {
      case: 'the stable channel stays on stable while a beta release is newer',
      stable: '0.2.0',
      beta: '0.3.0-beta.1',
      channel: 'stable' as const,
      expected: '0.2.0',
    },
  ])('offers the SemVer maximum of the channel pool: $case', async ({ stable, beta, channel, expected }) => {
    await publishVersion(stable, 'stable');
    await publishVersion(beta, 'beta');
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: 'unknown' });
    const response = await update(token, `?channel=${channel}`);
    expect(response.statusCode).toBe(200);
    const body = response.json<{ channel: string; latestVersion: string; manifest: string }>();
    expect(body.channel).toBe(channel);
    expect(body.latestVersion).toBe(expected);
    expect(JSON.parse(body.manifest).version).toBe(expected);
  });

  it('never offers a release that is not newer', async () => {
    await publishFixture();
    await publishVersion('0.2.0-beta.1', 'beta');
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.2.0' });

    for (const query of ['', '?channel=beta']) {
      const response = await update(token, query);
      expect(response.statusCode).toBe(200);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({ available: false, reason: 'no newer version' });
      expect(body).not.toHaveProperty('manifest');
      expect(body).not.toHaveProperty('signature');
    }

    await yank('0.2.0');
    const betaOnly = await update(token, '?channel=beta');
    expect(betaOnly.statusCode).toBe(200);
    expect(betaOnly.json()).toMatchObject({ available: false, latestVersion: '0.2.0-beta.1', reason: 'no newer version' });
  });

  it('does not offer a yanked release', async () => {
    await publishFixture();
    await yank('0.2.0');
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    const response = await update(token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: false,
      latestVersion: null,
      reason: 'no newer version',
    });
  });

  it('does not offer a release for another protocol version', async () => {
    await harness.db.insert(releases).values({
      version: '0.3.0',
      channel: 'stable',
      protocolVersion: 2,
      manifest: MANIFEST,
      signature: SIGNATURE,
      notes: '',
      publishedAt: new Date('2026-11-27T18:00:00Z'),
    });
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    const response = await update(token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: false,
      latestVersion: null,
      reason: 'no newer version',
    });
  });

  it('a pin overrides the channel', async () => {
    await publishFixture();
    await publishVersion('0.3.0-beta.1', 'beta');
    const owner = await seedUser(harness.db);
    const { runner, token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    await harness.db.update(runners).set({ pinnedVersion: '0.3.0-beta.1' }).where(eq(runners.id, runner.id));

    const response = await update(token, '?channel=stable');
    expect(response.statusCode).toBe(200);
    const body = response.json<{ pinnedVersion: string; latestVersion: string; manifest: string }>();
    expect(body).toMatchObject({
      available: true,
      pinnedVersion: '0.3.0-beta.1',
      latestVersion: '0.2.0',
    });
    expect(JSON.parse(body.manifest).version).toBe('0.3.0-beta.1');
  });

  it('does not offer the version the runner already runs', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const { runner, token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.2.0' });
    await harness.db.update(runners).set({ pinnedVersion: '0.2.0' }).where(eq(runners.id, runner.id));
    const response = await update(token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: false,
      pinnedVersion: '0.2.0',
      reason: 'already on the pinned version',
    });
  });

  it('does not offer an unavailable pin', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const unknown = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    await harness.db.update(runners).set({ pinnedVersion: '9.9.9' }).where(eq(runners.id, unknown.runner.id));
    const unknownPin = await update(unknown.token);
    expect(unknownPin.json()).toMatchObject({ available: false, reason: 'pinned version is unavailable' });

    await yank('0.2.0');
    const yankedPin = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    await harness.db.update(runners).set({ pinnedVersion: '0.2.0' }).where(eq(runners.id, yankedPin.runner.id));
    const yankedResponse = await update(yankedPin.token);
    expect(yankedResponse.json()).toMatchObject({ available: false, reason: 'pinned version is unavailable' });
  });

  it('treats an invalid current version as unknown', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: 'not-a-version' });
    const response = await update(token, '?current=not-a-version');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, latestVersion: '0.2.0' });
  });

  it('reads an explicit current version over an invalid stored one', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const { token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: 'not-a-version' });
    const same = await update(token, '?current=0.2.0');
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ available: false, reason: 'no newer version' });
    const older = await update(token, '?current=0.1.0');
    expect(older.statusCode).toBe(200);
    expect(older.json()).toMatchObject({ available: true, latestVersion: '0.2.0' });
  });

  it('uses the stored runner version when the query omits current', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const current = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.2.0' });
    expect((await update(current.token)).json()).toMatchObject({
      available: false,
      reason: 'no newer version',
    });

    const older = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    expect((await update(older.token)).json()).toMatchObject({ available: true, latestVersion: '0.2.0' });
  });

  it('returns the manifest when auto-update is disabled', async () => {
    await publishFixture();
    const owner = await seedUser(harness.db);
    const { runner, token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });
    await harness.db.update(runners).set({ autoUpdate: false }).where(eq(runners.id, runner.id));
    const response = await update(token);
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ available: true, autoUpdate: false, reason: 'auto-update is disabled' });
    expect(body.manifest).toBe(MANIFEST);
    expect(body.signature).toBe(SIGNATURE);
  });

  it('rejects a missing or revoked runner token', async () => {
    const owner = await seedUser(harness.db);
    const { runner, token } = await seedRunner(harness.db, { ownerUserId: owner.id, version: '0.1.0' });

    const missing = await harness.app.inject({ method: 'GET', url: '/api/runners/update' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ code: 'AUTH_REQUIRED' });

    await harness.db.update(runners).set({ revokedAt: new Date() }).where(eq(runners.id, runner.id));
    const revoked = await update(token);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
