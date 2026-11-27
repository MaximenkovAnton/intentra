import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { embeddingCache } from '../db/schema.js';
import type { DegradedRegistry } from './degraded.js';
import { sha256 } from './text.js';
import { MemoryUnavailableError } from './types.js';

const EmbedResponseSchema = z.object({ embeddings: z.array(z.array(z.number())) });

const BATCH_SIZE = 32;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Embeddings {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface OllamaEmbeddingsOptions {
  readonly url: string;
  readonly model: string;
  readonly dimension: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly db: Database;
  readonly degraded: DegradedRegistry;
  readonly logger: FastifyBaseLogger;
}

interface MissingText {
  readonly index: number;
  readonly hash: string;
  readonly text: string;
}

export class OllamaEmbeddings implements Embeddings {
  private readonly options: OllamaEmbeddingsOptions;

  constructor(options: OllamaEmbeddingsOptions) {
    this.options = options;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const hashes = texts.map((text) => sha256(text));
    const cached = await this.cached(hashes);
    const missing: MissingText[] = [];
    texts.forEach((text, index) => {
      const hash = hashes[index];
      if (hash === undefined || cached.has(hash)) return;
      missing.push({ index, hash, text });
    });
    const produced = new Map<string, readonly number[]>();
    for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
      const batch = missing.slice(offset, offset + BATCH_SIZE);
      const vectors = await this.request(batch.map((item) => item.text));
      if (vectors.length !== batch.length) {
        throw new MemoryUnavailableError('ollama', 'Ollama returned a wrong embedding count');
      }
      batch.forEach((item, position) => {
        const vector = vectors[position];
        if (vector === undefined) return;
        if (vector.length !== this.options.dimension) {
          throw new MemoryUnavailableError('ollama', `Ollama returned a ${vector.length}-dimension vector`);
        }
        produced.set(item.hash, vector);
      });
      await this.store(batch, vectors);
    }
    this.options.degraded.markUp('ollama');
    return texts.map((_, index) => {
      const hash = hashes[index];
      const vector = hash === undefined ? undefined : (cached.get(hash) ?? produced.get(hash));
      if (vector === undefined) throw new MemoryUnavailableError('ollama', 'embedding is missing');
      return vector;
    });
  }

  private async cached(hashes: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    const unique = [...new Set(hashes)];
    if (unique.length === 0) return new Map();
    try {
      const rows = await this.options.db
        .select({ hash: embeddingCache.contentSha256, vector: embeddingCache.vector })
        .from(embeddingCache)
        .where(and(inArray(embeddingCache.contentSha256, unique), eq(embeddingCache.model, this.options.model)));
      return new Map(rows.map((row) => [row.hash, row.vector] as const));
    } catch (error: unknown) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'embedding cache read failed',
      );
      return new Map();
    }
  }

  private async store(batch: readonly MissingText[], vectors: readonly (readonly number[])[]): Promise<void> {
    const rows = batch.flatMap((item, position) => {
      const vector = vectors[position];
      return vector === undefined ? [] : [{ contentSha256: item.hash, vector: [...vector], model: this.options.model }];
    });
    if (rows.length === 0) return;
    try {
      await this.options.db.insert(embeddingCache).values(rows).onConflictDoNothing();
    } catch (error: unknown) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'embedding cache write failed',
      );
    }
  }

  private async request(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        const response = await fetch(`${this.options.url}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.options.model, input: inputs }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (!response.ok) {
          lastError = new MemoryUnavailableError('ollama', `Ollama responded ${response.status}`);
          if (response.status >= 500 && attempt < this.options.retries) {
            await delay(250 * (attempt + 1));
            continue;
          }
          throw lastError;
        }
        const parsed = EmbedResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new MemoryUnavailableError('ollama', 'Ollama returned an invalid payload');
        return parsed.data.embeddings;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < this.options.retries) {
          await delay(250 * (attempt + 1));
          continue;
        }
      }
    }
    this.options.degraded.markDown('ollama', lastError);
    throw new MemoryUnavailableError('ollama', 'Ollama is unavailable');
  }
}
