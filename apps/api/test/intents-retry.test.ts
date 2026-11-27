import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { JobPayloadSchema } from '@intentra/contracts';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  waitForLockWaiters,
  type Harness,
} from './harness.js';
import { EMPTY_CONTEXT_PACK } from '../src/prompts/context.js';
import { frontOfficePrompt } from '../src/prompts/templates.js';
import { auditLog, intents, jobs, projectMembers, projects, stages } from '../src/db/schema.js';
import type { IntentRow, UserRow } from '../src/db/schema.js';
import { createIntent, postMessage, type Actor, type IntentDeps } from '../src/intents/service.js';

interface Session {
  readonly user: UserRow;
  readonly headers: { readonly cookie: string; readonly origin: string };
}

describe.skipIf(!hasDatabase)('intent retry API', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const deps = (): IntentDeps => ({
    db: harness.db,
    events: harness.events,
    memory: harness.memory,
    now: () => new Date(),
  });
  const actorOf = (user: UserRow): Actor => ({ kind: 'user', id: user.id });

  const session = async (): Promise<Session> => {
    const user = await seedUser(harness.db);
    return { user, headers: authCookie(await seedSession(harness.db, user.id)) };
  };

  const setupProject = async (key = 'acme') => {
    const owner = await session();
    const project = await seedProject(harness.db, owner.user.id, key);
    const editor = await session();
    const viewer = await session();
    await harness.db.insert(projectMembers).values([
      { projectId: project.id, userId: editor.user.id, role: 'editor' },
      { projectId: project.id, userId: viewer.user.id, role: 'viewer' },
    ]);
    return { owner, editor, viewer, project };
  };

  const call = (
    headers: Session['headers'],
    url: string,
  ): Promise<LightMyRequestResponse> => harness.app.inject({ method: 'POST', url, headers });

  const draft = async (projectId: string, actor: Actor, title = 'Git worktree'): Promise<IntentRow> =>
    createIntent(deps(), actor, {
      projectId,
      title,
      statement: 'Isolate every job in its own git worktree',
    });

  const countStages = async (intentId: string): Promise<number> => {
    const rows = await harness.db.select().from(stages).where(eq(stages.intentId, intentId));
    return rows.length;
  };

  const countJobs = async (intentId: string): Promise<number> => {
    const rows = await harness.db.select().from(jobs).where(eq(jobs.intentId, intentId));
    return rows.length;
  };

  it('restarts the intake of a draft intent and records the retry', async () => {
    const { editor, project } = await setupProject();
    const intent = await draft(project.id, actorOf(editor.user));
    const [failedStage] = await harness.db
      .insert(stages)
      .values({
        intentId: intent.id,
        kind: 'intake',
        status: 'failed',
        finishedAt: new Date(),
        error: 'worktree is dirty',
      })
      .returning();
    if (!failedStage) throw new Error('stage seed returned no row');
    await harness.db
      .insert(jobs)
      .values({ intentId: intent.id, stageId: failedStage.id, runtime: 'dsh', status: 'expired' });

    const seen: string[] = [];
    harness.events.subscribe((event) => {
      if (event.projectId === project.id) seen.push(event.type);
    });

    const response = await call(editor.headers, `/api/intents/${intent.id}/retry`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: intent.id, status: 'draft' });

    const stageRows = await harness.db.select().from(stages).where(eq(stages.intentId, intent.id));
    const running = stageRows.filter((row) => row.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ kind: 'intake' });
    expect(running[0]?.startedAt).not.toBeNull();

    const queued = await harness.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.intentId, intent.id), eq(jobs.status, 'queued')));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ stageId: running[0]?.id, runtime: 'auto' });
    const payload = JobPayloadSchema.parse(queued[0]?.payload);
    expect(payload.kind).toBe('intake');
    expect(payload.prompt).toBe(
      frontOfficePrompt({
        title: intent.title,
        statement: intent.statement,
        messages: [],
        contextPack: EMPTY_CONTEXT_PACK,
        capabilities: [],
      }),
    );

    const audits = await harness.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'intent.retry'), eq(auditLog.target, intent.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorKind: 'user', actorId: editor.user.id, meta: {} });

    expect(seen).toEqual(expect.arrayContaining(['stage.updated', 'job.updated']));
  });

  it('refuses a second retry once an intake stage is active', async () => {
    const { editor, project } = await setupProject();
    const intent = await draft(project.id, actorOf(editor.user));
    expect((await call(editor.headers, `/api/intents/${intent.id}/retry`)).statusCode).toBe(200);

    const again = await call(editor.headers, `/api/intents/${intent.id}/retry`);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CONFLICT' });

    expect(await countStages(intent.id)).toBe(1);
    expect(await countJobs(intent.id)).toBe(1);
  });

  it('serializes two concurrent retries behind the intent row lock', async () => {
    const { editor, project } = await setupProject();
    const intent = await draft(project.id, actorOf(editor.user));

    const client = await harness.pool.connect();
    const observer = await harness.pool.connect();
    await client.query('begin');
    await client.query('select 1 from intents where id = $1 for update', [intent.id]);
    const retries = Promise.all([
      call(editor.headers, `/api/intents/${intent.id}/retry`),
      call(editor.headers, `/api/intents/${intent.id}/retry`),
    ]);
    const locked = await waitForLockWaiters(observer, 2).then(
      () => true,
      () => false,
    );
    await client.query('rollback');
    client.release();
    observer.release();
    const responses = await retries;
    expect(locked).toBe(true);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await countStages(intent.id)).toBe(1);
    expect(await countJobs(intent.id)).toBe(1);
  });

  const conflictSetups: readonly {
    readonly name: string;
    readonly arrange: (intent: IntentRow, actor: Actor) => Promise<void>;
  }[] = [
    {
      name: 'a clarifying intent',
      arrange: async (intent, actor) => {
        await postMessage(deps(), actor, intent, { body: 'Hi' });
      },
    },
    {
      name: 'a running stage',
      arrange: async (intent) => {
        await harness.db
          .insert(stages)
          .values({ intentId: intent.id, kind: 'intake', status: 'running', startedAt: new Date() });
      },
    },
    {
      name: 'a queued job',
      arrange: async (intent) => {
        await harness.db.insert(jobs).values({ intentId: intent.id, runtime: 'auto', status: 'queued' });
      },
    },
  ];

  it.each(conflictSetups)('answers 409 for $name and creates no records', async ({ arrange }) => {
    const { editor, project } = await setupProject();
    const intent = await draft(project.id, actorOf(editor.user));
    await arrange(intent, actorOf(editor.user));
    const before = { stages: await countStages(intent.id), jobs: await countJobs(intent.id) };

    const response = await call(editor.headers, `/api/intents/${intent.id}/retry`);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'CONFLICT' });
    expect(await countStages(intent.id)).toBe(before.stages);
    expect(await countJobs(intent.id)).toBe(before.jobs);
  });

  it('requires editor access and hides every invisible intent the same way', async () => {
    const { editor, viewer, project } = await setupProject();
    const intent = await draft(project.id, actorOf(editor.user));

    const forbidden = await call(viewer.headers, `/api/intents/${intent.id}/retry`);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });

    const outsider = await session();
    const foreignProject = await seedProject(harness.db, outsider.user.id, 'other');
    const foreign = await draft(foreignProject.id, actorOf(outsider.user), 'Foreign intent');

    const archivedProject = await seedProject(harness.db, editor.user.id, 'archived');
    const archived = await draft(archivedProject.id, actorOf(editor.user), 'Archived intent');
    await harness.db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, archivedProject.id));

    const invisible = await Promise.all([
      call(editor.headers, `/api/intents/${foreign.id}/retry`),
      call(editor.headers, `/api/intents/${randomUUID()}/retry`),
      call(editor.headers, `/api/intents/${archived.id}/retry`),
    ]);
    for (const response of invisible) {
      expect(response.statusCode).toBe(404);
    }
    expect(new Set(invisible.map((response) => response.body)).size).toBe(1);

    expect(await countStages(intent.id)).toBe(0);
    expect(await countStages(foreign.id)).toBe(0);
    expect(await countStages(archived.id)).toBe(0);
    const [foreignRow] = await harness.db.select().from(intents).where(eq(intents.id, foreign.id));
    expect(foreignRow).toMatchObject({ status: 'draft' });
  });
});
