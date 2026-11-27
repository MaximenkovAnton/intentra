import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { decisions, type DecisionRow } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { sameQuestion } from '../escalation/policy.js';
import { recordAudit } from '../services/audit.js';

export interface DecisionDeps {
  readonly db: Database;
  readonly now: () => Date;
}

export interface DecisionInput {
  readonly projectId: string;
  readonly intentId: string | null;
  readonly question: string;
  readonly answer: string;
  readonly status: 'accepted' | 'provisional';
  readonly authorKind: 'user' | 'agent' | 'system';
  readonly authorId: string;
  readonly rationale?: string | null;
  readonly alternatives?: readonly string[];
  readonly evidence?: string | null;
  readonly supersedesId?: string | null;
}

const auditActorKind = (kind: DecisionInput['authorKind']): 'user' | 'runner' | 'system' =>
  kind === 'user' ? 'user' : kind === 'agent' ? 'runner' : 'system';

export async function resolveDecision(deps: DecisionDeps, input: DecisionInput): Promise<DecisionRow> {
  let supersedesId = input.supersedesId ?? null;

  if (supersedesId !== null) {
    const [previous] = await deps.db
      .select()
      .from(decisions)
      .where(and(eq(decisions.id, supersedesId), eq(decisions.projectId, input.projectId)))
      .limit(1);
    if (!previous) throw new HttpError('NOT_FOUND', 'Decision to supersede not found');
    await deps.db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, supersedesId));
  } else {
    const candidates = await deps.db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.projectId, input.projectId),
          inArray(decisions.status, ['accepted', 'provisional']),
          input.intentId === null ? isNull(decisions.intentId) : eq(decisions.intentId, input.intentId),
        ),
      )
      .orderBy(desc(decisions.createdAt));
    const previous = candidates.find((candidate) => sameQuestion(candidate.question, input.question));
    if (previous) {
      if (previous.status === input.status && sameQuestion(previous.answer, input.answer)) return previous;
      if (previous.status === 'accepted' && input.status === 'provisional') return previous;
      await deps.db.update(decisions).set({ status: 'superseded' }).where(eq(decisions.id, previous.id));
      supersedesId = previous.id;
    }
  }

  const [created] = await deps.db
    .insert(decisions)
    .values({
      projectId: input.projectId,
      intentId: input.intentId,
      question: input.question,
      answer: input.answer,
      rationale: input.rationale ?? null,
      alternatives: [...(input.alternatives ?? [])],
      status: input.status,
      supersedesId,
      authorKind: input.authorKind,
      authorId: input.authorId,
      evidence: input.evidence ?? null,
    })
    .returning();
  if (!created) throw new Error('decision insert returned no row');
  await recordAudit(deps.db, {
    actorKind: auditActorKind(input.authorKind),
    actorId: input.authorId,
    action: 'intent.decision.record',
    target: input.projectId,
    meta: { status: input.status, question: input.question },
  });
  return created;
}
