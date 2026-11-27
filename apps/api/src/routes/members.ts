import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq } from 'drizzle-orm';
import {
  AddMemberInputSchema,
  ApiErrorSchema,
  MemberListSchema,
  MemberSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentProject, currentUser } from '../auth/rbac.js';
import { HttpError, isPgUniqueViolation } from '../errors.js';
import { toMemberDto } from '../dto.js';
import { afterCreatedAt, createdAtText, decodeCursor, encodeCursor, pageOf } from '../pagination.js';
import { projectMembers, projects, users } from '../db/schema.js';
import { recordAudit } from '../services/audit.js';

export function registerMemberRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/projects/:key/members',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        params: z.object({ key: z.string() }),
        querystring: z.object({
          cursor: z.string().min(1).max(200).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(50),
        }),
        response: { 200: MemberListSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const project = currentProject(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const conditions = [eq(projectMembers.projectId, project.id)];
      if (cursor) conditions.push(afterCreatedAt(projectMembers.createdAt, projectMembers.userId, cursor));
      const rows = await deps.db
        .select({ member: projectMembers, user: users, cursorAt: createdAtText(projectMembers.createdAt) })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(...conditions))
        .orderBy(desc(projectMembers.createdAt), desc(projectMembers.userId))
        .limit(limit + 1);
      const { page, nextCursor } = pageOf(rows, limit, (row) =>
        encodeCursor({ createdAt: row.cursorAt, id: row.member.userId }),
      );
      return {
        items: page.map((row) => toMemberDto(row.member, row.user)),
        nextCursor,
      };
    },
  );

  typed.post(
    '/api/projects/:key/members',
    {
      preHandler: [guards.requireUser, guards.projectAccess('owner')],
      schema: {
        params: z.object({ key: z.string() }),
        body: AddMemberInputSchema,
        response: {
          201: MemberSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = currentUser(request);
      const project = currentProject(request);
      const [target] = await deps.db.select().from(users).where(eq(users.email, request.body.email)).limit(1);
      if (!target) throw new HttpError('NOT_FOUND', 'User has not signed in yet');
      try {
        const [member] = await deps.db
          .insert(projectMembers)
          .values({ projectId: project.id, userId: target.id, role: request.body.role })
          .returning();
        if (!member) throw new HttpError('INTERNAL', 'Member insert returned no row');
        await recordAudit(deps.db, {
          actorKind: 'user',
          actorId: actor.id,
          action: 'member.add',
          target: project.key,
          meta: { userId: target.id, role: request.body.role },
        });
        reply.status(201);
        return toMemberDto(member, target);
      } catch (error: unknown) {
        if (isPgUniqueViolation(error)) throw new HttpError('CONFLICT', 'User is already a member');
        throw error;
      }
    },
  );

  typed.delete(
    '/api/projects/:key/members/:userId',
    {
      preHandler: [guards.requireUser, guards.projectAccess('owner')],
      schema: {
        params: z.object({ key: z.string(), userId: z.string().uuid() }),
        response: { 204: z.void(), 403: ApiErrorSchema, 404: ApiErrorSchema, 409: ApiErrorSchema },
      },
    },
    async (request, reply) => {
      const actor = currentUser(request);
      const project = currentProject(request);
      const removed = await deps.db.transaction(async (tx) => {
        await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)).for('update');
        const [member] = await tx
          .select()
          .from(projectMembers)
          .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, request.params.userId)))
          .limit(1);
        if (!member) throw new HttpError('NOT_FOUND', 'Member not found');
        if (member.role === 'owner') {
          const owners = await tx
            .select({ userId: projectMembers.userId })
            .from(projectMembers)
            .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.role, 'owner')));
          if (owners.length <= 1) throw new HttpError('CONFLICT', 'Cannot remove the last project owner');
        }
        await tx
          .delete(projectMembers)
          .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, request.params.userId)));
        return member;
      });
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: actor.id,
        action: 'member.remove',
        target: project.key,
        meta: { userId: request.params.userId, role: removed.role },
      });
      return reply.status(204).send();
    },
  );
}
