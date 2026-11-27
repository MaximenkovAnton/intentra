import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RunnerRow } from '../db/schema.js';
import type { Database } from '../db/client.js';
import { runners } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { hashToken } from './session.js';

interface HeaderSource {
  readonly headers: { readonly authorization?: string | undefined };
}

interface RequestSource extends HeaderSource {
  readonly url?: string | undefined;
}

export function bearerToken(source: HeaderSource): string | null {
  const authorization = source.headers.authorization;
  if (authorization === undefined) return null;
  const [scheme, value] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0 ? value : null;
}

export function tokenFrom(request: RequestSource): string | null {
  const fromHeader = bearerToken(request);
  if (fromHeader !== null) return fromHeader;
  const url = new URL(request.url ?? '/', 'http://runner.invalid');
  const fromQuery = url.searchParams.get('token');
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : null;
}

export async function findRunnerByToken(db: Database, token: string): Promise<RunnerRow | null> {
  const [runner] = await db
    .select()
    .from(runners)
    .where(and(eq(runners.tokenHash, hashToken(token)), isNull(runners.revokedAt)))
    .limit(1);
  return runner ?? null;
}

export function currentRunner(request: FastifyRequest): RunnerRow {
  if (!request.runner) throw new HttpError('AUTH_REQUIRED', 'Unknown or revoked runner token');
  return request.runner;
}

export function createRunnerAuth(
  db: Database,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    const token = bearerToken(request);
    const runner = token === null ? null : await findRunnerByToken(db, token);
    if (runner === null) throw new HttpError('AUTH_REQUIRED', 'Unknown or revoked runner token');
    request.runner = runner;
  };
}
