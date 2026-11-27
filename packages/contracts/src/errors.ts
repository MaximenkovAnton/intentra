import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'VALIDATION',
  'CONFLICT',
  'NOT_FOUND',
  'LIMIT',
  'RUNNER_OFFLINE',
  'ESCALATION_EXPIRED',
  'UPSTREAM_FAILED',
  'RELEASE_DISABLED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ERROR_HTTP_STATUS = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  LIMIT: 429,
  RUNNER_OFFLINE: 503,
  ESCALATION_EXPIRED: 410,
  UPSTREAM_FAILED: 502,
  RELEASE_DISABLED: 503,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;
