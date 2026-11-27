import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiErrorSchema,
  CreateProjectInputSchema,
  ProjectListSchema,
  ProjectSchema,
  UpdateProjectInputSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentProject, currentUser } from '../auth/rbac.js';
import { HttpError, isPgUniqueViolation } from '../errors.js';
import { toProjectDto } from '../dto.js';
import { afterCreatedAt, createdAtText, decodeCursor, encodeCursor, pageOf } from '../pagination.js';
import { projectMembers, projects } from '../db/schema.js';
import { recordAudit } from '../services/audit.js';

export function registerProjectRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/projects',
    {
      preHandler: [guards.requireUser],
      schema: {
        querystring: z.object({
          cursor: z.string().min(1).max(200).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(50),
        }),
        response: { 200: ProjectListSchema, 401: ApiErrorSchema },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const conditions = [isNull(projects.archivedAt)];
      if (cursor) conditions.push(afterCreatedAt(projects.createdAt, projects.id, cursor));

      const rows = user.isAdmin
        ? await deps.db
            .select({ project: projects, cursorAt: createdAtText(projects.createdAt) })
            .from(projects)
            .where(and(...conditions))
            .orderBy(desc(projects.createdAt), desc(projects.id))
            .limit(limit + 1)
        : await deps.db
            .select({ project: projects, cursorAt: createdAtText(projects.createdAt) })
            .from(projects)
            .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
            .where(and(...conditions, eq(projectMembers.userId, user.id)))
            .orderBy(desc(projects.createdAt), desc(projects.id))
            .limit(limit + 1);

      const { page, nextCursor } = pageOf(rows, limit, (row) =>
        encodeCursor({ createdAt: row.cursorAt, id: row.project.id }),
      );
      return {
        items: page.map((row) => toProjectDto(row.project)),
        nextCursor,
      };
    },
  );

  typed.post(
    '/api/projects',
    {
      preHandler: [guards.requireUser],
      schema: {
        body: CreateProjectInputSchema,
        response: { 201: ProjectSchema, 400: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const body = request.body;
      try {
        const project = await deps.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(projects)
            .values({
              key: body.key,
              name: body.name,
              description: body.description ?? null,
              repoUrl: body.repoUrl ?? null,
              defaultBranch: body.defaultBranch,
              createdBy: user.id,
            })
            .returning();
          if (!created) throw new HttpError('INTERNAL', 'Project insert returned no row');
          await tx.insert(projectMembers).values({ projectId: created.id, userId: user.id, role: 'owner' });
          return created;
        });
        await recordAudit(deps.db, {
          actorKind: 'user',
          actorId: user.id,
          action: 'project.create',
          target: project.key,
        });
        reply.status(201);
        return toProjectDto(project);
      } catch (error: unknown) {
        if (isPgUniqueViolation(error)) throw new HttpError('CONFLICT', 'Project key already exists');
        throw error;
      }
    },
  );

  typed.get(
    '/api/projects/:key',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        params: z.object({ key: z.string() }),
        response: { 200: ProjectSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => toProjectDto(currentProject(request)),
  );

  typed.patch(
    '/api/projects/:key',
    {
      preHandler: [guards.requireUser, guards.projectAccess('owner')],
      schema: {
        params: z.object({ key: z.string() }),
        body: UpdateProjectInputSchema,
        response: { 200: ProjectSchema, 400: ApiErrorSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const project = currentProject(request);
      const body = request.body;
      const [updated] = await deps.db
        .update(projects)
        .set({
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.repoUrl === undefined ? {} : { repoUrl: body.repoUrl }),
          ...(body.defaultBranch === undefined ? {} : { defaultBranch: body.defaultBranch }),
        })
        .where(eq(projects.id, project.id))
        .returning();
      if (!updated) throw new HttpError('NOT_FOUND', 'Project not found');
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: user.id,
        action: 'project.update',
        target: project.key,
        meta: { fields: Object.keys(body) },
      });
      return toProjectDto(updated);
    },
  );

  typed.delete(
    '/api/projects/:key',
    {
      preHandler: [guards.requireUser, guards.projectAccess('owner')],
      schema: {
        params: z.object({ key: z.string() }),
        response: { 204: z.void(), 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const project = currentProject(request);
      if (!project.archivedAt) {
        await deps.db.update(projects).set({ archivedAt: deps.now() }).where(eq(projects.id, project.id));
        await recordAudit(deps.db, {
          actorKind: 'user',
          actorId: user.id,
          action: 'project.archive',
          target: project.key,
        });
      }
      return reply.status(204).send();
    },
  );
}
