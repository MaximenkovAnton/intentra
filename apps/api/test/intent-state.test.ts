import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { INTENT_TRANSITIONS, assertCanTransition, canTransition, isTerminalStatus } from '../src/intents/state.js';
import type { IntentStatus } from '@intentra/contracts';

describe('intent state machine', () => {
  it.each([
    { from: 'draft', to: 'clarifying', allowed: true },
    { from: 'draft', to: 'specified', allowed: false },
    { from: 'draft', to: 'cancelled', allowed: true },
    { from: 'clarifying', to: 'specified', allowed: true },
    { from: 'clarifying', to: 'planned', allowed: false },
    { from: 'specified', to: 'critiqued', allowed: true },
    { from: 'specified', to: 'planned', allowed: false },
    { from: 'critiqued', to: 'planned', allowed: true },
    { from: 'critiqued', to: 'specified', allowed: true },
    { from: 'planned', to: 'building', allowed: true },
    { from: 'building', to: 'verifying', allowed: true },
    { from: 'verifying', to: 'awaiting_acceptance', allowed: true },
    { from: 'verifying', to: 'building', allowed: true },
    { from: 'awaiting_acceptance', to: 'accepted', allowed: true },
    { from: 'awaiting_acceptance', to: 'building', allowed: true },
    { from: 'awaiting_acceptance', to: 'planned', allowed: true },
    { from: 'accepted', to: 'cancelled', allowed: false },
    { from: 'cancelled', to: 'draft', allowed: false },
    { from: 'rejected', to: 'draft', allowed: false },
  ] satisfies { from: IntentStatus; to: IntentStatus; allowed: boolean }[])(
    'moves $from -> $to: $allowed',
    ({ from, to, allowed }) => {
      expect(canTransition(from, to)).toBe(allowed);
    },
  );

  it.each([
    ['accepted', true],
    ['rejected', true],
    ['cancelled', true],
    ['awaiting_acceptance', false],
    ['draft', false],
  ] satisfies [IntentStatus, boolean][])('marks %s terminal: %s', (status, terminal) => {
    expect(isTerminalStatus(status)).toBe(terminal);
  });

  it('keeps every documented status in the transition table', () => {
    expect(Object.keys(INTENT_TRANSITIONS)).toEqual([
      'draft',
      'clarifying',
      'specified',
      'critiqued',
      'planned',
      'building',
      'verifying',
      'awaiting_acceptance',
      'accepted',
      'rejected',
      'cancelled',
    ]);
  });

  it('rejects a forbidden transition with CONFLICT', () => {
    expect(() => assertCanTransition('draft', 'accepted')).toThrow(HttpError);
    expect(() => assertCanTransition('draft', 'accepted')).toThrow(
      'Intent cannot move from draft to accepted',
    );
  });
});
