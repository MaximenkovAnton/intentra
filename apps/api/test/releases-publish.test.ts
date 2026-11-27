import { generateKeyPairSync, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  hasDatabase,
  resetDatabase,
  type Harness,
} from './harness.js';
import {
  MANIFEST,
  PLACEHOLDER_RELEASE_KEY,
  SIGNATURE,
  manifestFixture,
  manifestWith,
  signManifest,
} from './release-helpers.js';
import { auditLog, releases } from '../src/db/schema.js';

const PUBLISH_TOKEN = 'test-publish-token';

describe.skipIf(!hasDatabase)('release publishing', () => {
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

  const publish = (body: object, token = PUBLISH_TOKEN, target: Harness = harness) =>
    target.app.inject({
      method: 'POST',
      url: '/api/admin/releases',
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });

  const yank = (version: string, yanked: boolean, target: Harness = harness) =>
    target.app.inject({
      method: 'POST',
      url: `/api/admin/releases/${version}/yank`,
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: { yanked },
    });

  it('publishes a signed release, stores the exact bytes and records the audit', async () => {
    const response = await publish({ manifest: MANIFEST, signature: SIGNATURE });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      version: '0.2.0',
      channel: 'stable',
      protocolVersion: 1,
      yanked: false,
    });

    const rows = await harness.db.select().from(releases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifest).toBe(MANIFEST);
    expect(rows[0]?.signature).toBe(SIGNATURE);

    const audits = await harness.db.select().from(auditLog).where(eq(auditLog.action, 'release.publish'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'release.publish',
      actorKind: 'system',
      actorId: 'release',
      target: '0.2.0',
    });
  });

  it('is idempotent for the same signed release', async () => {
    expect((await publish({ manifest: MANIFEST, signature: SIGNATURE })).statusCode).toBe(201);
    expect((await yank('0.2.0', true)).statusCode).toBe(204);
    const repeated = await publish({ manifest: MANIFEST, signature: SIGNATURE });
    expect(repeated.statusCode).toBe(200);

    const rows = await harness.db.select().from(releases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.yanked).toBe(true);
  });

  it('rejects a signature that does not verify with the embedded key', async () => {
    const tampered = MANIFEST.replace('"version":"0.2.0"', '"version":"0.2.1"');
    const tamperedResponse = await publish({ manifest: tampered, signature: SIGNATURE });
    expect(tamperedResponse.statusCode).toBe(400);
    expect(tamperedResponse.json()).toMatchObject({ code: 'VALIDATION' });

    const { privateKey } = generateKeyPairSync('ed25519');
    const foreign = sign(null, Buffer.from(MANIFEST, 'utf8'), privateKey).toString('base64');
    const foreignResponse = await publish({ manifest: MANIFEST, signature: foreign });
    expect(foreignResponse.statusCode).toBe(400);
    expect(foreignResponse.json()).toMatchObject({ code: 'VALIDATION' });

    expect(await harness.db.select().from(releases)).toHaveLength(0);
  });

  it('rejects a manifest for another protocol version', async () => {
    const body = signManifest(manifestWith({ version: '0.3.0', protocolVersion: 2 }));
    const response = await publish(body);
    expect(response.statusCode).toBe(400);
    const error = response.json<{ code: string; message: string }>();
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toBe('manifest protocolVersion must equal 1');
    expect(await harness.db.select().from(releases)).toHaveLength(0);
  });

  it('rejects a manifest that does not match the schema', async () => {
    const fixture = manifestFixture();
    const fourAssets = signManifest({ ...fixture, assets: fixture.assets.slice(0, 4) });
    const cases: Array<Record<string, unknown>> = [
      { manifest: 'not-json', signature: SIGNATURE },
      fourAssets,
      { manifest: MANIFEST },
      { manifest: MANIFEST, signature: 'not-a-signature' },
    ];
    for (const body of cases) {
      const response = await publish(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION' });
    }
    expect(await harness.db.select().from(releases)).toHaveLength(0);
  });

  it('answers 503 when the publish token is not configured', async () => {
    const unconfigured = await createHarness({ RELEASE_PUBLISH_TOKEN: '' });
    try {
      const published = await publish({ manifest: MANIFEST, signature: SIGNATURE }, 'anything', unconfigured);
      expect(published.statusCode).toBe(503);
      expect(published.json()).toMatchObject({
        code: 'RELEASE_DISABLED',
        message: 'release publishing is not configured',
      });
      const yanked = await yank('0.2.0', true, unconfigured);
      expect(yanked.statusCode).toBe(503);
      expect(await unconfigured.db.select().from(releases)).toHaveLength(0);
    } finally {
      await unconfigured.close();
    }
  });

  it('rejects a wrong publish token', async () => {
    const response = await publish({ manifest: MANIFEST, signature: SIGNATURE }, 'wrong-publish-token');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await harness.db.select().from(releases)).toHaveLength(0);
  });

  it('answers 503 while the embedded release key is the placeholder', async () => {
    const placeholder = await createHarness(
      { RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN },
      { releasePublicKey: PLACEHOLDER_RELEASE_KEY },
    );
    try {
      const published = await publish({ manifest: MANIFEST, signature: SIGNATURE }, PUBLISH_TOKEN, placeholder);
      expect(published.statusCode).toBe(503);
      expect(published.json()).toMatchObject({
        code: 'RELEASE_DISABLED',
        message: 'release key is not configured',
      });
      const yanked = await yank('0.2.0', true, placeholder);
      expect(yanked.statusCode).toBe(503);
      expect(await placeholder.db.select().from(releases)).toHaveLength(0);
    } finally {
      await placeholder.close();
    }
  });

  it('rejects an asset above the configured size limit', async () => {
    const limited = await createHarness({ RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN, RELEASE_MAX_ARTIFACT_BYTES: '16' });
    try {
      const response = await publish({ manifest: MANIFEST, signature: SIGNATURE }, PUBLISH_TOKEN, limited);
      expect(response.statusCode).toBe(400);
      const error = response.json<{ code: string; message: string }>();
      expect(error.code).toBe('VALIDATION');
      expect(error.message).toBe('asset exceeds the release size limit');
    } finally {
      await limited.close();
    }
  });

  it('yanks and un-yanks a release and records the audit', async () => {
    await publish({ manifest: MANIFEST, signature: SIGNATURE });
    const yanked = await yank('0.2.0', true);
    expect(yanked.statusCode).toBe(204);
    let [row] = await harness.db.select().from(releases);
    expect(row?.yanked).toBe(true);

    const restored = await yank('0.2.0', false);
    expect(restored.statusCode).toBe(204);
    [row] = await harness.db.select().from(releases);
    expect(row?.yanked).toBe(false);

    const audits = await harness.db.select().from(auditLog).where(eq(auditLog.action, 'release.yank'));
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit).toMatchObject({ action: 'release.yank', actorKind: 'system', target: '0.2.0' });
    }
  });

  it('answers 404 for an unknown version on yank', async () => {
    const response = await yank('9.9.9', true);
    expect(response.statusCode).toBe(404);
    const error = response.json<{ code: string; message: string }>();
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Release not found');
  });
});
