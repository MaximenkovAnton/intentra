import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type {
  CreateEscalationInput,
  IntentAnswerResult,
  IntentCard,
  IntentStatus,
  Plan,
  PostIntentMessageInput,
  SpecBundle,
  SpecSubmission,
  SubmitFindingsInput,
  SubmitSpecInput,
  SubmitVerdictInput,
} from '@intentra/contracts';
import { JobPayloadSchema, PlanSchema } from '@intentra/contracts';
import type { Database } from '../db/client.js';
import type { EventBus } from '../events/bus.js';
import type { MemoryApi } from '../memory/index.js';
import {
  artifacts,
  decisions,
  dodRows,
  escalations,
  findings,
  intentMessages,
  intents,
  jobs,
  requirements,
  specs,
  verdicts,
  type EscalationRow,
  type FindingRow,
  type IntentMessageRow,
  type IntentRow,
  type JobRow,
  type SpecRow,
  type VerdictRow,
} from '../db/schema.js';
import { HttpError } from '../errors.js';
import {
  ESCALATION_TTL_MS,
  MAX_ESCALATIONS_PER_INTENT,
  escalationCardProblems,
  sameQuestion,
} from '../escalation/policy.js';
import { recordAudit } from '../services/audit.js';
import { critiqueSpec } from '../spec/critic.js';
import { validatePlan } from '../spec/plan.js';
import { formatOnlyTestRefChecker, type TestRefChecker } from '../spec/test-refs.js';
import {
  toDecisionDto,
  toDodRowDto,
  toEscalationDto,
  toFindingDto,
  toRequirementDto,
  toSpecDto,
} from '../dto.js';
import { readArtifactMeta, writeArtifact } from './artifacts.js';
import { resolveDecision } from './decisions.js';
import { assertCanTransition, isTerminalStatus } from './state.js';

export const SPEC_CRITIC_ROLE = 'spec-critic';
export const PLAN_CRITIC_ROLE = 'planner';
export const INTENT_CARD_ARTIFACT = 'intent_card';
export const PLAN_ARTIFACT = 'plan';

export interface IntentDeps {
  readonly db: Database;
  readonly events: EventBus;
  readonly memory: MemoryApi;
  readonly now: () => Date;
  readonly testRefs?: TestRefChecker;
}

export interface Actor {
  readonly kind: 'user' | 'agent' | 'system';
  readonly id: string;
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const auditActorKind = (actor: Actor): 'user' | 'runner' | 'system' =>
  actor.kind === 'user' ? 'user' : actor.kind === 'agent' ? 'runner' : 'system';

const publishIntent = (deps: IntentDeps, intent: IntentRow, status: IntentStatus = intent.status): void => {
  deps.events.publish({
    type: 'intent.updated',
    projectId: intent.projectId,
    data: { id: intent.id, status },
  });
};

export async function transitionIntent(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  to: IntentStatus,
): Promise<IntentRow> {
  assertCanTransition(intent.status, to);
  const [updated] = await deps.db
    .update(intents)
    .set({ status: to, ...(to === 'accepted' ? { acceptedAt: deps.now() } : {}) })
    .where(eq(intents.id, intent.id))
    .returning();
  if (!updated) throw new HttpError('NOT_FOUND', 'Intent not found');
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.transition',
    target: intent.id,
    meta: { from: intent.status, to },
  });
  publishIntent(deps, updated);
  return updated;
}

export async function createIntent(
  deps: IntentDeps,
  actor: Actor,
  input: { readonly projectId: string; readonly title: string; readonly statement: string },
): Promise<IntentRow> {
  const [created] = await deps.db
    .insert(intents)
    .values({
      projectId: input.projectId,
      title: input.title,
      statement: input.statement,
      createdBy: actor.id,
      status: 'draft',
    })
    .returning();
  if (!created) throw new Error('intent insert returned no row');
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.create',
    target: created.id,
    meta: { projectId: input.projectId },
  });
  publishIntent(deps, created);
  return created;
}

export async function postMessage(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: PostIntentMessageInput & { readonly role?: 'user' | 'assistant' },
): Promise<{ readonly message: IntentMessageRow; readonly intent: IntentRow }> {
  if (isTerminalStatus(intent.status)) throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  const [message] = await deps.db
    .insert(intentMessages)
    .values({ intentId: intent.id, role: input.role ?? 'user', body: input.body })
    .returning();
  if (!message) throw new Error('intent message insert returned no row');
  const updated =
    intent.status === 'draft' ? await transitionIntent(deps, actor, intent, 'clarifying') : intent;
  if (updated === intent) publishIntent(deps, intent);
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.message.create',
    target: intent.id,
    meta: { role: message.role },
  });
  return { message, intent: updated };
}

export async function submitIntentCard(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  card: IntentCard,
): Promise<IntentRow> {
  if (isTerminalStatus(intent.status)) throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  await writeArtifact(deps.db, {
    intentId: intent.id,
    kind: INTENT_CARD_ARTIFACT,
    meta: { ...card },
  });
  const updated =
    intent.status === 'draft' ? await transitionIntent(deps, actor, intent, 'clarifying') : intent;
  if (updated === intent) publishIntent(deps, intent);
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.card.submit',
    target: intent.id,
  });
  return updated;
}

async function nextRound(db: Database, intentId: string, role: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`coalesce(max(${findings.round}), 0)` })
    .from(findings)
    .where(and(eq(findings.intentId, intentId), eq(findings.role, role)));
  return Number(row?.value ?? 0) + 1;
}

export async function latestSpecRow(db: Database, intentId: string): Promise<SpecRow | null> {
  const [spec] = await db
    .select()
    .from(specs)
    .where(eq(specs.intentId, intentId))
    .orderBy(desc(specs.version))
    .limit(1);
  return spec ?? null;
}

export async function loadSpecBundle(db: Database, intentId: string): Promise<SpecBundle | null> {
  const spec = await latestSpecRow(db, intentId);
  if (!spec) return null;
  const requirementRows = await db.select().from(requirements).where(eq(requirements.specId, spec.id));
  const requirementIds = requirementRows.map((row) => row.id);
  const dodRowRows =
    requirementIds.length === 0
      ? []
      : await db.select().from(dodRows).where(inArray(dodRows.requirementId, requirementIds));
  return {
    spec: toSpecDto(spec),
    requirements: requirementRows.map(toRequirementDto),
    dodRows: dodRowRows.map(toDodRowDto),
  };
}

export async function readPlan(db: Database, intentId: string): Promise<Plan | null> {
  const meta = await readArtifactMeta(db, intentId, PLAN_ARTIFACT);
  if (!meta) return null;
  const parsed = PlanSchema.safeParse(meta);
  return parsed.success ? parsed.data : null;
}

export async function submitSpec(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: SubmitSpecInput,
): Promise<SpecSubmission> {
  if (!['clarifying', 'specified', 'critiqued'].includes(intent.status)) {
    throw new HttpError('CONFLICT', `A spec cannot be submitted while the intent is ${intent.status}`);
  }
  const acceptedDecisions = await deps.db
    .select({ question: decisions.question, answer: decisions.answer })
    .from(decisions)
    .where(and(eq(decisions.projectId, intent.projectId), eq(decisions.status, 'accepted')));
  const supersededDecisions = await deps.db
    .select({ question: decisions.question, answer: decisions.answer })
    .from(decisions)
    .where(and(eq(decisions.projectId, intent.projectId), eq(decisions.status, 'superseded')));
  const plan = await readPlan(deps.db, intent.id);
  const critic = critiqueSpec({
    bodyMd: input.bodyMd,
    testRefs: deps.testRefs ?? formatOnlyTestRefChecker,
    acceptedDecisions,
    supersededDecisions,
    plan,
  });
  const sha256 = hash(input.bodyMd);
  const round = await nextRound(deps.db, intent.id, SPEC_CRITIC_ROLE);

  const result = await deps.db.transaction(async (tx) => {
    const [versionRow] = await tx
      .select({ value: sql<number>`coalesce(max(${specs.version}), 0)` })
      .from(specs)
      .where(eq(specs.intentId, intent.id));
    await tx
      .update(specs)
      .set({ status: 'superseded' })
      .where(and(eq(specs.intentId, intent.id), ne(specs.status, 'superseded')));
    const [spec] = await tx
      .insert(specs)
      .values({
        intentId: intent.id,
        version: Number(versionRow?.value ?? 0) + 1,
        bodyMd: input.bodyMd,
        status: critic.verdict === 'approve' ? 'in_review' : 'draft',
        sha256,
      })
      .returning();
    if (!spec) throw new Error('spec insert returned no row');
    const requirementRows =
      critic.parsed.acRows.length === 0
        ? []
        : await tx
            .insert(requirements)
            .values(
              critic.parsed.acRows.map((row) => ({
                specId: spec.id,
                acId: row.acId,
                text: row.text,
                kind: row.kind,
              })),
            )
            .returning();
    const requirementByAc = new Map(requirementRows.map((row) => [row.acId, row.id]));
    const dodInput = critic.parsed.dodRows.flatMap((row) => {
      const requirementId = requirementByAc.get(row.acId);
      return requirementId === undefined
        ? []
        : [{ requirementId, testRef: row.testRef, probe: row.probe }];
    });
    const dodRowRows =
      dodInput.length === 0 ? [] : await tx.insert(dodRows).values(dodInput).returning();
    await tx
      .update(findings)
      .set({ status: 'closed' })
      .where(
        and(
          eq(findings.intentId, intent.id),
          eq(findings.role, SPEC_CRITIC_ROLE),
          eq(findings.status, 'open'),
        ),
      );
    const findingRows =
      critic.findings.length === 0
        ? []
        : await tx
            .insert(findings)
            .values(
              critic.findings.map((item) => ({
                intentId: intent.id,
                role: SPEC_CRITIC_ROLE,
                acId: item.acId ?? null,
                class: item.class,
                severity: item.severity,
                requirement: item.requirement,
                evidence: item.evidence ?? null,
                requiredChange: item.requiredChange ?? null,
                round,
                status: 'open' as const,
              })),
            )
            .returning();
    return { spec, requirementRows, dodRowRows, findingRows };
  });

  for (const finding of result.findingRows) {
    deps.events.publish({
      type: 'finding.created',
      projectId: intent.projectId,
      data: {
        id: finding.id,
        intentId: intent.id,
        class: finding.class,
        severity: finding.severity,
        acId: finding.acId,
      },
    });
  }
  if (intent.status === 'clarifying') {
    await transitionIntent(deps, actor, intent, 'specified');
  } else if (intent.status === 'critiqued') {
    await transitionIntent(deps, actor, intent, 'specified');
  } else {
    publishIntent(deps, intent);
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.spec.submit',
    target: intent.id,
    meta: { version: result.spec.version, verdict: critic.verdict, findings: result.findingRows.length },
  });
  return {
    spec: toSpecDto(result.spec),
    requirements: result.requirementRows.map(toRequirementDto),
    dodRows: result.dodRowRows.map(toDodRowDto),
    findings: result.findingRows.map(toFindingDto),
    verdict: critic.verdict,
  };
}

export async function submitPlan(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  plan: Plan,
): Promise<{ readonly plan: Plan; readonly findings: readonly FindingRow[] }> {
  if (!['critiqued', 'planned'].includes(intent.status)) {
    throw new HttpError('CONFLICT', `A plan cannot be submitted while the intent is ${intent.status}`);
  }
  const spec = await latestSpecRow(deps.db, intent.id);
  if (!spec) throw new HttpError('CONFLICT', 'A spec is required before a plan');
  const requirementRows = await deps.db.select().from(requirements).where(eq(requirements.specId, spec.id));
  const acIds = new Set(requirementRows.map((row) => row.acId));
  const draft = validatePlan(plan, acIds);

  await writeArtifact(deps.db, { intentId: intent.id, kind: PLAN_ARTIFACT, meta: { ...plan } });
  const round = await nextRound(deps.db, intent.id, PLAN_CRITIC_ROLE);
  await deps.db
    .update(findings)
    .set({ status: 'closed' })
    .where(
      and(
        eq(findings.intentId, intent.id),
        eq(findings.role, PLAN_CRITIC_ROLE),
        eq(findings.status, 'open'),
      ),
    );
  const findingRows =
    draft.length === 0
      ? []
      : await deps.db
          .insert(findings)
          .values(
            draft.map((item) => ({
              intentId: intent.id,
              role: PLAN_CRITIC_ROLE,
              acId: item.acId ?? null,
              class: item.class,
              severity: item.severity,
              requirement: item.requirement,
              evidence: item.evidence ?? null,
              requiredChange: item.requiredChange ?? null,
              round,
              status: 'open' as const,
            })),
          )
          .returning();
  for (const finding of findingRows) {
    deps.events.publish({
      type: 'finding.created',
      projectId: intent.projectId,
      data: { id: finding.id, intentId: intent.id, class: finding.class, severity: finding.severity },
    });
  }
  if (draft.length === 0 && intent.status === 'critiqued') {
    await transitionIntent(deps, actor, intent, 'planned');
  } else {
    publishIntent(deps, intent);
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.plan.submit',
    target: intent.id,
    meta: { tasks: plan.tasks.length, findings: findingRows.length },
  });
  return { plan, findings: findingRows };
}

export async function expireDueEscalations(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
): Promise<readonly EscalationRow[]> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - ESCALATION_TTL_MS);
  const due = await deps.db
    .select()
    .from(escalations)
    .where(
      and(
        eq(escalations.intentId, intent.id),
        eq(escalations.status, 'open'),
        lt(escalations.createdAt, cutoff),
      ),
    );
  const expired: EscalationRow[] = [];
  for (const escalation of due) {
    const option = escalation.options.find((item) => item.id === escalation.defaultOption);
    const decision = await resolveDecision(
      { db: deps.db, now: deps.now },
      {
        projectId: intent.projectId,
        intentId: intent.id,
        question: escalation.question,
        answer: option?.label ?? escalation.defaultOption,
        status: 'provisional',
        authorKind: 'system',
        authorId: 'system:escalation-expiry',
        rationale: 'Escalation timed out; the default option was applied',
        evidence: `timeout:${escalation.id}`,
      },
    );
    const [updated] = await deps.db
      .update(escalations)
      .set({
        status: 'expired',
        answerOption: escalation.defaultOption,
        answerNote: 'Expired: the default option was applied as a provisional decision',
        answeredAt: now,
        decisionId: decision.id,
      })
      .where(and(eq(escalations.id, escalation.id), eq(escalations.status, 'open')))
      .returning();
    if (!updated) continue;
    expired.push(updated);
    deps.events.publish({
      type: 'escalation.answered',
      projectId: intent.projectId,
      data: { id: updated.id, intentId: intent.id, status: 'expired', decisionId: decision.id },
    });
  }
  if (expired.length > 0) {
    publishIntent(deps, intent);
    await recordAudit(deps.db, {
      actorKind: auditActorKind(actor),
      actorId: actor.id,
      action: 'intent.escalation.expire',
      target: intent.id,
      meta: { count: expired.length },
    });
  }
  return expired;
}

export async function escalate(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: CreateEscalationInput,
): Promise<EscalationRow> {
  if (isTerminalStatus(intent.status)) throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  await expireDueEscalations(deps, actor, intent);
  const problems = escalationCardProblems(input);
  if (problems.length > 0) throw new HttpError('VALIDATION', 'Invalid escalation card', { problems });
  const existing = await deps.db.select().from(escalations).where(eq(escalations.intentId, intent.id));
  if (existing.length >= MAX_ESCALATIONS_PER_INTENT) {
    throw new HttpError('LIMIT', `An intent accepts at most ${MAX_ESCALATIONS_PER_INTENT} escalations`);
  }
  const repeated = existing.find((row) => sameQuestion(row.question, input.question));
  if (repeated) {
    throw new HttpError('CONFLICT', `The question was already asked (${repeated.status})`, {
      escalationId: repeated.id,
    });
  }
  const [created] = await deps.db
    .insert(escalations)
    .values({
      intentId: intent.id,
      stage: input.stage,
      question: input.question,
      context: input.context,
      options: input.options,
      recommendation: input.recommendation ?? null,
      defaultOption: input.defaultOption,
    })
    .returning();
  if (!created) throw new Error('escalation insert returned no row');
  deps.events.publish({
    type: 'escalation.created',
    projectId: intent.projectId,
    data: { id: created.id, intentId: intent.id, stage: created.stage, question: created.question },
  });
  publishIntent(deps, intent);
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.escalate',
    target: intent.id,
    meta: { trigger: input.trigger, escalationId: created.id },
  });
  return created;
}

export async function answerEscalation(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: { readonly escalationId: string; readonly optionId: string; readonly note?: string },
): Promise<IntentAnswerResult> {
  if (isTerminalStatus(intent.status)) throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  await expireDueEscalations(deps, actor, intent);
  const [escalation] = await deps.db
    .select()
    .from(escalations)
    .where(and(eq(escalations.id, input.escalationId), eq(escalations.intentId, intent.id)))
    .limit(1);
  if (!escalation) throw new HttpError('NOT_FOUND', 'Escalation not found');
  if (escalation.status === 'expired') {
    throw new HttpError('ESCALATION_EXPIRED', 'Escalation expired; its default was applied', {
      decisionId: escalation.decisionId,
    });
  }
  if (escalation.status !== 'open') throw new HttpError('CONFLICT', `Escalation is ${escalation.status}`);
  const option = escalation.options.find((item) => item.id === input.optionId);
  if (!option) {
    throw new HttpError('VALIDATION', 'Unknown escalation option', {
      options: escalation.options.map((item) => item.id),
    });
  }
  const decision = await resolveDecision(
    { db: deps.db, now: deps.now },
    {
      projectId: intent.projectId,
      intentId: intent.id,
      question: escalation.question,
      answer: option.label,
      status: 'accepted',
      authorKind: 'user',
      authorId: actor.id,
      rationale: input.note ?? null,
      alternatives: escalation.options
        .filter((item) => item.id !== input.optionId)
        .map((item) => item.label),
      evidence: `escalation:${escalation.id}`,
    },
  );
  const [updated] = await deps.db
    .update(escalations)
    .set({
      status: 'answered',
      answerOption: input.optionId,
      answerNote: input.note ?? null,
      answeredBy: actor.id,
      answeredAt: deps.now(),
      decisionId: decision.id,
    })
    .where(and(eq(escalations.id, escalation.id), eq(escalations.status, 'open')))
    .returning();
  if (!updated) throw new HttpError('CONFLICT', 'Escalation was resolved concurrently');
  await deps.memory.recordDecision({
    projectId: intent.projectId,
    intentId: intent.id,
    decisionId: decision.id,
    question: decision.question,
    answer: decision.answer,
    rationale: decision.rationale,
    status: decision.status,
  });
  deps.events.publish({
    type: 'escalation.answered',
    projectId: intent.projectId,
    data: { id: updated.id, intentId: intent.id, status: 'answered', decisionId: decision.id },
  });
  publishIntent(deps, intent);
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.escalation.answer',
    target: intent.id,
    meta: { escalationId: updated.id, decisionId: decision.id },
  });
  return { escalation: toEscalationDto(updated), decision: toDecisionDto(decision) };
}

export async function submitFindings(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: SubmitFindingsInput,
): Promise<readonly FindingRow[]> {
  const unsupported = input.findings.filter(
    (item) => item.severity === 'blocking' && item.evidence === undefined,
  );
  if (unsupported.length > 0) {
    throw new HttpError('VALIDATION', 'A blocking finding needs evidence', {
      requirements: unsupported.map((item) => item.requirement),
    });
  }
  if (input.jobId !== undefined) await requireJob(deps.db, input.jobId, intent.id);
  const round = await nextRound(deps.db, intent.id, input.role);
  const rows = await deps.db
    .insert(findings)
    .values(
      input.findings.map((item) => ({
        intentId: intent.id,
        jobId: input.jobId ?? null,
        role: input.role,
        acId: item.acId ?? null,
        class: item.class,
        severity: item.severity,
        requirement: item.requirement,
        evidence: item.evidence ?? null,
        requiredChange: item.requiredChange ?? null,
        round,
        status: 'open' as const,
      })),
    )
    .returning();
  for (const finding of rows) {
    deps.events.publish({
      type: 'finding.created',
      projectId: intent.projectId,
      data: {
        id: finding.id,
        intentId: intent.id,
        class: finding.class,
        severity: finding.severity,
        acId: finding.acId,
      },
    });
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.findings.submit',
    target: intent.id,
    meta: { role: input.role, count: rows.length },
  });
  return rows;
}

async function requireJob(db: Database, jobId: string, intentId: string): Promise<JobRow> {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.intentId, intentId)))
    .limit(1);
  if (!job) throw new HttpError('NOT_FOUND', 'Job not found');
  return job;
}

async function reviewedArtifactSha(
  db: Database,
  job: JobRow,
  intentId: string,
): Promise<string | null> {
  const payload = JobPayloadSchema.safeParse(job.payload);
  const taskId = payload.success ? payload.data.taskId : undefined;
  if (taskId === undefined) return null;
  const [row] = await db
    .select({ sha256: artifacts.sha256 })
    .from(artifacts)
    .where(and(eq(artifacts.intentId, intentId), eq(artifacts.kind, `diff_summary:${taskId}`)))
    .limit(1);
  return row?.sha256 ?? null;
}

export async function submitVerdict(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  input: SubmitVerdictInput,
): Promise<VerdictRow> {
  const job = await requireJob(deps.db, input.jobId, intent.id);
  const spec = await latestSpecRow(deps.db, intent.id);
  if (!spec) throw new HttpError('CONFLICT', 'A spec is required before a verdict');
  const expected =
    input.role === SPEC_CRITIC_ROLE ? spec.sha256 : await reviewedArtifactSha(deps.db, job, intent.id);
  if (expected === null) {
    throw new HttpError('CONFLICT', 'A review verdict needs the reviewed diff summary artifact', {
      jobId: job.id,
    });
  }
  if (input.artifactSha256 !== undefined && input.artifactSha256 !== expected) {
    throw new HttpError('CONFLICT', 'Verdict is bound to a different artifact', { expected });
  }
  const sha256 = input.artifactSha256 ?? expected;
  if (input.decision === 'approve') {
    const open = await deps.db
      .select({ id: findings.id })
      .from(findings)
      .where(
        and(
          eq(findings.intentId, intent.id),
          eq(findings.status, 'open'),
          eq(findings.severity, 'blocking'),
        ),
      );
    if (open.length > 0) {
      throw new HttpError('CONFLICT', 'A spec cannot be approved with open blocking findings', {
        findingIds: open.map((row) => row.id),
      });
    }
  }
  const [countRow] = await deps.db
    .select({ value: sql<number>`count(*)` })
    .from(verdicts)
    .innerJoin(jobs, eq(verdicts.jobId, jobs.id))
    .where(and(eq(jobs.intentId, intent.id), eq(verdicts.role, input.role)));
  const [verdict] = await deps.db
    .insert(verdicts)
    .values({
      jobId: input.jobId,
      role: input.role,
      decision: input.decision,
      artifactSha256: sha256,
      round: Number(countRow?.value ?? 0) + 1,
    })
    .returning();
  if (!verdict) throw new Error('verdict insert returned no row');
  if (input.decision === 'approve') {
    await deps.db.update(specs).set({ status: 'approved' }).where(eq(specs.id, spec.id));
    if (intent.status === 'specified') {
      await transitionIntent(deps, actor, intent, 'critiqued');
    } else {
      publishIntent(deps, intent);
    }
  } else {
    publishIntent(deps, intent);
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.verdict.submit',
    target: intent.id,
    meta: { role: input.role, decision: input.decision, round: verdict.round },
  });
  return verdict;
}

export async function acceptIntent(deps: IntentDeps, actor: Actor, intent: IntentRow): Promise<IntentRow> {
  if (intent.status !== 'awaiting_acceptance') {
    throw new HttpError('CONFLICT', `Intent cannot be accepted while ${intent.status}`);
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.accept',
    target: intent.id,
  });
  return transitionIntent(deps, actor, intent, 'accepted');
}

export async function reworkIntent(
  deps: IntentDeps,
  actor: Actor,
  intent: IntentRow,
  reason: string,
): Promise<IntentRow> {
  if (intent.status !== 'awaiting_acceptance') {
    throw new HttpError('CONFLICT', `Intent cannot be reworked while ${intent.status}`);
  }
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.rework',
    target: intent.id,
    meta: { reason },
  });
  return transitionIntent(deps, actor, intent, 'building');
}

export async function cancelIntent(deps: IntentDeps, actor: Actor, intent: IntentRow): Promise<IntentRow> {
  if (isTerminalStatus(intent.status)) throw new HttpError('CONFLICT', `Intent is ${intent.status}`);
  await recordAudit(deps.db, {
    actorKind: auditActorKind(actor),
    actorId: actor.id,
    action: 'intent.cancel',
    target: intent.id,
  });
  return transitionIntent(deps, actor, intent, 'cancelled');
}

