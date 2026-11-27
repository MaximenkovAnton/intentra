import { sql } from 'drizzle-orm';
import type { MemoryHit, MemoryNodeKind } from '@intentra/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import type { DegradedRegistry } from './degraded.js';
import type { Embeddings } from './embeddings.js';
import type { VectorSearcher } from './qdrant.js';
import { MemoryUnavailableError, type GraphNodeView, type GraphWriter } from './types.js';

export interface SearchInput {
  readonly projectId: string;
  readonly q: string;
  readonly kind?: MemoryNodeKind;
  readonly limit: number;
}

export interface SearchResult {
  readonly items: readonly MemoryHit[];
  readonly degraded: boolean;
}

export interface MemorySearchOptions {
  readonly db: Database;
  readonly graph: GraphWriter;
  readonly embeddings: Embeddings;
  readonly qdrant: VectorSearcher;
  readonly degraded: DegradedRegistry;
  readonly logger: FastifyBaseLogger;
}

interface FallbackRow extends Record<string, unknown> {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly score: number;
}

const nodeText = (view: GraphNodeView): string => {
  for (const key of ['text', 'statement', 'title', 'answer', 'name', 'key'] as const) {
    const value = view.props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
};

export class MemorySearch {
  private readonly options: MemorySearchOptions;

  constructor(options: MemorySearchOptions) {
    this.options = options;
  }

  async search(input: SearchInput): Promise<SearchResult> {
    const vector = await this.queryVector(input.q);
    if (vector !== null) {
      try {
        const hits = await this.options.qdrant.hybridSearch({
          projectId: input.projectId,
          text: input.q,
          vector,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          limit: input.limit,
        });
        return { items: await this.hydrate(hits), degraded: this.options.degraded.snapshot().degraded };
      } catch (error: unknown) {
        if (!(error instanceof MemoryUnavailableError)) throw error;
      }
    }
    return { items: await this.fallback(input), degraded: true };
  }

  private async queryVector(text: string): Promise<readonly number[] | null> {
    try {
      const vectors = await this.options.embeddings.embed([text]);
      return vectors[0] ?? null;
    } catch (error: unknown) {
      if (!(error instanceof MemoryUnavailableError)) throw error;
      return null;
    }
  }

  private async hydrate(hits: readonly MemoryHit[]): Promise<readonly MemoryHit[]> {
    const cache = new Map<string, GraphNodeView>();
    for (const hit of hits) {
      if (cache.has(hit.id)) continue;
      try {
        const node = await this.options.graph.readNode(hit.id);
        if (node) cache.set(hit.id, node);
      } catch (error: unknown) {
        if (!(error instanceof MemoryUnavailableError)) throw error;
        this.options.logger.warn(
          { error: error instanceof Error ? error.name : 'unknown' },
          'graph hydration skipped',
        );
        break;
      }
    }
    return hits.map((hit) => {
      const node = cache.get(hit.id);
      if (node === undefined) return hit;
      const text = nodeText(node);
      const status = node.props.status;
      return {
        ...hit,
        ...(text.length === 0 ? {} : { text }),
        meta: {
          ...(typeof status === 'string' ? { status } : {}),
          ...(hit.meta ?? {}),
        },
      };
    });
  }

  private async fallback(input: SearchInput): Promise<readonly MemoryHit[]> {
    const hits = new Map<string, MemoryHit>();
    try {
      const views = await this.options.graph.textSearch(input.projectId, input.q, input.limit);
      for (const view of views) {
        if (input.kind !== undefined && view.kind !== input.kind) continue;
        hits.set(view.id, { id: view.id, kind: view.kind, text: nodeText(view), score: 0.5 });
      }
    } catch (error: unknown) {
      if (!(error instanceof MemoryUnavailableError)) throw error;
    }
    const rows = await this.trigram(input);
    for (const row of rows) {
      const existing = hits.get(row.id);
      if (existing === undefined || existing.score < row.score) {
        hits.set(row.id, {
          id: row.id,
          kind: row.kind,
          text: row.text,
          score: row.score,
          meta: { source: 'trigram' },
        });
      }
    }
    return [...hits.values()]
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, input.limit);
  }

  private async trigram(input: SearchInput): Promise<readonly FallbackRow[]> {
    const result = await this.options.db.execute<FallbackRow>(sql`
      SELECT id, kind, text, score FROM (
        SELECT id::text AS id, 'intent' AS kind, title || ' ' || statement AS text,
               similarity(title || ' ' || statement, ${input.q}) AS score
        FROM intents
        WHERE project_id = ${input.projectId}
          AND (position(lower(${input.q}) in lower(title || ' ' || statement)) > 0
               OR similarity(title || ' ' || statement, ${input.q}) > 0.2)
        UNION ALL
        SELECT id::text, 'decision', question || ' ' || answer, similarity(question || ' ' || answer, ${input.q})
        FROM decisions
        WHERE project_id = ${input.projectId}
          AND (position(lower(${input.q}) in lower(question || ' ' || answer)) > 0
               OR similarity(question || ' ' || answer, ${input.q}) > 0.2)
        UNION ALL
        SELECT id::text, 'claim', statement || ' ' || expected, similarity(statement || ' ' || expected, ${input.q})
        FROM memory_claims
        WHERE project_id = ${input.projectId}
          AND (position(lower(${input.q}) in lower(statement || ' ' || expected)) > 0
               OR similarity(statement || ' ' || expected, ${input.q}) > 0.2)
      ) matches
      WHERE (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
      ORDER BY score DESC, id
      LIMIT ${input.limit}
    `);
    return result.rows;
  }
}
