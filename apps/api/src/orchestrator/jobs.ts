import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { JobPayloadSchema, type JobPayload, type StageKind } from '@intentra/contracts';
import type { Database } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { MemoryApi } from '../memory/index.js';
import {
  findings,
  intents,
  jobs,
  stages,
  type FindingRow,
  type IntentRow,
  type JobRow,
  type StageRow,
} from '../db/schema.js';

export interface OrchestratorDeps {
  readonly db: Database;
  readonly events: EventBus;
  readonly memory: MemoryApi;
  readonly now: () => Date;
}

export const MAX_JOB_ATTEMPTS = 3;
export const LEASE_MS = 30_000;

export const backoffFor = (attempt: number): number =>
  Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));

export function jobPayloadOf(job: JobRow): JobPayload {
  const parsed = JobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`job ${job.id} has an invalid payload`);
  return parsed.data;
}

export function publishStage(deps: OrchestratorDeps, intent: IntentRow, stage: StageRow): void {
  deps.events.publish({
    type: 'stage.updated',
    projectId: intent.projectId,
    data: {
      id: stage.id,
      intentId: intent.id,
      kind: stage.kind,
      status: stage.status,
      attempt: stage.attempt,
    },
  });
}

export function publishJob(deps: OrchestratorDeps, intent: IntentRow, job: JobRow): void {
  deps.events.publish({
    type: 'job.updated',
    projectId: intent.projectId,
    data: { id: job.id, intentId: intent.id, stageId: job.stageId, status: job.status, attempt: job.attempt },
  });
}

export async function loadIntent(db: Database, intentId: string): Promise<IntentRow | null> {
  const [row] = await db.select().from(intents).where(eq(intents.id, intentId)).limit(1);
  return row ?? null;
}

export async function loadStage(db: Database, stageId: string | null): Promise<StageRow | null> {
  if (stageId === null) return null;
  const [row] = await db.select().from(stages).where(eq(stages.id, stageId)).limit(1);
  return row ?? null;
}

export async function startStageRow(
  deps: OrchestratorDeps,
  intent: IntentRow,
  kind: StageKind,
): Promise<StageRow> {
  const [stage] = await deps.db
    .insert(stages)
    .values({ intentId: intent.id, kind, status: 'running', startedAt: deps.now() })
    .returning();
  if (!stage) throw new Error('stage insert returned no row');
  publishStage(deps, intent, stage);
  return stage;
}

export async function finishStageRow(
  deps: OrchestratorDeps,
  intent: IntentRow,
  stage: StageRow,
  status: 'succeeded' | 'failed' | 'blocked' | 'cancelled',
  error?: string,
): Promise<StageRow | null> {
  const [updated] = await deps.db
    .update(stages)
    .set({ status, finishedAt: deps.now(), error: error ?? null })
    .where(and(eq(stages.id, stage.id), inArray(stages.status, ['pending', 'running'])))
    .returning();
  if (!updated) return null;
  publishStage(deps, intent, updated);
  return updated;
}

export async function enqueueJob(
  deps: OrchestratorDeps,
  intent: IntentRow,
  stage: StageRow,
  payload: JobPayload,
): Promise<JobRow> {
  const [job] = await deps.db
    .insert(jobs)
    .values({
      intentId: intent.id,
      stageId: stage.id,
      runtime: 'auto',
      status: 'queued',
      payload,
      nextAttemptAt: deps.now(),
    })
    .returning();
  if (!job) throw new Error('job insert returned no row');
  publishJob(deps, intent, job);
  return job;
}

async function isTaskReady(deps: OrchestratorDeps, job: JobRow, payload: JobPayload): Promise<boolean> {
  if (payload.kind !== 'build' || payload.dependsOn.length === 0 || job.stageId === null) return true;
  const siblings = await deps.db
    .select({ payload: jobs.payload, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.stageId, job.stageId));
  const statusByTask = new Map<string, string>();
  for (const sibling of siblings) {
    const parsed = JobPayloadSchema.safeParse(sibling.payload);
    if (parsed.success && parsed.data.taskId !== undefined) {
      statusByTask.set(parsed.data.taskId, sibling.status);
    }
  }
  return payload.dependsOn.every((taskId) => statusByTask.get(taskId) === 'succeeded');
}

export async function nextQueuedJob(
  deps: OrchestratorDeps,
  projectIds: ReadonlySet<string>,
  now: Date,
): Promise<JobRow | null> {
  if (projectIds.size === 0) return null;
  const rows = await deps.db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(intents, eq(jobs.intentId, intents.id))
    .where(
      and(
        eq(jobs.status, 'queued'),
        lte(jobs.nextAttemptAt, now),
        inArray(intents.projectId, [...projectIds]),
      ),
    )
    .orderBy(asc(jobs.createdAt), asc(jobs.id))
    .limit(50);
  for (const row of rows) {
    const payload = JobPayloadSchema.safeParse(row.job.payload);
    if (!payload.success) continue;
    if (await isTaskReady(deps, row.job, payload.data)) return row.job;
  }
  return null;
}

export async function claimJob(
  deps: OrchestratorDeps,
  job: JobRow,
  runnerId: string,
  runtime: string,
  now: Date,
): Promise<JobRow | null> {
  const [claimed] = await deps.db
    .update(jobs)
    .set({
      status: 'offered',
      runnerId,
      runtime,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempt: job.attempt + 1,
    })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, 'queued'),
        sql`not exists (select 1 from ${jobs} active where active.runner_id = ${runnerId} and active.status in ('offered', 'running'))`,
      ),
    )
    .returning();
  if (!claimed) return null;
  const intent = await loadIntent(deps.db, claimed.intentId);
  if (intent) publishJob(deps, intent, claimed);
  return claimed;
}

export async function markJobRunning(
  deps: OrchestratorDeps,
  jobId: string,
  runnerId: string,
  now: Date,
): Promise<JobRow | null> {
  const [job] = await deps.db
    .update(jobs)
    .set({ status: 'running', startedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(and(eq(jobs.id, jobId), eq(jobs.runnerId, runnerId), inArray(jobs.status, ['offered', 'running'])))
    .returning();
  if (!job) return null;
  const intent = await loadIntent(deps.db, job.intentId);
  if (intent) publishJob(deps, intent, job);
  return job;
}

export async function renewJobLease(
  deps: OrchestratorDeps,
  jobId: string,
  runnerId: string,
  now: Date,
): Promise<boolean> {
  const [job] = await deps.db
    .update(jobs)
    .set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
    .where(and(eq(jobs.id, jobId), eq(jobs.runnerId, runnerId), inArray(jobs.status, ['offered', 'running'])))
    .returning({ id: jobs.id });
  return job !== undefined;
}

export async function finishJob(
  deps: OrchestratorDeps,
  job: JobRow,
  status: 'succeeded' | 'failed' | 'cancelled' | 'expired',
  result?: Record<string, unknown>,
): Promise<JobRow | null> {
  const [updated] = await deps.db
    .update(jobs)
    .set({
      status,
      finishedAt: deps.now(),
      leaseUntil: null,
      ...(result === undefined
        ? {}
        : { result: sql`coalesce(${jobs.result}, '{}'::jsonb) || ${JSON.stringify(result)}::jsonb` }),
    })
    .where(and(eq(jobs.id, job.id), notInArray(jobs.status, ['succeeded', 'failed', 'cancelled', 'expired'])))
    .returning();
  if (!updated) return null;
  const intent = await loadIntent(deps.db, updated.intentId);
  if (intent) publishJob(deps, intent, updated);
  return updated;
}

async function failStageForJob(deps: OrchestratorDeps, job: JobRow, error: string): Promise<void> {
  const stage = await loadStage(deps.db, job.stageId);
  if (!stage || (stage.status !== 'running' && stage.status !== 'pending')) return;
  const intent = await loadIntent(deps.db, job.intentId);
  if (!intent) return;
  await finishStageRow(deps, intent, stage, 'failed', error);
}

export async function requeueJob(
  deps: OrchestratorDeps,
  job: JobRow,
  now: Date,
  reason: string,
  immediate = false,
): Promise<'requeued' | 'expired'> {
  if (job.attempt >= MAX_JOB_ATTEMPTS) {
    await finishJob(deps, job, 'expired');
    await failStageForJob(deps, job, reason);
    return 'expired';
  }
  const [updated] = await deps.db
    .update(jobs)
    .set({
      status: 'queued',
      runnerId: null,
      runnerSeq: null,
      leaseUntil: null,
      startedAt: null,
      nextAttemptAt: immediate ? now : new Date(now.getTime() + backoffFor(job.attempt)),
    })
    .where(and(eq(jobs.id, job.id), inArray(jobs.status, ['offered', 'running'])))
    .returning();
  if (updated) {
    const intent = await loadIntent(deps.db, updated.intentId);
    if (intent) publishJob(deps, intent, updated);
  }
  return 'requeued';
}

export async function requeueExpiredLeases(deps: OrchestratorDeps, now: Date): Promise<number> {
  const rows = await deps.db
    .select()
    .from(jobs)
    .where(and(inArray(jobs.status, ['offered', 'running']), lt(jobs.leaseUntil, now)));
  let requeued = 0;
  for (const job of rows) {
    await requeueJob(deps, job, now, 'lease expired');
    requeued += 1;
  }
  return requeued;
}

export async function requeueRunnerJobs(deps: OrchestratorDeps, runnerId: string, now: Date): Promise<number> {
  const rows = await deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.runnerId, runnerId), inArray(jobs.status, ['offered', 'running'])));
  for (const job of rows) await requeueJob(deps, job, now, 'runner disconnected', true);
  return rows.length;
}

export async function cancelIntentJobs(deps: OrchestratorDeps, intent: IntentRow): Promise<readonly JobRow[]> {
  const now = deps.now();
  const running = await deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.intentId, intent.id), inArray(jobs.status, ['queued', 'offered', 'running'])));
  const cancelled: JobRow[] = [];
  for (const job of running) {
    const [updated] = await deps.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: now, leaseUntil: null })
      .where(and(eq(jobs.id, job.id), inArray(jobs.status, ['queued', 'offered', 'running'])))
      .returning();
    if (!updated) continue;
    cancelled.push(updated);
    publishJob(deps, intent, updated);
  }
  const stageRows = await deps.db
    .update(stages)
    .set({ status: 'cancelled', finishedAt: now })
    .where(and(eq(stages.intentId, intent.id), inArray(stages.status, ['pending', 'running'])))
    .returning();
  for (const stage of stageRows) publishStage(deps, intent, stage);
  return cancelled;
}

export async function cancelStageJobs(
  deps: OrchestratorDeps,
  intent: IntentRow,
  stageId: string,
): Promise<number> {
  const now = deps.now();
  const rows = await deps.db
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: now, leaseUntil: null })
    .where(and(eq(jobs.stageId, stageId), inArray(jobs.status, ['queued', 'offered', 'running'])))
    .returning();
  for (const job of rows) publishJob(deps, intent, job);
  return rows.length;
}

export async function updateJobPayload(
  deps: OrchestratorDeps,
  jobId: string,
  payload: JobPayload,
): Promise<void> {
  await deps.db.update(jobs).set({ payload }).where(eq(jobs.id, jobId));
}

export const isRunnerSeqNew = (job: JobRow, seq: number): boolean =>
  job.runnerSeq === null || job.runnerSeq < seq;

export async function commitRunnerSeq(
  deps: OrchestratorDeps,
  jobId: string,
  seq: number,
): Promise<void> {
  await deps.db
    .update(jobs)
    .set({ runnerSeq: seq })
    .where(
      and(
        eq(jobs.id, jobId),
        inArray(jobs.status, ['offered', 'running']),
        or(isNull(jobs.runnerSeq), lt(jobs.runnerSeq, seq)),
      ),
    );
}

export async function mergeJobUsage(
  deps: OrchestratorDeps,
  jobId: string,
  usage: { readonly inputTokens?: number; readonly outputTokens?: number },
): Promise<void> {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input === 0 && output === 0) return;
  await deps.db
    .update(jobs)
    .set({
      result: sql`jsonb_set(jsonb_set(coalesce(${jobs.result}, '{}'::jsonb), '{inputTokens}', to_jsonb(coalesce((${jobs.result} ->> 'inputTokens')::int, 0) + ${input})), '{outputTokens}', to_jsonb(coalesce((${jobs.result} ->> 'outputTokens')::int, 0) + ${output}))`,
    })
    .where(eq(jobs.id, jobId));
}

export async function closeCarriedFindings(
  deps: OrchestratorDeps,
  intentId: string,
  role: string,
): Promise<void> {
  await deps.db
    .update(findings)
    .set({ status: 'closed' })
    .where(and(eq(findings.intentId, intentId), eq(findings.role, role), eq(findings.status, 'carried')));
}

export async function carryOpenFindings(deps: OrchestratorDeps, intentId: string): Promise<FindingRow[]> {
  return deps.db
    .update(findings)
    .set({ status: 'carried' })
    .where(and(eq(findings.intentId, intentId), eq(findings.status, 'open')))
    .returning();
}
