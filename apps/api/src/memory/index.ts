import type { ContextPack, ContextPackQuery } from '@intentra/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { ClaimService } from './claims.js';
import { buildContextPack } from './context-pack.js';
import { DegradedRegistry } from './degraded.js';
import { OllamaEmbeddings } from './embeddings.js';
import { recordDecision, recordEpisode, type DecisionRecord, type EpisodeRecord } from './episodes.js';
import { FalkorClient } from './falkordb.js';
import { MemoryGraphStore, MemoryRepository } from './graph.js';
import { DbOutboxStore, OutboxWorker, type OutboxPayload } from './outbox.js';
import { QdrantClient } from './qdrant.js';
import { MemorySearch } from './search.js';
import { MemoryUnavailableError } from './types.js';

export interface MemoryApi {
  readonly graph: Pick<MemoryGraphStore, 'snapshot'>;
  readonly claims: Pick<ClaimService, 'create' | 'validate' | 'get' | 'list' | 'contradictedIds'>;
  readonly search: Pick<MemorySearch, 'search'>;
  buildContextPack(input: ContextPackQuery): Promise<ContextPack>;
  recordEpisode(input: EpisodeRecord): Promise<void>;
  recordDecision(input: DecisionRecord): Promise<void>;
}

export interface MemoryServices extends MemoryApi {
  readonly degraded: DegradedRegistry;
  readonly graph: MemoryGraphStore;
  readonly repository: MemoryRepository;
  readonly qdrant: QdrantClient;
  readonly embeddings: OllamaEmbeddings;
  readonly claims: ClaimService;
  readonly search: MemorySearch;
  readonly outbox: OutboxWorker;
  start(): void;
  stop(): Promise<void>;
}

export interface CreateMemoryInput {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
}

export function createMemory(input: CreateMemoryInput): MemoryServices {
  const { config, db, logger, now } = input;
  const degraded = new DegradedRegistry(now, logger);
  const outboxStore = new DbOutboxStore(db, now);
  const graph = new MemoryGraphStore({
    connect: (onError) =>
      FalkorClient.connect({
        url: config.memory.falkordbUrl,
        graphName: config.memory.graphName,
        connectTimeoutMs: Math.min(config.memory.timeoutMs, 5_000),
        queryTimeoutMs: config.memory.timeoutMs,
        onError,
      }),
    outbox: outboxStore,
    degraded,
    logger,
  });
  const qdrant = new QdrantClient({
    url: config.memory.qdrantUrl,
    apiKey: config.memory.qdrantApiKey,
    collection: 'intentra_text',
    dimension: config.memory.embeddingDimension,
    timeoutMs: config.memory.timeoutMs,
    degraded,
    logger,
  });
  const embeddings = new OllamaEmbeddings({
    url: config.memory.ollamaUrl,
    model: config.memory.embeddingModel,
    dimension: config.memory.embeddingDimension,
    timeoutMs: config.memory.timeoutMs,
    retries: 2,
    db,
    degraded,
    logger,
  });
  const repository = new MemoryRepository({
    graph,
    vectors: qdrant,
    embeddings,
    outbox: outboxStore,
    degraded,
    logger,
    now,
  });
  const claims = new ClaimService({ db, repository, now });
  const search = new MemorySearch({ db, graph, embeddings, qdrant, degraded, logger });

  const replay = async (payload: OutboxPayload): Promise<void> => {
    switch (payload.type) {
      case 'graph.node':
        await graph.writeNode(payload.node);
        return;
      case 'graph.edge':
        await graph.writeEdge(payload.edge);
        return;
      case 'qdrant.point': {
        const vectors = await embeddings.embed([payload.point.text]);
        const vector = vectors[0];
        if (vector === undefined) throw new MemoryUnavailableError('ollama', 'embedding is missing');
        await qdrant.upsert([{ ...payload.point, vector }]);
        return;
      }
    }
  };

  const outbox = new OutboxWorker({
    store: outboxStore,
    handler: replay,
    logger,
    now,
    intervalMs: config.memory.outboxIntervalMs,
  });

  return {
    degraded,
    graph,
    repository,
    qdrant,
    embeddings,
    claims,
    search,
    outbox,
    buildContextPack: (query) => buildContextPack({ db, graph, claims, degraded }, query),
    recordEpisode: (input) => recordEpisode(repository, input),
    recordDecision: (input) => recordDecision(repository, input),
    start: () => {
      outbox.start();
    },
    stop: async () => {
      await outbox.stop();
      await graph.close();
    },
  };
}
