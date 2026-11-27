import type { CreateEscalationInput, EscalationTrigger } from '@intentra/contracts';

export const ESCALATION_TTL_MS = 30 * 60 * 1000;
export const MAX_ESCALATIONS_PER_INTENT = 2;

export interface EscalationTriggerInfo {
  readonly title: string;
  readonly description: string;
}

export const ESCALATION_TRIGGERS = {
  E1: {
    title: 'Greenfield',
    description:
      'No memory or code exists and the choice fixes architecture, data or a contract.',
  },
  E2: {
    title: 'New stack',
    description:
      'A runtime, service, database, protocol, licence, a dependency over 2 MB or a provider switch.',
  },
  E3: {
    title: 'Point of no return',
    description:
      'Data, a public contract, auth or security, money, an irreversible delete or rename, or topology.',
  },
  E4: {
    title: 'Contradiction',
    description:
      'Accepted decisions or claims conflict and the code cannot resolve them, or the critic reports a blocking contradiction.',
  },
  E5: {
    title: 'Budget or loop',
    description: 'Three identical failures, an exhausted budget, or a question nobody answered.',
  },
} as const satisfies Record<EscalationTrigger, EscalationTriggerInfo>;

const ASSUMPTION_TOPIC =
  /\b(?:naming|names?|file layout|layout|test style|error (?:text|message)|defaults?|performance|version)\b|раскладк|стил|текст ошибки|именован/i;

export const isAssumptionOnly = (question: string): boolean => ASSUMPTION_TOPIC.test(question);

export const normalizeQuestion = (question: string): string =>
  question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#./-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const sameQuestion = (left: string, right: string): boolean =>
  normalizeQuestion(left) === normalizeQuestion(right);

export const expiresAtFor = (createdAt: Date): Date => new Date(createdAt.getTime() + ESCALATION_TTL_MS);

export function escalationCardProblems(input: CreateEscalationInput): readonly string[] {
  const problems: string[] = [];
  if (input.options.length < 2 || input.options.length > 4) {
    problems.push('The card must offer 2 to 4 options');
  }
  const ids = new Set(input.options.map((option) => option.id));
  if (ids.size !== input.options.length) problems.push('Option ids must be unique');
  if (!ids.has(input.defaultOption)) problems.push('defaultOption must name one of the options');
  if (input.recommendation !== undefined && !ids.has(input.recommendation)) {
    problems.push('recommendation must name one of the options');
  }
  if (isAssumptionOnly(input.question)) {
    problems.push('This question is an assumption, not an escalation');
  }
  return problems;
}
