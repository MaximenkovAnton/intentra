import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { AdapterDescriptorSchema } from './runner.js';
import { FindingInputSchema, VerdictDecisionSchema } from './finding.js';
import { CreateEscalationInputSchema } from './escalation.js';

export const PROTOCOL_VERSION = 1;

export const RunnerSeqSchema = z.number().int().min(1);

const usageSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});

export const RunnerHelloSchema = z.object({
  type: z.literal('hello'),
  seq: RunnerSeqSchema.optional(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runnerVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  adapters: z.array(AdapterDescriptorSchema),
  workspaces: z.array(z.string()),
});
export type RunnerHello = z.infer<typeof RunnerHelloSchema>;

export const RunnerHeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  seq: RunnerSeqSchema.optional(),
  activeJobs: z.number().int().min(0),
  lastSeenAt: IsoDateSchema,
});
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeatSchema>;

export const JobOfferSchema = z.object({
  type: z.literal('job.offer'),
  jobId: IdSchema,
  intentId: IdSchema,
  stage: z.string(),
  runtime: z.string(),
  payload: z.record(z.string(), z.unknown()),
  leaseUntil: IsoDateSchema,
});
export type JobOffer = z.infer<typeof JobOfferSchema>;

export const JobAcceptedSchema = z.object({
  type: z.literal('job.accept'),
  seq: RunnerSeqSchema.optional(),
  jobId: IdSchema,
});
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;

export const JobDeclinedSchema = z.object({
  type: z.literal('job.declined'),
  seq: RunnerSeqSchema.optional(),
  jobId: IdSchema,
  reason: z.string().max(4000),
});
export type JobDeclined = z.infer<typeof JobDeclinedSchema>;

export const JobHeartbeatSchema = z.object({
  type: z.literal('job.heartbeat'),
  seq: RunnerSeqSchema.optional(),
  jobId: IdSchema,
});
export type JobHeartbeat = z.infer<typeof JobHeartbeatSchema>;

export const JobResultStatusSchema = z.enum(['succeeded', 'failed', 'cancelled']);
export type JobResultStatus = z.infer<typeof JobResultStatusSchema>;

export const JobStatusMessageSchema = z.object({
  type: z.literal('job.status'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  detail: z.string().max(4000).optional(),
  usage: usageSchema.optional(),
});
export type JobStatusMessage = z.infer<typeof JobStatusMessageSchema>;

export const JobEventSchema = z.object({
  type: z.literal('job.event'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('tool'), name: z.string().min(1).max(200), status: z.enum(['started', 'finished']) }),
    z.object({ type: z.literal('usage'), inputTokens: z.number().int().min(0).optional(), outputTokens: z.number().int().min(0).optional() }),
  ]),
});
export type JobEventMessage = z.infer<typeof JobEventSchema>;

export const JobFindingsSchema = z.object({
  type: z.literal('job.findings'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  role: z.string().min(1).max(100),
  findings: z.array(FindingInputSchema).min(1).max(100),
});
export type JobFindingsMessage = z.infer<typeof JobFindingsSchema>;

export const JobVerdictSchema = z.object({
  type: z.literal('job.verdict'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  role: z.string().min(1).max(100),
  decision: VerdictDecisionSchema,
  artifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type JobVerdictMessage = z.infer<typeof JobVerdictSchema>;

export const JobSpecSchema = z.object({
  type: z.literal('job.spec'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  bodyMd: z.string().min(1).max(24 * 1024),
});
export type JobSpecMessage = z.infer<typeof JobSpecSchema>;

export const DiffFileSchema = z.object({
  path: z.string().min(1).max(500),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const JobDiffSummarySchema = z.object({
  type: z.literal('job.diff_summary'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  files: z.array(DiffFileSchema).max(500),
});
export type JobDiffSummaryMessage = z.infer<typeof JobDiffSummarySchema>;

export const JobLinkSchema = z.object({
  type: z.literal('job.link'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  branch: z.string().min(1).max(200).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{7,64}$/)
    .optional(),
  prUrl: z.string().url().max(1000).optional(),
});
export type JobLinkMessage = z.infer<typeof JobLinkSchema>;

export const JobQuestionSchema = z.object({
  type: z.literal('job.question'),
  seq: RunnerSeqSchema,
  jobId: IdSchema,
  question: CreateEscalationInputSchema,
});
export type JobQuestionMessage = z.infer<typeof JobQuestionSchema>;

export const JobResultSchema = z.object({
  type: z.literal('job.result'),
  seq: RunnerSeqSchema.optional(),
  jobId: IdSchema,
  status: JobResultStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobCancelSchema = z.object({
  type: z.literal('job.cancel'),
  jobId: IdSchema,
  reason: z.string().optional(),
});
export type JobCancel = z.infer<typeof JobCancelSchema>;

export const JobAnswerSchema = z.object({
  type: z.literal('job.answer'),
  jobId: IdSchema,
  answer: z.union([
    z.object({
      escalationId: IdSchema,
      optionId: z.string().min(1).max(200),
      label: z.string().min(1).max(2000),
    }),
    z.object({ cancelled: z.literal(true) }),
  ]),
});
export type JobAnswer = z.infer<typeof JobAnswerSchema>;

export const RunnerToCenterMessageSchema = z.discriminatedUnion('type', [
  RunnerHelloSchema,
  RunnerHeartbeatSchema,
  JobAcceptedSchema,
  JobDeclinedSchema,
  JobHeartbeatSchema,
  JobStatusMessageSchema,
  JobEventSchema,
  JobFindingsSchema,
  JobVerdictSchema,
  JobSpecSchema,
  JobDiffSummarySchema,
  JobLinkSchema,
  JobQuestionSchema,
  JobResultSchema,
]);
export type RunnerToCenterMessage = z.infer<typeof RunnerToCenterMessageSchema>;

export const CenterToRunnerMessageSchema = z.discriminatedUnion('type', [
  JobOfferSchema,
  JobCancelSchema,
  JobAnswerSchema,
]);
export type CenterToRunnerMessage = z.infer<typeof CenterToRunnerMessageSchema>;
