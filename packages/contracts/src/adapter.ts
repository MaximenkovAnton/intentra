import { z } from 'zod';
import { IdSchema } from './common.js';

export const AdapterRequestSchema = z.object({
  jobId: IdSchema,
  intentId: IdSchema,
  stage: z.string(),
  workspacePath: z.string(),
  prompt: z.string(),
  timeoutSeconds: z.number().int().min(1).max(86_400).default(3600),
});
export type AdapterRequest = z.infer<typeof AdapterRequestSchema>;

export const AdapterEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('artifact'), kind: z.string(), uri: z.string() }),
  z.object({ type: z.literal('finding'), text: z.string() }),
  z.object({ type: z.literal('done'), ok: z.boolean() }),
]);
export type AdapterEvent = z.infer<typeof AdapterEventSchema>;

export const AdapterRunResultSchema = z.object({
  ok: z.boolean(),
  events: z.array(AdapterEventSchema),
  diffSummary: z
    .object({
      files: z.number().int().min(0),
      additions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    })
    .optional(),
});
export type AdapterRunResult = z.infer<typeof AdapterRunResultSchema>;

export const AgentAdapterDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['dsh', 'cli', 'mock']),
});
export type AgentAdapterDescriptor = z.infer<typeof AgentAdapterDescriptorSchema>;
