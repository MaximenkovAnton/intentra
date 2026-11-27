import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';
import { DecisionSchema } from './decision.js';
import { EscalationSchema } from './escalation.js';

export const IntentStatusSchema = z.enum([
  'draft',
  'clarifying',
  'specified',
  'critiqued',
  'planned',
  'building',
  'verifying',
  'awaiting_acceptance',
  'accepted',
  'rejected',
  'cancelled',
]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const IntentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string(),
  statement: z.string(),
  status: IntentStatusSchema,
  createdBy: IdSchema,
  createdAt: IsoDateSchema,
  acceptedAt: IsoDateSchema.nullable(),
});
export type Intent = z.infer<typeof IntentSchema>;

export const IntentListSchema = z.object({
  items: z.array(IntentSchema),
  nextCursor: z.string().nullable(),
});
export type IntentList = z.infer<typeof IntentListSchema>;

export const CreateIntentInputSchema = z.object({
  title: z.string().min(1).max(200),
  statement: z.string().min(1).max(20_000),
});
export type CreateIntentInput = z.infer<typeof CreateIntentInputSchema>;

export const IntentMessageSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  role: z.enum(['user', 'assistant']),
  body: z.string(),
  createdAt: IsoDateSchema,
});
export type IntentMessage = z.infer<typeof IntentMessageSchema>;

export const IntentMessageListSchema = z.object({
  items: z.array(IntentMessageSchema),
  nextCursor: z.string().nullable(),
});
export type IntentMessageList = z.infer<typeof IntentMessageListSchema>;

export const PostIntentMessageInputSchema = z.object({
  body: z.string().min(1).max(20_000),
});
export type PostIntentMessageInput = z.infer<typeof PostIntentMessageInputSchema>;

export const AnswerIntentInputSchema = z.object({
  escalationId: IdSchema,
  optionId: z.string().min(1),
  note: z.string().max(2000).optional(),
});
export type AnswerIntentInput = z.infer<typeof AnswerIntentInputSchema>;

export const ReworkIntentInputSchema = z.object({
  reason: z.string().min(1).max(2000),
  target: z.enum(['build', 'plan']).default('build'),
});
export type ReworkIntentInput = z.infer<typeof ReworkIntentInputSchema>;

export const IntentCardSchema = z.object({
  objective: z.string().min(1).max(4000),
  users: z.array(z.string().min(1).max(1000)).min(1),
  jobs: z.array(z.string().min(1).max(1000)).min(1),
  inScope: z.array(z.string().min(1).max(1000)).min(1),
  outOfScope: z.array(z.string().min(1).max(1000)).min(1),
  constraints: z.array(z.string().min(1).max(1000)),
  successSignals: z.array(z.string().min(1).max(1000)).min(1),
  assumptions: z.array(z.string().min(1).max(1000)),
  risks: z.array(z.string().min(1).max(1000)),
  openQuestions: z.array(z.string().min(1).max(1000)),
});
export type IntentCard = z.infer<typeof IntentCardSchema>;

export const SubmitIntentCardInputSchema = IntentCardSchema;
export type SubmitIntentCardInput = z.infer<typeof SubmitIntentCardInputSchema>;

export const IntentDetailSchema = z.object({
  intent: IntentSchema,
  card: IntentCardSchema.nullable(),
  openEscalations: z.array(EscalationSchema),
});
export type IntentDetail = z.infer<typeof IntentDetailSchema>;

export const IntentAnswerResultSchema = z.object({
  escalation: EscalationSchema,
  decision: DecisionSchema,
});
export type IntentAnswerResult = z.infer<typeof IntentAnswerResultSchema>;
