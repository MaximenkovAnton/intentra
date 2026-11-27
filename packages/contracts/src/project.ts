import { z } from 'zod';
import { IdSchema, IsoDateSchema, ProjectKeySchema } from './common.js';

export const ProjectSchema = z.object({
  id: IdSchema,
  key: ProjectKeySchema,
  name: z.string(),
  description: z.string().nullable(),
  repoUrl: z.string().nullable(),
  defaultBranch: z.string(),
  createdBy: IdSchema,
  createdAt: IsoDateSchema,
  archivedAt: IsoDateSchema.nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  repoUrl: z.string().max(500).nullable().optional(),
  defaultBranch: z.string().min(1).max(120).default('main'),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    repoUrl: z.string().max(500).nullable().optional(),
    defaultBranch: z.string().min(1).max(120).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const ProjectListSchema = z.object({
  items: z.array(ProjectSchema),
  nextCursor: z.string().nullable(),
});
export type ProjectList = z.infer<typeof ProjectListSchema>;
