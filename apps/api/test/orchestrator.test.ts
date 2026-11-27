import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { JobPayloadSchema, type Plan } from '@intentra/contracts';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  sha256,
  type Harness,
} from './harness.js';
import { INTENT_CARD, VALID_SPEC } from './fixtures.js';
import {
  artifacts,
  auditLog,
  escalations,
  findings,
  intents,
  jobs,
  projectMembers,
  runners,
  specs,
  stages,
  verdicts,
  type IntentRow,
  type JobRow,
  type ProjectRow,
  type StageRow,
  type UserRow,
} from '../src/db/schema.js';
import { writeArtifact } from '../src/intents/artifacts.js';
import { type DecisionRecord, type EpisodeRecord } from '../src/memory/episodes.js';
import type { MemoryApi } from '../src/memory/index.js';
import { jobPayloadOf } from '../src/orchestrator/jobs.js';

type WsMessage = Record<string, unknown>;

const isRecord = (value: unknown): value is WsMessage =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (message: WsMessage, key: string): string => {
  const value = message[key];
  if (typeof value !== 'string') throw new Error(`message has no string ${key}`);
  return value;
};

const PLAN: Plan = {
  tasks: [
    {
      id: 'orchestrator-api',
      title: 'Orchestrator API',
      spec: 'Implement the orchestrator services.',
      paths: ['apps/api/src/orchestrator'],
      acceptance: ['AC-1', 'AC-2'],
      dependsOn: [],
      reviewLens: 'code-reviewer',
    },
  ],
};

const PLAN_TWO: Plan = {
  tasks: [
    {
      id: 'orchestrator-jobs',
      title: 'Job queue',
      spec: 'Implement the job queue.',
      paths: ['apps/api/src/orchestrator/jobs.ts'],
      acceptance: ['AC-1'],
      dependsOn: [],
      reviewLens: 'code-reviewer',
    },
    {
      id: 'orchestrator-flow',
      title: 'Stage machine',
      spec: 'Implement the stage machine.',
      paths: ['apps/api/src/orchestrator/flow.ts'],
      acceptance: ['AC-2'],
      dependsOn: [],
      reviewLens: 'test-reviewer',
    },
  ],
};

interface MockRunner {
  readonly runnerId: string;
  readonly ws: WebSocket;
  next(timeoutMs?: number): Promise<WsMessage>;
  send(message: WsMessage): void;
  close(): void;
}

const HELLO: WsMessage = {
  type: 'hello',
  protocolVersion: 1,
  runnerVersion: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  adapters: [{ id: 'dsh', label: 'DSH' }],
  workspaces: ['/tmp/intentra-workspace'],
};

const memorySpy: { episodes: EpisodeRecord[]; decisions: DecisionRecord[] } = {
  episodes: [],
  decisions: [],
};

const fakeMemory = (): MemoryApi => ({
  graph: { snapshot: async () => ({ nodes: [], edges: [] }) },
  claims: {
    create: async () => {
      throw new Error('claims are not exercised here');
    },
    validate: async () => {
      throw new Error('claims are not exercised here');
    },
    get: async () => null,
    list: async () => [],
    contradictedIds: async () => new Set<string>(),
  },
  search: { search: async () => ({ items: [], degraded: false }) },
  buildContextPack: async () => ({ text: '', bytes: 0, degraded: false, version: 1 }),
  recordEpisode: async (input) => {
    memorySpy.episodes.push(input);
  },
  recordDecision: async (input) => {
    memorySpy.decisions.push(input);
  },
});

describe.skipIf(!hasDatabase)('orchestrator', () => {
  let harness: Harness;
  let port = 0;
  const mocks: MockRunner[] = [];

  beforeAll(async () => {
    harness = await createHarness({}, { memory: fakeMemory() });
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('app is not listening');
    port = address.port;
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
    memorySpy.episodes.length = 0;
    memorySpy.decisions.length = 0;
  });
  afterEach(async () => {
    for (const mock of mocks) {
      if (mock.ws.readyState === WebSocket.OPEN) mock.close();
    }
    for (const mock of mocks) {
      await expect.poll(() => harness.app.orchestrator.hub.online(mock.runnerId), { timeout: 3000 }).toBe(false);
    }
    mocks.length = 0;
  });

  const createMockRunner = async (runnerId: string, token: string): Promise<MockRunner> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/runners/ws?token=${encodeURIComponent(token)}`);
    const queue: WsMessage[] = [];
    const waiters: { resolve: (message: WsMessage) => void; timer: NodeJS.Timeout }[] = [];
    ws.on('message', (data: { toString(): string }) => {
      const parsed: unknown = JSON.parse(data.toString());
      if (!isRecord(parsed)) return;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        queue.push(parsed);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const mock: MockRunner = {
      runnerId,
      ws,
      next: (timeoutMs = 5000) => {
        const queued = queue.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting for a runner message')), timeoutMs);
          waiters.push({ resolve, timer });
        });
      },
      send: (message) => ws.send(JSON.stringify(message)),
      close: () => ws.close(),
    };
    mocks.push(mock);
    return mock;
  };

  const setupProject = async (): Promise<{ owner: UserRow; project: ProjectRow; cookie: Record<string, string> }> => {
    const owner = await seedUser(harness.db, { isAdmin: true, name: 'Owner' });
    const project = await seedProject(harness.db, owner.id, 'acme');
    const cookie = authCookie(await seedSession(harness.db, owner.id));
    return { owner, project, cookie };
  };

  const registerRunner = async (cookie: Record<string, string>, name = 'dsh-laptop') => {
    const tokenResponse = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/runners/registration-token',
      headers: cookie,
    });
    expect(tokenResponse.statusCode).toBe(201);
    const registrationToken = tokenResponse.json<{ token: string }>().token;
    const registered = await harness.app.inject({
      method: 'POST',
      url: '/api/runners/register',
      payload: {
        registrationToken,
        name,
        os: 'linux',
        arch: 'x86_64',
        version: '0.1.0',
        capabilities: ['dsh'],
      },
    });
    expect(registered.statusCode).toBe(201);
    return registered.json<{ runnerId: string; token: string }>();
  };

  const connectRunner = async (cookie: Record<string, string>, name?: string): Promise<MockRunner> => {
    const runner = await registerRunner(cookie, name);
    const mock = await createMockRunner(runner.runnerId, runner.token);
    mock.send(HELLO);
    await expect
      .poll(async () => {
        const [row] = await harness.db.select().from(runners).where(eq(runners.id, runner.runnerId));
        return row?.status;
      })
      .toBe('online');
    return mock;
  };

  const createIntentThroughApi = async (cookie: Record<string, string>): Promise<string> => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects/acme/intents',
      headers: cookie,
      payload: { title: 'Orchestrate the flow', statement: 'Drive stages and jobs through a runner' },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };

  const nextOffer = async (mock: MockRunner): Promise<{ jobId: string; stage: string }> => {
    const message = await mock.next();
    expect(text(message, 'type')).toBe('job.offer');
    return { jobId: text(message, 'jobId'), stage: text(message, 'stage') };
  };

  const offerFor = async (mock: MockRunner, stage: string): Promise<string> => {
    const offer = await nextOffer(mock);
    expect(offer.stage).toBe(stage);
    mock.send({ type: 'job.accept', jobId: offer.jobId });
    return offer.jobId;
  };

  const seedAwaitingIntent = async (project: ProjectRow, createdBy: string): Promise<IntentRow> => {
    const [row] = await harness.db
      .insert(intents)
      .values({
        projectId: project.id,
        title: 'Awaiting acceptance',
        statement: 'A verified intent',
        status: 'awaiting_acceptance',
        createdBy,
      })
      .returning();
    if (!row) throw new Error('intent insert returned no row');
    return row;
  };

  const seedVerifyJob = async (
    intentId: string,
    status: 'succeeded' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> => {
    const [stage] = await harness.db
      .insert(stages)
      .values({ intentId, kind: 'verify', status, startedAt: new Date() })
      .returning();
    if (!stage) throw new Error('stage insert returned no row');
    await harness.db.insert(jobs).values({
      intentId,
      stageId: stage.id,
      runtime: 'test',
      status,
      result,
      attempt: 1,
    });
  };

  const seedRunningJob = async (
    intentId: string,
    runnerId: string,
    kind: 'review' | 'spec_critic',
    taskId?: string,
  ): Promise<{ stage: StageRow; job: JobRow }> => {
    const [stage] = await harness.db
      .insert(stages)
      .values({ intentId, kind, status: 'running', startedAt: new Date() })
      .returning();
    if (!stage) throw new Error('stage insert returned no row');
    const [job] = await harness.db
      .insert(jobs)
      .values({
        intentId,
        stageId: stage.id,
        runnerId,
        runtime: 'test',
        status: 'running',
        attempt: 1,
        payload: {
          kind,
          prompt: 'test',
          context: '',
          limits: { timeoutSeconds: 3600 },
          ...(taskId === undefined ? {} : { taskId }),
          dependsOn: [],
          gateCriteria: [],
        },
      })
      .returning();
    if (!job) throw new Error('job insert returned no row');
    return { stage, job };
  };

  const seedReviewStage = async (
    intentId: string,
    runnerId: string,
    taskIds: readonly string[],
    status: 'running' | 'failed' = 'running',
  ): Promise<{ stage: StageRow; jobRows: readonly JobRow[] }> => {
    const [stage] = await harness.db
      .insert(stages)
      .values({
        intentId,
        kind: 'review',
        status,
        startedAt: new Date(),
        ...(status === 'failed' ? { finishedAt: new Date() } : {}),
      })
      .returning();
    if (!stage) throw new Error('stage insert returned no row');
    const jobRows: JobRow[] = [];
    for (const taskId of taskIds) {
      const [job] = await harness.db
        .insert(jobs)
        .values({
          intentId,
          stageId: stage.id,
          runnerId,
          runtime: 'test',
          status: status === 'failed' ? 'failed' : 'running',
          attempt: 1,
          payload: {
            kind: 'review',
            prompt: 'test',
            context: '',
            limits: { timeoutSeconds: 3600 },
            taskId,
            dependsOn: [],
            gateCriteria: [],
          },
        })
        .returning();
      if (!job) throw new Error('job insert returned no row');
      jobRows.push(job);
      await writeArtifact(harness.db, { intentId, kind: `diff_summary:${taskId}`, meta: { files: [] } });
    }
    return { stage, jobRows };
  };

  const seedSpecRow = async (intentId: string): Promise<void> => {
    await harness.db.insert(specs).values({
      intentId,
      version: 1,
      bodyMd: VALID_SPEC,
      status: 'approved',
      sha256: sha256(VALID_SPEC),
    });
  };

  const currentJob = async (jobId: string): Promise<JobRow> => {
    const [row] = await harness.db.select().from(jobs).where(eq(jobs.id, jobId));
    if (!row) throw new Error(`job ${jobId} not found`);
    return row;
  };

  it(
    'drives intent, spec, critic, plan, build, review, verify and accept through a mock runner',
    async () => {
      const { cookie } = await setupProject();
      const seen: { type: string; data?: Record<string, unknown> }[] = [];
      const unsubscribe = harness.events.subscribe((event) => seen.push({ type: event.type, data: event.data }));
      const mock = await connectRunner(cookie);

      const intentId = await createIntentThroughApi(cookie);

      const intakeJob = await offerFor(mock, 'intake');
      mock.send({
        type: 'job.result',
        seq: 1,
        jobId: intakeJob,
        status: 'succeeded',
        result: { card: INTENT_CARD },
      });

      const specJob = await offerFor(mock, 'spec');
      mock.send({ type: 'job.spec', seq: 1, jobId: specJob, bodyMd: VALID_SPEC });
      mock.send({ type: 'job.result', seq: 2, jobId: specJob, status: 'succeeded' });

      const criticJob = await offerFor(mock, 'spec_critic');
      const spec = await harness.app.inject({
        method: 'GET',
        url: `/api/intents/${intentId}/spec`,
        headers: cookie,
      });
      expect(spec.statusCode).toBe(200);
      mock.send({
        type: 'job.verdict',
        seq: 1,
        jobId: criticJob,
        role: 'spec_critic',
        decision: 'approve',
      });
      mock.send({ type: 'job.result', seq: 2, jobId: criticJob, status: 'succeeded' });

      const planJob = await offerFor(mock, 'plan');
      mock.send({
        type: 'job.result',
        seq: 1,
        jobId: planJob,
        status: 'succeeded',
        result: { plan: PLAN },
      });

      const buildJob = await offerFor(mock, 'build');
      mock.send({
        type: 'job.diff_summary',
        seq: 1,
        jobId: buildJob,
        files: [{ path: 'apps/api/src/orchestrator/jobs.ts', status: 'modified', additions: 42, deletions: 3 }],
      });
      mock.send({
        type: 'job.link',
        seq: 2,
        jobId: buildJob,
        branch: 'intentra/orchestrator',
        commit: 'abc1234',
      });
      mock.send({
        type: 'job.result',
        seq: 3,
        jobId: buildJob,
        status: 'succeeded',
        result: { gates: [{ criterion: 'build', status: 'pass', durationMs: 12, exitCode: 0 }] },
      });

      const reviewJob = await offerFor(mock, 'review');
      mock.send({ type: 'job.verdict', seq: 1, jobId: reviewJob, role: 'code-reviewer', decision: 'approve' });
      mock.send({ type: 'job.result', seq: 2, jobId: reviewJob, status: 'succeeded' });

      const verifyJob = await offerFor(mock, 'verify');
      mock.send({
        type: 'job.result',
        seq: 1,
        jobId: verifyJob,
        status: 'succeeded',
        result: {
          gates: [
            { criterion: 'build', status: 'pass', durationMs: 5, exitCode: 0 },
            { criterion: 'tests', status: 'pass', durationMs: 50, exitCode: 0 },
          ],
          claims: [{ statement: 'the orchestrator route exists', status: 'fresh' }],
        },
      });

      await expect
        .poll(async () => {
          const detail = await harness.app.inject({
            method: 'GET',
            url: `/api/intents/${intentId}`,
            headers: cookie,
          });
          return detail.json<{ intent: { status: string } }>().intent.status;
        })
        .toBe('awaiting_acceptance');

      const accepted = await harness.app.inject({
        method: 'POST',
        url: `/api/intents/${intentId}/accept`,
        headers: cookie,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<{ status: string }>().status).toBe('accepted');
      expect(memorySpy.episodes).toEqual([
        expect.objectContaining({
          intentId,
          summary: expect.stringContaining('Orchestrate the flow'),
        }),
      ]);

      const evidence = await harness.app.inject({
        method: 'GET',
        url: `/api/intents/${intentId}/evidence`,
        headers: cookie,
      });
      expect(evidence.statusCode).toBe(200);
      const pack = evidence.json<{
        stages: { kind: string }[];
        jobs: { status: string }[];
        gates: { status: string }[];
        metrics: { attempts: number; gates: { pass: number } };
      }>();
      expect(pack.stages.map((stage) => stage.kind)).toEqual([
        'intake',
        'spec',
        'spec_critic',
        'plan',
        'build',
        'review',
        'verify',
      ]);
      expect(pack.gates.length).toBeGreaterThanOrEqual(2);
      expect(pack.metrics.gates.pass).toBeGreaterThanOrEqual(2);
      expect(pack.jobs.some((job) => job.status === 'succeeded')).toBe(true);

      const intakeEvents = seen
        .filter((event) => event.type === 'job.updated' && event.data?.id === intakeJob)
        .map((event) => (event.data as { status: string }).status);
      expect(intakeEvents).toEqual(['queued', 'offered', 'running', 'succeeded']);

      const audits = await harness.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.target, intentId));
      expect(audits.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'intent.accept',
          'intent.spec.submit',
          'intent.plan.submit',
          'intent.verdict.submit',
        ]),
      );

      const verdictRoles = await harness.db
        .select({ role: verdicts.role })
        .from(verdicts)
        .innerJoin(jobs, eq(verdicts.jobId, jobs.id))
        .where(eq(jobs.intentId, intentId));
      expect(verdictRoles.map((row) => row.role).sort()).toEqual(['review', 'spec-critic']);
      unsubscribe();
    },
    40_000,
  );

  it('does not lose a job when the runner reconnects', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const first = await nextOffer(mock);
    expect(first.stage).toBe('intake');
    mock.send({ type: 'job.status', seq: 1, jobId: first.jobId, status: 'running' });
    await expect.poll(async () => (await currentJob(first.jobId)).runnerSeq).toBe(1);

    mock.close();
    await expect.poll(async () => (await currentJob(first.jobId)).status).toBe('queued');
    expect((await currentJob(first.jobId)).runnerSeq).toBeNull();

    const reconnected = await connectRunner(cookie, 'dsh-laptop-2');
    const second = await nextOffer(reconnected);
    expect(second.jobId).toBe(first.jobId);

    reconnected.send({ type: 'job.accept', jobId: second.jobId });
    reconnected.send({
      type: 'job.result',
      seq: 1,
      jobId: second.jobId,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    const resumedAs = await nextOffer(reconnected);
    expect(resumedAs.stage).toBe('spec');

    const done = await currentJob(first.jobId);
    expect(done.attempt).toBe(2);
    expect(done.status).toBe('succeeded');
    expect(intentId.length).toBeGreaterThan(0);
  }, 20_000);

  it('retries the spec writer with the mechanical critic required change', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const intakeJob = await offerFor(mock, 'intake');
    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    const specJob = await offerFor(mock, 'spec');
    await harness.db.insert(specs).values({
      intentId,
      version: 1,
      bodyMd: VALID_SPEC,
      status: 'draft',
      sha256: sha256(VALID_SPEC),
    });
    await harness.db.insert(findings).values({
      intentId,
      role: 'spec-critic',
      class: 'ambiguous',
      severity: 'blocking',
      requirement: 'Acceptance criterion "AC-1" has an unknown type',
      evidence: 'contract',
      requiredChange: 'Use functional or nonfunctional',
      round: 1,
      status: 'open',
    });
    mock.send({ type: 'job.result', seq: 1, jobId: specJob, status: 'succeeded' });

    await expect
      .poll(async () => jobPayloadOf(await currentJob(specJob)).prompt)
      .toContain('has an unknown type');
    const prompt = jobPayloadOf(await currentJob(specJob)).prompt;
    expect(prompt).toContain('has an unknown type');
    expect(prompt).toContain('(evidence: contract)');
    expect(prompt).toContain('-> fix: Use functional or nonfunctional');
    expect(prompt).toContain('Type is exactly functional or nonfunctional');
  }, 20_000);

  it('expires an offered lease, backs off and finally expires the job and its stage', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    await createIntentThroughApi(cookie);
    const offer = await nextOffer(mock);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await harness.db
        .update(jobs)
        .set({ leaseUntil: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, offer.jobId));
      const requeued = await harness.app.orchestrator.sweep();
      expect(requeued).toBe(1);
      const [job] = await harness.db.select().from(jobs).where(eq(jobs.id, offer.jobId));
      expect(job?.status).toBe('queued');
      expect(job?.attempt).toBe(attempt);
      expect(job?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      await harness.db
        .update(jobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, offer.jobId));
      await harness.app.orchestrator.dispatch();
      const reoffered = await nextOffer(mock);
      expect(reoffered.jobId).toBe(offer.jobId);
    }

    await harness.db
      .update(jobs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, offer.jobId));
    await harness.app.orchestrator.sweep();
    const [expired] = await harness.db.select().from(jobs).where(eq(jobs.id, offer.jobId));
    expect(expired?.status).toBe('expired');
    if (!expired || expired.stageId === null) throw new Error('expired job lost its stage');
    const [stage] = await harness.db.select().from(stages).where(eq(stages.id, expired.stageId));
    expect(stage?.status).toBe('failed');
    await expect(mock.next(300)).rejects.toThrow('timeout');
  }, 20_000);

  it('ignores a duplicate seq instead of replaying the message', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const intakeJob = await offerFor(mock, 'intake');
    mock.send({ type: 'job.event', seq: 1, jobId: intakeJob, event: { type: 'usage', inputTokens: 10 } });
    mock.send({ type: 'job.event', seq: 1, jobId: intakeJob, event: { type: 'usage', inputTokens: 10 } });
    mock.send({
      type: 'job.result',
      seq: 2,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    const specJob = await offerFor(mock, 'spec');
    mock.send({
      type: 'job.result',
      seq: 2,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    mock.send({ type: 'job.spec', seq: 1, jobId: specJob, bodyMd: VALID_SPEC });
    mock.send({ type: 'job.result', seq: 2, jobId: specJob, status: 'succeeded' });
    await offerFor(mock, 'spec_critic');

    const intake = await currentJob(intakeJob);
    expect(intake.result?.inputTokens).toBe(10);
    const intentJobs = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    expect(intentJobs.map((job) => jobPayloadOf(job).kind).sort()).toEqual(['intake', 'spec', 'spec_critic']);
    const intentStages = await harness.db.select().from(stages).where(eq(stages.intentId, intentId));
    expect(intentStages.map((stage) => stage.kind).sort()).toEqual(['intake', 'spec', 'spec_critic']);
  }, 20_000);

  it('accepts a seq-less terminal result after runner events numbered per job', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const intakeJob = await offerFor(mock, 'intake');
    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    const specJob = await offerFor(mock, 'spec');
    mock.send({ type: 'job.event', seq: 1, jobId: specJob, event: { type: 'tool', name: 'read', status: 'started' } });
    mock.send({ type: 'job.event', seq: 2, jobId: specJob, event: { type: 'tool', name: 'read', status: 'finished' } });
    mock.send({ type: 'job.spec', seq: 3, jobId: specJob, bodyMd: VALID_SPEC });
    mock.send({ type: 'job.result', jobId: specJob, status: 'succeeded' });
    await offerFor(mock, 'spec_critic');

    const spec = await currentJob(specJob);
    expect(spec.status).toBe('succeeded');
    expect(spec.runnerSeq).toBe(3);
    const intentJobs = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    expect(intentJobs.map((job) => jobPayloadOf(job).kind).sort()).toEqual(['intake', 'spec', 'spec_critic']);
  }, 20_000);

  it('refuses accept while a blocking finding or a failed gate is open', async () => {
    const { owner, project, cookie } = await setupProject();
    const intent = await seedAwaitingIntent(project, owner.id);
    await harness.db.insert(findings).values({
      intentId: intent.id,
      role: 'review',
      acId: 'AC-1',
      class: 'ambiguous',
      severity: 'blocking',
      requirement: 'AC-1 has no observable result',
      evidence: 'the criterion says it works',
      status: 'open',
      round: 1,
    });

    const blocked = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/accept`,
      headers: cookie,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ code: string; details?: { findingIds?: string[] } }>().details?.findingIds).toHaveLength(1);

    await harness.db.update(findings).set({ status: 'closed' }).where(eq(findings.intentId, intent.id));
    await seedVerifyJob(intent.id, 'failed', {
      gates: [{ criterion: 'tests', status: 'fail', durationMs: 30, exitCode: 1 }],
    });

    const failedGate = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/accept`,
      headers: cookie,
    });
    expect(failedGate.statusCode).toBe(409);
    expect(failedGate.json<{ details?: { gates?: string[] } }>().details?.gates).toEqual(['tests']);

    await harness.db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.intentId, intent.id));
    await harness.db
      .update(jobs)
      .set({ result: { gates: [{ criterion: 'tests', status: 'pass', durationMs: 20, exitCode: 0 }] } })
      .where(eq(jobs.intentId, intent.id));

    const accepted = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/accept`,
      headers: cookie,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ status: string }>().status).toBe('accepted');
  }, 20_000);

  it('keeps history and reopens build or plan on rework', async () => {
    const { owner, project, cookie } = await setupProject();
    const intent = await seedAwaitingIntent(project, owner.id);
    const [priorStage] = await harness.db
      .insert(stages)
      .values({ intentId: intent.id, kind: 'build', status: 'succeeded', startedAt: new Date(), finishedAt: new Date() })
      .returning();
    if (!priorStage) throw new Error('stage insert returned no row');
    const [priorJob] = await harness.db
      .insert(jobs)
      .values({ intentId: intent.id, stageId: priorStage.id, runtime: 'test', status: 'succeeded', attempt: 1 })
      .returning();
    if (!priorJob) throw new Error('job insert returned no row');
    await writeArtifact(harness.db, { intentId: intent.id, kind: 'plan', meta: { ...PLAN } });
    await harness.db.insert(findings).values({
      intentId: intent.id,
      role: 'review',
      class: 'missing-evidence',
      severity: 'blocking',
      requirement: 'No test proves the lease expiry',
      evidence: 'the diff summary has no test file',
      status: 'open',
      round: 1,
    });

    const reworked = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/rework`,
      headers: cookie,
      payload: { reason: 'Add the lease expiry test', target: 'build' },
    });
    expect(reworked.statusCode).toBe(200);
    expect(reworked.json<{ status: string }>().status).toBe('building');

    const carried = await harness.db.select().from(findings).where(eq(findings.intentId, intent.id));
    expect(carried.every((row) => row.status === 'carried')).toBe(true);

    const keptStage = await harness.db.select().from(stages).where(eq(stages.id, priorStage.id));
    expect(keptStage.map((row) => row.status)).toEqual(['succeeded']);
    const keptJob = await harness.db.select().from(jobs).where(eq(jobs.id, priorJob.id));
    expect(keptJob.map((row) => row.status)).toEqual(['succeeded']);
    const reworkJobs = (await harness.db.select().from(jobs).where(eq(jobs.intentId, intent.id))).filter(
      (job) => job.id !== priorJob.id,
    );
    expect(reworkJobs.map((job) => jobPayloadOf(job).kind)).toEqual(['build']);
    expect(reworkJobs[0]?.attempt).toBe(0);

    const planIntent = await seedAwaitingIntent(project, owner.id);
    await harness.db.insert(specs).values({
      intentId: planIntent.id,
      version: 1,
      bodyMd: VALID_SPEC,
      status: 'approved',
      sha256: sha256(VALID_SPEC),
    });
    await writeArtifact(harness.db, { intentId: planIntent.id, kind: 'plan', meta: { ...PLAN } });
    const replanned = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${planIntent.id}/rework`,
      headers: cookie,
      payload: { reason: 'The plan misses a task', target: 'plan' },
    });
    expect(replanned.statusCode).toBe(200);
    expect(replanned.json<{ status: string }>().status).toBe('planned');
    const planJobs = await harness.db.select().from(jobs).where(eq(jobs.intentId, planIntent.id));
    expect(planJobs.map((job) => jobPayloadOf(job).kind)).toEqual(['plan']);

    const audits = await harness.db
      .select({ action: auditLog.action, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.target, intent.id));
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'intent.rework',
          meta: expect.objectContaining({ reason: 'Add the lease expiry test', target: 'build' }),
        }),
      ]),
    );
  }, 20_000);

  it.each([
    { role: 'viewer', action: 'accept', expected: 403 },
    { role: 'viewer', action: 'rework', expected: 403 },
    { role: 'editor', action: 'accept', expected: 403 },
    { role: 'editor', action: 'rework', expected: 403 },
  ] as const)('refuses $action to a $role', async ({ role, action, expected }) => {
    const { owner, project } = await setupProject();
    const member = await seedUser(harness.db);
    await harness.db.insert(projectMembers).values({ projectId: project.id, userId: member.id, role });
    const cookie = authCookie(await seedSession(harness.db, member.id));
    const intent = await seedAwaitingIntent(project, owner.id);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/${action}`,
      headers: cookie,
      ...(action === 'rework' ? { payload: { reason: 'No' } } : {}),
    });
    expect(response.statusCode).toBe(expected);
  }, 20_000);

  it('cancels queued jobs and stages when the intent is cancelled', async () => {
    const { cookie } = await setupProject();
    const intentId = await createIntentThroughApi(cookie);
    const queued = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    expect(queued.map((job) => job.status)).toEqual(['queued']);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intentId}/cancel`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('cancelled');

    const cancelledJobs = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    expect(cancelledJobs.map((job) => job.status)).toEqual(['cancelled']);
    const cancelledStages = await harness.db.select().from(stages).where(eq(stages.intentId, intentId));
    expect(cancelledStages.map((stage) => stage.status)).toEqual(['cancelled']);
  }, 20_000);

  it('cancels a running job, sends job.cancel and ignores a late result', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const intakeJob = await offerFor(mock, 'intake');

    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intentId}/cancel`,
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);

    const frame = await mock.next();
    expect(text(frame, 'type')).toBe('job.cancel');
    expect(text(frame, 'jobId')).toBe(intakeJob);
    expect(text(frame, 'reason')).toBe('intent cancelled');
    expect((await currentJob(intakeJob)).status).toBe('cancelled');

    const [stage] = await harness.db.select().from(stages).where(eq(stages.intentId, intentId));
    expect(stage?.status).toBe('cancelled');

    const barrierAt = Date.now();
    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    mock.send({ type: 'heartbeat', activeJobs: 0, lastSeenAt: new Date().toISOString() });
    await expect
      .poll(async () => {
        const [runner] = await harness.db.select().from(runners).where(eq(runners.id, mock.runnerId));
        return runner?.lastSeenAt?.getTime() ?? 0;
      })
      .toBeGreaterThanOrEqual(barrierAt);

    expect((await currentJob(intakeJob)).status).toBe('cancelled');
    const intentJobs = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    expect(intentJobs.map((job) => jobPayloadOf(job).kind)).toEqual(['intake']);
    const intentStages = await harness.db.select().from(stages).where(eq(stages.intentId, intentId));
    expect(intentStages.map((row) => row.status)).toEqual(['cancelled']);
  }, 20_000);

  it('renews the lease on job.heartbeat and refuses a job owned by another runner', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);
    const offer = await nextOffer(mock);
    mock.send({ type: 'job.accept', jobId: offer.jobId });
    await expect.poll(async () => (await currentJob(offer.jobId)).status).toBe('running');

    await harness.db
      .update(jobs)
      .set({ leaseUntil: new Date(Date.now() + 1000) })
      .where(eq(jobs.id, offer.jobId));
    const leaseBefore = (await currentJob(offer.jobId)).leaseUntil?.getTime() ?? 0;
    mock.send({ type: 'job.heartbeat', jobId: offer.jobId });
    await expect
      .poll(async () => (await currentJob(offer.jobId)).leaseUntil?.getTime() ?? 0)
      .toBeGreaterThan(leaseBefore);

    const other = await registerRunner(cookie, 'other-runner');
    const [otherJob] = await harness.db
      .insert(jobs)
      .values({
        intentId,
        stageId: null,
        runnerId: other.runnerId,
        runtime: 'test',
        status: 'running',
        attempt: 1,
        leaseUntil: new Date(Date.now() + 60_000),
        nextAttemptAt: new Date(),
      })
      .returning();
    if (!otherJob) throw new Error('job insert returned no row');
    const otherLease = otherJob.leaseUntil?.getTime() ?? 0;

    const barrierAt = Date.now();
    mock.send({ type: 'job.heartbeat', jobId: otherJob.id });
    mock.send({ type: 'heartbeat', activeJobs: 0, lastSeenAt: new Date().toISOString() });
    await expect
      .poll(async () => {
        const [runner] = await harness.db.select().from(runners).where(eq(runners.id, mock.runnerId));
        return runner?.lastSeenAt?.getTime() ?? 0;
      })
      .toBeGreaterThanOrEqual(barrierAt);
    expect((await currentJob(otherJob.id)).leaseUntil?.getTime()).toBe(otherLease);
  }, 20_000);

  it('backs off and expires a job whose results keep failing', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    await createIntentThroughApi(cookie);
    const offer = await nextOffer(mock);

    for (const attempt of [1, 2]) {
      mock.send({ type: 'job.accept', jobId: offer.jobId });
      mock.send({ type: 'job.result', seq: 1, jobId: offer.jobId, status: 'failed' });
      await expect.poll(async () => (await currentJob(offer.jobId)).status).toBe('queued');
      const requeued = await currentJob(offer.jobId);
      expect(requeued.attempt).toBe(attempt);
      expect(requeued.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      await harness.db
        .update(jobs)
        .set({ nextAttemptAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.id, offer.jobId));
      await harness.app.orchestrator.dispatch();
      const reoffered = await nextOffer(mock);
      expect(reoffered.jobId).toBe(offer.jobId);
    }

    mock.send({ type: 'job.accept', jobId: offer.jobId });
    mock.send({ type: 'job.result', seq: 1, jobId: offer.jobId, status: 'failed' });
    await expect.poll(async () => (await currentJob(offer.jobId)).status).toBe('expired');
    const expired = await currentJob(offer.jobId);
    if (expired.stageId === null) throw new Error('expired job lost its stage');
    const [stage] = await harness.db.select().from(stages).where(eq(stages.id, expired.stageId));
    expect(stage?.status).toBe('failed');
  }, 20_000);

  it('ingests runner findings and questions through the hub', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    const { job } = await seedRunningJob(intent.id, mock.runnerId, 'review', 'orchestrator-api');

    mock.send({
      type: 'job.findings',
      seq: 1,
      jobId: job.id,
      role: 'code-reviewer',
      findings: [
        {
          acId: 'AC-1',
          class: 'ambiguous',
          severity: 'blocking',
          requirement: 'AC-1 is vague',
          evidence: 'no observable result',
        },
      ],
    });
    await expect
      .poll(async () => (await harness.db.select().from(findings).where(eq(findings.intentId, intent.id))).length)
      .toBe(1);
    const [finding] = await harness.db.select().from(findings).where(eq(findings.intentId, intent.id));
    if (!finding) throw new Error('finding was not ingested');
    expect(finding.role).toBe('review');

    const blocked = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/accept`,
      headers: cookie,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ details?: { findingIds?: string[] } }>().details?.findingIds).toEqual([finding.id]);

    mock.send({
      type: 'job.question',
      seq: 2,
      jobId: job.id,
      question: {
        stage: 'review',
        question: 'Which store should back the queue?',
        context: 'Both options fit the budget.',
        trigger: 'E2',
        options: [
          { id: 'a', label: 'Postgres' },
          { id: 'b', label: 'SQLite' },
        ],
        defaultOption: 'a',
      },
    });
    await expect
      .poll(async () => (await harness.db.select().from(escalations).where(eq(escalations.intentId, intent.id))).length)
      .toBe(1);
    const [escalation] = await harness.db
      .select()
      .from(escalations)
      .where(eq(escalations.intentId, intent.id));
    expect(escalation?.status).toBe('open');
    expect(escalation?.question).toBe('Which store should back the queue?');
    if (escalation === undefined) throw new Error('escalation was not stored');

    const answered = await harness.app.inject({
      method: 'POST',
      url: `/api/intents/${intent.id}/answer`,
      headers: cookie,
      payload: { escalationId: escalation.id, optionId: 'b' },
    });
    expect(answered.statusCode).toBe(200);
    const answeredBody = answered.json<{
      escalation: { status: string };
      decision: { id: string; answer: string };
    }>();
    expect(answeredBody.escalation.status).toBe('answered');
    expect(memorySpy.decisions).toEqual([
      expect.objectContaining({ decisionId: answeredBody.decision.id, answer: 'SQLite' }),
    ]);
    const answer = await mock.next();
    expect(text(answer, 'type')).toBe('job.answer');
    expect(text(answer, 'jobId')).toBe(job.id);
    expect(answer.answer).toEqual({
      escalationId: escalation.id,
      optionId: 'b',
      label: 'SQLite',
    });

    mock.send({
      type: 'job.question',
      seq: 3,
      jobId: job.id,
      question: {
        stage: 'review',
        question: 'Which naming should the queue use?',
        context: 'Both names fit.',
        trigger: 'E2',
        options: [
          { id: 'a', label: 'jobs' },
          { id: 'b', label: 'tasks' },
        ],
        defaultOption: 'a',
      },
    });
    const refused = await mock.next();
    expect(text(refused, 'type')).toBe('job.answer');
    expect(refused.answer).toEqual({ cancelled: true });
  }, 20_000);

  it('sends a changed spec_critic verdict back to the spec writer and blocks at the round cap', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    await harness.db.update(intents).set({ status: 'specified' }).where(eq(intents.id, intent.id));
    await seedSpecRow(intent.id);
    await writeArtifact(harness.db, { intentId: intent.id, kind: 'intent_card', meta: INTENT_CARD });
    const { stage, job } = await seedRunningJob(intent.id, mock.runnerId, 'spec_critic');

    mock.send({ type: 'job.verdict', seq: 1, jobId: job.id, role: 'spec-critic', decision: 'changes' });
    mock.send({ type: 'job.result', seq: 2, jobId: job.id, status: 'succeeded' });

    const specJob = await offerFor(mock, 'spec');
    expect((await currentJob(job.id)).status).toBe('failed');
    expect((await harness.db.select().from(stages).where(eq(stages.id, stage.id)))[0]?.status).toBe('failed');

    mock.send({ type: 'job.spec', seq: 1, jobId: specJob, bodyMd: VALID_SPEC });
    mock.send({ type: 'job.result', seq: 2, jobId: specJob, status: 'succeeded' });
    const criticJob = await offerFor(mock, 'spec_critic');
    mock.send({ type: 'job.verdict', seq: 1, jobId: criticJob, role: 'spec-critic', decision: 'changes' });
    mock.send({ type: 'job.result', seq: 2, jobId: criticJob, status: 'succeeded' });

    await expect
      .poll(async () => {
        const rows = await harness.db
          .select()
          .from(stages)
          .where(
            and(
              eq(stages.intentId, intent.id),
              eq(stages.kind, 'spec_critic'),
              eq(stages.status, 'blocked'),
            ),
          );
        return rows.length;
      })
      .toBe(1);
    expect((await currentJob(criticJob)).status).toBe('failed');
  }, 20_000);

  it('keeps the runner failure message in the stage error when a job expires', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    const { stage, job } = await seedRunningJob(intent.id, mock.runnerId, 'spec_critic');
    await harness.db.update(jobs).set({ attempt: 3 }).where(eq(jobs.id, job.id));

    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: job.id,
      status: 'failed',
      error: 'dsh turn failed: boom',
    });

    await expect
      .poll(async () => (await harness.db.select().from(stages).where(eq(stages.id, stage.id)))[0]?.status)
      .toBe('failed');
    const [row] = await harness.db.select().from(stages).where(eq(stages.id, stage.id));
    expect(row?.error).toBe('dsh turn failed: boom');
    expect((await currentJob(job.id)).status).toBe('expired');
  }, 20_000);

  it('blocks the review stage when the pass is at the round cap', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    await seedSpecRow(intent.id);
    await seedReviewStage(intent.id, mock.runnerId, ['orchestrator-api'], 'failed');
    const { stage, jobRows } = await seedReviewStage(intent.id, mock.runnerId, ['orchestrator-api']);
    const job = jobRows[0];
    if (job === undefined) throw new Error('review job was not seeded');

    mock.send({ type: 'job.verdict', seq: 1, jobId: job.id, role: 'review', decision: 'changes' });
    mock.send({ type: 'job.result', seq: 2, jobId: job.id, status: 'succeeded' });
    await expect
      .poll(async () => (await harness.db.select().from(stages).where(eq(stages.id, stage.id)))[0]?.status)
      .toBe('blocked');
    expect((await currentJob(job.id)).status).toBe('failed');
  }, 20_000);

  it('reopens build when a review verdict requests changes below the round cap', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    await seedSpecRow(intent.id);
    await writeArtifact(harness.db, { intentId: intent.id, kind: 'plan', meta: { ...PLAN } });
    const { stage, jobRows } = await seedReviewStage(intent.id, mock.runnerId, [
      'orchestrator-api',
      'orchestrator-flow',
    ]);
    const first = jobRows[0];
    const sibling = jobRows[1];
    if (first === undefined || sibling === undefined) throw new Error('review jobs were not seeded');

    mock.send({
      type: 'job.findings',
      seq: 1,
      jobId: first.id,
      role: 'code-reviewer',
      findings: [
        {
          acId: 'AC-1',
          class: 'missing-evidence',
          severity: 'blocking',
          requirement: 'AC-1 has no stage branch',
          evidence: 'the stage machine has no review branch',
        },
      ],
    });
    mock.send({ type: 'job.verdict', seq: 2, jobId: first.id, role: 'code-reviewer', decision: 'changes' });
    mock.send({ type: 'job.result', seq: 3, jobId: first.id, status: 'succeeded' });

    await expect
      .poll(async () => (await harness.db.select().from(stages).where(eq(stages.id, stage.id)))[0]?.status)
      .toBe('failed');
    expect((await currentJob(first.id)).status).toBe('failed');
    expect((await currentJob(sibling.id)).status).toBe('cancelled');

    const carried = await harness.db.select().from(findings).where(eq(findings.intentId, intent.id));
    expect(carried.map((row) => row.status)).toEqual(['carried']);

    await expect
      .poll(
        async () =>
          (await harness.db.select().from(stages).where(and(eq(stages.intentId, intent.id), eq(stages.kind, 'build'))))
            .length,
      )
      .toBe(1);
    const buildJobs = await harness.db
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(stages, eq(jobs.stageId, stages.id))
      .where(and(eq(stages.intentId, intent.id), eq(stages.kind, 'build')));
    expect(buildJobs.map((row) => jobPayloadOf(row.job).kind)).toEqual(['build']);
    await expect
      .poll(async () => (await harness.db.select().from(intents).where(eq(intents.id, intent.id)))[0]?.status)
      .toBe('building');
  }, 20_000);

  it('counts two review verdicts of one pass as one round', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    await seedSpecRow(intent.id);
    await writeArtifact(harness.db, { intentId: intent.id, kind: 'plan', meta: { ...PLAN } });
    const { stage, jobRows } = await seedReviewStage(intent.id, mock.runnerId, [
      'orchestrator-api',
      'orchestrator-flow',
    ]);
    const first = jobRows[0];
    const second = jobRows[1];
    if (first === undefined || second === undefined) throw new Error('review jobs were not seeded');

    mock.send({ type: 'job.verdict', seq: 1, jobId: first.id, role: 'review', decision: 'approve' });
    mock.send({ type: 'job.result', seq: 2, jobId: first.id, status: 'succeeded' });
    await expect.poll(async () => (await currentJob(first.id)).status).toBe('succeeded');

    mock.send({ type: 'job.verdict', seq: 1, jobId: second.id, role: 'review', decision: 'changes' });
    mock.send({ type: 'job.result', seq: 2, jobId: second.id, status: 'succeeded' });

    await expect
      .poll(async () => (await harness.db.select().from(stages).where(eq(stages.id, stage.id)))[0]?.status)
      .toBe('failed');
    expect((await currentJob(second.id)).status).toBe('failed');
    await expect
      .poll(
        async () =>
          (await harness.db.select().from(stages).where(and(eq(stages.intentId, intent.id), eq(stages.kind, 'build'))))
            .length,
      )
      .toBe(1);
  }, 20_000);

  it('retries a review result without a verdict and fails the stage at the attempt cap', async () => {
    const { owner, project, cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intent = await seedAwaitingIntent(project, owner.id);
    const { stage, job } = await seedRunningJob(intent.id, mock.runnerId, 'review', 'orchestrator-api');

    mock.send({ type: 'job.result', seq: 1, jobId: job.id, status: 'succeeded' });
    await expect.poll(async () => (await currentJob(job.id)).status).toBe('queued');

    for (const attempt of [2, 3] as const) {
      await harness.db.update(jobs).set({ nextAttemptAt: new Date(0) }).where(eq(jobs.id, job.id));
      await harness.app.orchestrator.dispatch();
      expect(await offerFor(mock, 'review')).toBe(job.id);
      mock.send({ type: 'job.result', seq: 1, jobId: job.id, status: 'succeeded' });
      await expect
        .poll(async () => (await currentJob(job.id)).status)
        .toBe(attempt === 2 ? 'queued' : 'expired');
    }
    const stageRow = await harness.db.select().from(stages).where(eq(stages.id, stage.id));
    expect(stageRow.map((row) => row.status)).toEqual(['failed']);
  }, 20_000);

  it('waits for every review task and binds each verdict to its own artifact', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    const intentId = await createIntentThroughApi(cookie);

    const intakeJob = await offerFor(mock, 'intake');
    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: intakeJob,
      status: 'succeeded',
      result: { card: INTENT_CARD },
    });
    const specJob = await offerFor(mock, 'spec');
    mock.send({ type: 'job.spec', seq: 1, jobId: specJob, bodyMd: VALID_SPEC });
    mock.send({ type: 'job.result', seq: 2, jobId: specJob, status: 'succeeded' });
    const criticJob = await offerFor(mock, 'spec_critic');
    mock.send({ type: 'job.verdict', seq: 1, jobId: criticJob, role: 'spec-critic', decision: 'approve' });
    mock.send({ type: 'job.result', seq: 2, jobId: criticJob, status: 'succeeded' });
    const planJob = await offerFor(mock, 'plan');
    mock.send({
      type: 'job.result',
      seq: 1,
      jobId: planJob,
      status: 'succeeded',
      result: { plan: PLAN_TWO },
    });

    const buildOne = await offerFor(mock, 'build');
    mock.send({
      type: 'job.diff_summary',
      seq: 1,
      jobId: buildOne,
      files: [{ path: 'apps/api/src/orchestrator/jobs.ts', status: 'modified', additions: 5, deletions: 1 }],
    });
    mock.send({ type: 'job.result', seq: 2, jobId: buildOne, status: 'succeeded', result: {} });
    const buildTwo = await offerFor(mock, 'build');
    mock.send({
      type: 'job.diff_summary',
      seq: 1,
      jobId: buildTwo,
      files: [{ path: 'apps/api/src/orchestrator/flow.ts', status: 'modified', additions: 3, deletions: 2 }],
    });
    mock.send({ type: 'job.result', seq: 2, jobId: buildTwo, status: 'succeeded', result: {} });

    const reviewOne = await offerFor(mock, 'review');
    mock.send({ type: 'job.verdict', seq: 1, jobId: reviewOne, role: 'review', decision: 'approve' });
    mock.send({ type: 'job.result', seq: 2, jobId: reviewOne, status: 'succeeded' });
    const reviewTwo = await offerFor(mock, 'review');

    const reviewStages = await harness.db
      .select()
      .from(stages)
      .where(and(eq(stages.intentId, intentId), eq(stages.kind, 'review')));
    expect(reviewStages.map((row) => row.status)).toEqual(['running']);
    const verifyStagesBefore = await harness.db
      .select()
      .from(stages)
      .where(and(eq(stages.intentId, intentId), eq(stages.kind, 'verify')));
    expect(verifyStagesBefore).toHaveLength(0);

    mock.send({ type: 'job.verdict', seq: 1, jobId: reviewTwo, role: 'review', decision: 'approve' });
    mock.send({ type: 'job.result', seq: 2, jobId: reviewTwo, status: 'succeeded' });
    await offerFor(mock, 'verify');

    const reviewStagesAfter = await harness.db
      .select()
      .from(stages)
      .where(and(eq(stages.intentId, intentId), eq(stages.kind, 'review')));
    expect(reviewStagesAfter.map((row) => row.status)).toEqual(['succeeded']);

    const verdictRows = await harness.db
      .select({ verdict: verdicts, payload: jobs.payload })
      .from(verdicts)
      .innerJoin(jobs, eq(verdicts.jobId, jobs.id))
      .where(eq(jobs.intentId, intentId));
    const artifactRows = await harness.db
      .select({ kind: artifacts.kind, sha256: artifacts.sha256 })
      .from(artifacts)
      .where(eq(artifacts.intentId, intentId));
    const shaByKind = new Map(artifactRows.map((row) => [row.kind, row.sha256]));
    const reviewVerdicts = verdictRows.filter((row) => row.verdict.role === 'review');
    expect(reviewVerdicts).toHaveLength(2);
    for (const row of reviewVerdicts) {
      const payload = JobPayloadSchema.safeParse(row.payload);
      if (!payload.success) throw new Error('review job has an invalid payload');
      expect(row.verdict.artifactSha256).toBe(shaByKind.get(`diff_summary:${payload.data.taskId}`));
    }
  }, 40_000);

  it('serves Prometheus metrics', async () => {
    const { cookie } = await setupProject();
    const mock = await connectRunner(cookie);
    await createIntentThroughApi(cookie);
    await nextOffer(mock);

    const response = await harness.app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('intentra_jobs{status="offered"} 1');
    expect(response.body).toContain('intentra_runners_online 1');
    expect(response.body).toContain('intentra_job_attempts_total 1');
  }, 20_000);
});
