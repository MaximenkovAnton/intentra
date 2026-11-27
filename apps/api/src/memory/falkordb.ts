import { FalkorDB } from 'falkordb';
import type { Graph, QueryParams } from 'falkordb';
import type { GraphParam, MemoryRelation } from './types.js';

export type GraphRow = Record<string, unknown>;

export interface IndexSpec {
  readonly label: string;
  readonly properties: readonly string[];
}

export const GRAPH_INDEXES: readonly IndexSpec[] = [
  { label: 'Project', properties: ['id'] },
  { label: 'Intent', properties: ['projectId', 'status'] },
  { label: 'Spec', properties: ['intentId'] },
  { label: 'Decision', properties: ['projectId', 'status'] },
  { label: 'Claim', properties: ['projectId', 'status'] },
  { label: 'Claim', properties: ['id'] },
  { label: 'CodeRef', properties: ['path'] },
  { label: 'CodeRef', properties: ['blobSha'] },
  { label: 'Episode', properties: ['projectId'] },
  { label: 'Task', properties: ['projectId'] },
];

export interface FalkorConnectOptions {
  readonly url: string;
  readonly graphName: string;
  readonly connectTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

export class FalkorClient {
  private readonly db: FalkorDB;
  private readonly graph: Graph;
  private readonly queryTimeoutMs: number;

  private constructor(db: FalkorDB, graph: Graph, queryTimeoutMs: number) {
    this.db = db;
    this.graph = graph;
    this.queryTimeoutMs = queryTimeoutMs;
  }

  static async connect(options: FalkorConnectOptions): Promise<FalkorClient> {
    const url = new URL(options.url);
    const db = await FalkorDB.connect({
      socket: {
        host: url.hostname,
        port: url.port ? Number(url.port) : 6379,
        connectTimeout: options.connectTimeoutMs ?? 5_000,
        reconnectStrategy: false,
        ...(url.protocol === 'rediss:' ? { tls: true } : {}),
      },
      ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    });
    db.on('error', (error: unknown) => {
      options.onError?.(error);
    });
    return new FalkorClient(db, db.selectGraph(options.graphName), options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
  }

  async ensureSchema(): Promise<void> {
    await this.query('RETURN 1 AS ok');
    const covered = new Map<string, Set<string>>();
    for (const index of await this.listIndexes()) {
      const properties = covered.get(index.label) ?? new Set<string>();
      for (const property of index.properties) properties.add(property);
      covered.set(index.label, properties);
    }
    for (const spec of GRAPH_INDEXES) {
      const properties = covered.get(spec.label) ?? new Set<string>();
      if (spec.properties.every((property) => properties.has(property))) continue;
      await this.graph.createNodeRangeIndex(spec.label, ...spec.properties);
      for (const property of spec.properties) properties.add(property);
      covered.set(spec.label, properties);
    }
  }

  async listIndexes(): Promise<readonly IndexSpec[]> {
    const indexes = await this.graph.listIndices();
    return indexes.map((index) => ({ label: index.label, properties: index.properties }));
  }

  async upsertNode(label: string, id: string, props: Readonly<Record<string, GraphParam>>): Promise<void> {
    await this.query(`MERGE (n:${label} {id: $id}) SET n += $props`, { id, props });
  }

  async upsertEdge(
    from: string,
    to: string,
    relation: MemoryRelation,
    props: Readonly<Record<string, GraphParam>> = {},
  ): Promise<void> {
    await this.query(`MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${relation}]->(b) SET r += $props`, {
      from,
      to,
      props,
    });
  }

  async query<T = GraphRow>(cypher: string, params?: QueryParams): Promise<readonly T[]> {
    const reply = await this.graph.query<T>(cypher, {
      TIMEOUT: this.queryTimeoutMs,
      ...(params === undefined ? {} : { params }),
    });
    return reply.data ?? [];
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
