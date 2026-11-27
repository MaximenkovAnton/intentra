import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import './fastify-augment.js';
import type { AppDeps } from './deps.js';
import { createGuards } from './auth/rbac.js';
import { SESSION_COOKIE } from './auth/session.js';
import { HttpError, registerErrorHandler } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIntentRoutes } from './routes/intents.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerMemoryRoutes } from './routes/memory.js';
import { registerOpenApiRoute } from './routes/openapi.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunnerRoutes } from './routes/runners.js';
import { registerAdminReleaseRoutes } from './routes/admin-releases.js';
import { registerRunnerUpdateRoutes } from './routes/runner-updates.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { createOrchestrator } from './orchestrator/service.js';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger,
    trustProxy: true,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { method: request.method, route: request.routeOptions.url, statusCode: reply.statusCode },
      'request completed',
    );
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0];
    if (path !== undefined && path.startsWith('/api/') && path !== '/api/openapi.json' && path !== '/api/events') {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    return payload;
  });

  await app.register(cookie);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  app.decorateRequest('project', null);
  app.decorateRequest('runner', null);
  registerErrorHandler(app);

  const expectedOrigin = new URL(deps.config.publicUrl).origin;
  app.addHook('onRequest', async (request) => {
    const unsafe = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS';
    if (!unsafe || !request.cookies[SESSION_COOKIE]) return;
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    let actual: string | null = origin ?? null;
    if (!actual && referer) {
      try {
        actual = new URL(referer).origin;
      } catch {
        actual = null;
      }
    }
    if (actual !== expectedOrigin) throw new HttpError('FORBIDDEN', 'Cross-site request rejected');
  });

  const guards = createGuards(deps.db, deps.config, deps.now);
  app.decorate('orchestrator', createOrchestrator(deps));
  app.addHook('onClose', async () => {
    app.orchestrator.close();
  });
  app.server.on('upgrade', (request, socket, head) => {
    app.orchestrator.handleUpgrade(request, socket, head);
  });
  registerHealthRoutes(app, deps);
  registerMetricsRoute(app);
  registerOpenApiRoute(app);
  registerAuthRoutes(app, deps, guards);
  registerProjectRoutes(app, deps, guards);
  registerMemberRoutes(app, deps, guards);
  registerMemoryRoutes(app, deps, guards);
  registerRunnerRoutes(app, deps, guards);
  registerAdminReleaseRoutes(app, deps);
  registerRunnerUpdateRoutes(app, deps, guards);
  registerIntentRoutes(app, deps, guards);
  registerEventRoutes(app, deps, guards);

  return app;
}
