import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const MemoryNodeKindSchema = z.enum([
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
]);
export type MemoryNodeKind = z.infer<typeof MemoryNodeKindSchema>;

export const MemorySearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  kind: MemoryNodeKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type MemorySearchQuery = z.infer<typeof MemorySearchQuerySchema>;

export const MemoryHitSchema = z.object({
  id: z.string(),
  kind: z.string(),
  text: z.string(),
  score: z.number(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MemoryHit = z.infer<typeof MemoryHitSchema>;

export const MemorySearchResultSchema = z.object({
  items: z.array(MemoryHitSchema),
  degraded: z.boolean().optional(),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

export const MemoryGraphNodeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
});
export type MemoryGraphNode = z.infer<typeof MemoryGraphNodeSchema>;

export const MemoryGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string(),
});
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;

export const MemoryGraphSchema = z.object({
  nodes: z.array(MemoryGraphNodeSchema),
  edges: z.array(MemoryGraphEdgeSchema),
  updatedAt: IsoDateSchema,
  degraded: z.boolean().optional(),
});
export type MemoryGraph = z.infer<typeof MemoryGraphSchema>;

export const MemoryProbeTypeSchema = z.enum(['test', 'command', 'grep', 'file-exists']);
export type MemoryProbeType = z.infer<typeof MemoryProbeTypeSchema>;

export const MemoryProbeSchema = z.object({
  type: MemoryProbeTypeSchema,
  spec: z.string().min(1).max(2000),
});
export type MemoryProbe = z.infer<typeof MemoryProbeSchema>;

export const MemoryCodeRefSchema = z.object({
  path: z.string().min(1).max(1000),
  symbol: z.string().min(1).max(500).optional(),
  blobSha: z.string().min(1).max(200),
});
export type MemoryCodeRef = z.infer<typeof MemoryCodeRefSchema>;

export const ClaimStatusSchema = z.enum(['unverified', 'fresh', 'stale', 'contradicted']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const ClaimSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  intentId: IdSchema.nullable(),
  key: z.string(),
  statement: z.string(),
  probe: MemoryProbeSchema,
  expected: z.string(),
  status: ClaimStatusSchema,
  codeRef: MemoryCodeRefSchema.nullable(),
  verifiedBy: z.string().nullable(),
  verifiedAt: IsoDateSchema.nullable(),
  commit: z.string().nullable(),
  blobSha: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Claim = z.infer<typeof ClaimSchema>;

export const CreateClaimInputSchema = z.object({
  projectId: IdSchema,
  intentId: IdSchema.optional(),
  key: z.string().min(1).max(200),
  statement: z.string().min(1).max(8000),
  probe: MemoryProbeSchema,
  expected: z.string().min(1).max(2000),
  codeRef: MemoryCodeRefSchema.optional(),
});
export type CreateClaimInput = z.infer<typeof CreateClaimInputSchema>;

export const ValidateClaimInputSchema = z.object({
  projectId: IdSchema,
  outcome: z.enum(['passed', 'failed', 'stale']),
  verifiedBy: z.string().min(1).max(200),
  commit: z.string().min(1).max(200),
  blobSha: z.string().min(1).max(200).optional(),
  verifiedAt: IsoDateSchema.optional(),
});
export type ValidateClaimInput = z.infer<typeof ValidateClaimInputSchema>;

export const ClaimListSchema = z.object({
  items: z.array(ClaimSchema),
});
export type ClaimList = z.infer<typeof ClaimListSchema>;

export const MemoryStageSchema = z.enum([
  'intake',
  'spec',
  'spec_critic',
  'plan',
  'build',
  'review',
  'verify',
  'accept',
]);
export type MemoryStage = z.infer<typeof MemoryStageSchema>;

export const ContextPackQuerySchema = z.object({
  projectId: IdSchema,
  intentId: IdSchema.optional(),
  stage: MemoryStageSchema.optional(),
});
export type ContextPackQuery = z.infer<typeof ContextPackQuerySchema>;

export const ContextPackSchema = z.object({
  text: z.string(),
  bytes: z.number().int().min(0),
  degraded: z.boolean(),
  version: z.literal(1),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export const MemoryRecordSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  intentId: IdSchema.nullable(),
  kind: z.string(),
  contentSha256: z.string(),
  updatedAt: IsoDateSchema,
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
