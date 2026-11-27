import { describe, expect, it, vi } from 'vitest';
import { DegradedRegistry } from '../src/memory/degraded.js';
import { memoryId, uuidv5 } from '../src/memory/id.js';
import {
  OutboxWorker,
  OutboxPayloadSchema,
  backoffMs,
  type OutboxPayload,
  type OutboxRow,
  type OutboxStore,
} from '../src/memory/outbox.js';
import { QdrantClient, sparseVector } from '../src/memory/qdrant.js';
import { byteLength, truncateBytes } from '../src/memory/text.js';
import { MemoryUnavailableError } from '../src/memory/types.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger('silent');

const nodePayload: OutboxPayload = {
  type: 'graph.node',
  node: {
    kind: 'intent',
    projectId: '6f9619ff-8b86-4111-b42d-00c04fc964ff',
    key: 'intent-1',
    props: { title: 'Memory' },
  },
};

class FakeStore implements OutboxStore {
  rows: OutboxRow[] = [];
  readonly completed: string[] = [];
  readonly failed: { id: string; attempts: number; nextAttemptAt: Date }[] = [];

  async enqueue(): Promise<void> {}

  async due(): Promise<readonly OutboxRow[]> {
    return this.rows;
  }

  async complete(id: string): Promise<void> {
    this.completed.push(id);
    this.rows = this.rows.filter((row) => row.id !== id);
  }

  async fail(id: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    this.failed.push({ id, attempts, nextAttemptAt });
  }
}

const row = (id: string, payload: unknown): OutboxRow => ({ id, kind: 'graph.node', payload, attempts: 0 });

describe('memory id', () => {
  it('derives stable uuidv5 identifiers from the project, kind and key', () => {
    const first = memoryId('6f9619ff-8b86-d011-b42d-00c04fc964ff', 'claim', 'probe');
    const second = memoryId('6f9619ff-8b86-d011-b42d-00c04fc964ff', 'claim', 'probe');
    const other = memoryId('6f9619ff-8b86-d011-b42d-00c04fc964ff', 'claim', 'other');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('matches the uuid v5 reference computed by python', () => {
    expect(uuidv5('intentra:claim:probe')).toBe('08be969d-676b-5e19-9c04-b15290b279d2');
    expect(memoryId('6f9619ff-8b86-d011-b42d-00c04fc964ff', 'claim', 'probe')).toBe(
      'd20cc026-bf44-5a71-9863-dc92ea409175',
    );
  });
});

describe('sparse vectors', () => {
  it('is deterministic and counts repeated tokens', () => {
    const first = sparseVector('Memory memory graph');
    expect(first).toEqual(sparseVector('Memory memory graph'));
    expect(first.indices).toHaveLength(2);
    expect(first.values.sort((left, right) => left - right)).toEqual([1, 2]);
    expect(sparseVector('').indices).toEqual([]);
  });
});

describe('qdrant hybrid search', () => {
  it('sends the project and kind filters with the requested limit', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ result: { points: [] } }), { status: 200 });
      }),
    );
    try {
      const client = new QdrantClient({
        url: 'http://qdrant.test',
        apiKey: null,
        collection: 'intentra_text',
        dimension: 1024,
        timeoutMs: 1_000,
        degraded: new DegradedRegistry(() => new Date('2026-11-26T00:00:00.000Z'), logger),
        logger,
      });
      const hits = await client.hybridSearch({
        projectId: '6f9619ff-8b86-4111-b42d-00c04fc964ff',
        text: 'memory graph',
        vector: [0, 1],
        kind: 'claim',
        limit: 3,
      });
      expect(hits).toEqual([]);
      expect(bodies.at(-1)).toMatchObject({
        filter: {
          must: [
            { key: 'project_id', match: { value: '6f9619ff-8b86-4111-b42d-00c04fc964ff' } },
            { key: 'kind', match: { value: 'claim' } },
          ],
        },
        limit: 3,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('byte truncation', () => {
  it('cuts on a utf-8 boundary without exceeding the budget', () => {
    const value = 'память и граф';
    expect(byteLength(value)).toBeGreaterThan(12);
    const truncated = truncateBytes(value, 12);
    expect(byteLength(truncated)).toBeLessThanOrEqual(12);
    expect(value.startsWith(truncated)).toBe(true);
    expect(truncateBytes(value, 0)).toBe('');
    expect(truncateBytes(value, 1_000)).toBe(value);
  });

  it('never splits a surrogate pair into a replacement character', () => {
    const cases = [
      ['😀', 3, ''],
      ['😀', 4, '😀'],
      ['a😀', 4, 'a'],
      ['a😀', 5, 'a😀'],
    ] as const;
    for (const [value, budget, expected] of cases) {
      expect(truncateBytes(value, budget)).toBe(expected);
    }
  });
});

describe('degraded registry', () => {
  it('tracks a service going down and back up', () => {
    const registry = new DegradedRegistry(() => new Date('2026-11-26T00:00:00.000Z'), logger);
    expect(registry.snapshot().degraded).toBe(false);
    registry.markDown('qdrant', new MemoryUnavailableError('qdrant', 'down'));
    const down = registry.snapshot();
    expect(down.degraded).toBe(true);
    expect(down.services.qdrant.ok).toBe(false);
    expect(down.services.qdrant.error).toBe('MemoryUnavailableError');
    expect(down.services.falkordb.ok).toBe(true);
    registry.markUp('qdrant');
    expect(registry.snapshot().degraded).toBe(false);
  });
});

describe('outbox worker', () => {
  it('replays a due payload and removes it', async () => {
    const store = new FakeStore();
    store.rows = [row('a', nodePayload)];
    const seen: OutboxPayload[] = [];
    const worker = new OutboxWorker({
      store,
      handler: async (payload) => {
        seen.push(payload);
      },
      logger,
      now: () => new Date('2026-11-26T00:00:00.000Z'),
      intervalMs: 60_000,
    });
    expect(await worker.tick()).toBe(1);
    expect(seen).toEqual([nodePayload]);
    expect(store.completed).toEqual(['a']);
    expect(store.failed).toEqual([]);
  });

  it('backs off a failed replay and keeps the payload for the next attempt', async () => {
    const store = new FakeStore();
    store.rows = [row('b', nodePayload)];
    let attempt = 0;
    const worker = new OutboxWorker({
      store,
      handler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('service down');
      },
      logger,
      now: () => new Date('2026-11-26T00:00:00.000Z'),
      intervalMs: 60_000,
    });
    expect(await worker.tick()).toBe(0);
    expect(store.failed).toEqual([
      { id: 'b', attempts: 1, nextAttemptAt: new Date('2026-11-26T00:00:02.000Z') },
    ]);
    expect(store.rows).toHaveLength(1);
    expect(await worker.tick()).toBe(1);
    expect(store.completed).toEqual(['b']);
  });

  it('rejects a malformed payload instead of replaying it', async () => {
    const store = new FakeStore();
    store.rows = [{ id: 'c', kind: 'graph.node', payload: { type: 'graph.node' }, attempts: 0 }];
    let called = 0;
    const worker = new OutboxWorker({
      store,
      handler: async () => {
        called += 1;
      },
      logger,
      now: () => new Date('2026-11-26T00:00:00.000Z'),
      intervalMs: 60_000,
    });
    expect(await worker.tick()).toBe(0);
    expect(called).toBe(0);
    expect(store.failed[0]?.attempts).toBe(1);
  });

  it('caps the exponential backoff', () => {
    expect(backoffMs(0)).toBe(1_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(30)).toBe(300_000);
  });

  it('catches a failing tick from the interval instead of leaking the rejection', async () => {
    const store = new FakeStore();
    store.due = async () => {
      throw new Error('postgres is down');
    };
    const errors = vi.spyOn(logger, 'error');
    vi.useFakeTimers();
    try {
      const worker = new OutboxWorker({
        store,
        handler: async () => {},
        logger,
        now: () => new Date('2026-11-26T00:00:00.000Z'),
        intervalMs: 10,
      });
      worker.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Error' }),
        'outbox tick failed',
      );
      await worker.stop();
    } finally {
      vi.useRealTimers();
      errors.mockRestore();
    }
  });

  it('rejects an unknown payload type at the schema boundary', () => {
    expect(OutboxPayloadSchema.safeParse({ type: 'graph.node', node: { kind: 'other' } }).success).toBe(false);
    expect(OutboxPayloadSchema.safeParse(nodePayload).success).toBe(true);
  });
});
