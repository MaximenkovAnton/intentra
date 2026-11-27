import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  ClaimListSchema,
  ClaimSchema,
  ClaimStatusSchema,
  ContextPackQuerySchema,
  ContextPackSchema,
  CreateClaimInputSchema,
  IdSchema,
  MemoryGraphSchema,
  MemorySearchQuerySchema,
  MemorySearchResultSchema,
  ValidateClaimInputSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentProject } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import { postgresGraphSnapshot, toMemoryGraphEdge, toMemoryGraphNode } from '../memory/graph.js';
import { MemoryUnavailableError } from '../memory/types.js';

const ClaimListQuerySchema = z.object({
  projectId: IdSchema,
  status: ClaimStatusSchema.optional(),
  intentId: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const ClaimParamsSchema = z.object({ id: IdSchema });

const bearer = (header: string | undefined): string | null => {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
};

const sameToken = (expected: string, provided: string): boolean => {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const requireInternalToken = (deps: AppDeps) => async (request: FastifyRequest): Promise<void> => {
  const expected = deps.config.memory.internalToken;
  const provided = bearer(request.headers.authorization);
  if (expected === null || provided === null || !sameToken(expected, provided)) {
    throw new HttpError('AUTH_REQUIRED', 'Internal memory API requires a valid token');
  }
};

export function registerMemoryRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const internal = { preHandler: [requireInternalToken(deps)] };

  typed.get(
    '/api/projects/:key/memory/search',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        params: z.object({ key: z.string() }),
        querystring: MemorySearchQuerySchema,
        response: {
          200: MemorySearchResultSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const project = currentProject(request);
      const result = await deps.memory.search.search({
        projectId: project.id,
        q: request.query.q,
        ...(request.query.kind === undefined ? {} : { kind: request.query.kind }),
        limit: request.query.limit,
      });
      return { items: [...result.items], degraded: result.degraded };
    },
  );

  typed.get(
    '/api/projects/:key/memory/graph',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        params: z.object({ key: z.string() }),
        response: {
          200: MemoryGraphSchema,
          401: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const project = currentProject(request);
      try {
        const snapshot = await deps.memory.graph.snapshot(project.id);
        return {
          nodes: snapshot.nodes.map(toMemoryGraphNode),
          edges: snapshot.edges.map(toMemoryGraphEdge),
          updatedAt: deps.now().toISOString(),
          degraded: false,
        };
      } catch (error: unknown) {
        if (!(error instanceof MemoryUnavailableError)) throw error;
        request.log.warn({ error: error.name }, 'memory graph degraded to postgres');
        const snapshot = await postgresGraphSnapshot(deps.db, project.id);
        return {
          nodes: snapshot.nodes.map(toMemoryGraphNode),
          edges: snapshot.edges.map(toMemoryGraphEdge),
          updatedAt: deps.now().toISOString(),
          degraded: true,
        };
      }
    },
  );

  typed.get(
    '/api/internal/memory/context-pack',
    {
      ...internal,
      schema: {
        querystring: ContextPackQuerySchema,
        response: { 200: ContextPackSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => deps.memory.buildContextPack(request.query),
  );

  typed.post(
    '/api/internal/memory/claims',
    {
      ...internal,
      schema: {
        body: CreateClaimInputSchema,
        response: {
          201: ClaimSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const claim = await deps.memory.claims.create(request.body);
      reply.status(201);
      return claim;
    },
  );

  typed.get(
    '/api/internal/memory/claims',
    {
      ...internal,
      schema: {
        querystring: ClaimListQuerySchema,
        response: { 200: ClaimListSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => ({
      items: [
        ...(await deps.memory.claims.list(request.query.projectId, {
          status: request.query.status,
          intentId: request.query.intentId,
          limit: request.query.limit,
        })),
      ],
    }),
  );

  typed.get(
    '/api/internal/memory/claims/:id',
    {
      ...internal,
      schema: {
        params: ClaimParamsSchema,
        querystring: z.object({ projectId: IdSchema }),
        response: { 200: ClaimSchema, 401: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const claim = await deps.memory.claims.get(request.query.projectId, request.params.id);
      if (!claim) throw new HttpError('NOT_FOUND', 'Claim not found');
      return claim;
    },
  );

  typed.post(
    '/api/internal/memory/claims/:id/validate',
    {
      ...internal,
      schema: {
        params: ClaimParamsSchema,
        body: ValidateClaimInputSchema,
        response: {
          200: ClaimSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) =>
      deps.memory.claims.validate(request.body.projectId, request.params.id, request.body),
  );
}
