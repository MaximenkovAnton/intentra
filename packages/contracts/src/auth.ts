import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

export const LocaleSchema = z.enum(['ru', 'en']);
export type Locale = z.infer<typeof LocaleSchema>;

export const UserSchema = z.object({
  id: IdSchema,
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  locale: LocaleSchema,
  isAdmin: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

export const MeSchema = UserSchema;
export type Me = z.infer<typeof MeSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  authMethod: z.enum(['oidc', 'dev']),
  expiresAt: IsoDateSchema,
});
export type Session = z.infer<typeof SessionSchema>;

export const LogoutResponseSchema = z.object({
  redirectUrl: z.string().nullable(),
});
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
