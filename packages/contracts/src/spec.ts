import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { FindingSchema, VerdictDecisionSchema } from './finding.js';

export const SpecStatusSchema = z.enum(['draft', 'in_review', 'approved', 'superseded']);
export type SpecStatus = z.infer<typeof SpecStatusSchema>;

export const SpecSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  version: z.number().int().min(1),
  bodyMd: z.string(),
  status: SpecStatusSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: IsoDateSchema,
});
export type Spec = z.infer<typeof SpecSchema>;

export const RequirementKindSchema = z.enum(['functional', 'nonfunctional']);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const RequirementSchema = z.object({
  id: IdSchema,
  specId: IdSchema,
  acId: z.string().min(1),
  text: z.string(),
  kind: RequirementKindSchema,
  status: z.enum(['open', 'met', 'waived']),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const DodRowSchema = z.object({
  id: IdSchema,
  requirementId: IdSchema,
  testRef: z.string().nullable(),
  probe: z.string().nullable(),
  status: z.enum(['pending', 'pass', 'fail']),
});
export type DodRow = z.infer<typeof DodRowSchema>;

export const SpecBundleSchema = z.object({
  spec: SpecSchema,
  requirements: z.array(RequirementSchema),
  dodRows: z.array(DodRowSchema),
});
export type SpecBundle = z.infer<typeof SpecBundleSchema>;

export const SubmitSpecInputSchema = z.object({
  bodyMd: z.string().min(1).max(200_000),
});
export type SubmitSpecInput = z.infer<typeof SubmitSpecInputSchema>;

export const SpecSubmissionSchema = z.object({
  spec: SpecSchema,
  requirements: z.array(RequirementSchema),
  dodRows: z.array(DodRowSchema),
  findings: z.array(FindingSchema),
  verdict: VerdictDecisionSchema,
});
export type SpecSubmission = z.infer<typeof SpecSubmissionSchema>;
