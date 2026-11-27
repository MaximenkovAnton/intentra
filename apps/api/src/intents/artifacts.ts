import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { artifacts } from '../db/schema.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export async function writeArtifact(
  db: Database,
  input: {
    readonly intentId: string;
    readonly kind: string;
    readonly meta: Record<string, unknown>;
    readonly jobId?: string | null;
  },
): Promise<void> {
  const digest = sha256(JSON.stringify(input.meta));
  const uri = `intent://${input.intentId}/${input.kind}`;
  const [existing] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.intentId, input.intentId), eq(artifacts.kind, input.kind)))
    .limit(1);
  if (existing) {
    await db
      .update(artifacts)
      .set({ meta: input.meta, sha256: digest, uri, jobId: input.jobId ?? existing.jobId })
      .where(eq(artifacts.id, existing.id));
    return;
  }
  await db.insert(artifacts).values({
    intentId: input.intentId,
    kind: input.kind,
    uri,
    sha256: digest,
    meta: input.meta,
    jobId: input.jobId ?? null,
  });
}

export async function readArtifactMeta(
  db: Database,
  intentId: string,
  kind: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.intentId, intentId), eq(artifacts.kind, kind)))
    .limit(1);
  return row?.meta ?? null;
}
