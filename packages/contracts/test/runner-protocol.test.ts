import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CenterToRunnerMessageSchema,
  JobOfferSchema,
  PROTOCOL_VERSION,
  RunnerToCenterMessageSchema,
} from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/runner/${name}`, import.meta.url)), 'utf8'));

describe('runner WS protocol', () => {
  it.each(['hello.json', 'heartbeat.json', 'job-accept.json', 'job-result.json'])(
    'parses the shared Rust runner fixture %s',
    (name) => {
      const parsed = RunnerToCenterMessageSchema.safeParse(fixture(name));
      expect(parsed.success).toBe(true);
    },
  );

  it.each(['job-offer.json', 'job-cancel.json', 'job-answer.json'])('parses the shared Rust center fixture %s', (name) => {
    const parsed = CenterToRunnerMessageSchema.safeParse(fixture(name));
    expect(parsed.success).toBe(true);
  });

  it('stamps the hello fixture with the protocol version', () => {
    const message = RunnerToCenterMessageSchema.parse(fixture('hello.json'));
    expect(message.type).toBe('hello');
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('rejects an unknown message type', () => {
    expect(RunnerToCenterMessageSchema.safeParse({ type: 'shutdown' }).success).toBe(false);
  });

  const JOB_ID = '00000000-0000-4000-8000-000000000000';

  const JOB_MESSAGES: readonly (readonly [string, Record<string, unknown>])[] = [
    ['job.status', { type: 'job.status', seq: 1, jobId: JOB_ID, status: 'running' }],
    [
      'job.event',
      { type: 'job.event', seq: 2, jobId: JOB_ID, event: { type: 'usage', inputTokens: 10, outputTokens: 4 } },
    ],
    [
      'job.findings',
      {
        type: 'job.findings',
        seq: 3,
        jobId: JOB_ID,
        role: 'spec-critic',
        findings: [
          {
            acId: 'AC-1',
            class: 'ambiguous',
            severity: 'blocking',
            requirement: 'AC-1 is vague',
            evidence: 'the criterion says it works',
          },
        ],
      },
    ],
    ['job.verdict', { type: 'job.verdict', seq: 4, jobId: JOB_ID, role: 'review', decision: 'approve' }],
    ['job.spec', { type: 'job.spec', seq: 5, jobId: JOB_ID, bodyMd: '# Spec' }],
    [
      'job.diff_summary',
      {
        type: 'job.diff_summary',
        seq: 6,
        jobId: JOB_ID,
        files: [{ path: 'apps/api/src/app.ts', status: 'modified', additions: 1, deletions: 2 }],
      },
    ],
    ['job.link', { type: 'job.link', seq: 7, jobId: JOB_ID, branch: 'intentra/x', commit: 'abc1234' }],
    [
      'job.question',
      {
        type: 'job.question',
        seq: 8,
        jobId: JOB_ID,
        question: {
          stage: 'build',
          question: 'Which store?',
          context: 'Both fit the budget',
          trigger: 'E2',
          options: [
            { id: 'a', label: 'Postgres' },
            { id: 'b', label: 'SQLite' },
          ],
          defaultOption: 'a',
        },
      },
    ],
    ['job.result', { type: 'job.result', seq: 9, jobId: JOB_ID, status: 'succeeded', result: { plan: {} } }],
  ];

  it.each(JOB_MESSAGES)('parses the %s runner message', (_name, message) => {
    expect(RunnerToCenterMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each(JOB_MESSAGES.filter(([name]) => name !== 'job.result'))(
    'rejects the %s runner message without seq',
    (_name, message) => {
      const withoutSeq = Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'seq'));
      expect(RunnerToCenterMessageSchema.safeParse(withoutSeq).success).toBe(false);
    },
  );

  it('accepts a seq-less terminal job.result', () => {
    const result = JOB_MESSAGES.find(([name]) => name === 'job.result')?.[1];
    expect(result).toBeDefined();
    const withoutSeq = Object.fromEntries(Object.entries(result ?? {}).filter(([key]) => key !== 'seq'));
    expect(RunnerToCenterMessageSchema.safeParse(withoutSeq).success).toBe(true);
  });

  it('accepts the center answer with the escalation option and rejects an empty one', () => {
    const answer = {
      type: 'job.answer',
      jobId: JOB_ID,
      answer: { escalationId: JOB_ID, optionId: 'o2', label: 'SQLite' },
    };
    expect(CenterToRunnerMessageSchema.safeParse(answer).success).toBe(true);
    expect(CenterToRunnerMessageSchema.safeParse({ ...answer, answer: { cancelled: true } }).success).toBe(true);
    expect(CenterToRunnerMessageSchema.safeParse({ ...answer, answer: {} }).success).toBe(false);
  });

  it('rejects a job offer without a lease', () => {
    const offer = {
      type: 'job.offer',
      jobId: '00000000-0000-4000-8000-000000000000',
      intentId: '00000000-0000-4000-8000-000000000001',
      stage: 'build',
      runtime: 'dsh',
      payload: {},
    };
    expect(JobOfferSchema.safeParse(offer).success).toBe(false);
    expect(CenterToRunnerMessageSchema.safeParse({ ...offer, leaseUntil: '2026-11-26T10:00:00.000Z' }).success).toBe(
      true,
    );
  });
});
