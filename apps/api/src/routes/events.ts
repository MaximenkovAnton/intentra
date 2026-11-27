import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { SseEvent } from '@intentra/contracts';
import { ApiErrorSchema } from '@intentra/contracts';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentProject } from '../auth/rbac.js';
import { findSession, SESSION_COOKIE } from '../auth/session.js';
import { HttpError } from '../errors.js';
import { projectMembers } from '../db/schema.js';

const HEARTBEAT_MS = 20_000;

const formatEvent = (event: SseEvent): string =>
  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/events',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        querystring: z.object({
          project: z.string().min(1),
          lastEventId: z.string().min(1).optional(),
        }),
        response: { 401: ApiErrorSchema, 403: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const project = currentProject(request);
      const token = request.cookies[SESSION_COOKIE];
      if (!token) throw new HttpError('AUTH_REQUIRED', 'Authentication required');
      const lastEventId =
        request.query.lastEventId ??
        (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined);

      const stillAuthorized = async (): Promise<boolean> => {
        const authenticated = await findSession(deps.db, token, deps.now());
        if (!authenticated) return false;
        if (authenticated.user.isAdmin) return true;
        const [membership] = await deps.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, authenticated.user.id)),
          )
          .limit(1);
        return membership !== undefined;
      };

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders();
      for (const event of deps.events.replay(lastEventId)) {
        if (event.projectId === project.id) reply.raw.write(formatEvent(event));
      }

      let closed = false;
      let queue: Promise<void> = Promise.resolve();
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      const close = (): void => {
        cleanup();
        reply.raw.end();
      };
      const enqueue = (task: () => Promise<void>): void => {
        queue = queue.then(task).catch(() => close());
      };
      const send = (event: SseEvent): void => {
        if (closed || event.projectId !== project.id) return;
        enqueue(async () => {
          if (closed) return;
          if (!(await stillAuthorized())) {
            close();
            return;
          }
          reply.raw.write(formatEvent(event));
        });
      };

      const unsubscribe = deps.events.subscribe(send);
      const heartbeat = setInterval(() => {
        enqueue(async () => {
          if (closed) return;
          if (!(await stillAuthorized())) {
            close();
            return;
          }
          reply.raw.write(': heartbeat\n\n');
        });
      }, HEARTBEAT_MS);
      request.raw.on('close', cleanup);
      return reply;
    },
  );
}
