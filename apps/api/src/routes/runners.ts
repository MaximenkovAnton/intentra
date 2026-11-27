import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import {
  ApiErrorSchema,
  RegisterRunnerInputSchema,
  RegisterRunnerResponseSchema,
  RegistrationTokenSchema,
  RotateRunnerTokenResponseSchema,
  RunnerListSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { canManageRunner, currentProject, currentUser } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import { toRunnerDto } from '../dto.js';
import { generateToken, hashToken } from '../auth/session.js';
import { afterId, decodeIdCursor, encodeIdCursor, pageOf } from '../pagination.js';
import {
  projectMembers,
  projectRunners,
  runnerRegistrationTokens,
  runnerUpdateEvents,
  runners,
  type RunnerUpdateEventRow,
} from '../db/schema.js';
import { recordAudit } from '../services/audit.js';

const REGISTRATION_TTL_MS = 15 * 60 * 1000;

export function registerRunnerRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/api/projects/:key/runners/registration-token',
    {
      preHandler: [guards.requireUser, guards.projectAccess('owner')],
      schema: {
        params: z.object({ key: z.string() }),
        response: {
          201: RegistrationTokenSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const project = currentProject(request);
      const token = generateToken();
      const expiresAt = new Date(deps.now().getTime() + REGISTRATION_TTL_MS);
      await deps.db.insert(runnerRegistrationTokens).values({
        projectId: project.id,
        createdBy: user.id,
        tokenHash: hashToken(token),
        expiresAt,
      });
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: user.id,
        action: 'runner.registration_token.create',
        target: project.key,
      });
      reply.status(201);
      return { token, expiresAt: expiresAt.toISOString() };
    },
  );

  typed.post(
    '/api/runners/register',
    {
      schema: {
        body: RegisterRunnerInputSchema,
        response: {
          201: RegisterRunnerResponseSchema,
          400: ApiErrorSchema,
          401: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const now = deps.now();
      const [registration] = await deps.db
        .select()
        .from(runnerRegistrationTokens)
        .where(
          and(
            eq(runnerRegistrationTokens.tokenHash, hashToken(body.registrationToken)),
            isNull(runnerRegistrationTokens.usedAt),
            gt(runnerRegistrationTokens.expiresAt, now),
          ),
        )
        .limit(1);
      if (!registration) throw new HttpError('AUTH_REQUIRED', 'Invalid or expired registration token');

      const runnerToken = generateToken();
      const runner = await deps.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(runnerRegistrationTokens)
          .set({ usedAt: now })
          .where(and(eq(runnerRegistrationTokens.id, registration.id), isNull(runnerRegistrationTokens.usedAt)))
          .returning({ id: runnerRegistrationTokens.id });
        if (!claimed) throw new HttpError('CONFLICT', 'Registration token already used');
        const [created] = await tx
          .insert(runners)
          .values({
            name: body.name,
            ownerUserId: registration.createdBy,
            tokenHash: hashToken(runnerToken),
            os: body.os,
            arch: body.arch,
            version: body.version,
            capabilities: body.capabilities,
            status: 'offline',
          })
          .returning();
        if (!created) throw new HttpError('INTERNAL', 'Runner insert returned no row');
        await tx.insert(projectRunners).values({ projectId: registration.projectId, runnerId: created.id });
        return created;
      });

      await recordAudit(deps.db, {
        actorKind: 'runner',
        actorId: runner.id,
        action: 'runner.register',
        target: runner.name,
        meta: { projectId: registration.projectId, os: runner.os, arch: runner.arch },
      });
      deps.events.publish({
        type: 'runner.updated',
        projectId: registration.projectId,
        data: { runnerId: runner.id, status: runner.status },
      });
      reply.status(201);
      return { runnerId: runner.id, token: runnerToken };
    },
  );

  typed.get(
    '/api/runners',
    {
      preHandler: [guards.requireUser],
      schema: {
        querystring: z.object({
          cursor: z.string().min(1).max(200).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(50),
        }),
        response: { 200: RunnerListSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeIdCursor(request.query.cursor) : null;
      const conditions = cursor ? [afterId(runners.id, cursor)] : [];
      const rows = user.isAdmin
        ? await deps.db
            .selectDistinct({ runner: runners })
            .from(runners)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(asc(runners.id))
            .limit(limit + 1)
        : await deps.db
            .selectDistinct({ runner: runners })
            .from(runners)
            .innerJoin(projectRunners, eq(projectRunners.runnerId, runners.id))
            .innerJoin(
              projectMembers,
              and(
                eq(projectMembers.projectId, projectRunners.projectId),
                eq(projectMembers.userId, user.id),
              ),
            )
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(asc(runners.id))
            .limit(limit + 1);
      const { page, nextCursor } = pageOf(rows, limit, (row) => encodeIdCursor(row.runner.id));
      const runnerIds = page.map((row) => row.runner.id);
      const events =
        runnerIds.length === 0
          ? []
          : await deps.db
              .select()
              .from(runnerUpdateEvents)
              .where(inArray(runnerUpdateEvents.runnerId, runnerIds))
              .orderBy(desc(runnerUpdateEvents.createdAt));
      const lastUpdateByRunner = new Map<string, RunnerUpdateEventRow>();
      for (const event of events) {
        if (!lastUpdateByRunner.has(event.runnerId)) lastUpdateByRunner.set(event.runnerId, event);
      }
      const items = await Promise.all(
        page.map(async (row) => {
          const update = await deps.releases.resolveUpdate({
            runner: row.runner,
            channel: 'stable',
            current: null,
          });
          return toRunnerDto(row.runner, {
            latestVersion: update.latestVersion,
            updateAvailable: update.available,
            lastUpdate: lastUpdateByRunner.get(row.runner.id) ?? null,
          });
        }),
      );
      return { items, nextCursor };
    },
  );

  typed.post(
    '/api/runners/:id/rotate-token',
    {
      preHandler: [guards.requireUser],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: RotateRunnerTokenResponseSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const [runner] = await deps.db.select().from(runners).where(eq(runners.id, request.params.id)).limit(1);
      if (!runner) throw new HttpError('NOT_FOUND', 'Runner not found');
      if (!canManageRunner(runner, user)) throw new HttpError('FORBIDDEN', 'Forbidden');
      if (runner.revokedAt) throw new HttpError('CONFLICT', 'Runner is revoked');
      const token = generateToken();
      await deps.db.update(runners).set({ tokenHash: hashToken(token) }).where(eq(runners.id, runner.id));
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: user.id,
        action: 'runner.rotate_token',
        target: runner.id,
      });
      return { token };
    },
  );

  typed.delete(
    '/api/runners/:id',
    {
      preHandler: [guards.requireUser],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.void(), 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const [runner] = await deps.db.select().from(runners).where(eq(runners.id, request.params.id)).limit(1);
      if (!runner) throw new HttpError('NOT_FOUND', 'Runner not found');
      if (!canManageRunner(runner, user)) throw new HttpError('FORBIDDEN', 'Forbidden');
      if (!runner.revokedAt) {
        const bindings = await deps.db
          .select({ projectId: projectRunners.projectId })
          .from(projectRunners)
          .where(eq(projectRunners.runnerId, runner.id));
        await deps.db
          .update(runners)
          .set({ revokedAt: deps.now(), status: 'revoked' })
          .where(eq(runners.id, runner.id));
        await recordAudit(deps.db, {
          actorKind: 'user',
          actorId: user.id,
          action: 'runner.revoke',
          target: runner.id,
        });
        for (const binding of bindings) {
          deps.events.publish({
            type: 'runner.updated',
            projectId: binding.projectId,
            data: { runnerId: runner.id, status: 'revoked' },
          });
        }
      }
      return reply.status(204).send();
    },
  );
}
