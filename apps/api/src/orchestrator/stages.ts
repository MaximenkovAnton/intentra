import type { StageKind } from '@intentra/contracts';

export const STAGE_LIMITS = {
  spec: 3,
  spec_critic: 2,
  plan: 3,
  build: 3,
  review: 2,
} as const satisfies Partial<Record<StageKind, number>>;

export const DEFAULT_GATE_CRITERIA = ['build', 'tests', 'lint', 'format'] as const;

export const VERIFY_ROLE = 'verify';
export const REVIEW_ROLE = 'review';
