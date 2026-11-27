import type { IntentStatus } from '@intentra/contracts';
import { HttpError } from '../errors.js';

export const INTENT_TRANSITIONS = {
  draft: ['clarifying', 'cancelled', 'rejected'],
  clarifying: ['specified', 'cancelled', 'rejected'],
  specified: ['critiqued', 'cancelled'],
  critiqued: ['planned', 'specified', 'cancelled'],
  planned: ['building', 'cancelled'],
  building: ['verifying', 'cancelled'],
  verifying: ['awaiting_acceptance', 'building', 'cancelled'],
  awaiting_acceptance: ['accepted', 'building', 'planned', 'cancelled'],
  accepted: [],
  rejected: [],
  cancelled: [],
} as const satisfies Record<IntentStatus, readonly IntentStatus[]>;

export const isTerminalStatus = (status: IntentStatus): boolean => INTENT_TRANSITIONS[status].length === 0;

export const canTransition = (from: IntentStatus, to: IntentStatus): boolean =>
  (INTENT_TRANSITIONS[from] as readonly IntentStatus[]).includes(to);

export function assertCanTransition(from: IntentStatus, to: IntentStatus): void {
  if (!canTransition(from, to)) {
    throw new HttpError('CONFLICT', `Intent cannot move from ${from} to ${to}`);
  }
}
