import { and, desc, eq, inArray } from 'drizzle-orm';
import type { ContextPack, ContextPackQuery, MemoryStage, SpecStatus } from '@intentra/contracts';
import type { Database } from '../db/client.js';
import { decisions, intents, requirements, specs } from '../db/schema.js';
import type { ClaimService } from './claims.js';
import type { DegradedRegistry } from './degraded.js';
import type { GraphWriter } from './types.js';
import { MemoryUnavailableError, type GraphNodeView } from './types.js';
import { byteLength, truncateBytes } from './text.js';

export const CONTEXT_PACK_LIMIT = 3_072;

const INTENT_BUDGET = 800;
const AC_BUDGET = 800;
const DECISION_COUNT = 5;
const DECISION_BUDGET = 1_000;
const CLAIM_COUNT = 5;
const CLAIM_BUDGET = 1_000;
const CAPABILITY_BUDGET = 300;
const EPISODE_COUNT = 2;
const EPISODE_BUDGET = 300;
const TRAP_BUDGET = 400;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const SPEC_STATUSES_BY_STAGE = {
  intake: [],
  spec: ['draft', 'in_review'],
  spec_critic: ['draft', 'in_review'],
  plan: ['approved'],
  build: ['approved'],
  review: ['approved'],
  verify: ['approved'],
  accept: ['approved'],
} as const satisfies Record<MemoryStage, readonly SpecStatus[]>;

const CURRENT_SPEC_STATUSES: readonly SpecStatus[] = ['draft', 'in_review', 'approved'];

export interface ContextPackDeps {
  readonly db: Database;
  readonly graph: GraphWriter;
  readonly claims: Pick<ClaimService, 'contradictedIds' | 'list'>;
  readonly degraded: DegradedRegistry;
}

const section = (title: string, lines: readonly string[], budget: number): string => {
  if (lines.length === 0) return '';
  const body = truncateBytes(lines.join('\n'), budget);
  return `# ${title}\n${body}\n`;
};

const evidenceClaimIds = (evidence: string | null): readonly string[] =>
  evidence === null ? [] : (evidence.match(UUID_PATTERN) ?? []).map((id) => id.toLowerCase());

const nodeText = (view: GraphNodeView): string => {
  for (const key of ['text', 'statement', 'name', 'label'] as const) {
    const value = view.props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
};

const sorted = (views: readonly GraphNodeView[]): readonly GraphNodeView[] =>
  [...views].sort((left, right) => left.id.localeCompare(right.id));

const readKind = async (
  graph: GraphWriter,
  projectId: string,
  kind: 'capability' | 'episode' | 'trap',
  limit: number,
  degraded: { value: boolean },
): Promise<readonly GraphNodeView[]> => {
  try {
    return sorted(await graph.listByKind(projectId, kind, limit));
  } catch (error: unknown) {
    if (!(error instanceof MemoryUnavailableError)) throw error;
    degraded.value = true;
    return [];
  }
};

export async function buildContextPack(deps: ContextPackDeps, input: ContextPackQuery): Promise<ContextPack> {
  const parts: string[] = [];
  const graphDegraded = { value: false };

  if (input.intentId !== undefined) {
    const [intent] = await deps.db
      .select({ title: intents.title, statement: intents.statement, status: intents.status })
      .from(intents)
      .where(and(eq(intents.id, input.intentId), eq(intents.projectId, input.projectId)))
      .limit(1);
    if (intent) {
      parts.push(
        section('Intent', [`${intent.title} (${intent.status})`, intent.statement], INTENT_BUDGET),
      );
      const stageStatuses =
        input.stage === undefined ? CURRENT_SPEC_STATUSES : SPEC_STATUSES_BY_STAGE[input.stage];
      if (stageStatuses.length > 0) {
        const [spec] = await deps.db
          .select({ id: specs.id })
          .from(specs)
          .where(
            and(eq(specs.intentId, input.intentId), inArray(specs.status, [...stageStatuses])),
          )
          .orderBy(desc(specs.version))
          .limit(1);
        if (spec) {
          const rows = await deps.db
            .select({ acId: requirements.acId, text: requirements.text })
            .from(requirements)
            .where(eq(requirements.specId, spec.id))
            .orderBy(requirements.acId);
          parts.push(section('AC', rows.map((row) => `- ${row.acId}: ${row.text}`), AC_BUDGET));
        }
      }
    }
  }

  const contradicted = await deps.claims.contradictedIds(input.projectId);
  const decisionRows = await deps.db
    .select({
      id: decisions.id,
      answer: decisions.answer,
      rationale: decisions.rationale,
      evidence: decisions.evidence,
    })
    .from(decisions)
    .where(and(eq(decisions.projectId, input.projectId), eq(decisions.status, 'accepted')))
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(DECISION_COUNT * 2);
  const usableDecisions = decisionRows
    .filter((row) => evidenceClaimIds(row.evidence).every((id) => !contradicted.has(id)))
    .slice(0, DECISION_COUNT);
  parts.push(
    section(
      'Decisions',
      usableDecisions.map((row) =>
        truncateBytes(`- ${row.id}: ${row.answer}${row.rationale ? ` — ${row.rationale}` : ''}`, DECISION_BUDGET),
      ),
      DECISION_BUDGET,
    ),
  );

  const freshClaims = await deps.claims.list(input.projectId, { status: 'fresh', limit: CLAIM_COUNT });
  parts.push(
    section(
      'Claims',
      freshClaims.map((claim) =>
        truncateBytes(
          `- ${claim.id}: ${claim.statement} (probe: ${claim.probe.type} ${claim.probe.spec})`,
          CLAIM_BUDGET,
        ),
      ),
      CLAIM_BUDGET,
    ),
  );

  const capabilities = await readKind(deps.graph, input.projectId, 'capability', 10, graphDegraded);
  parts.push(
    section(
      'Capabilities',
      capabilities.map((view) => truncateBytes(`- ${nodeText(view)}`, CAPABILITY_BUDGET)),
      CAPABILITY_BUDGET,
    ),
  );

  const episodes = (await readKind(deps.graph, input.projectId, 'episode', 10, graphDegraded)).slice(
    0,
    EPISODE_COUNT,
  );
  parts.push(section('Episodes', episodes.map((view) => `- ${truncateBytes(nodeText(view), EPISODE_BUDGET)}`), EPISODE_BUDGET));

  const traps = await readKind(deps.graph, input.projectId, 'trap', 20, graphDegraded);
  parts.push(section('Traps', traps.map((view) => `- ${nodeText(view)}`), TRAP_BUDGET));

  const text = truncateBytes(parts.filter((part) => part.length > 0).join('\n'), CONTEXT_PACK_LIMIT);
  return {
    text,
    bytes: byteLength(text),
    degraded: graphDegraded.value || deps.degraded.snapshot().degraded,
    version: 1,
  };
}
