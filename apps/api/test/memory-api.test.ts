import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryStage } from '@intentra/contracts';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedSession,
  seedUser,
  type Harness,
} from './harness.js';
import { decisions, intents, outbox, projectMembers, projects, requirements, specs } from '../src/db/schema.js';
import { buildContextPack } from '../src/memory/context-pack.js';
import { DegradedRegistry } from '../src/memory/degraded.js';
import { memoryId } from '../src/memory/id.js';
import { DbOutboxStore, OutboxWorker } from '../src/memory/outbox.js';
import type { GraphNodeView, GraphWriter } from '../src/memory/types.js';
import { createLogger } from '../src/logger.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPEC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SPEC2_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
const REQUIREMENT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUIREMENT2_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddc';
const DECISION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EXCLUDED_DECISION_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const INTERNAL_TOKEN = 'test-internal-token-0123456789';
const FIXED_NOW = (): Date => new Date('2026-11-26T00:00:00.000Z');
const logger = createLogger('silent');

const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };

class FakeGraph implements GraphWriter {
  constructor(private readonly views: Partial<Record<string, readonly GraphNodeView[]>> = {}) {}

  async upsertNode(): Promise<void> {}
  async upsertEdge(): Promise<void> {}

  async readNode(): Promise<GraphNodeView | null> {
    return null;
  }

  async listByKind(_projectId: string, kind: GraphNodeView['kind'], _limit: number): Promise<readonly GraphNodeView[]> {
    return this.views[kind] ?? [];
  }

  async snapshot(): Promise<{ nodes: readonly GraphNodeView[]; edges: readonly [] }> {
    return { nodes: [], edges: [] };
  }

  async textSearch(): Promise<readonly GraphNodeView[]> {
    return [];
  }
}

const view = (id: string, kind: GraphNodeView['kind'], text: string): GraphNodeView => ({
  id,
  kind,
  projectId: PROJECT_ID,
  props: { text },
});

describe.skipIf(!hasDatabase)('memory API', () => {
  let harness: Harness;
  let cookie: { cookie: string; origin: string };

  beforeAll(async () => {
    harness = await createHarness({
      MEMORY_INTERNAL_TOKEN: INTERNAL_TOKEN,
      FALKORDB_URL: 'redis://127.0.0.1:1',
      OLLAMA_URL: 'http://127.0.0.1:1',
      QDRANT_URL: 'http://127.0.0.1:1',
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const seed = async () => {
    const user = await seedUser(harness.db);
    await harness.db.insert(projects).values({
      id: PROJECT_ID,
      key: 'memory',
      name: 'Memory',
      description: null,
      repoUrl: null,
      defaultBranch: 'main',
      createdBy: user.id,
    });
    await harness.db.insert(projectMembers).values({ projectId: PROJECT_ID, userId: user.id, role: 'owner' });
    cookie = authCookie(await seedSession(harness.db, user.id));
    return user;
  };

  const createClaim = async (key: string, statement: string) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/internal/memory/claims',
      headers: auth,
      payload: {
        projectId: PROJECT_ID,
        key,
        statement,
        probe: { type: 'test', spec: 'test/memory.test.ts' },
        expected: 'the probe passes',
        codeRef: { path: 'apps/api/src/memory/search.ts', symbol: 'search', blobSha: 'sha-fresh' },
      },
    });

  it('guards the internal memory API with the orchestrator token', async () => {
    await seed();
    const denied = await harness.app.inject({
      method: 'GET',
      url: `/api/internal/memory/context-pack?projectId=${PROJECT_ID}`,
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'AUTH_REQUIRED' });

    const allowed = await harness.app.inject({
      method: 'GET',
      url: `/api/internal/memory/context-pack?projectId=${PROJECT_ID}`,
      headers: auth,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects a claim without a probe with a validation error', async () => {
    await seed();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/internal/memory/claims',
      headers: auth,
      payload: {
        projectId: PROJECT_ID,
        key: 'no-probe',
        statement: 'a claim without a probe',
        expected: 'rejected',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('moves a claim fresh -> stale and contradicts it on a different result', async () => {
    await seed();
    const created = await createClaim('cache-hit', 'The embedding cache returns a hit for the same text');
    expect(created.statusCode).toBe(201);
    const claim = created.json();
    expect(claim.status).toBe('unverified');
    expect(claim.id).toBe(memoryId(PROJECT_ID, 'claim', 'cache-hit'));

    const validated = await harness.app.inject({
      method: 'POST',
      url: `/api/internal/memory/claims/${claim.id}/validate`,
      headers: auth,
      payload: {
        projectId: PROJECT_ID,
        outcome: 'passed',
        verifiedBy: 'runner-1',
        commit: 'commit-a',
        blobSha: 'sha-fresh',
      },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({ status: 'fresh', verifiedBy: 'runner-1', commit: 'commit-a' });

    const stale = await harness.app.inject({
      method: 'POST',
      url: `/api/internal/memory/claims/${claim.id}/validate`,
      headers: auth,
      payload: {
        projectId: PROJECT_ID,
        outcome: 'stale',
        verifiedBy: 'runner-1',
        commit: 'commit-b',
        blobSha: 'sha-changed',
      },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({
      status: 'stale',
      blobSha: 'sha-changed',
      commit: 'commit-b',
      codeRef: { path: 'apps/api/src/memory/search.ts', blobSha: 'sha-fresh' },
    });

    const contradicted = await harness.app.inject({
      method: 'POST',
      url: `/api/internal/memory/claims/${claim.id}/validate`,
      headers: auth,
      payload: {
        projectId: PROJECT_ID,
        outcome: 'failed',
        verifiedBy: 'runner-1',
        commit: 'commit-b',
      },
    });
    expect(contradicted.statusCode).toBe(200);
    expect(contradicted.json()).toMatchObject({ status: 'contradicted' });

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/api/internal/memory/claims?projectId=${PROJECT_ID}&status=contradicted`,
      headers: auth,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
  });

  it('queues graph and vector writes in the outbox while the services are down', async () => {
    await seed();
    await createClaim('outbox', 'A claim written while FalkorDB is down');

    const rows = await harness.db.select({ kind: outbox.kind, payload: outbox.payload }).from(outbox);
    const kinds = rows.map((row) => row.kind).sort();
    expect(kinds).toContain('graph.node');
    expect(kinds).toContain('qdrant.point');
    const node = rows.find((row) => row.kind === 'graph.node');
    expect(node?.payload).toMatchObject({ type: 'graph.node', node: { kind: 'claim', key: 'outbox' } });
  });

  it('drains a queued write through the real outbox store and backs off a failing one', async () => {
    await seed();
    await createClaim('catch-up', 'A claim queued while the memory services are down');

    const queued = await harness.db.select({ kind: outbox.kind }).from(outbox);
    expect(queued.map((row) => row.kind)).toEqual(
      expect.arrayContaining(['graph.node', 'qdrant.point']),
    );

    const store = new DbOutboxStore(harness.db, () => new Date());
    const written: string[] = [];
    const worker = new OutboxWorker({
      store,
      handler: async (payload) => {
        if (payload.type === 'qdrant.point') throw new Error('ollama is still down');
        written.push(payload.type === 'graph.node' ? payload.node.key : payload.edge.relation);
      },
      logger,
      now: () => new Date(),
      intervalMs: 60_000,
    });

    expect(await worker.tick()).toBeGreaterThanOrEqual(1);
    expect(written).toContain('catch-up');
    const failed = await harness.db
      .select({ kind: outbox.kind, attempts: outbox.attempts, nextAttemptAt: outbox.nextAttemptAt })
      .from(outbox);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: 'qdrant.point', attempts: 1 });
    expect(failed[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 500);

    const drain = new OutboxWorker({
      store,
      handler: async () => {},
      logger,
      now: () => new Date(Date.now() + 60_000),
      intervalMs: 60_000,
    });
    expect(await drain.tick()).toBe(1);
    expect(await harness.db.select({ id: outbox.id }).from(outbox)).toEqual([]);
  });

  it('serves the project graph from the postgres cache when FalkorDB is down', async () => {
    await seed();
    const claim = (await createClaim('graph-cache', 'Cached claim')).json();
    await harness.db.insert(decisions).values({
      id: DECISION_ID,
      projectId: PROJECT_ID,
      intentId: null,
      question: 'Which store?',
      answer: 'Postgres cache',
      rationale: null,
      status: 'accepted',
      authorKind: 'user',
      authorId: 'system',
      evidence: null,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/memory/memory/graph',
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.degraded).toBe(true);
    const ids = body.nodes.map((node: { id: string }) => node.id);
    expect(ids).toContain(DECISION_ID);
    expect(ids).toContain(claim.id);
    expect(body.edges).toEqual([]);
    expect(new Date(body.updatedAt).toString()).not.toBe('Invalid Date');
  });

  it('falls back to trigram search when vectors are unavailable', async () => {
    const user = await seed();
    await harness.db.insert(intents).values({
      id: INTENT_ID,
      projectId: PROJECT_ID,
      title: 'Memory graph',
      statement: 'The intent stores decisions in FalkorDB and vectors in Qdrant',
      status: 'draft',
      createdBy: user.id,
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/memory/memory/search?q=Qdrant',
      headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.degraded).toBe(true);
    expect(body.items).toEqual([
      expect.objectContaining({ id: INTENT_ID, kind: 'intent', meta: { source: 'trigram' } }),
    ]);

    const filtered = await harness.app.inject({
      method: 'GET',
      url: '/api/projects/memory/memory/search?q=Qdrant&kind=decision',
      headers: cookie,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toEqual([]);
  });

  it('builds a deterministic context pack within the byte budget', async () => {
    const user = await seed();
    await harness.db.insert(intents).values({
      id: INTENT_ID,
      projectId: PROJECT_ID,
      title: 'Memory core',
      statement: 'Store knowledge in FalkorDB and Qdrant with a deterministic context pack',
      status: 'clarifying',
      createdBy: user.id,
    });
    await harness.db.insert(specs).values({
      id: SPEC_ID,
      intentId: INTENT_ID,
      version: 1,
      bodyMd: '# spec',
      status: 'approved',
      sha256: 'spec-sha',
    });
    await harness.db.insert(requirements).values({
      id: REQUIREMENT_ID,
      specId: SPEC_ID,
      acId: 'AC-1',
      text: 'The context pack never exceeds 3072 bytes',
      kind: 'functional',
      status: 'open',
    });

    const contradicted = (await createClaim('bad', 'The cache never misses')).json();
    await harness.app.inject({
      method: 'POST',
      url: `/api/internal/memory/claims/${contradicted.id}/validate`,
      headers: auth,
      payload: { projectId: PROJECT_ID, outcome: 'failed', verifiedBy: 'runner-1', commit: 'commit-a' },
    });
    const fresh = (await createClaim('good', 'The embedding cache is keyed by content sha256')).json();
    await harness.app.inject({
      method: 'POST',
      url: `/api/internal/memory/claims/${fresh.id}/validate`,
      headers: auth,
      payload: { projectId: PROJECT_ID, outcome: 'passed', verifiedBy: 'runner-1', commit: 'commit-a' },
    });

    await harness.db.insert(decisions).values([
      {
        id: DECISION_ID,
        projectId: PROJECT_ID,
        intentId: INTENT_ID,
        question: 'Which vector store?',
        answer: 'Qdrant',
        rationale: 'Hybrid search support',
        status: 'accepted',
        authorKind: 'user',
        authorId: 'system',
        evidence: null,
      },
      {
        id: EXCLUDED_DECISION_ID,
        projectId: PROJECT_ID,
        intentId: INTENT_ID,
        question: 'Trust the contradicted claim?',
        answer: 'EXCLUDED-DECISION',
        rationale: null,
        status: 'accepted',
        authorKind: 'user',
        authorId: 'system',
        evidence: contradicted.id,
      },
    ]);

    const graph = new FakeGraph({
      capability: [view('11111111-1111-4111-8111-111111111111', 'capability', 'Memory: graph + vectors')],
      episode: [view('22222222-2222-4222-8222-222222222222', 'episode', 'Accepted memory core')],
      trap: [view('33333333-3333-4333-8333-333333333333', 'trap', 'Qdrant payloads never carry source code')],
    });
    const degraded = new DegradedRegistry(FIXED_NOW, logger);
    const pack = await buildContextPack(
      { db: harness.db, graph, claims: harness.memory.claims, degraded },
      { projectId: PROJECT_ID, intentId: INTENT_ID, stage: 'build' },
    );

    expect(pack.bytes).toBeLessThanOrEqual(3_072);
    expect(pack.bytes).toBe(Buffer.byteLength(pack.text, 'utf8'));
    expect(pack.version).toBe(1);
    expect(pack.text).toContain('AC-1: The context pack never exceeds 3072 bytes');
    expect(pack.text).toContain(fresh.id);
    expect(pack.text).not.toContain(contradicted.id);
    expect(pack.text).not.toContain('EXCLUDED-DECISION');
    expect(pack.text).toContain('Memory: graph + vectors');
    expect(pack.text).toContain('Accepted memory core');
    expect(pack.text).toContain('Qdrant payloads never carry source code');
    expect(pack.text).toMatchSnapshot();
  });

  it('selects the ACs of the spec current at the requested stage', async () => {
    const user = await seed();
    await harness.db.insert(intents).values({
      id: INTENT_ID,
      projectId: PROJECT_ID,
      title: 'Staged specs',
      statement: 'Each stage reads its own spec version',
      status: 'clarifying',
      createdBy: user.id,
    });
    await harness.db.insert(specs).values([
      {
        id: SPEC_ID,
        intentId: INTENT_ID,
        version: 1,
        bodyMd: '# approved',
        status: 'approved',
        sha256: 'sha-v1',
      },
      {
        id: SPEC2_ID,
        intentId: INTENT_ID,
        version: 2,
        bodyMd: '# draft',
        status: 'draft',
        sha256: 'sha-v2',
      },
    ]);
    await harness.db.insert(requirements).values([
      {
        id: REQUIREMENT_ID,
        specId: SPEC_ID,
        acId: 'AC-DONE',
        text: 'The approved AC',
        kind: 'functional',
        status: 'open',
      },
      {
        id: REQUIREMENT2_ID,
        specId: SPEC2_ID,
        acId: 'AC-DRAFT',
        text: 'The draft AC',
        kind: 'functional',
        status: 'open',
      },
    ]);

    const graph = new FakeGraph();
    const degraded = new DegradedRegistry(FIXED_NOW, logger);
    const pack = (stage?: MemoryStage) =>
      buildContextPack(
        { db: harness.db, graph, claims: harness.memory.claims, degraded },
        { projectId: PROJECT_ID, intentId: INTENT_ID, ...(stage === undefined ? {} : { stage }) },
      );

    const build = await pack('build');
    expect(build.text).toContain('AC-DONE');
    expect(build.text).not.toContain('AC-DRAFT');

    const critic = await pack('spec_critic');
    expect(critic.text).toContain('AC-DRAFT');
    expect(critic.text).not.toContain('AC-DONE');

    const intake = await pack('intake');
    expect(intake.text).not.toContain('AC-');

    const current = await pack();
    expect(current.text).toContain('AC-DRAFT');
    expect(current.text).not.toContain('AC-DONE');
  });
});
