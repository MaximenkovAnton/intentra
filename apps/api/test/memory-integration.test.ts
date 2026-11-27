import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseClient } from '../src/db/client.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { DegradedRegistry } from '../src/memory/degraded.js';
import { FalkorClient } from '../src/memory/falkordb.js';
import { MemoryGraphStore } from '../src/memory/graph.js';
import { memoryId } from '../src/memory/id.js';
import { createMemory, type MemoryServices } from '../src/memory/index.js';
import { MemoryUnavailableError } from '../src/memory/types.js';
import { baseEnv, hasDatabase } from './harness.js';

const enabled = process.env.MEMORY_IT === '1' && hasDatabase;

const logger = createLogger('silent');

describe.skipIf(!enabled)('memory integration', () => {
  let client: DatabaseClient;
  let memory: MemoryServices;
  let falkor: FalkorClient;
  let projectId: string;
  let config: AppConfig;

  beforeAll(async () => {
    config = loadConfig(
      baseEnv({
        FALKORDB_URL: process.env.FALKORDB_URL ?? 'redis://127.0.0.1:16379',
        QDRANT_URL: process.env.QDRANT_URL ?? 'http://127.0.0.1:16333',
        OLLAMA_URL: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
      }),
    );
    client = createDatabase(config.databaseUrl);
    memory = createMemory({ config, db: client.db, logger, now: () => new Date() });
    falkor = await FalkorClient.connect({
      url: config.memory.falkordbUrl,
      graphName: config.memory.graphName,
      connectTimeoutMs: 5_000,
    });
    projectId = randomUUID();
  });

  afterAll(async () => {
    await memory.stop();
    await falkor.close();
    await client.pool.end();
  });

  it('creates the graph schema and its indexes idempotently', async () => {
    await falkor.ensureSchema();
    const first = await falkor.listIndexes();
    await falkor.ensureSchema();
    const second = await falkor.listIndexes();
    const key = (index: { label: string; properties: readonly string[] }): string =>
      `${index.label}:${[...index.properties].sort().join(',')}`;
    expect(second.length).toBe(first.length);
    expect(new Set(second.map(key))).toEqual(new Set(first.map(key)));
    for (const label of ['Project', 'Intent', 'Spec', 'Decision', 'Claim', 'CodeRef', 'Episode']) {
      expect(first.some((index) => index.label === label)).toBe(true);
    }
  });

  it('creates the qdrant collection and payload indexes idempotently', async () => {
    await memory.qdrant.ensureSchema();
    await memory.qdrant.ensureSchema();
  });

  it('embeds in batches and caches vectors by content sha256', async () => {
    const vectors = await memory.embeddings.embed(['Память Intentra', 'Память Intentra']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1_024);
    expect(vectors[0]).toEqual(vectors[1]);
    const result = await client.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM embedding_cache`,
    );
    expect(result.rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('upserts knowledge, finds it with hybrid search and hydrates from the graph', async () => {
    const intentId = randomUUID();
    const decisionId = randomUUID();
    await memory.repository.upsertIntent({
      projectId,
      intentId,
      title: 'Memory core',
      statement: 'Hybrid retrieval over FalkorDB graph and Qdrant vectors',
      status: 'accepted',
    });
    await memory.repository.upsertDecision({
      projectId,
      decisionId,
      question: 'Which retrieval?',
      answer: 'Use Qdrant hybrid retrieval with RRF fusion',
      rationale: 'Dense and sparse signals together',
      status: 'accepted',
    });
    await memory.repository.upsertEpisode({
      projectId,
      episodeId: randomUUID(),
      intentId,
      summary: 'Memory core accepted with graph and vector search',
    });

    const found = await memory.search.search({ projectId, q: 'hybrid retrieval RRF', limit: 12 });
    const ids = found.items.map((item) => item.id);
    expect(ids).toContain(memoryId(projectId, 'intent', intentId));
    expect(found.items.every((item) => item.text.length > 0)).toBe(true);
  });

  it('drains graph writes queued while FalkorDB is down after it returns', async () => {
    const down = createMemory({
      config: loadConfig(
        baseEnv({
          FALKORDB_URL: 'redis://127.0.0.1:1',
          QDRANT_URL: config.memory.qdrantUrl,
          OLLAMA_URL: config.memory.ollamaUrl,
        }),
      ),
      db: client.db,
      logger,
      now: () => new Date(),
    });
    const intentId = randomUUID();
    try {
      await down.repository.upsertIntent({
        projectId,
        intentId,
        title: 'Queued while FalkorDB is down',
        statement: 'The outbox replays this intent after the service returns',
        status: 'draft',
      });
      expect(down.degraded.isUp('falkordb')).toBe(false);
    } finally {
      await down.stop();
    }

    const queued = await client.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM outbox WHERE payload->'node'->>'key' = ${intentId}`,
    );
    expect(queued.rows[0]?.count).toBe(1);

    expect(await memory.outbox.tick()).toBeGreaterThanOrEqual(1);

    const node = await memory.graph.readNode(memoryId(projectId, 'intent', intentId));
    expect(node?.props.title).toBe('Queued while FalkorDB is down');
    const drained = await client.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM outbox WHERE payload->'node'->>'key' = ${intentId}`,
    );
    expect(drained.rows[0]?.count).toBe(0);
  });

  it('degrades and reconnects after a FalkorDB socket disconnect instead of crashing', async () => {
    const target = new URL(config.memory.falkordbUrl);
    const port = target.port ? Number(target.port) : 6379;
    const pairs: { downstream: net.Socket; upstream: net.Socket }[] = [];
    let blocked = false;
    const proxy = net.createServer((downstream) => {
      if (blocked) {
        downstream.destroy();
        return;
      }
      const upstream = net.connect(port, target.hostname);
      downstream.pipe(upstream).pipe(downstream);
      pairs.push({ downstream, upstream });
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('proxy is not listening');

    const degraded = new DegradedRegistry(() => new Date(), logger);
    const enqueued: unknown[] = [];
    const graph = new MemoryGraphStore({
      connect: (onError) =>
        FalkorClient.connect({
          url: `redis://127.0.0.1:${address.port}`,
          graphName: config.memory.graphName,
          connectTimeoutMs: 2_000,
          queryTimeoutMs: 2_000,
          onError,
        }),
      outbox: { enqueue: async (payload) => void enqueued.push(payload) },
      degraded,
      logger,
    });
    const key = randomUUID();
    try {
      await graph.upsertNode({ kind: 'intent', projectId, key, props: { title: 'before' } });

      blocked = true;
      for (const pair of pairs) {
        pair.downstream.destroy();
        pair.upstream.destroy();
      }
      await expect(graph.readNode(memoryId(projectId, 'intent', key))).rejects.toBeInstanceOf(
        MemoryUnavailableError,
      );
      expect(degraded.isUp('falkordb')).toBe(false);

      blocked = false;
      await graph.upsertNode({ kind: 'intent', projectId, key, props: { title: 'after' } });
      expect(degraded.isUp('falkordb')).toBe(true);

      const node = await graph.readNode(memoryId(projectId, 'intent', key));
      expect(node?.props.title).toBe('after');
      expect(enqueued).toEqual([]);
    } finally {
      await graph.close();
      for (const pair of pairs) {
        pair.downstream.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
