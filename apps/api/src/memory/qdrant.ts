import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';
import type { MemoryHit, MemoryNodeKind } from '@intentra/contracts';
import type { DegradedRegistry } from './degraded.js';
import { truncateBytes } from './text.js';
import { MemoryUnavailableError } from './types.js';

const PointSchema = z.object({
  id: z.union([z.string(), z.number()]),
  score: z.number(),
  payload: z.record(z.string(), z.unknown()).nullish(),
});

const QueryResponseSchema = z.object({
  result: z.object({ points: z.array(PointSchema) }),
});

const PAYLOAD_INDEXES = ['project_id', 'kind', 'status'] as const;
const UPSERT_BATCH = 128;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_POINTS = 128;

export interface MemoryPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly projectId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly status: string;
  readonly text: string;
  readonly path?: string;
  readonly createdAt: string;
}

export interface VectorWriter {
  upsert(points: readonly MemoryPoint[]): Promise<void>;
}

export interface VectorSearcher {
  hybridSearch(input: HybridSearchInput): Promise<readonly MemoryHit[]>;
}

export interface HybridSearchInput {
  readonly projectId: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly kind?: MemoryNodeKind;
  readonly limit?: number;
}

export interface SparseVector {
  readonly indices: number[];
  readonly values: number[];
}

export function sparseVector(text: string): SparseVector {
  const counts = new Map<number, number>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length > 64) continue;
    let hash = 2_166_136_261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    const key = hash >>> 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((left, right) => left[0] - right[0]).slice(0, MAX_POINTS);
  return { indices: entries.map(([index]) => index), values: entries.map(([, value]) => value) };
}

export interface QdrantClientOptions {
  readonly url: string;
  readonly apiKey: string | null;
  readonly collection: string;
  readonly dimension: number;
  readonly timeoutMs: number;
  readonly degraded: DegradedRegistry;
  readonly logger: FastifyBaseLogger;
}

type HttpResult = { readonly status: number; readonly body: unknown };

export class QdrantClient implements VectorWriter, VectorSearcher {
  private readonly options: QdrantClientOptions;
  private schema: Promise<void> | null = null;

  constructor(options: QdrantClientOptions) {
    this.options = options;
  }

  private ensure(): Promise<void> {
    if (this.schema === null) {
      this.schema = this.ensureSchema().catch((error: unknown) => {
        this.schema = null;
        throw error;
      });
    }
    return this.schema;
  }

  async ensureSchema(): Promise<void> {
    try {
      const collection = await this.call('GET', `/collections/${this.options.collection}`);
      if (collection.status === 404) {
        const created = await this.call('PUT', `/collections/${this.options.collection}`, {
          vectors: { dense: { size: this.options.dimension, distance: 'Cosine' } },
          sparse_vectors: { sparse: { modifier: 'idf' } },
        });
        if (!created.ok) throw new MemoryUnavailableError('qdrant', 'Qdrant collection creation failed');
      } else if (!collection.ok) {
        throw new MemoryUnavailableError('qdrant', `Qdrant responded ${collection.status}`);
      }
      for (const field of PAYLOAD_INDEXES) {
        const indexed = await this.call('PUT', `/collections/${this.options.collection}/index`, {
          field_name: field,
          field_schema: 'keyword',
        });
        if (!indexed.ok) throw new MemoryUnavailableError('qdrant', 'Qdrant payload index creation failed');
      }
      this.options.degraded.markUp('qdrant');
    } catch (error: unknown) {
      this.options.degraded.markDown('qdrant', error);
      throw error instanceof MemoryUnavailableError
        ? error
        : new MemoryUnavailableError('qdrant', 'Qdrant is unavailable');
    }
  }

  async upsert(points: readonly MemoryPoint[]): Promise<void> {
    await this.ensure();
    for (let offset = 0; offset < points.length; offset += UPSERT_BATCH) {
      const batch = points.slice(offset, offset + UPSERT_BATCH).map((point) => ({
        id: point.id,
        vector: { dense: [...point.vector], sparse: sparseVector(point.text) },
        payload: {
          project_id: point.projectId,
          node_id: point.nodeId,
          kind: point.kind,
          status: point.status,
          created_at: point.createdAt,
          text: truncateBytes(point.text, MAX_TEXT_BYTES),
          ...(point.path === undefined ? {} : { path: point.path }),
        },
      }));
      const result = await this.call('PUT', `/collections/${this.options.collection}/points?wait=true`, {
        points: batch,
      });
      if (!result.ok) {
        this.options.degraded.markDown('qdrant', new Error(`status ${result.status}`));
        throw new MemoryUnavailableError('qdrant', 'Qdrant upsert failed');
      }
    }
    this.options.degraded.markUp('qdrant');
  }

  async hybridSearch(input: HybridSearchInput): Promise<readonly MemoryHit[]> {
    await this.ensure();
    const limit = input.limit ?? 12;
    const result = await this.call('POST', `/collections/${this.options.collection}/points/query`, {
      prefetch: [
        { query: [...input.vector], using: 'dense', limit: limit * 2 },
        { query: sparseVector(input.text), using: 'sparse', limit: limit * 2 },
      ],
      query: { fusion: 'rrf' },
      filter: {
        must: [
          { key: 'project_id', match: { value: input.projectId } },
          ...(input.kind === undefined ? [] : [{ key: 'kind', match: { value: input.kind } }]),
        ],
      },
      limit,
      with_payload: true,
    });
    if (!result.ok) {
      this.options.degraded.markDown('qdrant', new Error(`status ${result.status}`));
      throw new MemoryUnavailableError('qdrant', 'Qdrant search failed');
    }
    const parsed = QueryResponseSchema.safeParse(result.body);
    if (!parsed.success) throw new MemoryUnavailableError('qdrant', 'Qdrant returned an invalid payload');
    return parsed.data.result.points.map((point) => {
      const payload = point.payload ?? {};
      const text = typeof payload.text === 'string' ? payload.text : '';
      const nodeId = typeof payload.node_id === 'string' ? payload.node_id : String(point.id);
      const path = typeof payload.path === 'string' ? payload.path : undefined;
      return {
        id: nodeId,
        kind: typeof payload.kind === 'string' ? payload.kind : 'unknown',
        text,
        score: point.score,
        meta: {
          status: typeof payload.status === 'string' ? payload.status : null,
          ...(path === undefined ? {} : { path }),
        },
      };
    });
  }

  private async call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<HttpResult & { ok: boolean }> {
    let response: Response;
    try {
      response = await fetch(`${this.options.url.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey === null ? {} : { 'api-key': this.options.apiKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error: unknown) {
      this.options.logger.warn(
        { path, error: error instanceof Error ? error.name : 'unknown' },
        'qdrant request failed',
      );
      throw new MemoryUnavailableError('qdrant', 'Qdrant is unreachable');
    }
    const raw = await response.text().catch(() => '');
    let parsed: unknown = null;
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, body: parsed, ok: response.ok };
  }
}
