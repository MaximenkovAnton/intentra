import { z } from 'zod';
import { IdSchema, IsoDateSchema, ProjectKeySchema } from './common.js';
import { RunnerLastUpdateSchema, SemVerSchema } from './release.js';

export const RunnerStatusSchema = z.enum(['online', 'offline', 'revoked']);
export type RunnerStatus = z.infer<typeof RunnerStatusSchema>;

export const RunnerSchema = z.object({
  id: IdSchema,
  name: z.string(),
  ownerUserId: IdSchema,
  os: z.string(),
  arch: z.string(),
  version: z.string(),
  capabilities: z.array(z.string()),
  status: RunnerStatusSchema,
  lastSeenAt: IsoDateSchema.nullable(),
  revokedAt: IsoDateSchema.nullable(),
  pinnedVersion: SemVerSchema.nullable(),
  autoUpdate: z.boolean(),
  latestVersion: SemVerSchema.nullable(),
  updateAvailable: z.boolean(),
  lastUpdate: RunnerLastUpdateSchema.nullable(),
});
export type Runner = z.infer<typeof RunnerSchema>;

export const RunnerListSchema = z.object({
  items: z.array(RunnerSchema),
  nextCursor: z.string().nullable(),
});
export type RunnerList = z.infer<typeof RunnerListSchema>;

export const CreateRegistrationTokenInputSchema = z.object({
  projectKey: ProjectKeySchema,
});
export type CreateRegistrationTokenInput = z.infer<typeof CreateRegistrationTokenInputSchema>;

export const RegistrationTokenSchema = z.object({
  token: z.string(),
  expiresAt: IsoDateSchema,
});
export type RegistrationToken = z.infer<typeof RegistrationTokenSchema>;

export const RegisterRunnerInputSchema = z.object({
  registrationToken: z.string().min(1),
  name: z.string().min(1).max(120),
  os: z.string().min(1).max(40),
  arch: z.string().min(1).max(40),
  version: z.string().min(1).max(40),
  capabilities: z.array(z.string().max(60)).max(50).default([]),
});
export type RegisterRunnerInput = z.infer<typeof RegisterRunnerInputSchema>;

export const RegisterRunnerResponseSchema = z.object({
  runnerId: IdSchema,
  token: z.string(),
});
export type RegisterRunnerResponse = z.infer<typeof RegisterRunnerResponseSchema>;

export const RotateRunnerTokenResponseSchema = z.object({
  token: z.string(),
});
export type RotateRunnerTokenResponse = z.infer<typeof RotateRunnerTokenResponseSchema>;

export const AdapterDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type AdapterDescriptor = z.infer<typeof AdapterDescriptorSchema>;
