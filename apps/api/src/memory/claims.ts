import { and, desc, eq } from 'drizzle-orm';
import type {
  Claim,
  ClaimStatus,
  CreateClaimInput,
  MemoryCodeRef,
  MemoryProbe,
  ValidateClaimInput,
} from '@intentra/contracts';
import type { Database } from '../db/client.js';
import { memoryClaims, type MemoryClaimRow } from '../db/schema.js';
import { HttpError } from '../errors.js';
import type { MemoryRepository } from './graph.js';
import { memoryId } from './id.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface ClaimFilter {
  readonly status?: ClaimStatus;
  readonly intentId?: string;
  readonly limit?: number;
}

export interface ClaimServiceOptions {
  readonly db: Database;
  readonly repository: Pick<MemoryRepository, 'upsertClaim'>;
  readonly now: () => Date;
}

const toClaim = (row: MemoryClaimRow): Claim => ({
  id: row.id,
  projectId: row.projectId,
  intentId: row.intentId,
  key: row.key,
  statement: row.statement,
  probe: row.probe,
  expected: row.expected,
  status: row.status,
  codeRef: row.codeRef,
  verifiedBy: row.verifiedBy,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  commit: row.commit,
  blobSha: row.blobSha,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const mirror = async (
  repository: Pick<MemoryRepository, 'upsertClaim'>,
  row: MemoryClaimRow,
  probe: MemoryProbe,
  codeRef: MemoryCodeRef | null,
): Promise<void> => {
  await repository.upsertClaim({
    projectId: row.projectId,
    claimId: row.id,
    key: row.key,
    intentId: row.intentId,
    statement: row.statement,
    expected: row.expected,
    probe: { type: probe.type, spec: probe.spec },
    status: row.status,
    codeRef,
    verifiedBy: row.verifiedBy,
    verifiedAt: row.verifiedAt,
    commit: row.commit,
    blobSha: row.blobSha,
  });
};

export class ClaimService {
  private readonly options: ClaimServiceOptions;

  constructor(options: ClaimServiceOptions) {
    this.options = options;
  }

  async create(input: CreateClaimInput): Promise<Claim> {
    const id = memoryId(input.projectId, 'claim', input.key);
    const codeRef = input.codeRef ?? null;
    const [row] = await this.options.db
      .insert(memoryClaims)
      .values({
        id,
        projectId: input.projectId,
        intentId: input.intentId ?? null,
        key: input.key,
        statement: input.statement,
        probe: input.probe,
        expected: input.expected,
        status: 'unverified',
        codeRef,
        verifiedBy: null,
        verifiedAt: null,
        commit: null,
        blobSha: codeRef?.blobSha ?? null,
        updatedAt: this.options.now(),
      })
      .onConflictDoUpdate({
        target: [memoryClaims.projectId, memoryClaims.key],
        set: {
          intentId: input.intentId ?? null,
          statement: input.statement,
          probe: input.probe,
          expected: input.expected,
          status: 'unverified',
          codeRef,
          verifiedBy: null,
          verifiedAt: null,
          commit: null,
          blobSha: codeRef?.blobSha ?? null,
          updatedAt: this.options.now(),
        },
      })
      .returning();
    if (!row) throw new HttpError('INTERNAL', 'Claim insert returned no row');
    await mirror(this.options.repository, row, input.probe, codeRef);
    return toClaim(row);
  }

  async validate(projectId: string, claimId: string, input: ValidateClaimInput): Promise<Claim> {
    const [existing] = await this.options.db
      .select()
      .from(memoryClaims)
      .where(and(eq(memoryClaims.id, claimId), eq(memoryClaims.projectId, projectId)))
      .limit(1);
    if (!existing) throw new HttpError('NOT_FOUND', 'Claim not found');

    const now = this.options.now();
    const status: ClaimStatus =
      input.outcome === 'passed' ? 'fresh' : input.outcome === 'failed' ? 'contradicted' : 'stale';
    const observedBlobSha = input.blobSha ?? existing.blobSha;
    const codeRef: MemoryCodeRef | null =
      existing.codeRef === null
        ? null
        : input.outcome === 'passed' && input.blobSha !== undefined
          ? { ...existing.codeRef, blobSha: input.blobSha }
          : existing.codeRef;
    const [row] = await this.options.db
      .update(memoryClaims)
      .set({
        status,
        codeRef,
        verifiedBy: input.verifiedBy,
        verifiedAt: input.verifiedAt === undefined ? now : new Date(input.verifiedAt),
        commit: input.commit,
        blobSha: observedBlobSha,
        updatedAt: now,
      })
      .where(eq(memoryClaims.id, claimId))
      .returning();
    if (!row) throw new HttpError('INTERNAL', 'Claim update returned no row');
    await mirror(this.options.repository, row, existing.probe, codeRef);
    return toClaim(row);
  }

  async get(projectId: string, claimId: string): Promise<Claim | null> {
    const [row] = await this.options.db
      .select()
      .from(memoryClaims)
      .where(and(eq(memoryClaims.id, claimId), eq(memoryClaims.projectId, projectId)))
      .limit(1);
    return row ? toClaim(row) : null;
  }

  async list(projectId: string, filter: ClaimFilter = {}): Promise<readonly Claim[]> {
    const conditions = [eq(memoryClaims.projectId, projectId)];
    if (filter.status !== undefined) conditions.push(eq(memoryClaims.status, filter.status));
    if (filter.intentId !== undefined) conditions.push(eq(memoryClaims.intentId, filter.intentId));
    const rows = await this.options.db
      .select()
      .from(memoryClaims)
      .where(and(...conditions))
      .orderBy(desc(memoryClaims.updatedAt), desc(memoryClaims.id))
      .limit(Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    return rows.map(toClaim);
  }

  async contradictedIds(projectId: string): Promise<ReadonlySet<string>> {
    const rows = await this.options.db
      .select({ id: memoryClaims.id })
      .from(memoryClaims)
      .where(and(eq(memoryClaims.projectId, projectId), eq(memoryClaims.status, 'contradicted')));
    return new Set(rows.map((row) => row.id));
  }
}
