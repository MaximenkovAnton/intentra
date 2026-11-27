import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const EventTypeSchema = z.enum([
  'intent.updated',
  'stage.updated',
  'job.updated',
  'escalation.created',
  'escalation.answered',
  'finding.created',
  'runner.updated',
  'memory.updated',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const SseEventSchema = z.object({
  id: z.string().min(1),
  type: EventTypeSchema,
  projectId: IdSchema,
  at: IsoDateSchema,
  data: z.record(z.string(), z.unknown()).optional(),
});
export type SseEvent = z.infer<typeof SseEventSchema>;

export const SseQuerySchema = z.object({
  project: z.string().optional(),
  lastEventId: z.string().optional(),
});
export type SseQuery = z.infer<typeof SseQuerySchema>;
