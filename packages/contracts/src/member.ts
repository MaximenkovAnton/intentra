import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const ProjectRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const MemberSchema = z.object({
  userId: IdSchema,
  email: z.string().email(),
  name: z.string(),
  role: ProjectRoleSchema,
  createdAt: IsoDateSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const AddMemberInputSchema = z.object({
  email: z.string().email(),
  role: ProjectRoleSchema,
});
export type AddMemberInput = z.infer<typeof AddMemberInputSchema>;

export const MemberListSchema = z.object({
  items: z.array(MemberSchema),
  nextCursor: z.string().nullable(),
});
export type MemberList = z.infer<typeof MemberListSchema>;
