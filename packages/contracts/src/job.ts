import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const JobStatusSchema = z.enum([
  'queued',
  'offered',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const StageKindSchema = z.enum([
  'intake',
  'spec',
  'spec_critic',
  'plan',
  'build',
  'review',
  'verify',
  'accept',
]);
export type StageKind = z.infer<typeof StageKindSchema>;

export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const JobLimitsSchema = z.object({
  timeoutSeconds: z.number().int().min(1).max(86_400).default(3600),
});
export type JobLimits = z.infer<typeof JobLimitsSchema>;

export const JobPayloadSchema = z.object({
  kind: StageKindSchema,
  prompt: z.string().min(1),
  context: z.string().default(''),
  limits: JobLimitsSchema.default({ timeoutSeconds: 3600 }),
  taskId: z.string().min(1).max(64).optional(),
  dependsOn: z.array(z.string().min(1).max(64)).default([]),
  gateCriteria: z.array(z.string().min(1).max(100)).default([]),
});
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export const StageSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  kind: StageKindSchema,
  status: StageStatusSchema,
  attempt: z.number().int().min(0),
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
  error: z.string().nullable(),
});
export type Stage = z.infer<typeof StageSchema>;

export const JobSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  stageId: IdSchema.nullable(),
  runnerId: IdSchema.nullable(),
  runtime: z.string(),
  status: JobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  leaseUntil: IsoDateSchema.nullable(),
  attempt: z.number().int().min(0),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.nullable(),
  finishedAt: IsoDateSchema.nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const JobListSchema = z.object({
  items: z.array(JobSchema),
  nextCursor: z.string().nullable(),
});
export type JobList = z.infer<typeof JobListSchema>;
