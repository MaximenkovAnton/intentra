import { z } from 'zod';
import { IdSchema } from './common.js';

export const FindingClassSchema = z.enum([
  'ambiguous',
  'missing-evidence',
  'contradiction',
  'unprovable',
  'stale-doc',
  'scope',
]);
export type FindingClass = z.infer<typeof FindingClassSchema>;

export const FindingSeveritySchema = z.enum(['blocking', 'nit']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingStatusSchema = z.enum(['open', 'closed', 'carried']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  jobId: IdSchema.nullable(),
  role: z.string(),
  acId: z.string().nullable(),
  class: FindingClassSchema,
  severity: FindingSeveritySchema,
  requirement: z.string(),
  evidence: z.string().nullable(),
  requiredChange: z.string().nullable(),
  status: FindingStatusSchema,
  round: z.number().int().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingListSchema = z.object({
  items: z.array(FindingSchema),
  nextCursor: z.string().nullable(),
});
export type FindingList = z.infer<typeof FindingListSchema>;

export const FindingInputSchema = z.object({
  acId: z.string().min(1).optional(),
  class: FindingClassSchema,
  severity: FindingSeveritySchema,
  requirement: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(4000).optional(),
  requiredChange: z.string().min(1).max(4000).optional(),
});
export type FindingInput = z.infer<typeof FindingInputSchema>;

export const SubmitFindingsInputSchema = z.object({
  role: z.string().min(1).max(100),
  jobId: IdSchema.optional(),
  findings: z.array(FindingInputSchema).min(1),
});
export type SubmitFindingsInput = z.infer<typeof SubmitFindingsInputSchema>;

export const VerdictDecisionSchema = z.enum(['approve', 'changes', 'block']);
export type VerdictDecision = z.infer<typeof VerdictDecisionSchema>;

export const VerdictSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  role: z.string(),
  decision: VerdictDecisionSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  round: z.number().int().min(1),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const SubmitVerdictInputSchema = z.object({
  jobId: IdSchema,
  role: z.string().min(1).max(100),
  decision: VerdictDecisionSchema,
  artifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type SubmitVerdictInput = z.infer<typeof SubmitVerdictInputSchema>;
