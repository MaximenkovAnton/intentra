import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { UpdateManifestSchema, type UpdateManifest } from '@intentra/contracts';
import { generateToken, hashToken } from '../src/auth/session.js';
import type { ArtifactSource } from '../src/services/release-artifacts.js';
import type { Database } from '../src/db/client.js';
import { projectRunners, runners, type RunnerRow } from '../src/db/schema.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/release/${name}`, import.meta.url)), 'utf8');

export const MANIFEST_BYTES = readFileSync(
  fileURLToPath(new URL('../../../fixtures/release/manifest.json', import.meta.url)),
);
export const MANIFEST = MANIFEST_BYTES.toString('utf8');
export const SIGNATURE = fixture('manifest.sig').trim();
export const TEST_PUBLIC_KEY = fixture('test.pub').trim();
export const PLACEHOLDER_RELEASE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const testPrivateKey = createPrivateKey({
  key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(fixture('test.seed').trim(), 'base64')]),
  format: 'der',
  type: 'pkcs8',
});

export const manifestFixture = (): UpdateManifest => UpdateManifestSchema.parse(JSON.parse(MANIFEST));

export const manifestWith = (overrides: Partial<UpdateManifest>): UpdateManifest => ({
  ...manifestFixture(),
  ...overrides,
});

export function signManifest(manifest: unknown): { manifest: string; signature: string } {
  const bytes = JSON.stringify(manifest);
  return { manifest: bytes, signature: sign(null, Buffer.from(bytes, 'utf8'), testPrivateKey).toString('base64') };
}

export interface SeededRunner {
  readonly runner: RunnerRow;
  readonly token: string;
}

export async function seedRunner(
  db: Database,
  input: { ownerUserId: string; version?: string },
): Promise<SeededRunner> {
  const token = generateToken();
  const [runner] = await db
    .insert(runners)
    .values({
      name: `runner-${Math.random().toString(36).slice(2, 10)}`,
      ownerUserId: input.ownerUserId,
      tokenHash: hashToken(token),
      os: 'linux',
      arch: 'x86_64',
      version: input.version ?? '0.1.0',
      capabilities: [],
      status: 'offline',
    })
    .returning();
  if (!runner) throw new Error('seedRunner: insert returned no row');
  return { runner, token };
}

export async function bindRunner(db: Database, projectId: string, runnerId: string): Promise<void> {
  await db.insert(projectRunners).values({ projectId, runnerId });
}

export const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

type Responder = (signal: AbortSignal) => Promise<Readable>;

export class FakeArtifactSource implements ArtifactSource {
  readonly calls: string[] = [];
  private readonly queue: Responder[] = [];

  push(bytes: Buffer): void {
    this.queue.push(async () => Readable.from(bytes));
  }

  pushError(error: Error): void {
    this.queue.push(async () => {
      throw error;
    });
  }

  pushDelayed(bytes: Buffer, delayMs: number): void {
    this.queue.push(
      async () =>
        new Promise<Readable>((resolve) => {
          setTimeout(() => resolve(Readable.from(bytes)), delayMs);
        }),
    );
  }

  pushDeferred(): { resolve(bytes: Buffer): void; reject(error: Error): void } {
    let resolveBytes: (bytes: Buffer) => void = () => undefined;
    let rejectBytes: (error: Error) => void = () => undefined;
    const pending = new Promise<Buffer>((resolve, reject) => {
      resolveBytes = resolve;
      rejectBytes = reject;
    });
    this.queue.push(async () => Readable.from(await pending));
    return { resolve: resolveBytes, reject: rejectBytes };
  }

  clear(): void {
    this.queue.length = 0;
    this.calls.length = 0;
  }

  async open(url: string, _signal: AbortSignal): Promise<Readable> {
    this.calls.push(url);
    const responder = this.queue.shift();
    if (responder === undefined) throw new Error('FakeArtifactSource has no queued response');
    return responder(_signal);
  }
}
