import { desc, eq } from 'drizzle-orm';
import type { GraphNode } from 'falkordb';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { decisions, memoryClaims } from '../db/schema.js';
import type { DegradedRegistry } from './degraded.js';
import type { Embeddings } from './embeddings.js';
import type { FalkorClient } from './falkordb.js';
import { memoryId } from './id.js';
import type { OutboxStore } from './outbox.js';
import type { MemoryPoint, VectorWriter } from './qdrant.js';
import { truncateBytes } from './text.js';
import {
  GRAPH_KINDS,
  MemoryUnavailableError,
  type EdgeUpsert,
  type GraphNodeKind,
  type GraphNodeView,
  type GraphSnapshotView,
  type GraphWriter,
  type NodeUpsert,
} from './types.js';

export const NODE_LABELS = {
  intent: 'Intent',
  spec: 'Spec',
  ac: 'Requirement',
  decision: 'Decision',
  escalation: 'Escalation',
  episode: 'Episode',
  finding: 'Finding',
  trap: 'Trap',
  capability: 'Capability',
  claim: 'Claim',
  coderef: 'CodeRef',
  project: 'Project',
} as const satisfies Record<GraphNodeKind, string>;

const KIND_BY_LABEL: ReadonlyMap<string, GraphNodeKind> = new Map(
  GRAPH_KINDS.map((kind) => [NODE_LABELS[kind], kind] as const),
);

const LABEL_KEYS = ['title', 'statement', 'answer', 'question', 'text', 'name', 'key'] as const;

const labelOf = (view: GraphNodeView): string => {
  for (const key of LABEL_KEYS) {
    const value = view.props[key];
    if (typeof value === 'string' && value.length > 0) return truncateBytes(value, 120);
  }
  return view.id;
};

const toNodeView = (node: GraphNode): GraphNodeView | null => {
  const id = node.properties.id;
  const projectId = node.properties.projectId;
  const kind = KIND_BY_LABEL.get(node.labels[0] ?? '');
  if (typeof id !== 'string' || typeof projectId !== 'string' || kind === undefined) return null;
  return { id, kind, projectId, props: node.properties };
};

export interface MemoryGraphStoreOptions {
  readonly connect: (onError: (error: unknown) => void) => Promise<FalkorClient>;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly degraded: DegradedRegistry;
  readonly logger: FastifyBaseLogger;
}

export class MemoryGraphStore implements GraphWriter {
  private readonly options: MemoryGraphStoreOptions;
  private client: Promise<FalkorClient> | null = null;
  private generation = 0;

  constructor(options: MemoryGraphStoreOptions) {
    this.options = options;
  }

  private clientOrThrow(): Promise<FalkorClient> {
    if (this.client === null) {
      this.generation += 1;
      const generation = this.generation;
      this.client = this.options
        .connect((error) => this.handleConnectionError(generation, error))
        .then(async (client) => {
          await client.ensureSchema();
          this.options.degraded.markUp('falkordb');
          return client;
        })
        .catch((error: unknown) => {
          if (this.generation === generation) {
            this.client = null;
            this.options.degraded.markDown('falkordb', error);
            this.options.logger.warn(
              { error: error instanceof Error ? error.name : 'unknown' },
              'falkordb connection failed',
            );
          }
          throw new MemoryUnavailableError('falkordb', 'FalkorDB is unavailable');
        });
    }
    return this.client;
  }

  private handleConnectionError(generation: number, error: unknown): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.client = null;
    this.options.degraded.markDown('falkordb', error);
    this.options.logger.warn(
      { error: error instanceof Error ? error.name : 'unknown' },
      'falkordb connection lost',
    );
  }

  private invalidate(): void {
    this.generation += 1;
    this.client = null;
  }

  private async read<T>(operation: (client: FalkorClient) => Promise<T>): Promise<T> {
    try {
      const result = await operation(await this.clientOrThrow());
      this.options.degraded.markUp('falkordb');
      return result;
    } catch (error: unknown) {
      if (error instanceof MemoryUnavailableError) throw error;
      this.invalidate();
      this.options.degraded.markDown('falkordb', error);
      throw new MemoryUnavailableError('falkordb', 'FalkorDB query failed');
    }
  }

  async writeNode(input: NodeUpsert): Promise<void> {
    const client = await this.clientOrThrow();
    await client.upsertNode(NODE_LABELS[input.kind], memoryId(input.projectId, input.kind, input.key), {
      ...input.props,
      kind: input.kind,
      projectId: input.projectId,
      key: input.key,
    });
  }

  async writeEdge(input: EdgeUpsert): Promise<void> {
    const client = await this.clientOrThrow();
    await client.upsertEdge(input.from, input.to, input.relation, input.props ?? {});
  }

  async upsertNode(input: NodeUpsert): Promise<void> {
    try {
      await this.writeNode(input);
      this.options.degraded.markUp('falkordb');
    } catch (error: unknown) {
      this.invalidate();
      this.options.degraded.markDown('falkordb', error);
      await this.options.outbox.enqueue({ type: 'graph.node', node: input });
      this.options.logger.warn(
        { kind: input.kind, key: input.key, error: error instanceof Error ? error.name : 'unknown' },
        'falkordb write queued in outbox',
      );
    }
  }

  async upsertEdge(input: EdgeUpsert): Promise<void> {
    try {
      await this.writeEdge(input);
      this.options.degraded.markUp('falkordb');
    } catch (error: unknown) {
      this.invalidate();
      this.options.degraded.markDown('falkordb', error);
      await this.options.outbox.enqueue({ type: 'graph.edge', edge: input });
      this.options.logger.warn(
        { relation: input.relation, error: error instanceof Error ? error.name : 'unknown' },
        'falkordb edge queued in outbox',
      );
    }
  }

  async readNode(id: string): Promise<GraphNodeView | null> {
    return this.read(async (client) => {
      const rows = await client.query<{ n: GraphNode }>('MATCH (n {id: $id}) RETURN n LIMIT 1', { id });
      const node = rows[0]?.n;
      return node ? toNodeView(node) : null;
    });
  }

  async listByKind(projectId: string, kind: GraphNodeKind, limit: number): Promise<readonly GraphNodeView[]> {
    return this.read(async (client) => {
      const rows = await client.query<{ n: GraphNode }>(
        `MATCH (n:${NODE_LABELS[kind]}) WHERE n.projectId = $projectId RETURN n ORDER BY n.id LIMIT $limit`,
        { projectId, limit },
      );
      return rows.flatMap((row) => {
        const view = toNodeView(row.n);
        return view ? [view] : [];
      });
    });
  }

  async snapshot(projectId: string, limit = 500): Promise<GraphSnapshotView> {
    return this.read(async (client) => {
      const nodeRows = await client.query<{ n: GraphNode }>(
        'MATCH (n) WHERE n.projectId = $projectId RETURN n ORDER BY n.id LIMIT $limit',
        { projectId, limit },
      );
      const edgeRows = await client.query<{ from: unknown; to: unknown; relation: unknown }>(
        `MATCH (a)-[r]->(b) WHERE a.projectId = $projectId AND b.projectId = $projectId
         RETURN a.id AS from, b.id AS to, type(r) AS relation ORDER BY from, to LIMIT $limit`,
        { projectId, limit },
      );
      return {
        nodes: nodeRows.flatMap((row) => {
          const view = toNodeView(row.n);
          return view ? [view] : [];
        }),
        edges: edgeRows.flatMap((row) => {
          if (typeof row.from !== 'string' || typeof row.to !== 'string' || typeof row.relation !== 'string') {
            return [];
          }
          return [{ from: row.from, to: row.to, relation: row.relation }];
        }),
      };
    });
  }

  async textSearch(projectId: string, query: string, limit: number): Promise<readonly GraphNodeView[]> {
    return this.read(async (client) => {
      const rows = await client.query<{ n: GraphNode }>(
        `MATCH (n) WHERE n.projectId = $projectId AND (
           toLower(coalesce(n.title, '')) CONTAINS toLower($query) OR
           toLower(coalesce(n.statement, '')) CONTAINS toLower($query) OR
           toLower(coalesce(n.text, '')) CONTAINS toLower($query) OR
           toLower(coalesce(n.answer, '')) CONTAINS toLower($query) OR
           toLower(coalesce(n.question, '')) CONTAINS toLower($query) OR
           toLower(coalesce(n.name, '')) CONTAINS toLower($query))
         RETURN n ORDER BY n.id LIMIT $limit`,
        { projectId, query, limit },
      );
      return rows.flatMap((row) => {
        const view = toNodeView(row.n);
        return view ? [view] : [];
      });
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.invalidate();
    if (client === null) return;
    try {
      await (await client).close();
    } catch (error: unknown) {
      this.options.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'falkordb close failed',
      );
    }
  }
}

export function toMemoryGraphNode(view: GraphNodeView): { id: string; kind: string; label: string } {
  return { id: view.id, kind: view.kind, label: labelOf(view) };
}

export function toMemoryGraphEdge(view: GraphSnapshotView['edges'][number]): {
  from: string;
  to: string;
  kind: string;
} {
  return { from: view.from, to: view.to, kind: view.relation };
}

export async function postgresGraphSnapshot(db: Database, projectId: string): Promise<GraphSnapshotView> {
  const [decisionRows, claimRows] = await Promise.all([
    db
      .select({ id: decisions.id, answer: decisions.answer, question: decisions.question, status: decisions.status })
      .from(decisions)
      .where(eq(decisions.projectId, projectId))
      .orderBy(desc(decisions.createdAt))
      .limit(100),
    db
      .select({ id: memoryClaims.id, statement: memoryClaims.statement, status: memoryClaims.status })
      .from(memoryClaims)
      .where(eq(memoryClaims.projectId, projectId))
      .orderBy(desc(memoryClaims.updatedAt))
      .limit(100),
  ]);
  const nodes: GraphNodeView[] = [
    ...decisionRows.map((row) => ({
      id: row.id,
      kind: 'decision' as const,
      projectId,
      props: { answer: row.answer, question: row.question, status: row.status },
    })),
    ...claimRows.map((row) => ({
      id: row.id,
      kind: 'claim' as const,
      projectId,
      props: { statement: row.statement, status: row.status },
    })),
  ];
  return { nodes, edges: [] };
}

export interface MemoryRepositoryOptions {
  readonly graph: GraphWriter;
  readonly vectors: VectorWriter;
  readonly embeddings: Embeddings;
  readonly outbox: Pick<OutboxStore, 'enqueue'>;
  readonly degraded: DegradedRegistry;
  readonly logger: FastifyBaseLogger;
  readonly now: () => Date;
}

export interface IntentUpsert {
  readonly projectId: string;
  readonly intentId: string;
  readonly title: string;
  readonly statement: string;
  readonly status: string;
  readonly createdAt?: Date;
}

export interface DecisionUpsert {
  readonly projectId: string;
  readonly decisionId: string;
  readonly intentId?: string;
  readonly question: string;
  readonly answer: string;
  readonly rationale: string | null;
  readonly status: string;
  readonly supersedesId?: string;
}

export interface ClaimUpsert {
  readonly projectId: string;
  readonly claimId: string;
  readonly key: string;
  readonly intentId: string | null;
  readonly statement: string;
  readonly expected: string;
  readonly probe: { readonly type: string; readonly spec: string };
  readonly status: string;
  readonly codeRef: { readonly path: string; readonly symbol?: string; readonly blobSha: string } | null;
  readonly verifiedBy: string | null;
  readonly verifiedAt: Date | null;
  readonly commit: string | null;
  readonly blobSha: string | null;
}

export interface EpisodeUpsert {
  readonly projectId: string;
  readonly episodeId: string;
  readonly intentId: string | null;
  readonly summary: string;
  readonly createdAt?: Date;
}

export interface CapabilityUpsert {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly text: string;
  readonly status: string;
}

export interface TrapUpsert {
  readonly projectId: string;
  readonly key: string;
  readonly text: string;
}

export class MemoryRepository {
  private readonly options: MemoryRepositoryOptions;

  constructor(options: MemoryRepositoryOptions) {
    this.options = options;
  }

  async upsertIntent(input: IntentUpsert): Promise<string> {
    const id = memoryId(input.projectId, 'intent', input.intentId);
    await this.options.graph.upsertNode({
      kind: 'intent',
      projectId: input.projectId,
      key: input.intentId,
      props: { intentId: input.intentId, title: input.title, statement: input.statement, status: input.status },
    });
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'intent',
      status: input.status,
      text: `${input.title}\n${input.statement}`,
      createdAt: (input.createdAt ?? this.options.now()).toISOString(),
    });
    return id;
  }

  async upsertDecision(input: DecisionUpsert): Promise<string> {
    const id = memoryId(input.projectId, 'decision', input.decisionId);
    await this.options.graph.upsertNode({
      kind: 'decision',
      projectId: input.projectId,
      key: input.decisionId,
      props: {
        decisionId: input.decisionId,
        question: input.question,
        answer: input.answer,
        rationale: input.rationale,
        status: input.status,
      },
    });
    if (input.supersedesId !== undefined) {
      await this.options.graph.upsertEdge({
        from: id,
        to: memoryId(input.projectId, 'decision', input.supersedesId),
        relation: 'SUPERSEDES',
      });
    }
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'decision',
      status: input.status,
      text: [input.question, input.answer, input.rationale ?? ''].join('\n'),
      createdAt: this.options.now().toISOString(),
    });
    return id;
  }

  async upsertClaim(input: ClaimUpsert): Promise<string> {
    const id = input.claimId;
    await this.options.graph.upsertNode({
      kind: 'claim',
      projectId: input.projectId,
      key: input.key,
      props: {
        statement: input.statement,
        expected: input.expected,
        probeType: input.probe.type,
        probeSpec: input.probe.spec,
        status: input.status,
        path: input.codeRef?.path ?? null,
        symbol: input.codeRef?.symbol ?? null,
        blobSha: input.blobSha ?? input.codeRef?.blobSha ?? null,
        verifiedBy: input.verifiedBy,
        verifiedAt: input.verifiedAt?.toISOString() ?? null,
        commit: input.commit,
      },
    });
    if (input.codeRef !== null) {
      const codeRefKey = `${input.codeRef.path}#${input.codeRef.symbol ?? ''}@${input.codeRef.blobSha}`;
      const codeRefId = memoryId(input.projectId, 'coderef', codeRefKey);
      await this.options.graph.upsertNode({
        kind: 'coderef',
        projectId: input.projectId,
        key: codeRefKey,
        props: {
          path: input.codeRef.path,
          symbol: input.codeRef.symbol ?? null,
          blobSha: input.codeRef.blobSha,
        },
      });
      await this.options.graph.upsertEdge({ from: id, to: codeRefId, relation: 'ON' });
    }
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'claim',
      status: input.status,
      text: `${input.statement}\n${input.expected}`,
      ...(input.codeRef === null ? {} : { path: input.codeRef.path }),
      createdAt: this.options.now().toISOString(),
    });
    return id;
  }

  async upsertEpisode(input: EpisodeUpsert): Promise<string> {
    const id = memoryId(input.projectId, 'episode', input.episodeId);
    await this.options.graph.upsertNode({
      kind: 'episode',
      projectId: input.projectId,
      key: input.episodeId,
      props: { text: input.summary },
    });
    if (input.intentId !== null) {
      await this.options.graph.upsertEdge({
        from: memoryId(input.projectId, 'intent', input.intentId),
        to: id,
        relation: 'LEARNED',
      });
    }
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'episode',
      status: 'accepted',
      text: input.summary,
      createdAt: (input.createdAt ?? this.options.now()).toISOString(),
    });
    return id;
  }

  async upsertCapability(input: CapabilityUpsert): Promise<string> {
    const id = memoryId(input.projectId, 'capability', input.key);
    await this.options.graph.upsertNode({
      kind: 'capability',
      projectId: input.projectId,
      key: input.key,
      props: { name: input.name, text: input.text, status: input.status },
    });
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'capability',
      status: input.status,
      text: `${input.name}\n${input.text}`,
      createdAt: this.options.now().toISOString(),
    });
    return id;
  }

  async upsertTrap(input: TrapUpsert): Promise<string> {
    const id = memoryId(input.projectId, 'trap', input.key);
    await this.options.graph.upsertNode({
      kind: 'trap',
      projectId: input.projectId,
      key: input.key,
      props: { text: input.text },
    });
    await this.index({
      id,
      projectId: input.projectId,
      nodeId: id,
      kind: 'trap',
      status: 'active',
      text: input.text,
      createdAt: this.options.now().toISOString(),
    });
    return id;
  }

  private async index(point: Omit<MemoryPoint, 'vector'>): Promise<void> {
    try {
      const vectors = await this.options.embeddings.embed([point.text]);
      const vector = vectors[0];
      if (vector === undefined) throw new MemoryUnavailableError('ollama', 'embedding is missing');
      await this.options.vectors.upsert([{ ...point, vector }]);
    } catch (error: unknown) {
      this.options.logger.warn(
        { kind: point.kind, error: error instanceof Error ? error.name : 'unknown' },
        'memory vectorization queued in outbox',
      );
      await this.options.outbox.enqueue({ type: 'qdrant.point', point });
    }
  }
}
