import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const DecisionStatusSchema = z.enum(['accepted', 'provisional', 'superseded']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  intentId: IdSchema.nullable(),
  question: z.string(),
  answer: z.string(),
  rationale: z.string().nullable(),
  alternatives: z.array(z.string()),
  status: DecisionStatusSchema,
  supersedesId: IdSchema.nullable(),
  authorKind: z.string(),
  authorId: z.string(),
  evidence: z.string().nullable(),
  createdAt: IsoDateSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DecisionListSchema = z.object({
  items: z.array(DecisionSchema),
  nextCursor: z.string().nullable(),
});
export type DecisionList = z.infer<typeof DecisionListSchema>;
