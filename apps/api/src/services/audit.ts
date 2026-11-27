import { auditLog } from '../db/schema.js';
import type { Database } from '../db/client.js';

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'project.create'
  | 'project.update'
  | 'project.archive'
  | 'member.add'
  | 'member.remove'
  | 'runner.registration_token.create'
  | 'runner.register'
  | 'runner.rotate_token'
  | 'runner.revoke'
  | 'intent.create'
  | 'intent.message.create'
  | 'intent.card.submit'
  | 'intent.spec.submit'
  | 'intent.plan.submit'
  | 'intent.escalate'
  | 'intent.escalation.expire'
  | 'intent.escalation.answer'
  | 'intent.decision.record'
  | 'intent.findings.submit'
  | 'intent.verdict.submit'
  | 'intent.transition'
  | 'intent.accept'
  | 'intent.rework'
  | 'intent.cancel';

export interface AuditEntry {
  readonly actorKind: 'user' | 'runner' | 'system';
  readonly actorId: string;
  readonly action: AuditAction;
  readonly target?: string | null;
  readonly meta?: Record<string, unknown> | null;
}

export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorKind: entry.actorKind,
    actorId: entry.actorId,
    action: entry.action,
    target: entry.target ?? null,
    meta: entry.meta ?? null,
  });
}
