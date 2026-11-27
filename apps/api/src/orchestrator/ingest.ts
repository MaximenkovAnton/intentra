import { and, eq, inArray } from 'drizzle-orm';
import { type JobAnswer, type JobResultStatus, type RunnerToCenterMessage } from '@intentra/contracts';
import type { Database } from '../db/client.js';
import { jobs, type IntentRow, type JobRow } from '../db/schema.js';
import { HttpError } from '../errors.js';
import {
  escalate,
  submitFindings,
  submitVerdict,
  SPEC_CRITIC_ROLE,
  type Actor,
  type IntentDeps,
} from '../intents/service.js';
import {
  closeCarriedFindings,
  commitRunnerSeq,
  isRunnerSeqNew,
  jobPayloadOf,
  loadIntent,
  markJobRunning,
  mergeJobUsage,
  renewJobLease,
  requeueJob,
  type OrchestratorDeps,
} from './jobs.js';
import { onBuildDiff, onJobResult, onJobSpec } from './flow.js';
import { REVIEW_ROLE } from './stages.js';

export interface IngestControl {
  setActiveJob(jobId: string | null): void;
  dispatch(): Promise<void>;
  answer(answer: JobAnswer): void;
}

const loadJob = async (db: Database, jobId: string, runnerId: string): Promise<JobRow> => {
  const [job] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.runnerId, runnerId),
        inArray(jobs.status, ['offered', 'running']),
      ),
    )
    .limit(1);
  if (!job) throw new HttpError('NOT_FOUND', 'Job is not assigned to this runner');
  return job;
};

const loadIntentRow = async (db: Database, job: JobRow): Promise<IntentRow> => {
  const intent = await loadIntent(db, job.intentId);
  if (!intent) throw new HttpError('NOT_FOUND', 'Intent not found');
  return intent;
};

const runnerActor = (runnerId: string): Actor => ({ kind: 'agent', id: runnerId });

const jobRole = (job: JobRow): string => {
  switch (jobPayloadOf(job).kind) {
    case 'spec_critic':
      return SPEC_CRITIC_ROLE;
    case 'review':
      return REVIEW_ROLE;
    default:
      throw new HttpError('CONFLICT', 'Only review and spec_critic jobs report findings or verdicts', {
        jobId: job.id,
      });
  }
};

const requireSeq = (job: JobRow, seq: number): boolean => isRunnerSeqNew(job, seq);

const finishSeq = (deps: OrchestratorDeps, job: JobRow, seq: number): Promise<void> =>
  commitRunnerSeq(deps, job.id, seq);

const intentsDeps = (deps: OrchestratorDeps): IntentDeps => ({
  db: deps.db,
  events: deps.events,
  memory: deps.memory,
  now: deps.now,
});
export async function handleRunnerMessage(
  deps: OrchestratorDeps,
  runnerId: string,
  message: RunnerToCenterMessage,
  control: IngestControl,
): Promise<void> {
  switch (message.type) {
    case 'job.accept': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      const running = await markJobRunning(deps, job.id, runnerId, deps.now());
      if (running) control.setActiveJob(running.id);
      return;
    }
    case 'job.heartbeat': {
      await renewJobLease(deps, message.jobId, runnerId, deps.now());
      return;
    }
    case 'job.status': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      if (message.usage) await mergeJobUsage(deps, job.id, message.usage);
      if (message.status === 'running') {
        const running = await markJobRunning(deps, job.id, runnerId, deps.now());
        if (running) control.setActiveJob(running.id);
        await finishSeq(deps, job, message.seq);
        return;
      }
      await onJobResult(deps, job, message.status, undefined, message.detail);
      await finishSeq(deps, job, message.seq);
      control.setActiveJob(null);
      await control.dispatch();
      return;
    }
    case 'job.event': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      if (message.event.type === 'usage') await mergeJobUsage(deps, job.id, message.event);
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.findings': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      const intent = await loadIntentRow(deps.db, job);
      await submitFindings(intentsDeps(deps), runnerActor(runnerId), intent, {
        role: jobRole(job),
        jobId: job.id,
        findings: message.findings,
      });
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.verdict': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      const intent = await loadIntentRow(deps.db, job);
      const role = jobRole(job);
      if (message.decision === 'approve') await closeCarriedFindings(deps, intent.id, role);
      await submitVerdict(intentsDeps(deps), runnerActor(runnerId), intent, {
        jobId: job.id,
        role,
        decision: message.decision,
        ...(message.artifactSha256 === undefined ? {} : { artifactSha256: message.artifactSha256 }),
      });
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.spec': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      await onJobSpec(deps, job, message.bodyMd);
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.diff_summary': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      const additions = message.files.reduce((sum, file) => sum + file.additions, 0);
      const deletions = message.files.reduce((sum, file) => sum + file.deletions, 0);
      await onBuildDiff(deps, job, 'diff_summary', {
        files: message.files,
        additions,
        deletions,
        fileCount: message.files.length,
      });
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.link': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      await onBuildDiff(deps, job, 'link', {
        ...(message.branch === undefined ? {} : { branch: message.branch }),
        ...(message.commit === undefined ? {} : { commit: message.commit }),
        ...(message.prUrl === undefined ? {} : { prUrl: message.prUrl }),
      });
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.question': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      if (!requireSeq(job, message.seq)) return;
      const intent = await loadIntentRow(deps.db, job);
      try {
        await escalate(intentsDeps(deps), runnerActor(runnerId), intent, message.question);
      } catch (error: unknown) {
        if (!(error instanceof HttpError)) throw error;
        control.answer({ type: 'job.answer', jobId: job.id, answer: { cancelled: true } });
      }
      await finishSeq(deps, job, message.seq);
      return;
    }
    case 'job.declined': {
      const [job] = await deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, message.jobId), eq(jobs.runnerId, runnerId), eq(jobs.status, 'offered')))
        .limit(1);
      if (job) {
        await requeueJob(deps, job, deps.now(), message.reason);
        await control.dispatch();
      }
      return;
    }
    case 'job.result': {
      const job = await loadJob(deps.db, message.jobId, runnerId);
      const seq = message.seq ?? (job.runnerSeq ?? 0) + 1;
      if (!requireSeq(job, seq)) return;
      const status: JobResultStatus = message.status;
      await onJobResult(deps, job, status, message.result, message.error);
      await finishSeq(deps, job, seq);
      control.setActiveJob(null);
      await control.dispatch();
      return;
    }
    case 'hello':
    case 'heartbeat':
      return;
  }
}
