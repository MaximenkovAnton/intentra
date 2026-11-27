import { createPublicKey, verify } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import semver from 'semver';
import {
  PROTOCOL_VERSION,
  RunnerUpdateSchema,
  SemVerSchema,
  UpdateManifestSchema,
  type Channel,
  type Release,
  type RunnerUpdate,
  type UpdateAsset,
  type UpdateManifest,
} from '@intentra/contracts';
import type { Database } from '../db/client.js';
import { releases, type ReleaseRow, type RunnerRow } from '../db/schema.js';
import { HttpError } from '../errors.js';

export const PLACEHOLDER_RELEASE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface ResolveUpdateInput {
  readonly runner: RunnerRow;
  readonly channel: Channel;
  readonly current: string | null;
}

export interface ReleaseService {
  readonly keyConfigured: boolean;
  publish(input: { manifest: string; signature: string }): Promise<{ created: boolean; release: Release }>;
  yank(version: string, yanked: boolean): Promise<void>;
  resolveUpdate(input: ResolveUpdateInput): Promise<RunnerUpdate>;
  resolveUpdates(inputs: ReadonlyArray<ResolveUpdateInput>): Promise<Map<string, RunnerUpdate>>;
  findArtifact(fileName: string): Promise<UpdateAsset | null>;
}

export interface ReleaseServiceInput {
  readonly db: Database;
  readonly now: () => Date;
  readonly publicKeyBase64: string;
  readonly maxArtifactBytes: number;
}

export function createReleaseService(input: ReleaseServiceInput): ReleaseService {
  const rawKey = Buffer.from(input.publicKeyBase64.trim(), 'base64');
  if (rawKey.length !== 32) throw new Error('release public key must be 32 raw bytes');
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: 'der',
    type: 'spki',
  });

  const releasePoolCondition = and(
    eq(releases.yanked, false),
    eq(releases.protocolVersion, PROTOCOL_VERSION),
  );

  const pool = async (): Promise<ReleaseRow[]> =>
    input.db.select().from(releases).where(releasePoolCondition);

  const latestOf = (rows: ReadonlyArray<ReleaseRow>, channel: Channel): ReleaseRow | null => {
    const candidates = rows.filter(
      (row) =>
        SemVerSchema.safeParse(row.version).success &&
        (channel === 'beta' ? row.channel === 'stable' || row.channel === 'beta' : row.channel === 'stable'),
    );
    return candidates.sort((left, right) => semver.rcompare(left.version, right.version))[0] ?? null;
  };

  const toRelease = (row: ReleaseRow): Release => ({
    version: row.version,
    channel: row.channel,
    protocolVersion: row.protocolVersion,
    publishedAt: row.publishedAt.toISOString(),
    yanked: row.yanked,
    manifest: row.manifest,
    signature: row.signature,
    notes: row.notes,
  });

  const readManifest = (bytes: string): UpdateManifest => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes);
    } catch {
      throw new HttpError('VALIDATION', 'manifest is not valid JSON');
    }
    const parsed = UpdateManifestSchema.safeParse(decoded);
    if (!parsed.success) throw new HttpError('VALIDATION', 'manifest does not match the release schema');
    if (parsed.data.protocolVersion !== PROTOCOL_VERSION) {
      throw new HttpError('VALIDATION', `manifest protocolVersion must equal ${PROTOCOL_VERSION}`);
    }
    if (parsed.data.assets.some((asset) => asset.sizeBytes > input.maxArtifactBytes)) {
      throw new HttpError('VALIDATION', 'asset exceeds the release size limit');
    }
    return parsed.data;
  };

  const decide = (
    rows: ReadonlyArray<ReleaseRow>,
    { runner, channel, current }: ResolveUpdateInput,
  ): RunnerUpdate => {
    const latest = latestOf(rows, channel);
    const stored = SemVerSchema.safeParse(runner.version);
    const explicit = current === null ? null : SemVerSchema.safeParse(current);
    const version = stored.success ? stored.data : explicit?.success === true ? explicit.data : null;
    const base = {
      channel,
      latestVersion: latest?.version ?? null,
      pinnedVersion: runner.pinnedVersion,
      autoUpdate: runner.autoUpdate,
    };
    if (runner.pinnedVersion !== null) {
      const pinned = rows.find((row) => row.version === runner.pinnedVersion);
      if (pinned === undefined) {
        return RunnerUpdateSchema.parse({ ...base, available: false, reason: 'pinned version is unavailable' });
      }
      if (version !== null && semver.eq(pinned.version, version)) {
        return RunnerUpdateSchema.parse({ ...base, available: false, reason: 'already on the pinned version' });
      }
      if (runner.autoUpdate === false) {
        return RunnerUpdateSchema.parse({ ...base, available: false, reason: 'auto-update is disabled' });
      }
      return RunnerUpdateSchema.parse({
        ...base,
        available: true,
        manifest: pinned.manifest,
        signature: pinned.signature,
      });
    }
    if (latest === null || (version !== null && semver.gte(version, latest.version))) {
      return RunnerUpdateSchema.parse({ ...base, available: false, reason: 'no newer version' });
    }
    if (runner.autoUpdate === false) {
      return RunnerUpdateSchema.parse({ ...base, available: false, reason: 'auto-update is disabled' });
    }
    return RunnerUpdateSchema.parse({
      ...base,
      available: true,
      manifest: latest.manifest,
      signature: latest.signature,
    });
  };

  return {
    keyConfigured: input.publicKeyBase64.trim() !== PLACEHOLDER_RELEASE_KEY,

    async publish(body) {
      const manifest = readManifest(body.manifest);
      const signature = Buffer.from(body.signature, 'base64');
      if (!verify(null, Buffer.from(body.manifest, 'utf8'), publicKey, signature)) {
        throw new HttpError('VALIDATION', 'manifest signature does not verify');
      }
      const values = {
        version: manifest.version,
        channel: manifest.channel,
        protocolVersion: manifest.protocolVersion,
        manifest: body.manifest,
        signature: body.signature,
        notes: manifest.notes,
        publishedAt: new Date(manifest.publishedAt),
      };
      const [inserted] = await input.db
        .insert(releases)
        .values(values)
        .onConflictDoNothing({ target: releases.version })
        .returning();
      if (inserted) return { created: true, release: toRelease(inserted) };
      const [updated] = await input.db
        .update(releases)
        .set({ ...values, updatedAt: input.now() })
        .where(eq(releases.version, manifest.version))
        .returning();
      if (!updated) throw new HttpError('INTERNAL', 'release upsert returned no row');
      return { created: false, release: toRelease(updated) };
    },

    async yank(version, yanked) {
      const updated = await input.db
        .update(releases)
        .set({ yanked, updatedAt: input.now() })
        .where(eq(releases.version, version))
        .returning({ version: releases.version });
      if (updated.length === 0) throw new HttpError('NOT_FOUND', 'Release not found');
    },

    async resolveUpdate(input) {
      return decide(await pool(), input);
    },

    async resolveUpdates(inputs) {
      if (inputs.length === 0) return new Map<string, RunnerUpdate>();
      const rows = await pool();
      return new Map(
        inputs.map((entry): [string, RunnerUpdate] => [entry.runner.id, decide(rows, entry)]),
      );
    },

    async findArtifact(fileName) {
      const rows = await input.db
        .select()
        .from(releases)
        .where(releasePoolCondition)
        .orderBy(desc(releases.publishedAt));
      for (const row of rows) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(row.manifest);
        } catch {
          continue;
        }
        const parsed = UpdateManifestSchema.safeParse(decoded);
        if (parsed.success) {
          const asset = parsed.data.assets.find((candidate) => candidate.fileName === fileName);
          if (asset !== undefined) return asset;
        }
      }
      return null;
    },
  };
}
