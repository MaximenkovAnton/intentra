import type { MemoryRepository } from './graph.js';

export interface DecisionRecord {
  readonly projectId: string;
  readonly intentId: string;
  readonly decisionId: string;
  readonly question: string;
  readonly answer: string;
  readonly rationale: string | null;
  readonly status: string;
  readonly supersedesId?: string;
}

export interface EpisodeDecision {
  readonly decisionId: string;
  readonly question: string;
  readonly answer: string;
  readonly rationale: string | null;
  readonly status: string;
}

export interface EpisodeRecord {
  readonly projectId: string;
  readonly intentId: string;
  readonly title: string;
  readonly statement: string;
  readonly summary: string;
  readonly decisions: readonly EpisodeDecision[];
}

export async function recordDecision(
  repository: MemoryRepository,
  input: DecisionRecord,
): Promise<void> {
  await repository.upsertDecision({
    projectId: input.projectId,
    decisionId: input.decisionId,
    intentId: input.intentId,
    question: input.question,
    answer: input.answer,
    rationale: input.rationale,
    status: input.status,
    ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
  });
}

export async function recordEpisode(
  repository: MemoryRepository,
  input: EpisodeRecord,
): Promise<void> {
  await repository.upsertIntent({
    projectId: input.projectId,
    intentId: input.intentId,
    title: input.title,
    statement: input.statement,
    status: 'accepted',
  });
  for (const decision of input.decisions) {
    await repository.upsertDecision({
      projectId: input.projectId,
      decisionId: decision.decisionId,
      intentId: input.intentId,
      question: decision.question,
      answer: decision.answer,
      rationale: decision.rationale,
      status: decision.status,
    });
  }
  await repository.upsertEpisode({
    projectId: input.projectId,
    episodeId: input.intentId,
    intentId: input.intentId,
    summary: input.summary,
  });
}
