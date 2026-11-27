import { describe, expect, it } from 'vitest';
import type { FindingInput, Plan, PlanTask } from '@intentra/contracts';
import { critiqueSpec } from '../src/spec/critic.js';
import { validatePlan } from '../src/spec/plan.js';
import { formatOnlyTestRefChecker, knownTestRefChecker } from '../src/spec/test-refs.js';

import { VALID_SPEC } from './fixtures.js';


const withRisks = (body: string): string => VALID_SPEC.replace('- Scope creep into the runner.', body);

const task = (overrides: Partial<PlanTask> & Pick<PlanTask, 'id' | 'acceptance'>): PlanTask => ({
  title: `Task ${overrides.id}`,
  spec: 'Implement the task as specified.',
  dependsOn: [],
  paths: ['apps/api/src'],
  reviewLens: 'code-reviewer',
  ...overrides,
});

const planOf = (...tasks: PlanTask[]): Plan => ({ tasks });

describe('mechanical spec critic', () => {
  it('approves a spec whose AC table, DoD rows and refs are complete', () => {
    const result = critiqueSpec({ bodyMd: VALID_SPEC, testRefs: formatOnlyTestRefChecker });
    expect(result.verdict).toBe('approve');
    expect(result.findings).toEqual([]);
    expect(result.parsed.acRows.map((row) => row.acId)).toEqual(['AC-1', 'AC-2']);
    expect(result.parsed.dodRows).toEqual([
      { acId: 'AC-1', testRef: 'apps/api/test/intents-api.test.ts::creates an intent', probe: null },
      { acId: 'AC-2', testRef: null, probe: 'pnpm -w typecheck' },
    ]);
  });

  it.each([
    {
      name: 'a missing definition of done',
      body: VALID_SPEC.replace(/\n## Definition of done[\s\S]*?(?=\n## Decisions)/, '\n'),
      expected: { class: 'missing-evidence', requirement: /definition of done/ },
    },
    {
      name: 'a placeholder instead of content',
      body: withRisks('TBD'),
      expected: { class: 'ambiguous', requirement: /risks/i },
    },
    {
      name: 'a duplicated criterion',
      body: VALID_SPEC.replace(
        '| AC-2 | Every route is documented in OpenAPI | nonfunctional | must |',
        '| AC-2 | Every route is documented in OpenAPI | nonfunctional | must |\n| AC-1 | A second AC-1 | functional | must |',
      ),
      expected: { class: 'contradiction', requirement: /more than once/ },
    },
    {
      name: 'an unspecified priority',
      body: VALID_SPEC.replace('| functional | must |', '| functional |  |'),
      expected: { class: 'ambiguous', requirement: /no priority/, acId: 'AC-1' },
    },
    {
      name: 'a criterion without a DoD row',
      body: VALID_SPEC.replace('| AC-2 | - | pnpm -w typecheck |', ''),
      expected: { class: 'missing-evidence', requirement: /no definition of done row/, acId: 'AC-2' },
    },
    {
      name: 'an unknown criterion in the DoD',
      body: VALID_SPEC.replace('| AC-2 | - | pnpm -w typecheck |', '| AC-9 | - | pnpm -w typecheck |'),
      expected: { class: 'contradiction', requirement: /unknown acceptance criterion/, acId: 'AC-9' },
    },
    {
      name: 'a test ref that is not a path',
      body: VALID_SPEC.replace(
        'apps/api/test/intents-api.test.ts::creates an intent',
        'the intent creation test',
      ),
      expected: { class: 'unprovable', requirement: /is not a test path/, acId: 'AC-1' },
    },
    {
      name: 'a missing required section',
      body: VALID_SPEC.replace(/\n## Constraints\n\n- Everything runs online in the control plane\.\n- Session state is stored in Postgres\.\n/, ''),
      expected: { class: 'ambiguous', requirement: /missing the "constraints"/ },
    },
    {
      name: 'a spec over the size budget',
      body: `${VALID_SPEC}\n${'x'.repeat(25 * 1024)}\n`,
      expected: { class: 'scope', requirement: /bytes; the limit is/ },
    },
    {
      name: 'contradictory constraints',
      body: VALID_SPEC.replace(
        '- Everything runs online in the control plane.',
        '- Offline-first is mandatory.\n- The API is online only.',
      ),
      expected: { class: 'contradiction', requirement: /both sides of offline\/online/ },
    },
    {
      name: 'a repeat of a superseded decision',
      body: VALID_SPEC.replace(
        '- Postgres is the only store; no cache.',
        '- SQLite is the primary store for all sessions',
      ),
      supersededDecisions: [
        { question: 'Which database?', answer: 'SQLite is the primary store for all sessions' },
      ],
      expected: { class: 'stale-doc', requirement: /superseded decision/ },
    },
    {
      name: 'a constraint that contradicts an accepted decision',
      body: VALID_SPEC.replace(
        '- Everything runs online in the control plane.',
        '- The processor is asynchronous.',
      ),
      acceptedDecisions: [{ question: 'Processor model', answer: 'Run the processor synchronously in the request' }],
      expected: { class: 'contradiction', requirement: /contradict the accepted decision/ },
    },
  ])('rejects $name with a blocking finding', ({ body, expected, acceptedDecisions, supersededDecisions }) => {
    const result = critiqueSpec({
      bodyMd: body,
      testRefs: formatOnlyTestRefChecker,
      acceptedDecisions: acceptedDecisions ?? [],
      supersededDecisions: supersededDecisions ?? [],
    });
    expect(result.verdict).toBe('changes');
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: expected.class,
          severity: 'blocking',
          requirement: expect.stringMatching(expected.requirement),
          ...('acId' in expected ? { acId: expected.acId } : {}),
        }),
      ]),
    );
  });

  it('rejects a test ref the workspace does not contain', () => {
    const findings = critiqueSpec({
      bodyMd: VALID_SPEC,
      testRefs: knownTestRefChecker(['apps/api/test/other.test.ts::something']),
    }).findings;
    expect(findings).toEqual([
      expect.objectContaining({
        class: 'unprovable',
        acId: 'AC-1',
        requirement: expect.stringMatching(/does not exist/),
      }),
    ]);
  });
});

describe('plan validation', () => {
  const acIds = new Set(['AC-1', 'AC-2']);
  const planFindings = (plan: Plan): readonly FindingInput[] => validatePlan(plan, acIds);

  it('accepts a plan that covers every criterion inside the budgets', () => {
    const plan = planOf(
      task({ id: 'api', acceptance: ['AC-1'] }),
      task({ id: 'docs', acceptance: ['AC-2'], dependsOn: ['api'] }),
    );
    expect(planFindings(plan)).toEqual([]);
  });

  it.each([
    {
      name: 'more than ten tasks',
      plan: planOf(
        ...Array.from({ length: 11 }, (_, index) =>
          task({ id: `task-${index}`, acceptance: ['AC-1', 'AC-2'] }),
        ),
      ),
      expected: { class: 'scope' as const, requirement: /at most 10/ },
    },
    {
      name: 'an unknown dependency',
      plan: planOf(task({ id: 'api', acceptance: ['AC-1', 'AC-2'], dependsOn: ['ghost'] })),
      expected: { class: 'contradiction' as const, requirement: /unknown task "ghost"/ },
    },
    {
      name: 'a dependency cycle',
      plan: planOf(
        task({ id: 'api', acceptance: ['AC-1', 'AC-2'], dependsOn: ['web'] }),
        task({ id: 'web', acceptance: ['AC-1'], dependsOn: ['api'] }),
      ),
      expected: { class: 'contradiction' as const, requirement: /form a cycle/ },
    },
    {
      name: 'more than four direct dependents',
      plan: planOf(
        task({ id: 'base', acceptance: ['AC-1', 'AC-2'] }),
        ...Array.from({ length: 5 }, (_, index) =>
          task({ id: `child-${index}`, acceptance: ['AC-1'], dependsOn: ['base'] }),
        ),
      ),
      expected: { class: 'scope' as const, requirement: /5 direct dependents/ },
    },
    {
      name: 'a task with no paths',
      plan: planOf(task({ id: 'api', acceptance: ['AC-1', 'AC-2'], paths: [] })),
      expected: { class: 'ambiguous' as const, requirement: /names no paths/ },
    },
    {
      name: 'an acceptance id missing from the spec',
      plan: planOf(task({ id: 'api', acceptance: ['AC-1', 'AC-2', 'AC-7'] })),
      expected: { class: 'contradiction' as const, requirement: /unknown criterion "AC-7"/, acId: 'AC-7' },
    },
  ])('reports $name', ({ plan, expected }) => {
    expect(planFindings(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          class: expected.class,
          severity: 'blocking',
          requirement: expect.stringMatching(expected.requirement),
          ...('acId' in expected ? { acId: expected.acId } : {}),
        }),
      ]),
    );
  });

  it('reports a criterion no plan task accepts', () => {
    const plan = planOf(task({ id: 'api', acceptance: ['AC-1'] }));
    expect(planFindings(plan)).toEqual([
      expect.objectContaining({
        class: 'missing-evidence',
        acId: 'AC-2',
        requirement: expect.stringMatching(/not covered/),
      }),
    ]);
  });

  it('adds plan coverage findings to the critic result', () => {
    const plan = planOf(task({ id: 'api', acceptance: ['AC-1'] }));
    const result = critiqueSpec({ bodyMd: VALID_SPEC, testRefs: formatOnlyTestRefChecker, plan });
    expect(result.verdict).toBe('changes');
    expect(result.findings).toEqual([
      expect.objectContaining({ class: 'missing-evidence', acId: 'AC-2' }),
    ]);
  });
});
