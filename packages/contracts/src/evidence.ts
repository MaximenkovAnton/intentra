import { z } from 'zod';
import { DecisionSchema } from './decision.js';
import { FindingClassSchema, FindingSchema, VerdictSchema } from './finding.js';
import { JobSchema, StageSchema } from './job.js';
import { GateStatusSchema } from './verify.js';

export const IntentMetricsSchema = z.object({
  durationMs: z.number().int().min(0).nullable(),
  humanWaitMs: z.number().int().min(0),
  attempts: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  findingsByClass: z.record(FindingClassSchema, z.number().int().min(0)),
  gates: z.object({
    pass: z.number().int().min(0),
    fail: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
});
export type IntentMetrics = z.infer<typeof IntentMetricsSchema>;

export const EvidenceSchema = z.object({
  decisions: z.array(DecisionSchema),
  findings: z.array(FindingSchema),
  verdicts: z.array(VerdictSchema),
  stages: z.array(StageSchema),
  jobs: z.array(JobSchema),
  gates: z.array(GateStatusSchema),
  metrics: IntentMetricsSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;
