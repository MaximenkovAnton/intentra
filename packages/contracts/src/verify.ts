import { z } from 'zod';

export const GateStatusSchema = z.object({
  criterion: z.string().min(1).max(100),
  status: z.enum(['pass', 'fail', 'skipped']),
  durationMs: z.number().int().min(0).max(86_400_000),
  exitCode: z.number().int().optional(),
  outputSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const ClaimCheckSchema = z.object({
  statement: z.string().min(1).max(2000),
  status: z.enum(['fresh', 'stale', 'contradicted', 'unverified']),
  path: z.string().max(500).optional(),
  symbol: z.string().max(300).optional(),
  blobSha: z.string().max(200).optional(),
});
export type ClaimCheck = z.infer<typeof ClaimCheckSchema>;

export const VerifyReportSchema = z.object({
  gates: z.array(GateStatusSchema).max(50),
  claims: z.array(ClaimCheckSchema).max(100).default([]),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;
