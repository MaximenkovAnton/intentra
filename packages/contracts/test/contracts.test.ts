import { describe, expect, it } from 'vitest';
import {
  AddMemberInputSchema,
  CreateProjectInputSchema,
  ErrorCodeSchema,
  EscalationSchema,
  IntentStatusSchema,
  RegisterRunnerInputSchema,
  UpdateProjectInputSchema,
} from '../src/index.js';

describe('project contracts', () => {
  const cases = [
    { key: 'intentra', valid: true },
    { key: 'a', valid: false },
    { key: 'Intentra', valid: false },
    { key: 'intentra_1', valid: false },
    { key: 'intentra-v1', valid: true },
  ];
  it.each(cases)('validates project key $key', ({ key, valid }) => {
    const input = { key, name: 'Intentra' };
    expect(CreateProjectInputSchema.safeParse(input).success).toBe(valid);
  });

  it('defaults the branch and rejects an empty patch', () => {
    const created = CreateProjectInputSchema.parse({ key: 'intentra', name: 'Intentra' });
    expect(created.defaultBranch).toBe('main');
    expect(UpdateProjectInputSchema.safeParse({}).success).toBe(false);
  });

  it('treats description and repoUrl as nullable when provided', () => {
    const parsed = CreateProjectInputSchema.parse({
      key: 'intentra',
      name: 'Intentra',
      description: null,
      repoUrl: null,
    });
    expect(parsed.description).toBeNull();
    expect(parsed.repoUrl).toBeNull();
  });
});

describe('error contracts', () => {
  it.each(ErrorCodeSchema.options)('accepts the documented code %s', (code) => {
    expect(ErrorCodeSchema.parse(code)).toBe(code);
  });

  it('rejects an undocumented code', () => {
    expect(ErrorCodeSchema.safeParse('TEAPOT').success).toBe(false);
  });
});

describe('member contracts', () => {
  it.each(['owner', 'editor', 'viewer'])('accepts role %s', (role) => {
    expect(AddMemberInputSchema.safeParse({ email: 'dev@example.com', role }).success).toBe(true);
  });

  it('rejects an unknown role and a malformed email', () => {
    expect(AddMemberInputSchema.safeParse({ email: 'dev@example.com', role: 'root' }).success).toBe(false);
    expect(AddMemberInputSchema.safeParse({ email: 'nope', role: 'viewer' }).success).toBe(false);
  });
});

describe('runner registration contract', () => {
  it('defaults capabilities and requires a token', () => {
    const parsed = RegisterRunnerInputSchema.parse({
      registrationToken: 'token',
      name: 'laptop',
      os: 'linux',
      arch: 'x86_64',
      version: '0.1.0',
    });
    expect(parsed.capabilities).toEqual([]);
    expect(RegisterRunnerInputSchema.safeParse({ registrationToken: '' }).success).toBe(false);
  });
});

describe('escalation contract', () => {
  const escalation = (count: number) => ({
    id: '00000000-0000-4000-8000-000000000001',
    intentId: '00000000-0000-4000-8000-000000000002',
    stage: 'intake',
    question: 'Which runtime?',
    context: 'No existing stack',
    options: Array.from({ length: count }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
    })),
    recommendation: null,
    defaultOption: 'option-0',
    expiresAt: null,
    status: 'open',
    answerOption: null,
    answerNote: null,
    answeredBy: null,
    answeredAt: null,
    decisionId: null,
  });

  it.each([
    { count: 1, valid: false },
    { count: 2, valid: true },
    { count: 4, valid: true },
    { count: 5, valid: false },
  ])('requires 2-4 options, got $count', ({ count, valid }) => {
    expect(EscalationSchema.safeParse(escalation(count)).success).toBe(valid);
  });
});

describe('intent status contract', () => {
  it('keeps the documented states and rejects unknown ones', () => {
    expect(IntentStatusSchema.options).toContain('awaiting_acceptance');
    expect(IntentStatusSchema.safeParse('awaiting_acceptance').success).toBe(true);
    expect(IntentStatusSchema.safeParse('done').success).toBe(false);
  });
});
