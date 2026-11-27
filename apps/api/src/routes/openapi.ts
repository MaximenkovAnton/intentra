import type { FastifyInstance } from 'fastify';
import { buildOpenApiDocument } from '@intentra/contracts';

export function registerOpenApiRoute(app: FastifyInstance): void {
  app.get('/api/openapi.json', async () => buildOpenApiDocument());
}
