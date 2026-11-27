import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AnswerIntentInput, IntentAnswerResult, ReworkIntentInput } from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import { intents, jobs, projects, type IntentRow, type StageRow } from '../db/schema.js';
import { answerEscalation, type Actor } from '../intents/service.js';
import { HttpError } from '../errors.js';
import {
  claimJob,
  jobPayloadOf,
  LEASE_MS,
  nextQueuedJob,
  requeueExpiredLeases,
  requeueJob,
  type OrchestratorDeps,
} from './jobs.js';
import { createRunnerHub, type RunnerConnectionView, type RunnerHub } from './hub.js';
import { handleRunnerMessage } from './ingest.js';
import { retryIntake, startBuild, startIntake, startPlan } from './flow.js';
import { acceptIntent, cancelIntent, reworkIntent, type AcceptResult } from './verify.js';
import { buildEvidence, renderPrometheusMetrics } from './metrics.js';

const TICK_MS = 5_000;

const runtimeOf = (adapters: ReadonlySet<string>): string => {
  if (adapters.has('dsh')) return 'dsh';
  const first = adapters.values().next();
  return first.done === true ? 'generic' : first.value;
};

export interface Orchestrator {
  readonly hub: RunnerHub;
  start(): void;
  close(): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  startIntake(intent: IntentRow): Promise<void>;
  retry(actor: Actor, intent: IntentRow): Promise<IntentRow>;
  startPlan(intent: IntentRow): Promise<void>;
  startBuild(intent: IntentRow): Promise<StageRow>;
  dispatch(): Promise<void>;
  sweep(): Promise<number>;
  accept(actor: Actor, intent: IntentRow): Promise<AcceptResult>;
  answerEscalation(actor: Actor, intent: IntentRow, input: AnswerIntentInput): Promise<IntentAnswerResult>;
  rework(actor: Actor, intent: IntentRow, input: ReworkIntentInput): Promise<IntentRow>;
  cancel(actor: Actor, intent: IntentRow): Promise<IntentRow>;
  evidence(intent: IntentRow): Promise<Awaited<ReturnType<typeof buildEvidence>>>;
  metrics(): Promise<string>;
}

export function createOrchestrator(deps: AppDeps): Orchestrator {
  const orchestratorDeps: OrchestratorDeps = { db: deps.db, events: deps.events, memory: deps.memory, now: deps.now };
  const hub = createRunnerHub(deps);
  let ticker: NodeJS.Timeout | null = null;

  const offer = async (session: RunnerConnectionView): Promise<void> => {
    if (session.activeJobId !== null || session.adapters.size === 0) return;
    const now = deps.now();
    const job = await nextQueuedJob(orchestratorDeps, session.projectIds, now);
    if (!job) return;
    const runtime = runtimeOf(session.adapters);
    const claimed = await claimJob(orchestratorDeps, job, session.runnerId, runtime, now);
    if (!claimed) return;
    const projectKey = await projectKeyOf(claimed.intentId);
    const sent = hub.sendOffer(session.runnerId, {
      type: 'job.offer',
      jobId: claimed.id,
      intentId: claimed.intentId,
      stage: jobPayloadOf(claimed).kind,
      runtime,
      payload: { ...claimed.payload, ...(projectKey === null ? {} : { projectKey }) },
      leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
    });
    if (!sent) await requeueJob(orchestratorDeps, claimed, now, 'runner disconnected');
  };

  const projectKeyOf = async (intentId: string): Promise<string | null> => {
    const [row] = await deps.db
      .select({ key: projects.key })
      .from(intents)
      .innerJoin(projects, eq(intents.projectId, projects.id))
      .where(eq(intents.id, intentId))
      .limit(1);
    return row?.key ?? null;
  };

  const dispatch = async (): Promise<void> => {
    for (const session of hub.sessions()) {
      await offer(session);
    }
  };

  hub.setHandler({
    onMessage: async (runnerId, message, control) => {
      await handleRunnerMessage(orchestratorDeps, runnerId, message, {
        setActiveJob: (jobId) => {
          control.setActiveJob(jobId);
        },
        dispatch,
        answer: (answer) => {
          hub.sendAnswer(runnerId, answer);
        },
      });
    },
    onReady: async () => {
      await dispatch();
    },
    onDisconnect: async () => {
      await dispatch();
    },
  });

  const kickoff = async (intent: IntentRow, target: 'build' | 'plan'): Promise<void> => {
    try {
      if (target === 'plan') await startPlan(orchestratorDeps, intent);
      else await startBuild(orchestratorDeps, intent);
    } catch (error: unknown) {
      if (!(error instanceof HttpError) || error.code !== 'CONFLICT') throw error;
    }
    await dispatch();
  };

  const sweep = async (): Promise<number> => {
    const requeued = await requeueExpiredLeases(orchestratorDeps, deps.now());
    await dispatch();
    return requeued;
  };

  const start = (): void => {
    if (ticker !== null) return;
    ticker = setInterval(() => {
      void sweep().catch((error: unknown) => {
        deps.logger.warn({ err: error }, 'orchestrator sweep failed');
      });
    }, TICK_MS);
    ticker.unref();
  };

  return {
    hub,
    handleUpgrade: (request, socket, head) => {
      hub.handleUpgrade(request, socket, head);
    },
    start,
    close: () => {
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      hub.close();
    },
    startIntake: async (intent) => {
      await startIntake(orchestratorDeps, intent);
      await dispatch();
    },
    retry: async (actor, intent) => {
      const retried = await retryIntake(orchestratorDeps, actor, intent);
      await dispatch();
      return retried;
    },
    startPlan: async (intent) => {
      await startPlan(orchestratorDeps, intent);
      await dispatch();
    },
    startBuild: async (intent) => {
      const stage = await startBuild(orchestratorDeps, intent);
      await dispatch();
      return stage;
    },
    dispatch,
    sweep,
    accept: (actor, intent) => acceptIntent(orchestratorDeps, actor, intent),
    answerEscalation: async (actor, intent, input) => {
      const result = await answerEscalation(orchestratorDeps, actor, intent, input);
      const label = result.escalation.options.find((option) => option.id === input.optionId)?.label;
      const [job] = await deps.db
        .select({ id: jobs.id, runnerId: jobs.runnerId })
        .from(jobs)
        .where(and(eq(jobs.intentId, intent.id), eq(jobs.status, 'running'), isNotNull(jobs.runnerId)))
        .orderBy(desc(jobs.startedAt))
        .limit(1);
      if (job !== undefined && job.runnerId !== null) {
        hub.sendAnswer(job.runnerId, {
          type: 'job.answer',
          jobId: job.id,
          answer: {
            escalationId: result.escalation.id,
            optionId: input.optionId,
            label: label ?? input.optionId,
          },
        });
      }
      return result;
    },
    rework: async (actor, intent, input) => {
      const updated = await reworkIntent(orchestratorDeps, actor, intent, input);
      await kickoff(updated, input.target);
      return updated;
    },
    cancel: async (actor, intent) => {
      const { intent: updated, cancelledJobs } = await cancelIntent(orchestratorDeps, actor, intent);
      for (const job of cancelledJobs) {
        if (job.runnerId !== null) hub.sendCancel(job.runnerId, job.id, 'intent cancelled');
      }
      return updated;
    },
    evidence: (intent) => buildEvidence(deps.db, intent, deps.now()),
    metrics: () => renderPrometheusMetrics(deps.db, deps.now()),
  };
}
