import { describe, expect, it } from 'vitest';
import type { CreateEscalationInput } from '@intentra/contracts';
import {
  ESCALATION_TTL_MS,
  ESCALATION_TRIGGERS,
  escalationCardProblems,
  expiresAtFor,
  isAssumptionOnly,
  sameQuestion,
} from '../src/escalation/policy.js';
import { resolveQuestion } from '../src/escalation/resolver.js';

const card = (overrides: Partial<CreateEscalationInput> = {}): CreateEscalationInput => ({
  stage: 'intake',
  question: 'Which runtime executes the agent jobs?',
  context: 'The project is greenfield: no memory, no code, and the choice fixes the protocol.',
  trigger: 'E1',
  options: [
    { id: 'dsh', label: 'DSH', meaning: 'The DeepSeek Harness runtime' },
    { id: 'cli', label: 'Generic CLI', meaning: 'Any CLI agent behind an adapter' },
  ],
  recommendation: 'dsh',
  defaultOption: 'dsh',
  ...overrides,
});

describe('escalation policy', () => {
  it.each([
    { name: 'a complete card', input: card(), problems: [] },
    {
      name: 'a default that is not an option',
      input: card({ defaultOption: 'ghost' }),
      problems: ['defaultOption must name one of the options'],
    },
    {
      name: 'a recommendation that is not an option',
      input: card({ recommendation: 'ghost' }),
      problems: ['recommendation must name one of the options'],
    },
    {
      name: 'duplicate option ids',
      input: card({
        options: [
          { id: 'dsh', label: 'DSH' },
          { id: 'dsh', label: 'DSH again' },
        ],
        recommendation: undefined,
        defaultOption: 'dsh',
      }),
      problems: ['Option ids must be unique'],
    },
    {
      name: 'a one-option card',
      input: card({
        options: [{ id: 'dsh', label: 'DSH' }],
        recommendation: undefined,
        defaultOption: 'dsh',
      }),
      problems: ['The card must offer 2 to 4 options'],
    },
    {
      name: 'a five-option card',
      input: card({
        options: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id })),
        recommendation: undefined,
        defaultOption: 'a',
      }),
      problems: ['The card must offer 2 to 4 options'],
    },
    {
      name: 'a question that is an assumption',
      input: card({ question: 'Which error text do we return?' }),
      problems: ['This question is an assumption, not an escalation'],
    },
  ])('validates $name', ({ input, problems }) => {
    expect(escalationCardProblems(input)).toEqual(problems);
  });

  it('keeps an assumption topic out of escalation', () => {
    expect(isAssumptionOnly('File layout for the intents module')).toBe(true);
    expect(isAssumptionOnly('Which database engine stores sessions?')).toBe(false);
  });

  it('normalizes questions for the repeat guard', () => {
    expect(sameQuestion('Which runtime?', 'which   RUNTIME')).toBe(true);
    expect(sameQuestion('Which runtime?', 'Which database?')).toBe(false);
  });

  it('sets the 30 minute expiry on the card', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    expect(expiresAtFor(createdAt).toISOString()).toBe(
      new Date(createdAt.getTime() + ESCALATION_TTL_MS).toISOString(),
    );
    expect(ESCALATION_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('documents every trigger E1-E5', () => {
    expect(Object.keys(ESCALATION_TRIGGERS)).toEqual(['E1', 'E2', 'E3', 'E4', 'E5']);
  });
});

describe('resolution order', () => {
  const base = {
    question: 'Which runner runtime?',
    assumption: 'Use the generic CLI adapter until DSH is installed.',
    trigger: null,
  };

  it.each([
    {
      name: 'an accepted decision with fresh evidence',
      input: {
        acceptedDecisions: [
          { id: 'd1', question: 'Which runner runtime?', answer: 'DSH', evidence: 'probe: dsh --version' },
        ],
        claims: [{ id: 'c1', statement: 'Which runner runtime?', commit: 'abc', currentCommit: 'abc' }],
        codeEvidence: [{ probe: 'ls crates', output: 'runner-core', resolves: true }],
        conventions: ['Use DSH'],
      },
      expected: { kind: 'accepted-decision', decisionId: 'd1', answer: 'DSH' },
    },
    {
      name: 'a decision without evidence still loses to a fresh claim',
      input: {
        acceptedDecisions: [
          { id: 'd1', question: 'Which runner runtime?', answer: 'DSH', evidence: null },
        ],
        claims: [{ id: 'c1', statement: 'Which runner runtime?', commit: 'abc', currentCommit: 'abc' }],
      },
      expected: { kind: 'claim', claimId: 'c1', statement: 'Which runner runtime?' },
    },
    {
      name: 'a claim from an older commit is stale',
      input: {
        claims: [{ id: 'c1', statement: 'Which runner runtime?', commit: 'old', currentCommit: 'abc' }],
        codeEvidence: [{ probe: 'ls crates', output: 'runner-core', resolves: true }],
      },
      expected: { kind: 'code-evidence', probe: 'ls crates', output: 'runner-core' },
    },
    {
      name: 'a convention when no evidence resolves the question',
      input: { conventions: ['Generic CLI first'] },
      expected: { kind: 'convention', convention: 'Generic CLI first' },
    },
  ])('prefers $name', ({ input, expected }) => {
    const resolution = resolveQuestion({ ...base, ...input });
    expect(resolution).toEqual(expect.objectContaining(expected));
  });

  it('falls back to an assumption without a trigger', () => {
    expect(resolveQuestion(base)).toEqual({
      kind: 'assumption',
      assumption: 'Use the generic CLI adapter until DSH is installed.',
    });
  });

  it('escalates when a trigger is set and nothing else resolves the question', () => {
    expect(resolveQuestion({ ...base, trigger: 'E3' })).toEqual({
      kind: 'escalate',
      trigger: 'E3',
      reason: 'No decision, claim, code evidence or convention resolves the question',
    });
  });
});
