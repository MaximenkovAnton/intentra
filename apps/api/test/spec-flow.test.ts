import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Plan } from '@intentra/contracts';
import {
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedUser,
  type Harness,
} from './harness.js';
import { VALID_SPEC } from './fixtures.js';
import { findings, intents, jobs, specs } from '../src/db/schema.js';
import {
  SPEC_CRITIC_ROLE,
  createIntent,
  loadSpecBundle,
  postMessage,
  readPlan,
  submitFindings,
  submitPlan,
  submitSpec,
  submitVerdict,
  transitionIntent,
  type Actor,
  type IntentDeps,
} from '../src/intents/service.js';
import { knownTestRefChecker, type TestRefChecker } from '../src/spec/test-refs.js';

const SPEC_WITHOUT_DOD = VALID_SPEC.replace(/\n## Definition of done[\s\S]*?(?=\n## Decisions)/, '\n');

const task = (id: string, acceptance: string[], dependsOn: string[] = []): Plan['tasks'][number] => ({
  id,
  title: `Task ${id}`,
  spec: 'Implement the task as specified.',
  paths: ['apps/api/src'],
  acceptance,
  dependsOn,
  reviewLens: 'code-reviewer',
});

const VALID_PLAN: Plan = { tasks: [task('intents', ['AC-1']), task('openapi', ['AC-2'], ['intents'])] };
const UNCOVERED_PLAN: Plan = { tasks: [task('intents', ['AC-1'])] };

describe.skipIf(!hasDatabase)('spec, plan and verdict services', () => {
  let harness: Harness;
  let actor: Actor;
  let projectId: string;

  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
    const user = await seedUser(harness.db);
    const project = await seedProject(harness.db, user.id, 'acme');
    actor = { kind: 'user', id: user.id };
    projectId = project.id;
  });

  const deps = (testRefs?: TestRefChecker): IntentDeps => ({
    db: harness.db,
    events: harness.events,
    memory: harness.memory,
    now: () => new Date(),
    ...(testRefs === undefined ? {} : { testRefs }),
  });

  const clarifiedIntent = async () => {
    const created = await createIntent(deps(), actor, {
      projectId,
      title: 'Intent-driven flow',
      statement: 'Turn intent conversations into reviewed specs',
    });
    const { intent } = await postMessage(deps(), actor, created, { body: 'Hi' });
    return intent;
  };

  const reloadIntent = async (id: string) => {
    const [row] = await harness.db.select().from(intents).where(eq(intents.id, id));
    if (!row) throw new Error('intent disappeared');
    return row;
  };

  const seedJob = async (intentId: string) => {
    const [job] = await harness.db.insert(jobs).values({ intentId, runtime: 'test' }).returning();
    if (!job) throw new Error('job insert returned no row');
    return job;
  };

  const critiquedIntent = async () => {
    const intent = await clarifiedIntent();
    await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });
    const job = await seedJob(intent.id);
    await submitVerdict(deps(), actor, await reloadIntent(intent.id), {
      jobId: job.id,
      role: SPEC_CRITIC_ROLE,
      decision: 'approve',
    });
    return reloadIntent(intent.id);
  };

  it('accepts a complete spec and persists its requirements and DoD rows', async () => {
    const intent = await clarifiedIntent();
    const submission = await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });

    expect(submission.verdict).toBe('approve');
    expect(submission.spec.status).toBe('in_review');
    expect(submission.findings).toEqual([]);
    expect(submission.requirements.map((row) => row.acId)).toEqual(['AC-1', 'AC-2']);
    expect(submission.dodRows).toHaveLength(2);
    expect((await reloadIntent(intent.id)).status).toBe('specified');

    const bundle = await loadSpecBundle(harness.db, intent.id);
    expect(bundle?.spec.sha256).toBe(submission.spec.sha256);
    expect(bundle?.dodRows.map((row) => row.testRef)).toContain(
      'apps/api/test/intents-api.test.ts::creates an intent',
    );
  });

  it('rejects a spec without a definition of done and keeps the spec in draft', async () => {
    const seen: { type: string; data?: Record<string, unknown> }[] = [];
    const unsubscribe = harness.events.subscribe((event) => seen.push(event));
    const intent = await clarifiedIntent();
    const submission = await submitSpec(deps(), actor, intent, { bodyMd: SPEC_WITHOUT_DOD });

    expect(submission.verdict).toBe('changes');
    expect(submission.spec.status).toBe('draft');
    expect(submission.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: 'missing-evidence',
          severity: 'blocking',
          role: SPEC_CRITIC_ROLE,
          status: 'open',
        }),
      ]),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'finding.created',
        data: expect.objectContaining({ intentId: intent.id, severity: 'blocking' }),
      }),
    );
    unsubscribe();
    const stored = await harness.db
      .select()
      .from(findings)
      .where(eq(findings.intentId, intent.id));
    expect(stored.length).toBe(submission.findings.length);
    const [spec] = await harness.db.select().from(specs).where(eq(specs.intentId, intent.id));
    expect(spec?.status).toBe('draft');
  });

  it('rejects a test ref the workspace does not contain', async () => {
    const intent = await clarifiedIntent();
    const submission = await submitSpec(deps(knownTestRefChecker([])), actor, intent, {
      bodyMd: VALID_SPEC,
    });
    expect(submission.findings).toEqual([
      expect.objectContaining({ class: 'unprovable', acId: 'AC-1' }),
    ]);
  });

  it('supersedes the previous spec and closes earlier findings on resubmission', async () => {
    const intent = await clarifiedIntent();
    const first = await submitSpec(deps(), actor, intent, { bodyMd: SPEC_WITHOUT_DOD });
    expect(first.spec.version).toBe(1);

    const second = await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });
    expect(second.spec.version).toBe(2);
    expect(second.verdict).toBe('approve');

    const specRows = await harness.db.select().from(specs).where(eq(specs.intentId, intent.id));
    expect(specRows.find((row) => row.id === first.spec.id)?.status).toBe('superseded');
    expect(specRows.find((row) => row.id === second.spec.id)?.status).toBe('in_review');

    const oldFindings = await harness.db
      .select()
      .from(findings)
      .where(eq(findings.intentId, intent.id));
    expect(oldFindings).toHaveLength(first.findings.length);
    expect(oldFindings.every((row) => row.status === 'closed')).toBe(true);
  });

  it('rejects a blocking finding without evidence and stores a documented one', async () => {
    const intent = await clarifiedIntent();
    await expect(
      submitFindings(deps(), actor, intent, {
        role: SPEC_CRITIC_ROLE,
        findings: [{ class: 'ambiguous', severity: 'blocking', requirement: 'AC-1 is vague' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const rows = await submitFindings(deps(), actor, intent, {
      role: SPEC_CRITIC_ROLE,
      findings: [
        {
          acId: 'AC-1',
          class: 'ambiguous',
          severity: 'blocking',
          requirement: 'AC-1 is vague',
          evidence: 'The criterion says "works" without an observable result',
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('open');
  });

  it('blocks an approve verdict while a blocking finding is open and binds the verdict to the spec sha', async () => {
    const intent = await clarifiedIntent();
    await submitSpec(deps(), actor, intent, { bodyMd: VALID_SPEC });
    const job = await seedJob(intent.id);

    await submitFindings(deps(), actor, intent, {
      role: SPEC_CRITIC_ROLE,
      jobId: job.id,
      findings: [
        {
          acId: 'AC-1',
          class: 'ambiguous',
          severity: 'blocking',
          requirement: 'AC-1 is vague',
          evidence: 'No observable result',
        },
      ],
    });
    await expect(
      submitVerdict(deps(), actor, await reloadIntent(intent.id), {
        jobId: job.id,
        role: SPEC_CRITIC_ROLE,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      submitVerdict(deps(), actor, await reloadIntent(intent.id), {
        jobId: job.id,
        role: SPEC_CRITIC_ROLE,
        decision: 'approve',
        artifactSha256: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await harness.db
      .update(findings)
      .set({ status: 'closed' })
      .where(eq(findings.intentId, intent.id));
    const verdict = await submitVerdict(deps(), actor, await reloadIntent(intent.id), {
      jobId: job.id,
      role: SPEC_CRITIC_ROLE,
      decision: 'approve',
    });
    expect(verdict.decision).toBe('approve');
    expect(verdict.round).toBe(1);

    const [spec] = await harness.db.select().from(specs).where(eq(specs.intentId, intent.id));
    expect(spec?.status).toBe('approved');
    expect((await reloadIntent(intent.id)).status).toBe('critiqued');
  });

  it('rejects a plan that leaves a criterion uncovered and accepts a covering plan', async () => {
    const intent = await critiquedIntent();
    const rejected = await submitPlan(deps(), actor, intent, UNCOVERED_PLAN);
    expect(rejected.findings).toEqual([
      expect.objectContaining({ class: 'missing-evidence', acId: 'AC-2' }),
    ]);
    expect((await reloadIntent(intent.id)).status).toBe('critiqued');

    const accepted = await submitPlan(deps(), actor, intent, VALID_PLAN);
    expect(accepted.findings).toEqual([]);
    expect((await reloadIntent(intent.id)).status).toBe('planned');
    expect(await readPlan(harness.db, intent.id)).toEqual(VALID_PLAN);
  });

  it('walks the state machine to acceptance and rejects acceptance from a wrong status', async () => {
    const intent = await critiquedIntent();
    await submitPlan(deps(), actor, intent, VALID_PLAN);
    let current = await reloadIntent(intent.id);
    for (const next of ['building', 'verifying', 'awaiting_acceptance'] as const) {
      current = await transitionIntent(deps(), actor, current, next);
    }
    expect(current.status).toBe('awaiting_acceptance');
    expect((await transitionIntent(deps(), actor, current, 'accepted')).status).toBe('accepted');

    const fresh = await clarifiedIntent();
    await expect(transitionIntent(deps(), actor, fresh, 'accepted')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
