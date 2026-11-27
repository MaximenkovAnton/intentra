import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Plan } from '@intentra/contracts';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  type Harness,
} from './harness.js';
import { INTENT_CARD, VALID_SPEC } from './fixtures.js';
import { escalations, intents, jobs, projectMembers } from '../src/db/schema.js';
import type { IntentRow, UserRow } from '../src/db/schema.js';
import {
  SPEC_CRITIC_ROLE,
  createIntent,
  escalate,
  postMessage,
  submitFindings,
  submitIntentCard,
  submitPlan,
  submitSpec,
  submitVerdict,
  transitionIntent,
  type Actor,
  type IntentDeps,
} from '../src/intents/service.js';

const ESCALATION = {
  stage: 'intake',
  question: 'Which runtime executes the agent jobs?',
  context: 'Greenfield: the choice fixes the protocol.',
  trigger: 'E1' as const,
  options: [
    { id: 'dsh', label: 'DSH' },
    { id: 'cli', label: 'Generic CLI' },
  ],
  recommendation: 'dsh',
  defaultOption: 'dsh',
};

const PLAN: Plan = {
  tasks: [
    {
      id: 'intents',
      title: 'Intents',
      spec: 'Implement the intent services.',
      paths: ['apps/api/src/intents'],
      acceptance: ['AC-1', 'AC-2'],
      dependsOn: [],
      reviewLens: 'code-reviewer',
    },
  ],
};

interface Session {
  readonly user: UserRow;
  readonly headers: { readonly cookie: string; readonly origin: string };
}

describe.skipIf(!hasDatabase)('intent API', () => {
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

  const deps = (): IntentDeps => ({ db: harness.db, events: harness.events, memory: harness.memory, now: () => new Date() });
  const actorOf = (user: UserRow): Actor => ({ kind: 'user', id: user.id });

  const session = async (): Promise<Session> => {
    const user = await seedUser(harness.db);
    return { user, headers: authCookie(await seedSession(harness.db, user.id)) };
  };

  const setupProject = async () => {
    const owner = await session();
    const project = await seedProject(harness.db, owner.user.id, 'acme');
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
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    harness.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

  const reload = async (id: string): Promise<IntentRow> => {
    const [row] = await harness.db.select().from(intents).where(eq(intents.id, id));
    if (!row) throw new Error('intent disappeared');
    return row;
  };

  const createIntentThroughApi = async (headers: Session['headers'], title = 'Intent-driven flow') => {
    const response = await call(headers, 'POST', '/api/projects/acme/intents', {
      title,
      statement: 'Turn intent conversations into reviewed specs',
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string; status: string }>();
  };

  const clarified = async (projectId: string, actor: Actor) => {
    const created = await createIntent(deps(), actor, {
      projectId,
      title: 'Intent-driven flow',
      statement: 'Turn intent conversations into reviewed specs',
    });
    const { intent } = await postMessage(deps(), actor, created, { body: 'Hi' });
    return intent;
  };

  const critiqued = async (projectId: string, actor: Actor): Promise<IntentRow> => {
    const intent = await clarified(projectId, actor);
    await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });
    const [job] = await harness.db
      .insert(jobs)
      .values({ intentId: intent.id, runtime: 'test' })
      .returning();
    if (!job) throw new Error('job insert returned no row');
    await submitVerdict(deps(), actor, await reload(intent.id), {
      jobId: job.id,
      role: SPEC_CRITIC_ROLE,
      decision: 'approve',
    });
    return reload(intent.id);
  };

  it('requires a session', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/intents/00000000-0000-4000-8000-000000000001',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('rejects a malformed intent id with VALIDATION', async () => {
    const { editor } = await setupProject();
    const response = await call(editor.headers, 'POST', '/api/intents/not-a-uuid/messages', {
      body: 'Hi',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('lets an editor create and message an intent while a viewer can only read it', async () => {
    const { editor, viewer } = await setupProject();
    const intent = await createIntentThroughApi(editor.headers);
    expect(intent.status).toBe('draft');

    const blocked = await call(viewer.headers, 'POST', `/api/intents/${intent.id}/messages`, {
      body: 'Hi',
    });
    expect(blocked.statusCode).toBe(403);

    const posted = await call(editor.headers, 'POST', `/api/intents/${intent.id}/messages`, {
      body: 'Hi',
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({ intentId: intent.id, role: 'user', body: 'Hi' });

    const detail = await call(viewer.headers, 'GET', `/api/intents/${intent.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      intent: { id: intent.id, status: 'clarifying' },
      card: null,
      openEscalations: [],
    });
  });

  it('returns the submitted intent card in the detail read', async () => {
    const { editor, viewer, project } = await setupProject();
    const created = await createIntent(deps(), actorOf(editor.user), {
      projectId: project.id,
      title: 'Intent card',
      statement: 'Expose the intent card through the detail read',
    });
    await submitIntentCard(deps(), actorOf(editor.user), created, INTENT_CARD);

    const detail = await call(viewer.headers, 'GET', `/api/intents/${created.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      intent: { id: created.id, status: 'clarifying' },
      card: INTENT_CARD,
      openEscalations: [],
    });
  });

  it('answers an escalation and returns the accepted decision', async () => {
    const { owner, editor, project } = await setupProject();
    const intent = await clarified(project.id, actorOf(owner.user));
    const escalation = await escalate(deps(), actorOf(owner.user), intent, ESCALATION);

    const response = await call(editor.headers, 'POST', `/api/intents/${intent.id}/answer`, {
      escalationId: escalation.id,
      optionId: 'cli',
      note: 'Until DSH is installed',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      escalation: { status: string };
      decision: { status: string; answer: string };
    }>();
    expect(body.escalation.status).toBe('answered');
    expect(body.decision.status).toBe('accepted');
    expect(body.decision.answer).toBe('Generic CLI');

    const again = await call(editor.headers, 'POST', `/api/intents/${intent.id}/answer`, {
      escalationId: escalation.id,
      optionId: 'dsh',
    });
    expect(again.statusCode).toBe(409);
  });

  it('answers an expired escalation with 410 ESCALATION_EXPIRED', async () => {
    const { owner, project } = await setupProject();
    const intent = await clarified(project.id, actorOf(owner.user));
    const escalation = await escalate(deps(), actorOf(owner.user), intent, ESCALATION);
    await harness.db
      .update(escalations)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(escalations.id, escalation.id));

    const response = await call(owner.headers, 'POST', `/api/intents/${intent.id}/answer`, {
      escalationId: escalation.id,
      optionId: 'cli',
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: 'ESCALATION_EXPIRED' });
  });

  it('cancels, accepts and reworks an intent', async () => {
    const { owner, editor, project } = await setupProject();
    const actor = actorOf(owner.user);

    const draft = await createIntentThroughApi(editor.headers, 'Cancelled');
    const cancelled = await call(editor.headers, 'POST', `/api/intents/${draft.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const twice = await call(editor.headers, 'POST', `/api/intents/${draft.id}/cancel`);
    expect(twice.statusCode).toBe(409);

    const acceptedIntent = await critiqued(project.id, actor);
    await submitPlan(deps(), actor, acceptedIntent, PLAN);
    let current = await reload(acceptedIntent.id);
    for (const next of ['building', 'verifying', 'awaiting_acceptance'] as const) {
      current = await transitionIntent(deps(), actor, current, next);
    }
    const acceptanceBlocked = await call(editor.headers, 'POST', `/api/intents/${current.id}/accept`);
    expect(acceptanceBlocked.statusCode).toBe(403);
    const accepted = await call(owner.headers, 'POST', `/api/intents/${current.id}/accept`);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted' });
    expect(accepted.json<{ acceptedAt: string | null }>().acceptedAt).not.toBeNull();

    const reworkIntent = await critiqued(project.id, actor);
    let reworkCurrent = reworkIntent;
    for (const next of ['planned', 'building', 'verifying', 'awaiting_acceptance'] as const) {
      reworkCurrent = await transitionIntent(deps(), actor, reworkCurrent, next);
    }
    const reworkBlocked = await call(editor.headers, 'POST', `/api/intents/${reworkCurrent.id}/rework`, {
      reason: 'The diff summary is missing',
    });
    expect(reworkBlocked.statusCode).toBe(403);
    const reworked = await call(owner.headers, 'POST', `/api/intents/${reworkCurrent.id}/rework`, {
      reason: 'The diff summary is missing',
    });
    expect(reworked.statusCode).toBe(200);
    expect(reworked.json()).toMatchObject({ status: 'building' });
  });

  it('serves the spec bundle, findings, plan, jobs and evidence', async () => {
    const { owner, editor, project } = await setupProject();
    const actor = actorOf(owner.user);
    const intent = await clarified(project.id, actor);
    const submission = await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });
    const [job] = await harness.db
      .insert(jobs)
      .values({ intentId: intent.id, runtime: 'test' })
      .returning();
    if (!job) throw new Error('job insert returned no row');
    await submitFindings(deps(), actor, intent, {
      role: SPEC_CRITIC_ROLE,
      jobId: job.id,
      findings: [{ class: 'ambiguous', severity: 'nit', requirement: 'Tighten AC-1 wording' }],
    });
    await submitVerdict(deps(), actor, await reload(intent.id), {
      jobId: job.id,
      role: SPEC_CRITIC_ROLE,
      decision: 'approve',
    });
    await submitPlan(deps(), actor, await reload(intent.id), PLAN);

    const spec = await call(editor.headers, 'GET', `/api/intents/${intent.id}/spec`);
    expect(spec.statusCode).toBe(200);
    expect(spec.json<{ spec: { sha256: string } }>().spec.sha256).toBe(submission.spec.sha256);

    const findingList = await call(editor.headers, 'GET', `/api/intents/${intent.id}/findings`);
    expect(findingList.statusCode).toBe(200);
    expect(findingList.json<{ items: unknown[] }>().items).toHaveLength(1);

    const plan = await call(editor.headers, 'GET', `/api/intents/${intent.id}/plan`);
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toEqual(PLAN);

    const jobList = await call(editor.headers, 'GET', `/api/intents/${intent.id}/jobs`);
    expect(jobList.statusCode).toBe(200);
    expect(jobList.json<{ items: unknown[] }>().items).toHaveLength(1);

    const evidence = await call(editor.headers, 'GET', `/api/intents/${intent.id}/evidence`);
    expect(evidence.statusCode).toBe(200);
    const pack = evidence.json<{ findings: unknown[]; verdicts: unknown[] }>();
    expect(pack.findings).toHaveLength(1);
    expect(pack.verdicts).toHaveLength(1);

    const fresh = await createIntentThroughApi(editor.headers, 'No spec yet');
    expect((await call(editor.headers, 'GET', `/api/intents/${fresh.id}/spec`)).statusCode).toBe(404);
    expect((await call(editor.headers, 'GET', `/api/intents/${fresh.id}/plan`)).statusCode).toBe(404);
    expect((await call(editor.headers, 'GET', `/api/intents/${fresh.id}/findings`)).statusCode).toBe(200);
    expect((await call(editor.headers, 'GET', `/api/intents/${fresh.id}/evidence`)).statusCode).toBe(200);
  });

  it('pages the project intent list and hides it from a non-member', async () => {
    const { owner, editor, project } = await setupProject();
    const actor = actorOf(owner.user);
    for (const title of ['alpha', 'bravo', 'charlie']) {
      await createIntent(deps(), actor, { projectId: project.id, title, statement: title });
    }
    const first = await call(editor.headers, 'GET', '/api/projects/acme/intents?limit=2');
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ items: { title: string }[]; nextCursor: string | null }>();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const second = await call(
      editor.headers,
      'GET',
      `/api/projects/acme/intents?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);

    const outsider = await session();
    const forbidden = await call(outsider.headers, 'GET', '/api/projects/acme/intents');
    expect(forbidden.statusCode).toBe(403);
  });

  it('publishes an intent.updated event to the shared bus', async () => {
    const { editor, project } = await setupProject();
    const seen: { type: string; projectId: string }[] = [];
    harness.events.subscribe((event) => seen.push({ type: event.type, projectId: event.projectId }));
    await createIntentThroughApi(editor.headers);
    expect(seen).toEqual(expect.arrayContaining([{ type: 'intent.updated', projectId: project.id }]));
  });
});
