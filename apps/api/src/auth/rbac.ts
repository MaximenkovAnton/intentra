import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { IdSchema, type ProjectRole } from '@intentra/contracts';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { intents, projectMembers, projects, type IntentRow, type ProjectRow } from '../db/schema.js';
import { HttpError } from '../errors.js';
import {
  findSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  toAuthUser,
  touchSession,
  type AuthUser,
} from './session.js';

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 } as const satisfies Record<ProjectRole, number>;

export type ProjectAccess = ProjectRole | 'admin';

export interface IntentAccessOptions {
  readonly hidden?: 'forbidden' | 'notfound';
}

export interface Guards {
  readonly requireUser: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  readonly projectAccess: (minimum: ProjectRole) => (request: FastifyRequest) => Promise<void>;
  readonly intentAccess: (
    minimum: ProjectRole,
    options?: IntentAccessOptions,
  ) => (request: FastifyRequest) => Promise<void>;
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) throw new HttpError('AUTH_REQUIRED', 'Authentication required');
  return request.user;
}

export function currentProject(request: FastifyRequest): ProjectRow {
  if (!request.project) throw new HttpError('NOT_FOUND', 'Project not found');
  return request.project;
}

export function currentIntent(request: FastifyRequest): IntentRow {
  if (!request.intent) throw new HttpError('NOT_FOUND', 'Intent not found');
  return request.intent;
}

export function isAtLeast(role: ProjectAccess, minimum: ProjectRole): boolean {
  return role === 'admin' || ROLE_RANK[role] >= ROLE_RANK[minimum];
}

function readPathKey(request: FastifyRequest): string | null {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null || !('key' in params)) return null;
  const key: unknown = params.key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function readPathId(request: FastifyRequest): string | null {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null || !('id' in params)) return null;
  const id: unknown = params.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readQueryProject(request: FastifyRequest): string | null {
  const query: unknown = request.query;
  if (typeof query !== 'object' || query === null || !('project' in query)) return null;
  const project: unknown = query.project;
  return typeof project === 'string' && project.length > 0 ? project : null;
}

function readProjectKey(request: FastifyRequest): string {
  const key = readPathKey(request) ?? readQueryProject(request);
  if (!key) throw new HttpError('VALIDATION', 'Project key is required');
  return key;
}

export function createGuards(db: Database, config: AppConfig, now: () => Date): Guards {
  const requireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.user) return;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError('AUTH_REQUIRED', 'Authentication required');
    const authenticated = await findSession(db, token, now());
    if (!authenticated) throw new HttpError('AUTH_REQUIRED', 'Session expired');
    const touched = await touchSession(db, authenticated.session, now());
    if (touched.expiresAt.getTime() !== authenticated.session.expiresAt.getTime()) {
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(config, touched.expiresAt));
    }
    request.user = toAuthUser(authenticated.user);
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(request, reply);
    if (!request.user?.isAdmin) throw new HttpError('FORBIDDEN', 'Forbidden');
  };

  const projectAccess = (minimum: ProjectRole) => async (request: FastifyRequest): Promise<void> => {
    if (!request.user) throw new HttpError('AUTH_REQUIRED', 'Authentication required');
    const key = readProjectKey(request);
    const [project] = await db.select().from(projects).where(eq(projects.key, key)).limit(1);
    if (!project) {
      if (request.user.isAdmin) throw new HttpError('NOT_FOUND', 'Project not found');
      throw new HttpError('FORBIDDEN', 'Forbidden');
    }
    if (project.archivedAt) {
      if (request.user.isAdmin) throw new HttpError('NOT_FOUND', 'Project archived');
      throw new HttpError('FORBIDDEN', 'Forbidden');
    }
    if (request.user.isAdmin) {
      request.project = project;
      return;
    }
    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, request.user.id)))
      .limit(1);
    if (!membership || !isAtLeast(membership.role, minimum)) throw new HttpError('FORBIDDEN', 'Forbidden');
    request.project = project;
  };

  const intentAccess =
    (minimum: ProjectRole, options?: IntentAccessOptions) =>
    async (request: FastifyRequest): Promise<void> => {
      if (!request.user) throw new HttpError('AUTH_REQUIRED', 'Authentication required');
      const hidden = options?.hidden === 'notfound';
      const raw = readPathId(request);
      const parsed = IdSchema.safeParse(raw);
      if (!parsed.success) throw new HttpError('VALIDATION', 'Intent id must be a UUID');
      const [row] = await db
        .select({ intent: intents, project: projects })
        .from(intents)
        .innerJoin(projects, eq(intents.projectId, projects.id))
        .where(eq(intents.id, parsed.data))
        .limit(1);
      if (!row) {
        if (request.user.isAdmin || hidden) throw new HttpError('NOT_FOUND', 'Intent not found');
        throw new HttpError('FORBIDDEN', 'Forbidden');
      }
      if (row.project.archivedAt) {
        if (request.user.isAdmin) throw new HttpError('NOT_FOUND', 'Project archived');
        if (hidden) throw new HttpError('NOT_FOUND', 'Intent not found');
        throw new HttpError('FORBIDDEN', 'Forbidden');
      }
      if (request.user.isAdmin) {
        request.intent = row.intent;
        request.project = row.project;
        return;
      }
      const [membership] = await db
        .select()
        .from(projectMembers)
        .where(
          and(eq(projectMembers.projectId, row.project.id), eq(projectMembers.userId, request.user.id)),
        )
        .limit(1);
      if (!membership) {
        if (hidden) throw new HttpError('NOT_FOUND', 'Intent not found');
        throw new HttpError('FORBIDDEN', 'Forbidden');
      }
      if (!isAtLeast(membership.role, minimum)) throw new HttpError('FORBIDDEN', 'Forbidden');
      request.intent = row.intent;
      request.project = row.project;
    };

  return { requireUser, requireAdmin, projectAccess, intentAccess };
}
