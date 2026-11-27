import { z } from 'zod';

export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

export const IsoDateSchema = z.string().datetime();
export type IsoDate = z.infer<typeof IsoDateSchema>;

export const ProjectKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase slug, 2-32 chars');
export type ProjectKey = z.infer<typeof ProjectKeySchema>;

export const CursorSchema = z.string().min(1).max(200).optional();
export const LimitSchema = z.coerce.number().int().min(1).max(50).default(50);
