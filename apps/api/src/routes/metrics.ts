import type { FastifyInstance } from 'fastify';

export function registerMetricsRoute(app: FastifyInstance): void {
  app.get('/metrics', async (_request, reply) => {
    const body = await app.orchestrator.metrics();
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
  });
}
