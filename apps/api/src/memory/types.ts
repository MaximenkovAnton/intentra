export const GRAPH_KINDS = [
  'intent',
  'spec',
  'ac',
  'decision',
  'escalation',
  'episode',
  'finding',
  'trap',
  'capability',
  'claim',
  'coderef',
  'project',
] as const;

export type GraphNodeKind = (typeof GRAPH_KINDS)[number];

export type MemoryService = 'falkordb' | 'qdrant' | 'ollama';

export class MemoryUnavailableError extends Error {
  override readonly name = 'MemoryUnavailableError';
  readonly service: MemoryService;

  constructor(service: MemoryService, message: string) {
    super(message);
    this.service = service;
  }
}

export type GraphParam =
  | string
  | number
  | boolean
  | null
  | GraphParam[]
  | { [key: string]: GraphParam };

export const MEMORY_RELATIONS = [
  'HAS_SPEC',
  'REQUIRES',
  'SUPERSEDES',
  'ASSERTS',
  'PROVEN_BY',
  'REALIZES',
  'LEARNED',
  'COVERED_BY',
  'ON',
  'TOUCHED',
  'MENTIONS',
  'DEPENDS_ON',
  'ACCEPTED_BY',
  'PRODUCED',
] as const;

export type MemoryRelation = (typeof MEMORY_RELATIONS)[number];

export interface NodeUpsert {
  readonly kind: GraphNodeKind;
  readonly projectId: string;
  readonly key: string;
  readonly props: Readonly<Record<string, GraphParam>>;
}

export interface EdgeUpsert {
  readonly from: string;
  readonly to: string;
  readonly relation: MemoryRelation;
  readonly props?: Readonly<Record<string, GraphParam>>;
}

export interface GraphNodeView {
  readonly id: string;
  readonly kind: GraphNodeKind;
  readonly projectId: string;
  readonly props: Readonly<Record<string, unknown>>;
}

export interface GraphEdgeView {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
}

export interface GraphSnapshotView {
  readonly nodes: readonly GraphNodeView[];
  readonly edges: readonly GraphEdgeView[];
}

export interface GraphWriter {
  upsertNode(input: NodeUpsert): Promise<void>;
  upsertEdge(input: EdgeUpsert): Promise<void>;
  readNode(id: string): Promise<GraphNodeView | null>;
  listByKind(projectId: string, kind: GraphNodeKind, limit: number): Promise<readonly GraphNodeView[]>;
  snapshot(projectId: string, limit?: number): Promise<GraphSnapshotView>;
  textSearch(projectId: string, query: string, limit: number): Promise<readonly GraphNodeView[]>;
}
