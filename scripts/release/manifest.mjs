#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveChannel } from './channel.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const REPO = 'https://github.com/MaximenkovAnton/intentra';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const contractsPath = join(ROOT, 'packages/contracts/dist/index.js');
if (!existsSync(contractsPath)) {
  fail('packages/contracts/dist/index.js is missing; run pnpm --filter @intentra/contracts build');
}
const { PROTOCOL_VERSION, TargetSchema, UpdateManifestSchema } = await import(
  pathToFileURL(contractsPath).href
);
const TARGETS = TargetSchema.options;

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    channel: { type: 'string' },
    assets: { type: 'string', default: join(ROOT, 'dist/release') },
    out: { type: 'string' },
    'published-at': { type: 'string' },
    'notes-out': { type: 'string' },
    'public-key': { type: 'string', default: join(ROOT, 'crates/runner-core/keys/release.pub') },
  },
});

const workspaceVersion = () => {
  const cargo = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8');
  const section = /^\[workspace\.package\][^[]*/m.exec(cargo);
  const match = section && /^version = "([^"]+)"/m.exec(section[0]);
  if (!match) fail('cannot read the workspace version from Cargo.toml');
  return match[1];
};

const LINK_REFERENCE = /^\[[^\]]+\]:\s+\S+$/;

const trimLinkReferences = (section) => {
  for (let boundary = section.length - 1; boundary >= 0; boundary -= 1) {
    if (section[boundary].trim() !== '') continue;
    const tail = section.slice(boundary + 1).filter((line) => line.trim() !== '');
    if (tail.length > 0 && tail.every((line) => LINK_REFERENCE.test(line))) {
      return section.slice(0, boundary);
    }
  }
  return section;
};

const changelogNotes = (version) => {
  const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start < 0) fail(`CHANGELOG.md has no ${heading} section`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const notes = trimLinkReferences(section).join('\n').trim();
  if (!notes) fail(`CHANGELOG.md section ${heading} is empty`);
  return notes;
};

const hashFile = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const cargoVersion = workspaceVersion();
const version = values.version ?? cargoVersion;
if (version !== cargoVersion) {
  fail(`version ${version} does not match the workspace version ${cargoVersion}`);
}
const channel = values.channel ?? deriveChannel(version);
if (channel !== 'stable' && channel !== 'beta') fail(`channel must be stable or beta, got ${channel}`);
const protocolVersion = PROTOCOL_VERSION;
const publishedAt = values['published-at'] ?? new Date().toISOString();
const notes = changelogNotes(version);
const assetsDir = resolve(values.assets);
const outDir = resolve(values.out ?? assetsDir);

const assets = TARGETS.map((target) => {
  const fileName = `intentra-runner-${version}-${target}${target === 'x86_64-pc-windows-msvc' ? '.zip' : '.tar.gz'}`;
  const path = join(assetsDir, fileName);
  if (!existsSync(path)) fail(`missing asset ${path}; run scripts/release/package.sh ${target}`);
  return {
    target,
    fileName,
    url: `${REPO}/releases/download/v${version}/${fileName}`,
    sizeBytes: statSync(path).size,
    sha256: hashFile(path),
  };
});

const manifest = {
  schemaVersion: 1,
  version,
  channel,
  protocolVersion,
  publishedAt,
  notes,
  assets,
};
const bytes = Buffer.from(JSON.stringify(manifest));

const parsed = UpdateManifestSchema.safeParse(manifest);
if (!parsed.success) {
  for (const issue of parsed.error.issues) {
    console.error(`release: schema: ${issue.path.join('.')}: ${issue.message}`);
  }
  fail('the update manifest violates the shared contract');
}

const rawSeed = process.env.RELEASE_SIGNING_KEY?.trim();
if (!rawSeed) fail('RELEASE_SIGNING_KEY is not set');
const seed = Buffer.from(rawSeed, 'base64');
if (seed.length !== 32) fail('RELEASE_SIGNING_KEY must be a base64-encoded 32-byte Ed25519 seed');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, seed]),
  format: 'der',
  type: 'pkcs8',
});
const signature = sign(null, bytes, privateKey);

const publicKeyPath = resolve(values['public-key']);
const rawPublicKey = Buffer.from(readFileSync(publicKeyPath, 'utf8').trim(), 'base64');
if (rawPublicKey.length !== 32) fail(`${publicKeyPath} must hold a raw base64 32-byte Ed25519 public key`);
if (rawPublicKey.every((byte) => byte === 0)) {
  fail(`${publicKeyPath} is still the all-zero placeholder; embed the release public key first`);
}
const publicKey = createPublicKey({
  key: Buffer.concat([SPKI_PREFIX, rawPublicKey]),
  format: 'der',
  type: 'spki',
});
if (!verify(null, bytes, publicKey, signature)) {
  fail(`the manifest signature does not verify against ${publicKeyPath}`);
}

mkdirSync(outDir, { recursive: true });
const manifestPath = join(outDir, 'update-manifest.json');
const signaturePath = `${manifestPath}.sig`;
writeFileSync(manifestPath, bytes);
writeFileSync(signaturePath, `${signature.toString('base64')}\n`);
if (values['notes-out']) {
  writeFileSync(resolve(values['notes-out']), `${notes}\n`);
}

console.log(`release: version ${version}, channel ${channel}, protocol ${protocolVersion}`);
console.log(`release: manifest ${manifestPath} (${bytes.length} bytes)`);
console.log(`release: signature ${signaturePath}`);
