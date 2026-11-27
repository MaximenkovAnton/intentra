import { and, asc, eq } from 'drizzle-orm';
import {
  VerifyReportSchema,
  type Evidence,
  type FindingClass,
  type GateStatus,
  type IntentMetrics,
} from '@intentra/contracts';
import type { Database } from '../db/client.js';
import {
  decisions,
  escalations,
  findings,
  jobs,
  runners,
  stages,
  verdicts,
  type IntentRow,
} from '../db/schema.js';
import { toDecisionDto, toFindingDto, toJobDto, toStageDto, toVerdictDto } from '../dto.js';
import { humanWaitMs } from './verify.js';

const FINDING_CLASSES: readonly FindingClass[] = [
  'ambiguous',
  'missing-evidence',
  'contradiction',
  'unprovable',
  'stale-doc',
  'scope',
];

const numberValue = (value: unknown): number => (typeof value === 'number' ? value : 0);

const gatesOf = (result: Record<string, unknown> | null): readonly GateStatus[] => {
  if (result === null) return [];
  const candidate = result.report ?? result;
  const parsed = VerifyReportSchema.safeParse(candidate);
  return parsed.success ? parsed.data.gates : [];
};

export async function buildEvidence(db: Database, intent: IntentRow, now: Date): Promise<Evidence> {
  const [decisionRows, findingRows, verdictRows, stageRows, jobRows, wait] = await Promise.all([
    db
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, intent.projectId), eq(decisions.intentId, intent.id))),
    db.select().from(findings).where(eq(findings.intentId, intent.id)),
    db
      .select({ verdict: verdicts })
      .from(verdicts)
      .innerJoin(jobs, eq(verdicts.jobId, jobs.id))
      .where(eq(jobs.intentId, intent.id)),
    db.select().from(stages).where(eq(stages.intentId, intent.id)).orderBy(asc(stages.startedAt)),
    db.select().from(jobs).where(eq(jobs.intentId, intent.id)),
    humanWaitMs(db, intent.id),
  ]);

  const gates = jobRows.flatMap((job) => gatesOf(job.result));
  const findingsByClass = Object.fromEntries(
    FINDING_CLASSES.map((findingClass) => [
      findingClass,
      findingRows.filter((row) => row.class === findingClass).length,
    ]),
  ) as Record<FindingClass, number>;
  const metrics: IntentMetrics = {
    durationMs:
      intent.acceptedAt === null
        ? Math.max(0, now.getTime() - intent.createdAt.getTime())
        : Math.max(0, intent.acceptedAt.getTime() - intent.createdAt.getTime()),
    humanWaitMs: wait,
    attempts: jobRows.reduce((total, job) => total + job.attempt, 0),
    inputTokens: jobRows.reduce((total, job) => total + numberValue(job.result?.inputTokens), 0),
    outputTokens: jobRows.reduce((total, job) => total + numberValue(job.result?.outputTokens), 0),
    findingsByClass,
    gates: {
      pass: gates.filter((gate) => gate.status === 'pass').length,
      fail: gates.filter((gate) => gate.status === 'fail').length,
      skipped: gates.filter((gate) => gate.status === 'skipped').length,
    },
  };

  return {
    decisions: decisionRows.map(toDecisionDto),
    findings: findingRows.map(toFindingDto),
    verdicts: verdictRows.map((row) => toVerdictDto(row.verdict)),
    stages: stageRows.map(toStageDto),
    jobs: jobRows.map(toJobDto),
    gates,
    metrics,
  };
}

const line = (name: string, value: number, labels = ''): string =>
  labels === '' ? `${name} ${value}` : `${name}{${labels}} ${value}`;

export async function renderPrometheusMetrics(db: Database, now: Date): Promise<string> {
  const [stageRows, jobsByStatus, findingsByClass, onlineRunners, tokenRows, escalationRows] =
    await Promise.all([
      db
        .select({ kind: stages.kind, status: stages.status, startedAt: stages.startedAt, finishedAt: stages.finishedAt })
        .from(stages),
      db.select({ status: jobs.status, attempt: jobs.attempt }).from(jobs),
      db.select({ class: findings.class, severity: findings.severity }).from(findings),
      db.select({ id: runners.id }).from(runners).where(eq(runners.status, 'online')),
      db.select({ result: jobs.result }).from(jobs),
      db.select({ createdAt: escalations.createdAt, answeredAt: escalations.answeredAt }).from(escalations),
    ]);

  const lines: string[] = [
    '# HELP intentra_stage_duration_ms Average finished stage duration in milliseconds.',
    '# TYPE intentra_stage_duration_ms gauge',
  ];
  const byKind = new Map<string, { total: number; count: number }>();
  for (const stage of stageRows) {
    if (stage.startedAt === null || stage.finishedAt === null) continue;
    const entry = byKind.get(stage.kind) ?? { total: 0, count: 0 };
    entry.total += Math.max(0, stage.finishedAt.getTime() - stage.startedAt.getTime());
    entry.count += 1;
    byKind.set(stage.kind, entry);
  }
  for (const [kind, entry] of byKind) {
    lines.push(line('intentra_stage_duration_ms', Math.round(entry.total / entry.count), `kind="${kind}"`));
  }

  lines.push('# TYPE intentra_jobs gauge');
  const jobCounts = new Map<string, number>();
  let attempts = 0;
  for (const job of jobsByStatus) {
    jobCounts.set(job.status, (jobCounts.get(job.status) ?? 0) + 1);
    attempts += job.attempt;
  }
  for (const [status, count] of jobCounts) lines.push(line('intentra_jobs', count, `status="${status}"`));

  lines.push('# TYPE intentra_job_attempts_total counter');
  lines.push(line('intentra_job_attempts_total', attempts));

  lines.push('# TYPE intentra_findings_total counter');
  const classCounts = new Map<string, number>();
  for (const finding of findingsByClass) {
    classCounts.set(finding.class, (classCounts.get(finding.class) ?? 0) + 1);
  }
  for (const [findingClass, count] of classCounts) {
    lines.push(line('intentra_findings_total', count, `class="${findingClass}"`));
  }

  lines.push('# TYPE intentra_token_usage_total counter');
  let inputTokens = 0;
  let outputTokens = 0;
  for (const row of tokenRows) {
    inputTokens += numberValue(row.result?.inputTokens);
    outputTokens += numberValue(row.result?.outputTokens);
  }
  lines.push(line('intentra_token_usage_total', inputTokens, 'direction="input"'));
  lines.push(line('intentra_token_usage_total', outputTokens, 'direction="output"'));

  lines.push('# TYPE intentra_human_wait_ms_total counter');
  const wait = escalationRows.reduce(
    (total, row) =>
      row.answeredAt === null ? total : total + Math.max(0, row.answeredAt.getTime() - row.createdAt.getTime()),
    0,
  );
  lines.push(line('intentra_human_wait_ms_total', wait));

  lines.push('# TYPE intentra_runners_online gauge');
  lines.push(line('intentra_runners_online', onlineRunners.length));

  lines.push('# TYPE intentra_metrics_timestamp_seconds gauge');
  lines.push(line('intentra_metrics_timestamp_seconds', Math.floor(now.getTime() / 1000)));

  return `${lines.join('\n')}\n`;
}
