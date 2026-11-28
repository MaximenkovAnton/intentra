import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  ReleasePublishInputSchema,
  ReleaseSchema,
  ReleaseYankInputSchema,
  SemVerSchema,
} from '@intentra/contracts';
import type { AppConfig } from '../config.js';
import type { AppDeps } from '../deps.js';
import { bearerToken } from '../auth/runner-token.js';
import { HttpError } from '../errors.js';
import { recordAudit, type AuditAction } from '../services/audit.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

export const createPublishGuard =
  (config: AppConfig) =>
  async (request: FastifyRequest): Promise<void> => {
    const configured = config.release.publishToken;
    if (configured === null) throw new HttpError('RELEASE_DISABLED', 'release publishing is not configured');
    const token = bearerToken(request);
    if (token === null || !timingSafeEqual(sha256(token), sha256(configured))) {
      throw new HttpError('AUTH_REQUIRED', 'Invalid release publish token');
    }
  };

export function registerAdminReleaseRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const requirePublishToken = createPublishGuard(deps.config);

  const audit = async (action: AuditAction, target: string): Promise<void> => {
    await recordAudit(deps.db, { actorKind: 'system', actorId: 'release', action, target });
  };

  const requireReleaseKey = (): void => {
    if (!deps.releases.keyConfigured) throw new HttpError('RELEASE_DISABLED', 'release key is not configured');
  };

  typed.post(
    '/api/admin/releases',
    {
      preHandler: [requirePublishToken],
      schema: {
        body: ReleasePublishInputSchema,
        response: {
          200: ReleaseSchema,
          201: ReleaseSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      requireReleaseKey();
      const { created, release } = await deps.releases.publish(request.body);
      request.log.info({ version: release.version, channel: release.channel, created }, 'release published');
      await audit('release.publish', release.version);
      reply.status(created ? 201 : 200);
      return release;
    },
  );

  typed.post(
    '/api/admin/releases/:version/yank',
    {
      preHandler: [requirePublishToken],
      schema: {
        params: z.object({ version: SemVerSchema }),
        body: ReleaseYankInputSchema,
        response: {
          204: z.void(),
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          404: ApiErrorSchema,
          503: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      requireReleaseKey();
      await deps.releases.yank(request.params.version, request.body.yanked);
      request.log.info({ version: request.params.version, yanked: request.body.yanked }, 'release yank changed');
      await audit('release.yank', request.params.version);
      return reply.status(204).send();
    },
  );
}
