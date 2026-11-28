import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, hasDatabase, resetDatabase, seedUser, type Harness } from './harness.js';
import {
  FakeArtifactSource,
  manifestFixture,
  seedRunner,
  sha256Hex,
  signManifest,
  type SeededRunner,
} from './release-helpers.js';

const PUBLISH_TOKEN = 'test-publish-token';

interface ReleaseBody {
  readonly body: { manifest: string; signature: string };
  readonly fileName: string;
  readonly sha256: string;
}

describe.skipIf(!hasDatabase)('release artifacts', () => {
  let harness: Harness;
  let source: FakeArtifactSource;
  let cacheDir: string;

  beforeAll(async () => {
    source = new FakeArtifactSource();
    cacheDir = await mkdtemp(join(tmpdir(), 'intentra-artifacts-'));
    harness = await createHarness(
      { RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN },
      { releaseArtifactSource: source, releaseCacheDir: cacheDir },
    );
  });
  afterAll(async () => {
    await harness.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
    source.clear();
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
  });

  const releaseBody = (
    bytes: Buffer,
    version: string,
    options: { sizeBytes?: number; allSizeBytes?: number; sha256?: string } = {},
  ): ReleaseBody => {
    const fileName = `intentra-runner-${version}-x86_64-unknown-linux-gnu.tar.gz`;
    const fixture = manifestFixture();
    const assets = fixture.assets.map((asset, index) =>
      index === 0
        ? {
            ...asset,
            fileName,
            sizeBytes: options.sizeBytes ?? bytes.length,
            sha256: options.sha256 ?? sha256Hex(bytes),
          }
        : { ...asset, ...(options.allSizeBytes === undefined ? {} : { sizeBytes: options.allSizeBytes }) },
    );
    return { body: signManifest({ ...fixture, version, assets }), fileName, sha256: sha256Hex(bytes) };
  };

  const publish = async (release: ReleaseBody, target: Harness = harness): Promise<void> => {
    const response = await target.app.inject({
      method: 'POST',
      url: '/api/admin/releases',
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: release.body,
    });
    expect(response.statusCode).toBe(201);
  };

  const runnerWithToken = async (target: Harness = harness): Promise<SeededRunner> => {
    const owner = await seedUser(target.db);
    return seedRunner(target.db, { ownerUserId: owner.id, version: '0.1.0' });
  };

  const getArtifact = (fileName: string, token: string, target: Harness = harness) =>
    target.app.inject({
      method: 'GET',
      url: `/api/runners/update/artifact/${fileName}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const digestOf = (bytes: Buffer): string => `sha-256=${createHash('sha256').update(bytes).digest('base64')}`;

  it('streams the artifact bytes with the digest and caches them by sha256', async () => {
    const bytes = Buffer.from('release artifact bytes for the cache test');
    const release = releaseBody(bytes, '0.2.1');
    await publish(release);
    const { token } = await runnerWithToken();
    source.push(bytes);

    const response = await getArtifact(release.fileName, token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-length']).toBe(String(bytes.length));
    expect(response.headers.digest).toBe(digestOf(bytes));
    expect(response.rawPayload.equals(bytes)).toBe(true);
    expect(await readdir(cacheDir)).toContain(release.sha256);
    expect(source.calls).toHaveLength(1);
  });

  it('serves a second request from the cache without calling the source', async () => {
    const bytes = Buffer.from('cached artifact bytes');
    const release = releaseBody(bytes, '0.2.2');
    await publish(release);
    const { token } = await runnerWithToken();
    source.push(bytes);

    const first = await getArtifact(release.fileName, token);
    const second = await getArtifact(release.fileName, token);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.rawPayload.equals(bytes)).toBe(true);
    expect(second.rawPayload.equals(bytes)).toBe(true);
    expect(source.calls).toHaveLength(1);
    const entries = await readdir(cacheDir);
    expect(entries.filter((entry) => entry === release.sha256)).toHaveLength(1);
    expect(entries.some((entry) => entry.startsWith('.tmp-'))).toBe(false);
  });

  it('collapses concurrent downloads of the same sha256 into one source call', async () => {
    const bytes = Buffer.from('concurrent artifact bytes');
    const release = releaseBody(bytes, '0.2.3');
    await publish(release);
    const { token } = await runnerWithToken();
    const deferred = source.pushDeferred();

    const first = getArtifact(release.fileName, token);
    const second = getArtifact(release.fileName, token);
    await vi.waitFor(() => expect(source.calls).toHaveLength(1));
    deferred.resolve(bytes);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.rawPayload.equals(bytes)).toBe(true);
    expect(secondResponse.rawPayload.equals(bytes)).toBe(true);
    expect(source.calls).toHaveLength(1);
  });

  it('rejects bytes that do not match the manifest sha256', async () => {
    const bytes = Buffer.from('expected artifact bytes');
    const release = releaseBody(bytes, '0.2.4');
    await publish(release);
    const { token } = await runnerWithToken();
    source.push(Buffer.from('tampered artifact bytes'));

    const response = await getArtifact(release.fileName, token);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: 'UPSTREAM_FAILED' });
    const entries = await readdir(cacheDir);
    expect(entries).not.toContain(release.sha256);
    expect(entries.some((entry) => entry.startsWith('.tmp-'))).toBe(false);
  });

  it('answers 502 when the source fails, exceeds the limit or times out', async () => {
    const failing = Buffer.from('failing source bytes');
    const failingRelease = releaseBody(failing, '0.2.5');
    await publish(failingRelease);
    const failingRunner = await runnerWithToken();
    source.pushError(new Error('source is down'));
    const failed = await getArtifact(failingRelease.fileName, failingRunner.token);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: 'UPSTREAM_FAILED' });

    const limitDir = await mkdtemp(join(tmpdir(), 'intentra-artifacts-limit-'));
    const limitSource = new FakeArtifactSource();
    const limited = await createHarness(
      { RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN, RELEASE_MAX_ARTIFACT_BYTES: '16' },
      { releaseArtifactSource: limitSource, releaseCacheDir: limitDir },
    );
    try {
      const oversize = Buffer.alloc(32, 7);
      const oversizeRelease = releaseBody(oversize, '0.2.6', { sizeBytes: 10, allSizeBytes: 10 });
      await publish(oversizeRelease, limited);
      const limitRunner = await runnerWithToken(limited);
      limitSource.push(oversize);
      const exceeded = await getArtifact(oversizeRelease.fileName, limitRunner.token, limited);
      expect(exceeded.statusCode).toBe(502);
      expect(exceeded.json()).toMatchObject({ code: 'UPSTREAM_FAILED' });
    } finally {
      await limited.close();
      await rm(limitDir, { recursive: true, force: true });
    }

    const timeoutDir = await mkdtemp(join(tmpdir(), 'intentra-artifacts-timeout-'));
    const timeoutSource = new FakeArtifactSource();
    const timingOut = await createHarness(
      { RELEASE_PUBLISH_TOKEN: PUBLISH_TOKEN },
      { releaseArtifactSource: timeoutSource, releaseCacheDir: timeoutDir, releaseFetchTimeoutMs: 20 },
    );
    try {
      const slow = Buffer.from('slow artifact bytes');
      const slowRelease = releaseBody(slow, '0.2.7');
      await publish(slowRelease, timingOut);
      const slowRunner = await runnerWithToken(timingOut);
      timeoutSource.pushDelayed(slow, 200);
      const timedOut = await getArtifact(slowRelease.fileName, slowRunner.token, timingOut);
      expect(timedOut.statusCode).toBe(502);
      expect(timedOut.json()).toMatchObject({ code: 'UPSTREAM_FAILED' });
    } finally {
      await timingOut.close();
      await rm(timeoutDir, { recursive: true, force: true });
    }
  });

  it('classifies_a_local_cache_failure_as_500', async () => {
    const bytes = Buffer.from('rename phase failure bytes');
    const release = releaseBody(bytes, '0.2.9');
    await publish(release);
    const { token } = await runnerWithToken();
    const deferred = source.pushDeferred();

    const pending = getArtifact(release.fileName, token);
    await vi.waitFor(() => expect(source.calls).toHaveLength(1));
    await mkdir(join(cacheDir, release.sha256), { recursive: true });
    deferred.resolve(bytes);

    const response = await pending;
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL', message: 'release cache is unavailable' });
    expect(response.body).not.toContain(cacheDir);
    expect((await readdir(cacheDir)).some((entry) => entry.startsWith('.tmp-'))).toBe(false);
  });

  it('reports_a_corrupt_cache_entry_as_500', async () => {
    const bytes = Buffer.from('corrupt cache entry bytes');
    const release = releaseBody(bytes, '0.2.10');
    await publish(release);
    const { token } = await runnerWithToken();
    source.push(bytes);
    await mkdir(join(cacheDir, release.sha256), { recursive: true });

    const response = await getArtifact(release.fileName, token);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL', message: 'release cache is unavailable' });
    expect(response.body).not.toContain(cacheDir);
    expect(source.calls).toHaveLength(0);
  });

  it('reports_an_uncreatable_cache_directory_as_500', async () => {
    const bytes = Buffer.from('uncreatable cache directory bytes');
    const release = releaseBody(bytes, '0.2.11');
    await publish(release);
    const { token } = await runnerWithToken();
    source.push(bytes);
    await rm(cacheDir, { recursive: true, force: true });
    await symlink(join(tmpdir(), `intentra-missing-${randomUUID()}`), cacheDir);

    const response = await getArtifact(release.fileName, token);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL', message: 'release cache is unavailable' });
    expect(response.body).not.toContain(cacheDir);
  });

  it('answers 404 for an unknown or yanked artifact', async () => {
    const { token } = await runnerWithToken();
    const unauthenticated = await harness.app.inject({
      method: 'GET',
      url: '/api/runners/update/artifact/nope.tar.gz',
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ code: 'AUTH_REQUIRED' });

    const unknown = await getArtifact('nope.tar.gz', token);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });

    const bytes = Buffer.from('yanked artifact bytes');
    const release = releaseBody(bytes, '0.2.8');
    await publish(release);
    const yankResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/admin/releases/0.2.8/yank',
      headers: { authorization: `Bearer ${PUBLISH_TOKEN}` },
      payload: { yanked: true },
    });
    expect(yankResponse.statusCode).toBe(204);
    const yanked = await getArtifact(release.fileName, token);
    expect(yanked.statusCode).toBe(404);
    expect(yanked.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
