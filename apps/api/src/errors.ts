import { ZodError } from 'zod';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorSchema, ERROR_HTTP_STATUS, type ErrorCode } from '@intentra/contracts';

export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const statusFor = (code: ErrorCode): number => ERROR_HTTP_STATUS[code];

const isFastifyValidation = (error: FastifyError): boolean =>
  error.validation !== undefined || error.code === 'FST_ERR_VALIDATION';

const postgresCode = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;

const causeOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined;

export function pgCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth += 1) {
    const code = postgresCode(current);
    if (typeof code === 'string') return code;
    current = causeOf(current);
  }
  return undefined;
}

export function isPgUniqueViolation(error: unknown): boolean {
  return pgCodeOf(error) === '23505';
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | HttpError | ZodError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      return reply.status(statusFor(error.code)).send(
        ApiErrorSchema.parse({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
    }
    if (error instanceof ZodError) {
      return reply.status(400).send(
        ApiErrorSchema.parse({
          code: 'VALIDATION',
          message: 'Validation failed',
          details: error.issues,
        }),
      );
    }
    if (isFastifyValidation(error)) {
      return reply.status(400).send(
        ApiErrorSchema.parse({
          code: 'VALIDATION',
          message: 'Validation failed',
          details: error.validation,
        }),
      );
    }
    const dbCode = pgCodeOf(error);
    request.log.error(
      dbCode === undefined
        ? { name: error.name, message: error.message }
        : { name: error.name, pgCode: dbCode },
      'unhandled request error',
    );
    return reply.status(500).send(ApiErrorSchema.parse({ code: 'INTERNAL', message: 'Internal server error' }));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send(ApiErrorSchema.parse({ code: 'NOT_FOUND', message: `Route ${request.url} not found` })),
  );
}
