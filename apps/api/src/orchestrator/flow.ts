import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import {
  IntentCardSchema,
  PlanSchema,
  VerifyReportSchema,
  type IntentCard,
  type IntentStatus,
  type JobPayload,
  type JobResultStatus,
  type StageKind,
  type VerifyReport,
} from '@intentra/contracts';
import { HttpError } from '../errors.js';
import {
  artifacts,
  decisions,
  findings,
  intentMessages,
  jobs,
  requirements,
  stages,
  verdicts,
  type IntentRow,
  type JobRow,
  type StageRow,
} from '../db/schema.js';
import { readArtifactMeta, writeArtifact } from '../intents/artifacts.js';
import {
  INTENT_CARD_ARTIFACT,
  SPEC_CRITIC_ROLE,
  latestSpecRow,
  loadSpecBundle,
  readPlan,
  submitIntentCard,
  submitPlan,
  submitSpec,
  transitionIntent,
  type Actor,
} from '../intents/service.js';
import { EMPTY_CONTEXT_PACK } from '../prompts/context.js';
import { frontOfficePrompt, specCriticPrompt, specWriterPrompt } from '../prompts/templates.js';
import { buildPrompt, planPrompt, reviewPrompt, verifyPrompt } from './prompts.js';
import {
  DEFAULT_GATE_CRITERIA,
  REVIEW_ROLE,
  STAGE_LIMITS,
  VERIFY_ROLE,
} from './stages.js';
import {
  cancelStageJobs,
  carryOpenFindings,
  closeCarriedFindings,
  enqueueJob,
  finishJob,
  finishStageRow,
  jobPayloadOf,
  loadIntent,
  loadStage,
  publishJob,
  requeueJob,
  startStageRow,
  updateJobPayload,
  type OrchestratorDeps,
} from './jobs.js';

const ORCHESTRATOR: Actor = { kind: 'system', id: 'orchestrator' };

const payloadOf = (kind: StageKind, prompt: string, extra: Partial<JobPayload> = {}): JobPayload => ({
  kind,
  prompt,
  context: '',
  limits: { timeoutSeconds: 3600 },
  dependsOn: [],
  gateCriteria: [],
  ...extra,
});

const reload = async (deps: OrchestratorDeps, intentId: string): Promise<IntentRow> => {
  const intent = await loadIntent(deps.db, intentId);
  if (!intent) throw new HttpError('NOT_FOUND', 'Intent not found');
  return intent;
};

const advance = async (
  deps: OrchestratorDeps,
  intent: IntentRow,
  to: IntentStatus,
): Promise<IntentRow> => {
  if (intent.status === to) return intent;
  return transitionIntent(deps, ORCHESTRATOR, intent, to);
};

const acceptedDecisions = async (
  deps: OrchestratorDeps,
  projectId: string,
): Promise<readonly { question: string; answer: string }[]> => {
  return deps.db
    .select({ question: decisions.question, answer: decisions.answer })
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.status, 'accepted')))
    .orderBy(desc(decisions.createdAt))
    .limit(5);
};

const acIdsOf = async (deps: OrchestratorDeps, intentId: string): Promise<readonly string[]> => {
  const spec = await latestSpecRow(deps.db, intentId);
  if (!spec) return [];
  const rows = await deps.db
    .select({ acId: requirements.acId })
    .from(requirements)
    .where(eq(requirements.specId, spec.id));
  return rows.map((row) => row.acId);
};

const loadCard = async (deps: OrchestratorDeps, intentId: string): Promise<IntentCard | null> => {
  const meta = await readArtifactMeta(deps.db, intentId, INTENT_CARD_ARTIFACT);
  if (meta === null) return null;
  const parsed = IntentCardSchema.safeParse(meta);
  return parsed.success ? parsed.data : null;
};

const latestSpecMd = async (deps: OrchestratorDeps, intentId: string): Promise<string | null> => {
  const bundle = await loadSpecBundle(deps.db, intentId);
  return bundle?.spec.bodyMd ?? null;
};

export async function startIntake(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const stage = await startStageRow(deps, intent, 'intake');
  const messages = await deps.db
    .select({ role: intentMessages.role, body: intentMessages.body })
    .from(intentMessages)
    .where(eq(intentMessages.intentId, intent.id))
    .orderBy(desc(intentMessages.createdAt))
    .limit(20);
  const prompt = frontOfficePrompt({
    title: intent.title,
    statement: intent.statement,
    messages: messages.toReversed(),
    contextPack: EMPTY_CONTEXT_PACK,
    capabilities: [],
  });
  await enqueueJob(deps, intent, stage, payloadOf('intake', prompt));
}

export async function startSpec(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const card = await loadCard(deps, intent.id);
  if (card === null) throw new HttpError('CONFLICT', 'Intent card is required before the spec stage');
  const previous = await deps.db
    .select({
      acId: findings.acId,
      class: findings.class,
      severity: findings.severity,
      requirement: findings.requirement,
      evidence: findings.evidence,
      requiredChange: findings.requiredChange,
    })
    .from(findings)
    .where(
      and(eq(findings.intentId, intent.id), eq(findings.role, SPEC_CRITIC_ROLE), eq(findings.status, 'open')),
    );
  const stage = await startStageRow(deps, intent, 'spec');
  await enqueueJob(
    deps,
    intent,
    stage,
    payloadOf(
      'spec',
      specWriterPrompt({
        card,
        acceptedDecisions: await acceptedDecisions(deps, intent.projectId),
        contextPack: EMPTY_CONTEXT_PACK,
        findings: previous.map((row) => ({
          ...(row.acId === null ? {} : { acId: row.acId }),
          class: row.class,
          severity: row.severity,
          requirement: row.requirement,
          ...(row.evidence === null ? {} : { evidence: row.evidence }),
          ...(row.requiredChange === null ? {} : { requiredChange: row.requiredChange }),
        })),
      }),
    ),
  );
}

export async function startSpecCritic(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const spec = await latestSpecRow(deps.db, intent.id);
  if (!spec) throw new HttpError('CONFLICT', 'A spec is required before spec_critic');
  const stage = await startStageRow(deps, intent, 'spec_critic');
  await enqueueJob(
    deps,
    intent,
    stage,
    payloadOf(
      'spec_critic',
      specCriticPrompt({
        specMd: spec.bodyMd,
        specSha256: spec.sha256,
        acceptedDecisions: await acceptedDecisions(deps, intent.projectId),
        contextPack: EMPTY_CONTEXT_PACK,
      }),
    ),
  );
}

export async function startPlan(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const specMd = await latestSpecMd(deps, intent.id);
  if (specMd === null) throw new HttpError('CONFLICT', 'A spec is required before the plan');
  const stage = await startStageRow(deps, intent, 'plan');
  await enqueueJob(
    deps,
    intent,
    stage,
    payloadOf('plan', planPrompt(specMd, await acIdsOf(deps, intent.id))),
  );
}

export async function startBuild(deps: OrchestratorDeps, intent: IntentRow): Promise<StageRow> {
  const plan = await readPlan(deps.db, intent.id);
  if (!plan || plan.tasks.length === 0) throw new HttpError('CONFLICT', 'A plan is required before build');
  const current = await advance(deps, intent, 'building');
  const specMd = (await latestSpecMd(deps, current.id)) ?? '';
  const stage = await startStageRow(deps, current, 'build');
  for (const task of plan.tasks) {
    await enqueueJob(
      deps,
      current,
      stage,
      payloadOf('build', buildPrompt(task, specMd), {
        taskId: task.id,
        dependsOn: task.dependsOn,
      }),
    );
  }
  return stage;
}

const diffSummaries = async (deps: OrchestratorDeps, intentId: string): Promise<readonly string[]> => {
  const rows = await deps.db
    .select({ meta: artifacts.meta })
    .from(artifacts)
    .where(and(eq(artifacts.intentId, intentId), like(artifacts.kind, 'diff_summary%')));
  return rows.flatMap((row) => {
    if (row.meta === null) return [];
    const files = row.meta.files;
    if (!Array.isArray(files)) return [];
    const lines = files.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== 'string') return [];
      return [`- ${record.path} +${String(record.additions ?? 0)} -${String(record.deletions ?? 0)}`];
    });
    return [lines.join('\n')];
  });
};

export async function startReview(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const plan = await readPlan(deps.db, intent.id);
  if (!plan) throw new HttpError('CONFLICT', 'A plan is required before review');
  const specMd = (await latestSpecMd(deps, intent.id)) ?? '';
  const summaries = await diffSummaries(deps, intent.id);
  const stage = await startStageRow(deps, intent, 'review');
  for (const task of plan.tasks) {
    await enqueueJob(
      deps,
      intent,
      stage,
      payloadOf('review', reviewPrompt(task, specMd, summaries), { taskId: task.id }),
    );
  }
}

export async function startVerify(deps: OrchestratorDeps, intent: IntentRow): Promise<void> {
  const current = await advance(deps, intent, 'verifying');
  const stage = await startStageRow(deps, current, 'verify');
  await enqueueJob(
    deps,
    current,
    stage,
    payloadOf('verify', verifyPrompt(DEFAULT_GATE_CRITERIA), {
      gateCriteria: [...DEFAULT_GATE_CRITERIA],
    }),
  );
}

const retryOrBlock = async (deps: OrchestratorDeps, job: JobRow, reason: string): Promise<void> => {
  await requeueJob(deps, job, deps.now(), reason);
};

const latestVerdictOfJob = async (deps: OrchestratorDeps, jobId: string) => {
  const [row] = await deps.db
    .select()
    .from(verdicts)
    .where(eq(verdicts.jobId, jobId))
    .orderBy(desc(verdicts.round))
    .limit(1);
  return row ?? null;
};

const reportOf = (result: Record<string, unknown> | undefined): VerifyReport | null => {
  const candidate = result === undefined ? undefined : (result.report ?? result);
  const parsed = VerifyReportSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

const reviewPassRound = async (deps: OrchestratorDeps, intentId: string): Promise<number> => {
  const [row] = await deps.db
    .select({ value: sql<number>`count(*)` })
    .from(stages)
    .where(
      and(
        eq(stages.intentId, intentId),
        eq(stages.kind, 'review'),
        inArray(stages.status, ['failed', 'blocked']),
      ),
    );
  return Number(row?.value ?? 0) + 1;
};

const specCriticPassRound = async (deps: OrchestratorDeps, intentId: string): Promise<number> => {
  const [row] = await deps.db
    .select({ value: sql<number>`count(*)` })
    .from(stages)
    .where(
      and(
        eq(stages.intentId, intentId),
        eq(stages.kind, 'spec_critic'),
        inArray(stages.status, ['failed', 'blocked']),
      ),
    );
  return Number(row?.value ?? 0) + 1;
};

const verifyFinding = (report: VerifyReport): string[] => {
  const gates = report.gates
    .filter((gate) => gate.status === 'fail')
    .map((gate) => `gate ${gate.criterion} failed`);
  const claims = report.claims
    .filter((claim) => claim.status === 'contradicted')
    .map((claim) => `claim contradicted: ${claim.statement}`);
  return [...gates, ...claims];
};

const stageTasksDone = async (deps: OrchestratorDeps, job: JobRow): Promise<boolean> => {
  const stage = await loadStage(deps.db, job.stageId);
  if (!stage) return false;
  const siblings = await deps.db.select().from(jobs).where(eq(jobs.stageId, stage.id));
  return siblings.every((sibling) => sibling.status === 'succeeded');
};

const intentTerminal = (status: IntentStatus): boolean =>
  status === 'accepted' || status === 'rejected' || status === 'cancelled';

async function onIntakeResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  const card = IntentCardSchema.safeParse(result?.card);
  if (!card.success) {
    await retryOrBlock(deps, job, 'intake result has no valid intent card');
    return;
  }
  if ((await finishJob(deps, job, 'succeeded', result)) === null) return;
  await submitIntentCard(deps, ORCHESTRATOR, intent, card.data);
  if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
  await startSpec(deps, await reload(deps, intent.id));
}

async function onSpecResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
): Promise<void> {
  const spec = await latestSpecRow(deps.db, intent.id);
  if (spec && spec.status !== 'draft') {
    if ((await finishJob(deps, job, 'succeeded')) === null) return;
    if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
    await startSpecCritic(deps, await reload(deps, intent.id));
    return;
  }
  const payload = jobPayloadOf(job);
  const card = await loadCard(deps, intent.id);
  if (card !== null && job.attempt < STAGE_LIMITS.spec) {
    const open = await deps.db
      .select()
      .from(findings)
      .where(
        and(eq(findings.intentId, intent.id), eq(findings.role, SPEC_CRITIC_ROLE), eq(findings.status, 'open')),
      );
    const prompt = specWriterPrompt({
      card,
      acceptedDecisions: await acceptedDecisions(deps, intent.projectId),
      contextPack: EMPTY_CONTEXT_PACK,
      findings: open.map((row) => ({
        ...(row.acId === null ? {} : { acId: row.acId }),
        class: row.class,
        severity: row.severity,
        requirement: row.requirement,
        ...(row.evidence === null ? {} : { evidence: row.evidence }),
        ...(row.requiredChange === null ? {} : { requiredChange: row.requiredChange }),
      })),
    });
    await updateJobPayload(deps, job.id, { ...payload, prompt });
  }
  await retryOrBlock(deps, job, 'the mechanical spec critic rejected the spec');
}

async function onSpecCriticResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
): Promise<void> {
  const verdict = await latestVerdictOfJob(deps, job.id);
  if (verdict === null) {
    await retryOrBlock(deps, job, 'spec_critic result has no verdict');
    return;
  }
  if (verdict.decision !== 'approve') {
    if ((await specCriticPassRound(deps, intent.id)) >= STAGE_LIMITS.spec_critic) {
      await finishJob(deps, job, 'failed');
      await finishStageRow(deps, intent, stage, 'blocked', 'spec_critic round limit reached');
      return;
    }
    if ((await finishJob(deps, job, 'failed')) === null) return;
    if ((await finishStageRow(deps, intent, stage, 'failed', 'spec_critic requested changes')) === null) {
      return;
    }
    await startSpec(deps, await reload(deps, intent.id));
    return;
  }
  if ((await finishJob(deps, job, 'succeeded')) === null) return;
  if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
  await startPlan(deps, await reload(deps, intent.id));
}

async function onPlanResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  const plan = PlanSchema.safeParse(result?.plan);
  if (!plan.success) {
    await retryOrBlock(deps, job, 'plan result has no valid plan');
    return;
  }
  const submitted = await submitPlan(deps, ORCHESTRATOR, intent, plan.data);
  if (submitted.findings.length > 0) {
    await retryOrBlock(deps, job, 'the plan critic rejected the plan');
    return;
  }
  if ((await finishJob(deps, job, 'succeeded', result)) === null) return;
  if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
  await startBuild(deps, await reload(deps, intent.id));
}

async function onBuildResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  const report = reportOf(result);
  const failed = report === null ? [] : verifyFinding(report);
  if (failed.length > 0) {
    await retryOrBlock(deps, job, failed.join('; '));
    return;
  }
  if ((await finishJob(deps, job, 'succeeded', result)) === null) return;
  if (!(await stageTasksDone(deps, job))) return;
  if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
  await startReview(deps, intent);
}

async function onReviewResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
): Promise<void> {
  const verdict = await latestVerdictOfJob(deps, job.id);
  if (verdict === null) {
    await retryOrBlock(deps, job, 'review result has no verdict');
    return;
  }
  if (verdict.decision === 'approve') {
    if ((await finishJob(deps, job, 'succeeded')) === null) return;
    if (!(await stageTasksDone(deps, job))) return;
    await closeCarriedFindings(deps, intent.id, REVIEW_ROLE);
    if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
    await startVerify(deps, await reload(deps, intent.id));
    return;
  }
  if ((await reviewPassRound(deps, intent.id)) >= STAGE_LIMITS.review) {
    await finishJob(deps, job, 'failed');
    if ((await finishStageRow(deps, intent, stage, 'blocked', 'review round limit reached')) === null) return;
    await cancelStageJobs(deps, intent, stage.id);
    return;
  }
  if ((await finishJob(deps, job, 'failed')) === null) return;
  if ((await finishStageRow(deps, intent, stage, 'failed', 'review requested changes; reworking build')) === null) {
    return;
  }
  await cancelStageJobs(deps, intent, stage.id);
  await carryOpenFindings(deps, intent.id);
  await startBuild(deps, await reload(deps, intent.id));
}

async function onVerifyResult(
  deps: OrchestratorDeps,
  job: JobRow,
  stage: StageRow,
  intent: IntentRow,
  result: Record<string, unknown> | undefined,
): Promise<void> {
  const report = reportOf(result);
  const problems = report === null ? ['verify report is missing'] : verifyFinding(report);
  if ((await finishJob(deps, job, 'succeeded', result)) === null) return;
  if (problems.length === 0) {
    await closeCarriedFindings(deps, intent.id, VERIFY_ROLE);
    if ((await finishStageRow(deps, intent, stage, 'succeeded')) === null) return;
    await advance(deps, await reload(deps, intent.id), 'awaiting_acceptance');
    return;
  }
  if ((await finishStageRow(deps, intent, stage, 'failed', problems.join('; '))) === null) return;
  const current = await reload(deps, intent.id);
  const reworking = await advance(deps, current, 'building');
  await startBuild(deps, reworking);
}

export async function onJobResult(
  deps: OrchestratorDeps,
  job: JobRow,
  status: JobResultStatus,
  result: Record<string, unknown> | undefined,
  error?: string,
): Promise<void> {
  const intent = await reload(deps, job.intentId);
  if (intentTerminal(intent.status)) return;
  if (job.status !== 'offered' && job.status !== 'running') return;
  const stage = await loadStage(deps.db, job.stageId);
  if (!stage || (stage.status !== 'pending' && stage.status !== 'running')) return;
  if (status !== 'succeeded') {
    await retryOrBlock(deps, job, error ?? `job ${status}`);
    return;
  }
  const payload = jobPayloadOf(job);
  switch (payload.kind) {
    case 'intake':
      await onIntakeResult(deps, job, stage, intent, result);
      return;
    case 'spec':
      await onSpecResult(deps, job, stage, intent);
      return;
    case 'spec_critic':
      await onSpecCriticResult(deps, job, stage, intent);
      return;
    case 'plan':
      await onPlanResult(deps, job, stage, intent, result);
      return;
    case 'build':
      await onBuildResult(deps, job, stage, intent, result);
      return;
    case 'review':
      await onReviewResult(deps, job, stage, intent);
      return;
    case 'verify':
      await onVerifyResult(deps, job, stage, intent, result);
      return;
    case 'accept':
      await finishStageRow(deps, intent, stage, 'succeeded');
      return;
  }
}

export async function onJobSpec(
  deps: OrchestratorDeps,
  job: JobRow,
  bodyMd: string,
): Promise<void> {
  const intent = await reload(deps, job.intentId);
  if (intent.status !== 'clarifying' && intent.status !== 'specified') return;
  await submitSpec(deps, ORCHESTRATOR, intent, { bodyMd });
  const reloaded = await reload(deps, job.intentId);
  publishJob(deps, reloaded, job);
}

export async function onBuildDiff(
  deps: OrchestratorDeps,
  job: JobRow,
  kind: 'diff_summary' | 'link',
  meta: Record<string, unknown>,
): Promise<void> {
  const payload = jobPayloadOf(job);
  const suffix = payload.taskId ?? job.id;
  await writeArtifact(deps.db, {
    intentId: job.intentId,
    kind: `${kind}:${suffix}`,
    jobId: job.id,
    meta: { ...meta, jobId: job.id, taskId: payload.taskId ?? null },
  });
}
