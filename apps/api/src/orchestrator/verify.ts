import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  VerifyReportSchema,
  type ReworkIntentInput,
  type VerifyReport,
} from '@intentra/contracts';
import type { Database } from '../db/client.js';
import {
  decisions,
  escalations,
  findings,
  jobs,
  stages,
  type IntentRow,
  type JobRow,
} from '../db/schema.js';
import { HttpError } from '../errors.js';
import { transitionIntent, type Actor } from '../intents/service.js';
import { recordAudit } from '../services/audit.js';
import { cancelIntentJobs, carryOpenFindings, type OrchestratorDeps } from './jobs.js';

export interface VerifyJob {
  readonly job: JobRow;
  readonly report: VerifyReport | null;
}

export async function latestVerifyJob(db: Database, intentId: string): Promise<VerifyJob | null> {
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(stages, eq(jobs.stageId, stages.id))
    .where(and(eq(jobs.intentId, intentId), eq(stages.kind, 'verify')))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  if (!row) return null;
  const candidate = row.job.result === null ? undefined : (row.job.result.report ?? row.job.result);
  const parsed = VerifyReportSchema.safeParse(candidate);
  return { job: row.job, report: parsed.success ? parsed.data : null };
}

export async function openBlockingFindings(db: Database, intentId: string): Promise<readonly string[]> {
  const rows = await db
    .select({ id: findings.id })
    .from(findings)
    .where(
      and(
        eq(findings.intentId, intentId),
        eq(findings.severity, 'blocking'),
        inArray(findings.status, ['open', 'carried']),
      ),
    );
  return rows.map((row) => row.id);
}

export async function assertAcceptable(
  db: Database,
  intent: IntentRow,
): Promise<{ readonly job: JobRow | null }> {
  if (intent.status !== 'awaiting_acceptance') {
    throw new HttpError('CONFLICT', `Intent cannot be accepted while ${intent.status}`);
  }
  const blocking = await openBlockingFindings(db, intent.id);
  if (blocking.length > 0) {
    throw new HttpError('CONFLICT', 'Accept is blocked by open blocking findings', { findingIds: blocking });
  }
  const verify = await latestVerifyJob(db, intent.id);
  if (!verify) return { job: null };
  const failed = (verify.report?.gates ?? []).filter((gate) => gate.status === 'fail');
  const contradicted = (verify.report?.claims ?? []).filter((claim) => claim.status === 'contradicted');
  if (failed.length > 0 || contradicted.length > 0) {
    throw new HttpError('CONFLICT', 'Accept is blocked by a failed gate or a contradicted claim', {
      gates: failed.map((gate) => gate.criterion),
      claims: contradicted.map((claim) => claim.statement),
    });
  }
  if (verify.job.status !== 'succeeded') {
    throw new HttpError('CONFLICT', 'Accept is blocked: the verify stage did not succeed', {
      jobId: verify.job.id,
      status: verify.job.status,
    });
  }
  return { job: verify.job };
}

export interface AcceptResult {
  readonly intent: IntentRow;
  readonly humanWaitMs: number;
}

export async function humanWaitMs(db: Database, intentId: string): Promise<number> {
  const rows = await db
    .select({ createdAt: escalations.createdAt, answeredAt: escalations.answeredAt })
    .from(escalations)
    .where(eq(escalations.intentId, intentId));
  return rows.reduce((total, row) => {
    if (row.answeredAt === null) return total;
    return total + Math.max(0, row.answeredAt.getTime() - row.createdAt.getTime());
  }, 0);
}

export async function acceptIntent(
  deps: OrchestratorDeps,
  actor: Actor,
  intent: IntentRow,
): Promise<AcceptResult> {
  const verified = await assertAcceptable(deps.db, intent);
  const accepted = await transitionIntent(deps, actor, intent, 'accepted');
  const wake = await humanWaitMs(deps.db, intent.id);
  const decisionRows = await deps.db
    .select({
      id: decisions.id,
      question: decisions.question,
      answer: decisions.answer,
      rationale: decisions.rationale,
      status: decisions.status,
    })
    .from(decisions)
    .where(
      and(
        eq(decisions.projectId, intent.projectId),
        eq(decisions.intentId, intent.id),
        eq(decisions.status, 'accepted'),
      ),
    )
    .orderBy(desc(decisions.createdAt));
  await deps.memory.recordEpisode({
    projectId: intent.projectId,
    intentId: intent.id,
    title: intent.title,
    statement: intent.statement,
    summary: `${intent.title}: ${intent.statement}`,
    decisions: decisionRows.map((row) => ({
      decisionId: row.id,
      question: row.question,
      answer: row.answer,
      rationale: row.rationale,
      status: row.status,
    })),
  });
  await recordAudit(deps.db, {
    actorKind: 'user',
    actorId: actor.id,
    action: 'intent.accept',
    target: intent.id,
    meta: { verifyJobId: verified.job?.id ?? null, humanWaitMs: wake },
  });
  return { intent: accepted, humanWaitMs: wake };
}

export async function reworkIntent(
  deps: OrchestratorDeps,
  actor: Actor,
  intent: IntentRow,
  input: ReworkIntentInput,
): Promise<IntentRow> {
  if (intent.status !== 'awaiting_acceptance') {
    throw new HttpError('CONFLICT', `Intent cannot be reworked while ${intent.status}`);
  }
  const carried = await carryOpenFindings(deps, intent.id);
  const target = input.target === 'plan' ? 'planned' : 'building';
  const updated = await transitionIntent(deps, actor, intent, target);
  await recordAudit(deps.db, {
    actorKind: 'user',
    actorId: actor.id,
    action: 'intent.rework',
    target: intent.id,
    meta: { reason: input.reason, target: input.target, carriedFindings: carried.length },
  });
  return updated;
}

export async function cancelIntent(
  deps: OrchestratorDeps,
  actor: Actor,
  intent: IntentRow,
): Promise<{ readonly intent: IntentRow; readonly cancelledJobs: readonly JobRow[] }> {
  if (intent.status === 'accepted' || intent.status === 'rejected' || intent.status === 'cancelled') {
    throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  }
  const cancelledJobs = await cancelIntentJobs(deps, intent);
  const updated = await transitionIntent(deps, actor, intent, 'cancelled');
  return { intent: updated, cancelledJobs };
}
