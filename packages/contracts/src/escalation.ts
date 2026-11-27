import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const EscalationStatusSchema = z.enum(['open', 'answered', 'expired', 'cancelled']);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const EscalationTriggerSchema = z.enum(['E1', 'E2', 'E3', 'E4', 'E5']);
export type EscalationTrigger = z.infer<typeof EscalationTriggerSchema>;

export const EscalationOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  meaning: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  cost: z.string().min(1).optional(),
  risk: z.string().min(1).optional(),
  reversible: z.boolean().optional(),
});
export type EscalationOption = z.infer<typeof EscalationOptionSchema>;

export const EscalationSchema = z.object({
  id: IdSchema,
  intentId: IdSchema,
  stage: z.string(),
  question: z.string(),
  context: z.string(),
  options: z.array(EscalationOptionSchema).min(2).max(4),
  recommendation: z.string().nullable(),
  defaultOption: z.string().min(1),
  expiresAt: IsoDateSchema.nullable(),
  status: EscalationStatusSchema,
  answerOption: z.string().nullable(),
  answerNote: z.string().nullable(),
  answeredBy: IdSchema.nullable(),
  answeredAt: IsoDateSchema.nullable(),
  decisionId: IdSchema.nullable(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const CreateEscalationInputSchema = z.object({
  stage: z.string().min(1).max(100),
  question: z.string().min(1).max(2000),
  context: z.string().min(1).max(4000),
  trigger: EscalationTriggerSchema,
  options: z.array(EscalationOptionSchema).min(2).max(4),
  recommendation: z.string().min(1).max(2000).optional(),
  defaultOption: z.string().min(1),
});
export type CreateEscalationInput = z.infer<typeof CreateEscalationInputSchema>;

export const AnswerEscalationInputSchema = z.object({
  optionId: z.string().min(1),
  note: z.string().max(2000).optional(),
});
export type AnswerEscalationInput = z.infer<typeof AnswerEscalationInputSchema>;
