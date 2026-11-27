import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CreateEscalationInput } from '@intentra/contracts';
import {
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedUser,
  type Harness,
} from './harness.js';
import { INTENT_CARD } from './fixtures.js';
import { auditLog, decisions, escalations, intentMessages, intents } from '../src/db/schema.js';
import {
  answerEscalation,
  createIntent,
  escalate,
  postMessage,
  submitIntentCard,
  type Actor,
  type IntentDeps,
} from '../src/intents/service.js';
import { resolveDecision } from '../src/intents/decisions.js';
import { readArtifactMeta } from '../src/intents/artifacts.js';

const CARD_INPUT: CreateEscalationInput = {
  stage: 'intake',
  question: 'Which runtime executes the agent jobs?',
  context: 'Greenfield: no memory, no code, and the choice fixes the protocol.',
  trigger: 'E1',
  options: [
    { id: 'dsh', label: 'DSH', meaning: 'The DeepSeek Harness runtime' },
    { id: 'cli', label: 'Generic CLI', meaning: 'Any CLI behind an adapter' },
  ],
  recommendation: 'dsh',
  defaultOption: 'dsh',
};

describe.skipIf(!hasDatabase)('intent services', () => {
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

  const deps = (): IntentDeps => ({
    db: harness.db,
    events: harness.events,
    memory: harness.memory,
    now: () => new Date(),
  });

  const newIntent = () =>
    createIntent(deps(), actor, {
      projectId,
      title: 'Intent-driven flow',
      statement: 'Turn intent conversations into reviewed specs',
    });

  it('creates an intent in draft and moves it to clarifying on the first message', async () => {
    const seen: string[] = [];
    const unsubscribe = harness.events.subscribe((event) => seen.push(event.type));
    const intent = await newIntent();
    expect(intent.status).toBe('draft');

    const { message, intent: updated } = await postMessage(deps(), actor, intent, { body: 'Hello' });
    expect(updated.status).toBe('clarifying');
    expect(message.role).toBe('user');
    expect(message.body).toBe('Hello');

    const stored = await harness.db.select().from(intentMessages).where(eq(intentMessages.intentId, intent.id));
    expect(stored.map((row) => row.body)).toEqual(['Hello']);
    expect(seen).toContain('intent.updated');
    const audits = await harness.db.select().from(auditLog).where(eq(auditLog.action, 'intent.transition'));
    expect(audits).toHaveLength(1);
    unsubscribe();
  });

  it('stores the intent card as an artifact', async () => {
    const intent = await newIntent();
    const updated = await submitIntentCard(deps(), actor, intent, INTENT_CARD);
    expect(updated.status).toBe('clarifying');

    const meta = await readArtifactMeta(harness.db, intent.id, 'intent_card');
    expect(meta).toMatchObject({ objective: INTENT_CARD.objective, users: INTENT_CARD.users });
  });

  it('escalates a question, answers it and records an accepted decision', async () => {
    const seen: { type: string; data?: Record<string, unknown> }[] = [];
    const unsubscribe = harness.events.subscribe((event) => seen.push(event));
    const intent = await newIntent();
    const escalation = await escalate(deps(), actor, intent, CARD_INPUT);
    expect(escalation.status).toBe('open');
    expect(escalation.options).toHaveLength(2);

    const result = await answerEscalation(deps(), actor, intent, {
      escalationId: escalation.id,
      optionId: 'cli',
      note: 'Until DSH is installed',
    });
    expect(result.escalation.status).toBe('answered');
    expect(result.escalation.answerOption).toBe('cli');
    expect(result.decision.status).toBe('accepted');
    expect(result.decision.answer).toBe('Generic CLI');
    expect(result.escalation.decisionId).toBe(result.decision.id);
    expect(seen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'escalation.created',
          data: expect.objectContaining({ id: escalation.id, intentId: intent.id }),
        }),
        expect.objectContaining({
          type: 'escalation.answered',
          data: expect.objectContaining({ id: escalation.id, status: 'answered' }),
        }),
      ]),
    );
    unsubscribe();

    const [stored] = await harness.db
      .select()
      .from(escalations)
      .where(eq(escalations.id, escalation.id));
    expect(stored?.decisionId).toBe(result.decision.id);
    expect(stored?.answeredBy).toBe(actor.id);
  });

  it('rejects a repeated question and a third escalation', async () => {
    const intent = await newIntent();
    await escalate(deps(), actor, intent, CARD_INPUT);
    await expect(
      escalate(deps(), actor, intent, { ...CARD_INPUT, options: CARD_INPUT.options, question: CARD_INPUT.question }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await escalate(deps(), actor, intent, { ...CARD_INPUT, question: 'Which database stores sessions?' });
    await expect(
      escalate(deps(), actor, intent, { ...CARD_INPUT, question: 'Which CI runs the gates?' }),
    ).rejects.toMatchObject({ code: 'LIMIT' });
  });

  it('rejects a card whose default is not an option', async () => {
    const intent = await newIntent();
    await expect(
      escalate(deps(), actor, intent, { ...CARD_INPUT, defaultOption: 'ghost' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it.each([
    { name: 'a one-option card', options: [{ id: 'dsh', label: 'DSH' }], defaultOption: 'dsh' },
    {
      name: 'a five-option card',
      options: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id })),
      defaultOption: 'a',
    },
  ])('rejects $name before writing an escalation', async ({ options, defaultOption }) => {
    const intent = await newIntent();
    await expect(
      escalate(deps(), actor, intent, {
        ...CARD_INPUT,
        options,
        recommendation: undefined,
        defaultOption,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const rows = await harness.db
      .select()
      .from(escalations)
      .where(eq(escalations.intentId, intent.id));
    expect(rows).toHaveLength(0);
  });

  it('expires an overdue escalation to its default as a provisional decision and never asks again', async () => {
    const intent = await newIntent();
    const escalation = await escalate(deps(), actor, intent, CARD_INPUT);
    await harness.db
      .update(escalations)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(escalations.id, escalation.id));

    await expect(
      answerEscalation(deps(), actor, intent, { escalationId: escalation.id, optionId: 'cli' }),
    ).rejects.toMatchObject({ code: 'ESCALATION_EXPIRED' });

    const [stored] = await harness.db
      .select()
      .from(escalations)
      .where(eq(escalations.id, escalation.id));
    expect(stored?.status).toBe('expired');
    expect(stored?.answerOption).toBe('dsh');
    const [decision] = await harness.db
      .select()
      .from(decisions)
      .where(eq(decisions.id, stored?.decisionId ?? ''));
    expect(decision?.status).toBe('provisional');
    expect(decision?.answer).toBe('DSH');

    await expect(escalate(deps(), actor, intent, CARD_INPUT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('supersedes an accepted decision instead of editing it', async () => {
    const first = await resolveDecision(deps(), {
      projectId,
      intentId: null,
      question: 'Which database stores sessions?',
      answer: 'Postgres',
      status: 'accepted',
      authorKind: 'user',
      authorId: actor.id,
    });
    const second = await resolveDecision(deps(), {
      projectId,
      intentId: null,
      question: 'Which database stores sessions?',
      answer: 'SQLite',
      status: 'accepted',
      authorKind: 'user',
      authorId: actor.id,
    });
    expect(second.supersedesId).toBe(first.id);

    const rows = await harness.db.select().from(decisions);
    const old = rows.find((row) => row.id === first.id);
    expect(old?.status).toBe('superseded');
    expect(old?.answer).toBe('Postgres');
    expect(second.status).toBe('accepted');
  });

  it('promotes an assumption when an accepted answer arrives and keeps an accepted decision intact', async () => {
    const assumption = await resolveDecision(deps(), {
      projectId,
      intentId: null,
      question: 'Which runtime executes the agent jobs?',
      answer: 'Generic CLI',
      status: 'provisional',
      authorKind: 'system',
      authorId: 'system:assumption',
    });
    const accepted = await resolveDecision(deps(), {
      projectId,
      intentId: null,
      question: 'Which runtime executes the agent jobs?',
      answer: 'DSH',
      status: 'accepted',
      authorKind: 'user',
      authorId: actor.id,
    });
    expect(accepted.supersedesId).toBe(assumption.id);

    const later = await resolveDecision(deps(), {
      projectId,
      intentId: null,
      question: 'Which runtime executes the agent jobs?',
      answer: 'Something else',
      status: 'provisional',
      authorKind: 'system',
      authorId: 'system:assumption',
    });
    expect(later.id).toBe(accepted.id);

    const [storedAssumption] = await harness.db
      .select()
      .from(decisions)
      .where(eq(decisions.id, assumption.id));
    expect(storedAssumption?.status).toBe('superseded');
    const [storedAccepted] = await harness.db
      .select()
      .from(decisions)
      .where(eq(decisions.id, accepted.id));
    expect(storedAccepted?.status).toBe('accepted');
  });

  it('audits intent creation with the acting user', async () => {
    const intent = await newIntent();
    const audits = await harness.db.select().from(auditLog).where(eq(auditLog.action, 'intent.create'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorId).toBe(actor.id);
    expect(audits[0]?.target).toBe(intent.id);
    const [row] = await harness.db.select().from(intents).where(eq(intents.id, intent.id));
    expect(row?.projectId).toBe(projectId);
  });
});
