import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ApiErrorSchema } from '@intentra/contracts';
import type { AppDeps } from '../deps.js';

export function registerHealthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/healthz',
    { schema: { response: { 200: z.object({ status: z.literal('ok') }) } } },
    async () => ({ status: 'ok' as const }),
  );

  typed.get(
    '/readyz',
    {
      schema: {
        response: {
          200: z.object({ status: z.literal('ready') }),
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await deps.pool.query('SELECT 1');
        return { status: 'ready' as const };
      } catch (error: unknown) {
        request.log.error({ err: error }, 'readiness check failed');
        return reply.status(503).send({ code: 'INTERNAL', message: 'Database unreachable' });
      }
    },
  );
}
