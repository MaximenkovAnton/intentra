import { createReadStream } from 'node:fs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  ChannelSchema,
  RunnerUpdateSchema,
  UpdatePolicyInputSchema,
  UpdateReportInputSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import { canManageRunner, currentUser, type Guards } from '../auth/rbac.js';
import { createRunnerAuth, currentRunner } from '../auth/runner-token.js';
import { HttpError } from '../errors.js';
import { projectRunners, runnerUpdateEvents, runners } from '../db/schema.js';
import { recordAudit } from '../services/audit.js';

export function registerRunnerUpdateRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authenticateRunner = createRunnerAuth(deps.db);

  typed.get(
    '/api/runners/update',
    {
      preHandler: [authenticateRunner],
      schema: {
        querystring: z.object({
          current: z.string().min(1).max(64).optional(),
          channel: ChannelSchema.default('stable'),
        }),
        response: { 200: RunnerUpdateSchema, 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => {
      const runner = currentRunner(request);
      return deps.releases.resolveUpdate({
        runner,
        channel: request.query.channel,
        current: request.query.current ?? null,
      });
    },
  );

  typed.get(
    '/api/runners/update/artifact/:fileName',
    {
      preHandler: [authenticateRunner],
      schema: {
        params: z.object({ fileName: z.string().min(1).max(255) }),
      },
    },
    async (request, reply) => {
      const asset = await deps.releases.findArtifact(request.params.fileName);
      if (asset === null) throw new HttpError('NOT_FOUND', 'Artifact not found');
      let path: string;
      try {
        path = await deps.releaseArtifacts.ensureCached(asset);
      } catch (error) {
        request.log.warn({ url: asset.url, reason: error instanceof Error ? error.message : 'unknown' }, 'release artifact unavailable');
        throw error;
      }
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', String(asset.sizeBytes));
      reply.header('Digest', `sha-256=${Buffer.from(asset.sha256, 'hex').toString('base64')}`);
      return reply.send(createReadStream(path));
    },
  );

  typed.post(
    '/api/runners/update/report',
    {
      preHandler: [authenticateRunner],
      schema: {
        body: UpdateReportInputSchema,
        response: { 204: z.void(), 400: ApiErrorSchema, 401: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const runner = currentRunner(request);
      const body = request.body;
      await deps.db.insert(runnerUpdateEvents).values({
        runnerId: runner.id,
        fromVersion: body.fromVersion,
        toVersion: body.toVersion,
        status: body.status,
        reason: body.reason ?? null,
      });
      const bindings = await deps.db
        .select({ projectId: projectRunners.projectId })
        .from(projectRunners)
        .where(eq(projectRunners.runnerId, runner.id));
      for (const binding of bindings) {
        deps.events.publish({
          type: 'runner.updated',
          projectId: binding.projectId,
          data: { runnerId: runner.id, version: body.toVersion, status: body.status },
        });
      }
      return reply.status(204).send();
    },
  );

  typed.put(
    '/api/runners/:id/update-policy',
    {
      preHandler: [guards.requireUser],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: UpdatePolicyInputSchema,
        response: {
          204: z.void(),
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const [runner] = await deps.db.select().from(runners).where(eq(runners.id, request.params.id)).limit(1);
      if (!runner) throw new HttpError('NOT_FOUND', 'Runner not found');
      if (!canManageRunner(runner, user)) throw new HttpError('FORBIDDEN', 'Forbidden');
      if (runner.revokedAt) throw new HttpError('CONFLICT', 'Runner is revoked');
      const { pinnedVersion, autoUpdate } = request.body;
      await deps.db.update(runners).set({ pinnedVersion, autoUpdate }).where(eq(runners.id, runner.id));
      request.log.info({ runnerId: runner.id, pinnedVersion, autoUpdate }, 'runner update policy changed');
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: user.id,
        action: 'runner.update_policy',
        target: runner.id,
        meta: { pinnedVersion, autoUpdate },
      });
      const bindings = await deps.db
        .select({ projectId: projectRunners.projectId })
        .from(projectRunners)
        .where(eq(projectRunners.runnerId, runner.id));
      for (const binding of bindings) {
        deps.events.publish({
          type: 'runner.updated',
          projectId: binding.projectId,
          data: { runnerId: runner.id, pinnedVersion, autoUpdate },
        });
      }
      return reply.status(204).send();
    },
  );
}
