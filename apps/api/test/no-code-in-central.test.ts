import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import type { Plan } from '@intentra/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authCookie,
  baseEnv,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  type Harness,
} from './harness.js';
import { INTENT_CARD, VALID_SPEC } from './fixtures.js';
import { loadConfig } from '../src/config.js';
import { jobs, runners } from '../src/db/schema.js';

const CODE_MARKER = 'INTENTRA_CODE_MARKER';

const RUNNER_MODEL_ENV = [
  'INTENTRA_MODEL_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'DSH_MODEL_API_KEY',
  'DSH_API_KEY',
] as const;

const FORBIDDEN_CONFIG_TOKENS = ['openai', 'anthropic', 'deepseek', 'dsh', 'modelapikey', 'modelkey'] as const;

const PLAN: Plan = {
  tasks: [
    {
      id: 'no-code-in-central',
      title: 'Runner code boundary',
      spec: 'Prove the centre never stores runner code.',
      paths: ['apps/api/src/orchestrator'],
      acceptance: ['AC-1', 'AC-2'],
      dependsOn: [],
      reviewLens: 'code-reviewer',
    },
  ],
};

const HELLO: WsMessage = {
  type: 'hello',
  protocolVersion: 1,
  runnerVersion: '0.1.0',
  os: 'linux',
  arch: 'x86_64',
  adapters: [{ id: 'dsh', label: 'DSH' }],
  workspaces: ['/tmp/intentra-workspace'],
};

type WsMessage = Record<string, unknown>;

const isRecord = (value: unknown): value is WsMessage =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (message: WsMessage, key: string): string => {
  const value = message[key];
  if (typeof value !== 'string') throw new Error(`message has no string ${key}`);
  return value;
};

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const waitFor = async <T>(probe: () => Promise<T>, expected: T, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe()) === expected) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${String(expected)}`);
};

const configPaths = (value: unknown, prefix = ''): readonly string[] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => configPaths(item, `${prefix}[${index}]`));
  if (typeof value !== 'object' || value === null) return prefix.length === 0 ? [] : [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    configPaths(child, prefix.length === 0 ? key : `${prefix}.${key}`),
  );
};

interface MockRunner {
  next(timeoutMs?: number): Promise<WsMessage>;
  send(message: WsMessage): void;
  close(): void;
}

describe('centre configuration', () => {
  it('keeps model provider keys out of the validated centre configuration', () => {
    const sentinels = Object.fromEntries(RUNNER_MODEL_ENV.map((name) => [name, `sentinel-${name}`]));
    const env = baseEnv(sentinels);
    for (const name of RUNNER_MODEL_ENV) {
      expect(env[name]).toBe(`sentinel-${name}`);
    }

    const clean = loadConfig(baseEnv());
    const withRunnerKeys = loadConfig(env);
    expect(withRunnerKeys).toEqual(clean);
    const serialized = JSON.stringify(withRunnerKeys);
    expect(serialized).toBe(JSON.stringify(clean));

    const paths = configPaths(withRunnerKeys);
    for (const [name, value] of Object.entries(sentinels)) {
      expect(serialized).not.toContain(value);
      const flat = name.toLowerCase().replaceAll('_', '');
      expect(paths.filter((path) => path.toLowerCase().replaceAll('_', '').includes(flat))).toEqual([]);
    }
    for (const token of FORBIDDEN_CONFIG_TOKENS) {
      expect(paths.filter((path) => path.toLowerCase().includes(token))).toEqual([]);
    }
  });
});

describe.skipIf(!hasDatabase)('no-code-in-central', () => {
  let harness: Harness;
  let port = 0;
  let runner: MockRunner | null = null;
  let cookie: Record<string, string> = {};
  let intentId = '';
  let runnerDir = '';
  let codeFile = '';
  const eventPayloads: string[] = [];

  const createMockRunner = async (token: string): Promise<MockRunner> => {
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
    return {
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
  };

  const registerRunner = async (): Promise<{ runnerId: string; token: string }> => {
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
        name: 'dsh-laptop',
        os: 'linux',
        arch: 'x86_64',
        version: '0.1.0',
        capabilities: ['dsh'],
      },
    });
    expect(registered.statusCode).toBe(201);
    return registered.json<{ runnerId: string; token: string }>();
  };

  beforeAll(async () => {
    harness = await createHarness();
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('app is not listening');
    port = address.port;
    await resetDatabase(harness.db);

    const owner = await seedUser(harness.db, { isAdmin: true, name: 'Owner' });
    await seedProject(harness.db, owner.id, 'acme');
    cookie = authCookie(await seedSession(harness.db, owner.id));

    runnerDir = await mkdtemp(join(tmpdir(), 'intentra-runner-'));
    codeFile = join(runnerDir, 'worktree', 'apps', 'api', 'src', 'runner-only.ts');
    await mkdir(dirname(codeFile), { recursive: true });
    await writeFile(codeFile, `export const runnerOnly = '${CODE_MARKER}';\n`, 'utf8');
    const runnerCode = await readFile(codeFile, 'utf8');
    expect(runnerCode).toContain(CODE_MARKER);

    const registered = await registerRunner();
    const mock = await createMockRunner(registered.token);
    runner = mock;
    mock.send(HELLO);
    await waitFor(async () => {
      const [row] = await harness.db.select().from(runners).where(eq(runners.id, registered.runnerId));
      return row?.status;
    }, 'online', 3000);

    const seqs = new Map<string, number>();
    const sendJob = (jobId: string, message: WsMessage): void => {
      const seq = (seqs.get(jobId) ?? 0) + 1;
      seqs.set(jobId, seq);
      mock.send({ ...message, seq, jobId });
    };
    const offerFor = async (stage: string): Promise<string> => {
      const offer = await mock.next();
      expect(text(offer, 'type')).toBe('job.offer');
      expect(text(offer, 'stage')).toBe(stage);
      const jobId = text(offer, 'jobId');
      sendJob(jobId, { type: 'job.accept' });
      return jobId;
    };

    const unsubscribe = harness.events.subscribe((event) => eventPayloads.push(JSON.stringify(event)));
    try {
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects/acme/intents',
        headers: cookie,
        payload: { title: 'No code in central', statement: 'Prove the centre keeps runner code out' },
      });
      expect(created.statusCode).toBe(201);
      intentId = created.json<{ id: string }>().id;

      const intakeJob = await offerFor('intake');
      sendJob(intakeJob, { type: 'job.result', status: 'succeeded', result: { card: INTENT_CARD } });

      const specJob = await offerFor('spec');
      sendJob(specJob, { type: 'job.spec', bodyMd: VALID_SPEC });
      sendJob(specJob, { type: 'job.result', status: 'succeeded' });

      const criticJob = await offerFor('spec_critic');
      sendJob(criticJob, { type: 'job.verdict', role: 'spec_critic', decision: 'approve' });
      sendJob(criticJob, { type: 'job.result', status: 'succeeded' });

      const planJob = await offerFor('plan');
      sendJob(planJob, { type: 'job.result', status: 'succeeded', result: { plan: PLAN } });

      const buildJob = await offerFor('build');
      sendJob(buildJob, { type: 'job.status', status: 'running', detail: runnerCode });
      await waitFor(async () => {
        const [row] = await harness.db
          .select({ status: jobs.status, runnerSeq: jobs.runnerSeq })
          .from(jobs)
          .where(eq(jobs.id, buildJob));
        return row === undefined ? 'missing' : `${row.status}:${String(row.runnerSeq)}`;
      }, 'running:2');
      sendJob(buildJob, {
        type: 'job.diff_summary',
        files: [{ path: 'apps/api/src/orchestrator/jobs.ts', status: 'modified', additions: 42, deletions: 3 }],
      });
      sendJob(buildJob, { type: 'job.link', branch: 'intentra/no-code', commit: 'abc1234' });
      sendJob(buildJob, {
        type: 'job.result',
        status: 'succeeded',
        result: { gates: [{ criterion: 'build', status: 'pass', durationMs: 12, exitCode: 0 }] },
      });

      const reviewJob = await offerFor('review');
      sendJob(reviewJob, { type: 'job.verdict', role: 'code-reviewer', decision: 'approve' });
      sendJob(reviewJob, { type: 'job.result', status: 'succeeded' });

      const verifyJob = await offerFor('verify');
      sendJob(verifyJob, { type: 'job.status', status: 'running', detail: runnerCode });
      sendJob(verifyJob, {
        type: 'job.result',
        status: 'succeeded',
        result: {
          gates: [
            { criterion: 'build', status: 'pass', durationMs: 5, exitCode: 0 },
            { criterion: 'tests', status: 'pass', durationMs: 50, exitCode: 0 },
          ],
          claims: [{ statement: 'the centre stores only metadata', status: 'fresh' }],
        },
      });

      await waitFor(async () => {
        const detail = await harness.app.inject({
          method: 'GET',
          url: `/api/intents/${intentId}`,
          headers: cookie,
        });
        return detail.json<{ intent: { status: string } }>().intent.status;
      }, 'awaiting_acceptance', 10_000);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  afterAll(async () => {
    runner?.close();
    await harness.close();
    if (runnerDir !== '') await rm(runnerDir, { recursive: true, force: true });
  });

  it('holds the code marker in the runner worktree and completes the full cycle', async () => {
    const runnerCode = await readFile(codeFile, 'utf8');
    expect(runnerCode).toContain(CODE_MARKER);
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/intents/${intentId}`,
      headers: cookie,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ intent: { status: string } }>().intent.status).toBe('awaiting_acceptance');
  });

  it('scans every centre table and finds no runner code marker', async () => {
    const tableResult = await harness.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    const tableNames = tableResult.rows.map((row) => row.table_name);
    expect(tableNames).toEqual(expect.arrayContaining(['intents', 'jobs', 'stages', 'specs', 'artifacts']));

    const tablesWithMarker: string[] = [];
    let rowsScanned = 0;
    for (const tableName of tableNames) {
      const result = await harness.pool.query<Record<string, unknown>>(
        `select * from public.${quoteIdent(tableName)}`,
      );
      rowsScanned += result.rows.length;
      if (JSON.stringify(result.rows).includes(CODE_MARKER)) tablesWithMarker.push(tableName);
    }
    expect(rowsScanned).toBeGreaterThan(0);
    expect(tablesWithMarker).toEqual([]);
  });

  it('serves no runner code marker through the authenticated intent API', async () => {
    const urls = [
      `/api/intents/${intentId}`,
      `/api/intents/${intentId}/spec`,
      `/api/intents/${intentId}/findings`,
      `/api/intents/${intentId}/plan`,
      `/api/intents/${intentId}/jobs`,
      `/api/intents/${intentId}/evidence`,
      '/api/projects/acme/intents',
    ];
    for (const url of urls) {
      const response = await harness.app.inject({ method: 'GET', url, headers: cookie });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(CODE_MARKER);
    }
    expect(eventPayloads.length).toBeGreaterThan(0);
    expect(eventPayloads.filter((payload) => payload.includes(CODE_MARKER))).toEqual([]);
  });
});
