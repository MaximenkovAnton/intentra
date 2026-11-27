import { z } from 'zod';

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(200),
  spec: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  paths: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).min(1),
  reviewLens: z.string().min(1),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PlanSchema = z.object({
  tasks: z.array(PlanTaskSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

export const SubmitPlanInputSchema = PlanSchema;
export type SubmitPlanInput = z.infer<typeof SubmitPlanInputSchema>;
