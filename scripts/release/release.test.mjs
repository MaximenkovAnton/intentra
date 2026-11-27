import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import { deriveChannel } from './channel.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const REPO = 'https://github.com/MaximenkovAnton/intentra';

const contractsPath = join(ROOT, 'packages/contracts/dist/index.js');
if (!existsSync(contractsPath)) {
  throw new Error(`${contractsPath} is missing; run pnpm --filter @intentra/contracts build`);
}
const { PROTOCOL_VERSION, TargetSchema, UpdateManifestSchema } = await import(
  pathToFileURL(contractsPath).href
);
const TARGETS = TargetSchema.options;

const workspaceVersion = () => {
  const section = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8')
    .split(/^\[/m)
    .find((part) => part.startsWith('workspace.package]'));
  return /^version = "([^"]+)"/m.exec(section)[1];
};
const version = workspaceVersion();

const rawPublicKey = (path) => {
  const raw = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  assert.equal(raw.length, 32);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
};

const fixtureSeed = readFileSync(join(ROOT, 'fixtures/release/test.seed'), 'utf8').trim();

const makeAssets = () => {
  const dir = mkdtempSync(join(tmpdir(), 'intentra-release-assets-'));
  for (const target of TARGETS) {
    const extension = target === 'x86_64-pc-windows-msvc' ? '.zip' : '.tar.gz';
    const fileName = `intentra-runner-${version}-${target}${extension}`;
    writeFileSync(join(dir, fileName), Buffer.from(`archive:${target}:${version}`));
  }
  return dir;
};

const runManifest = (args, env = {}) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts/release/manifest.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('deriveChannel reads the SemVer prerelease and ignores build metadata', () => {
  for (const [candidate, expected] of [
    ['0.2.0', 'stable'],
    ['0.2.0-beta.1', 'beta'],
    ['0.2.0+build-1', 'stable'],
    ['0.2.0-beta.1+build-1', 'beta'],
  ]) {
    assert.equal(deriveChannel(candidate), expected, candidate);
  }
});

test('package.sh rejects a tag that does not match the workspace version', () => {
  const result = spawnSync(
    'bash',
    [join(ROOT, 'scripts/release/package.sh'), 'x86_64-unknown-linux-gnu'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: 'v9.9.9' },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`v9\\.9\\.9 does not match the workspace version v${version}`));
});

test('manifest.mjs writes a manifest the shared schema accepts and signs it', () => {
  const assets = makeAssets();
  const result = runManifest(
    [
      '--version',
      version,
      '--assets',
      assets,
      '--out',
      join(assets, 'out'),
      '--published-at',
      '2026-11-27T18:00:00Z',
      '--public-key',
      join(ROOT, 'fixtures/release/test.pub'),
      '--notes-out',
      join(assets, 'notes.md'),
    ],
    { RELEASE_SIGNING_KEY: fixtureSeed },
  );
  assert.equal(result.status, 0, result.stderr);

  const bytes = readFileSync(join(assets, 'out/update-manifest.json'));
  const manifest = UpdateManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, version);
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.protocolVersion, PROTOCOL_VERSION);
  assert.equal(manifest.publishedAt, '2026-11-27T18:00:00Z');
  assert.match(manifest.notes, /Signed runner releases/);
  assert.doesNotMatch(manifest.notes, /^\[[^\]]+\]:/m);

  assert.deepEqual(
    manifest.assets.map((asset) => asset.target),
    TARGETS,
  );
  for (const asset of manifest.assets) {
    const path = join(assets, asset.fileName);
    assert.equal(
      asset.url,
      `${REPO}/releases/download/v${version}/${asset.fileName}`,
    );
    assert.equal(asset.sha256, createHash('sha256').update(readFileSync(path)).digest('hex'));
    assert.equal(asset.sizeBytes, statSync(path).size);
  }

  const signature = readFileSync(join(assets, 'out/update-manifest.json.sig'), 'utf8').trim();
  assert.equal(
    verify(null, bytes, rawPublicKey(join(ROOT, 'fixtures/release/test.pub')), Buffer.from(signature, 'base64')),
    true,
  );
  assert.equal(readFileSync(join(assets, 'notes.md'), 'utf8').trim(), manifest.notes);
});

test('manifest.mjs refuses a signature the runner public key cannot verify', () => {
  const assets = makeAssets();
  const other = generateKeyPairSync('ed25519');
  const otherPublicKey = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  writeFileSync(join(assets, 'other.pub'), `${otherPublicKey.toString('base64')}\n`);
  const result = runManifest(
    ['--version', version, '--assets', assets, '--out', join(assets, 'out'), '--public-key', join(assets, 'other.pub')],
    { RELEASE_SIGNING_KEY: fixtureSeed },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not verify against/);
});

test('committed release.pub is a real 32-byte key', () => {
  const encoded = readFileSync(join(ROOT, 'crates/runner-core/keys/release.pub'), 'utf8').trim();
  const raw = Buffer.from(encoded, 'base64');
  assert.equal(encoded.length, 44);
  assert.equal(raw.length, 32);
  assert.equal(raw.toString('base64'), encoded);
  assert.ok(!raw.every((byte) => byte === 0));
});

test('manifest.mjs refuses a placeholder release public key', () => {
  const assets = makeAssets();
  const placeholder = join(assets, 'placeholder.pub');
  writeFileSync(placeholder, `${Buffer.alloc(32).toString('base64')}\n`);
  const result = runManifest(
    ['--version', version, '--assets', assets, '--out', join(assets, 'out'), '--public-key', placeholder],
    { RELEASE_SIGNING_KEY: fixtureSeed },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still the all-zero placeholder/);
});

test('manifest.mjs refuses a version that differs from Cargo.toml', () => {
  const assets = makeAssets();
  const result = runManifest(
    ['--version', '9.9.9', '--assets', assets, '--out', join(assets, 'out')],
    { RELEASE_SIGNING_KEY: fixtureSeed },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the workspace version/);
});

test('release.yml parses and builds every target on its runner', () => {
  const workflow = parse(readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.tags, ['v*']);
  assert.equal(workflow.jobs.build.needs, 'gate');
  assert.equal(workflow.jobs.publish.needs, 'build');
  const matrix = workflow.jobs.build.strategy.matrix.include;
  assert.deepEqual(
    matrix.map((entry) => entry.target).sort(),
    [...TARGETS].sort(),
  );
  assert.deepEqual(
    matrix.filter((entry) => entry.os === 'ubuntu-latest').map((entry) => entry.target).sort(),
    ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'],
  );
  for (const entry of matrix) {
    assert.equal(
      entry.cargo,
      entry.os === 'ubuntu-latest' ? 'cargo zigbuild' : 'cargo build',
      `${entry.target} on ${entry.os}`,
    );
  }
  const packageStep = workflow.jobs.build.steps.find((step) => step.name === 'Package');
  assert.equal(packageStep.env.CARGO_COMMAND, '${{ matrix.cargo }}');
});
