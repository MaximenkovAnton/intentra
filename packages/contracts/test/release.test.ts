import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  ChannelSchema,
  ReleasePublishInputSchema,
  ReleaseSchema,
  RunnerUpdateSchema,
  SemVerSchema,
  SignatureSchema,
  UpdateAssetSchema,
  UpdateManifestSchema,
  UpdatePolicyInputSchema,
  UpdateReportInputSchema,
  type Release,
  type ReleasePublishInput,
  type RunnerUpdate,
  type UpdateAsset,
  type UpdateManifest,
  type UpdatePolicyInput,
  type UpdateReportInput,
} from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/release/${name}`, import.meta.url)), 'utf8');

const manifestBytes = readFileSync(
  fileURLToPath(new URL('../../../fixtures/release/manifest.json', import.meta.url)),
);
const MANIFEST_JSON = manifestBytes.toString('utf8');
const MANIFEST_SIG = fixture('manifest.sig').trim();
const TEST_PUB = fixture('test.pub').trim();
const TEST_SEED = fixture('test.seed').trim();
const PLACEHOLDER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const publicKeyFromRaw = (rawBase64: string) =>
  createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawBase64, 'base64')]),
    format: 'der',
    type: 'spki',
  });

const verifyFixture = (bytes: Buffer, signatureBase64: string, publicKeyBase64: string): boolean =>
  verify(null, bytes, publicKeyFromRaw(publicKeyBase64), Buffer.from(signatureBase64, 'base64'));

const fixtureManifest = UpdateManifestSchema.parse(JSON.parse(MANIFEST_JSON));

function firstAsset(): UpdateAsset {
  const [asset] = fixtureManifest.assets;
  if (asset === undefined) {
    throw new Error('release fixture must carry assets');
  }
  return asset;
}

function withFirstAsset(overrides: Partial<UpdateAsset>): unknown {
  return {
    ...fixtureManifest,
    assets: [{ ...firstAsset(), ...overrides }, ...fixtureManifest.assets.slice(1)],
  };
}

describe('release manifest contract', () => {
  it('parses the shared manifest fixture into the contract literals', () => {
    const manifest = UpdateManifestSchema.parse(JSON.parse(MANIFEST_JSON));
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.assets).toHaveLength(5);
    expect(manifest.assets.map((asset) => asset.target)).toEqual([
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
      'x86_64-pc-windows-msvc',
    ]);
    expect(manifest.assets.map((asset) => asset.sha256)).toEqual([
      '0294240bb72986e3f97d8188eb28a9ffc4d9a119683f269ffac658bd3eb664ea',
      'e8c58faa9002fa24d88073aad22c7354c1e5d2d7124bd67132f3d635da36a010',
      '38f65af3ad37681f3d767eda97949df06b10e6f1aef6aa60176933539217b348',
      'c1861226d6643dec660cd6942ff0c8c5bd5afbcfb0d9607bef063f0eb18ecec1',
      '8a6f81197ea82d56bba33bca18f2bee3661fc1b4fa7d3743a254ed9f130a2eb7',
    ]);
  });

  it('verifies the fixture signature with the test public key', () => {
    expect(verifyFixture(manifestBytes, MANIFEST_SIG, TEST_PUB)).toBe(true);
  });

  it('rejects a manifest whose bytes changed after signing', () => {
    const tampered = Buffer.from(manifestBytes);
    tampered.writeUInt8(tampered.readUInt8(10) ^ 0x01, 10);
    expect(verifyFixture(tampered, MANIFEST_SIG, TEST_PUB)).toBe(false);
  });

  it('rejects the fixture signature under a foreign public key', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const foreignRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    expect(verifyFixture(manifestBytes, MANIFEST_SIG, foreignRaw)).toBe(false);
  });

  it('rejects unknown fields on the manifest and the update response', () => {
    expect(UpdateManifestSchema.safeParse({ ...fixtureManifest, extra: true }).success).toBe(false);
    expect(
      RunnerUpdateSchema.safeParse({
        available: false,
        channel: 'stable',
        latestVersion: null,
        pinnedVersion: null,
        autoUpdate: true,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('enforces the manifest and signature invariant on the update response', () => {
    const base = { channel: 'stable', latestVersion: '0.2.0', pinnedVersion: null, autoUpdate: true } as const;
    const rejected = [
      { ...base, available: false, manifest: MANIFEST_JSON, signature: MANIFEST_SIG },
      { ...base, available: true, signature: MANIFEST_SIG },
      { ...base, available: true, manifest: MANIFEST_JSON },
      { ...base, available: true },
    ];
    for (const candidate of rejected) {
      expect(RunnerUpdateSchema.safeParse(candidate).success).toBe(false);
    }
    const accepted = [
      { ...base, available: true, manifest: MANIFEST_JSON, signature: MANIFEST_SIG },
      { available: false, channel: 'stable', latestVersion: null, pinnedVersion: null, autoUpdate: true },
      {
        available: false,
        channel: 'stable',
        latestVersion: null,
        pinnedVersion: null,
        autoUpdate: false,
        reason: 'pinned by admin',
      },
    ];
    for (const candidate of accepted) {
      expect(RunnerUpdateSchema.safeParse(candidate).success).toBe(true);
    }
  });

  it('rejects asset sets that are not exactly one per target', () => {
    const assets = fixtureManifest.assets;
    const [first, second] = assets;
    if (first === undefined || second === undefined) {
      throw new Error('release fixture must carry at least two assets');
    }
    const rejected: unknown[] = [
      { ...fixtureManifest, assets: assets.slice(0, 4) },
      { ...fixtureManifest, assets: [...assets, first] },
      { ...fixtureManifest, assets: [first, { ...second, target: first.target }, ...assets.slice(2)] },
      { ...fixtureManifest, assets: [first, { ...second, fileName: first.fileName }, ...assets.slice(2)] },
    ];
    for (const candidate of rejected) {
      expect(UpdateManifestSchema.safeParse(candidate).success).toBe(false);
    }
    expect(UpdateManifestSchema.safeParse({ ...fixtureManifest, assets }).success).toBe(true);
  });

  it('validates semver, sha256, https url and manifest header fields', () => {
    const cases: Array<[string, unknown, boolean]> = [
      ['release semver', { ...fixtureManifest, version: '0.2.0' }, true],
      ['prerelease semver', { ...fixtureManifest, version: '0.2.0-beta.1' }, true],
      ['prerelease with build metadata', { ...fixtureManifest, version: '0.2.0-rc.1+build.5' }, true],
      ['v-prefixed semver', { ...fixtureManifest, version: 'v0.2.0' }, false],
      ['two-part semver', { ...fixtureManifest, version: '0.2' }, false],
      ['empty prerelease', { ...fixtureManifest, version: '0.2.0-' }, false],
      ['leading zero prerelease', { ...fixtureManifest, version: '0.2.0-01' }, false],
      ['leading zero major', { ...fixtureManifest, version: '01.2.3' }, false],
      ['uppercase sha256', withFirstAsset({ sha256: 'A'.repeat(64) }), false],
      ['short sha256', withFirstAsset({ sha256: '0'.repeat(63) }), false],
      ['http url', withFirstAsset({ url: 'http://example.com/runner.tar.gz' }), false],
      ['ftp url', withFirstAsset({ url: 'ftp://example.com/runner.tar.gz' }), false],
      ['non-url', withFirstAsset({ url: 'not a url' }), false],
      ['https url', withFirstAsset({ url: 'https://example.com/runner.tar.gz' }), true],
      ['schemaVersion 2', { ...fixtureManifest, schemaVersion: 2 }, false],
      ['protocolVersion 0', { ...fixtureManifest, protocolVersion: 0 }, false],
      ['protocolVersion fractional', { ...fixtureManifest, protocolVersion: 1.5 }, false],
      ['sizeBytes 0', withFirstAsset({ sizeBytes: 0 }), false],
      ['sizeBytes negative', withFirstAsset({ sizeBytes: -1 }), false],
      ['empty fileName', withFirstAsset({ fileName: '' }), false],
      ['publishedAt offset', { ...fixtureManifest, publishedAt: '2026-11-27T18:00:00+03:00' }, false],
      ['publishedAt space', { ...fixtureManifest, publishedAt: '2026-11-27 18:00:00Z' }, false],
      ['publishedAt without fraction', { ...fixtureManifest, publishedAt: '2026-11-27T18:00:00Z' }, true],
      ['publishedAt milliseconds', { ...fixtureManifest, publishedAt: '2026-11-27T18:00:00.000Z' }, true],
      ['protocolVersion 1', { ...fixtureManifest, protocolVersion: 1 }, true],
      ['sizeBytes 1', withFirstAsset({ sizeBytes: 1 }), true],
    ];
    for (const [name, input, valid] of cases) {
      expect(UpdateManifestSchema.safeParse(input).success, name).toBe(valid);
    }
  });

  it('accepts valid publish, policy, report and release examples', () => {
    expect(
      ReleasePublishInputSchema.safeParse({ manifest: '{"schemaVersion":1}', signature: MANIFEST_SIG }).success,
    ).toBe(true);
    expect(ReleasePublishInputSchema.safeParse({ signature: MANIFEST_SIG }).success).toBe(false);
    expect(UpdatePolicyInputSchema.safeParse({ pinnedVersion: '0.2.0', autoUpdate: true }).success).toBe(true);
    expect(UpdatePolicyInputSchema.safeParse({ pinnedVersion: null, autoUpdate: false }).success).toBe(true);
    expect(UpdatePolicyInputSchema.safeParse({ pinnedVersion: null }).success).toBe(false);
    expect(
      UpdateReportInputSchema.safeParse({ fromVersion: '0.1.0', toVersion: '0.2.0', status: 'applied' }).success,
    ).toBe(true);
    expect(
      UpdateReportInputSchema.safeParse({ fromVersion: '0.1.0', toVersion: '0.2.0', status: 'ok' }).success,
    ).toBe(false);
    const release = {
      version: '0.2.0',
      channel: 'stable',
      protocolVersion: 1,
      publishedAt: '2026-11-27T18:00:00Z',
      yanked: false,
      manifest: '{"schemaVersion":1}',
      signature: MANIFEST_SIG,
      notes: '',
    };
    expect(ReleaseSchema.safeParse(release).success).toBe(true);
    expect(ReleaseSchema.safeParse({ ...release, yanked: 'false' }).success).toBe(false);
  });

  it('exports the release schemas and types from the package root', () => {
    for (const schema of [
      UpdateAssetSchema,
      UpdateManifestSchema,
      ReleasePublishInputSchema,
      RunnerUpdateSchema,
      UpdatePolicyInputSchema,
      UpdateReportInputSchema,
      ReleaseSchema,
      SemVerSchema,
      SignatureSchema,
      ChannelSchema,
    ]) {
      expect(schema).toBeDefined();
    }
    expectTypeOf<z.infer<typeof UpdateAssetSchema>>().toEqualTypeOf<UpdateAsset>();
    expectTypeOf<z.infer<typeof UpdateManifestSchema>>().toEqualTypeOf<UpdateManifest>();
    expectTypeOf<z.infer<typeof ReleasePublishInputSchema>>().toEqualTypeOf<ReleasePublishInput>();
    expectTypeOf<z.infer<typeof RunnerUpdateSchema>>().toEqualTypeOf<RunnerUpdate>();
    expectTypeOf<z.infer<typeof UpdatePolicyInputSchema>>().toEqualTypeOf<UpdatePolicyInput>();
    expectTypeOf<z.infer<typeof UpdateReportInputSchema>>().toEqualTypeOf<UpdateReportInput>();
    expectTypeOf<z.infer<typeof ReleaseSchema>>().toEqualTypeOf<Release>();
  });

  it('fixture keys and signature have the documented raw byte lengths', () => {
    expect(Buffer.from(TEST_PUB, 'base64')).toHaveLength(32);
    expect(Buffer.from(TEST_SEED, 'base64')).toHaveLength(32);
    expect(Buffer.from(MANIFEST_SIG, 'base64')).toHaveLength(64);
    expect(TEST_PUB).not.toBe(PLACEHOLDER);
  });
});
