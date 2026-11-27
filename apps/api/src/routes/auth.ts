import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiErrorSchema,
  LogoutResponseSchema,
  MeSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentUser } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import { createSession, deleteSession, OIDC_STATE_COOKIE, oidcStateCookieOptions, SESSION_COOKIE, sessionCookieOptions } from '../auth/session.js';
import { openOidcState, safeRedirectPath, sealOidcState } from '../auth/state.js';
import { provisionUser } from '../auth/provisioning.js';
import { provisionDevUser } from '../auth/dev.js';
import { recordAudit } from '../services/audit.js';

const requestMeta = (request: { ip: string; headers: Record<string, string | string[] | undefined> }) => {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
};

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/api/auth/login',
    {
      schema: {
        querystring: z.object({ redirect: z.string().max(500).optional() }),
      },
    },
    async (request, reply) => {
      const redirectPath = safeRedirectPath(request.query.redirect);
      const cookiePath = oidcStateCookieOptions(deps.config);
      if (!deps.oidc) {
        const user = await provisionDevUser(deps.db);
        const session = await createSession(deps.db, {
          userId: user.id,
          authMethod: 'dev',
          ...requestMeta(request),
          now: deps.now(),
        });
        reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(deps.config, session.expiresAt));
        await recordAudit(deps.db, {
          actorKind: 'user',
          actorId: user.id,
          action: 'auth.login',
          meta: { method: 'dev' },
        });
        return reply.redirect(`${deps.config.publicUrl}${redirectPath}`, 302);
      }
      const { url, pending } = await deps.oidc.createAuthorizationRequest(redirectPath);
      reply.setCookie(OIDC_STATE_COOKIE, sealOidcState(deps.config.sessionSecret, pending), cookiePath);
      return reply.redirect(url.toString(), 302);
    },
  );

  typed.get(
    '/api/auth/callback',
    {
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          iss: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      if (!deps.oidc) throw new HttpError('NOT_FOUND', 'OIDC is not enabled');
      const oidcConfig = deps.config.oidc;
      if (!oidcConfig) throw new HttpError('NOT_FOUND', 'OIDC is not configured');
      if (request.query.error) {
        const target = `${deps.config.publicUrl}/auth/error?error=${encodeURIComponent(request.query.error)}`;
        return reply.redirect(target, 302);
      }
      const sealed = request.cookies[OIDC_STATE_COOKIE];
      if (!sealed) throw new HttpError('VALIDATION', 'Missing OIDC state cookie');
      const pending = openOidcState(deps.config.sessionSecret, sealed);
      reply.clearCookie(OIDC_STATE_COOKIE, { path: oidcStateCookieOptions(deps.config).path });
      if (!pending) throw new HttpError('VALIDATION', 'Invalid OIDC state cookie');
      if (!request.query.code || request.query.state !== pending.state) {
        throw new HttpError('FORBIDDEN', 'Invalid OIDC state');
      }
      const callbackUrl = new URL(request.url, oidcConfig.redirectUri);
      const identity = await deps.oidc.completeLogin(callbackUrl, pending);
      const user = await provisionUser(deps.db, identity, oidcConfig.adminGroup);
      const session = await createSession(deps.db, {
        userId: user.id,
        authMethod: 'oidc',
        ...requestMeta(request),
        now: deps.now(),
      });
      reply.setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(deps.config, session.expiresAt));
      await recordAudit(deps.db, {
        actorKind: 'user',
        actorId: user.id,
        action: 'auth.login',
        meta: { method: 'oidc', subject: identity.subject },
      });
      return reply.redirect(`${deps.config.publicUrl}${pending.redirectPath}`, 302);
    },
  );

  typed.post(
    '/api/auth/logout',
    {
      preHandler: [guards.requireUser],
      schema: {
        response: {
          200: LogoutResponseSchema,
          401: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const token = request.cookies[SESSION_COOKIE];
      if (token) await deleteSession(deps.db, token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      await recordAudit(deps.db, { actorKind: 'user', actorId: user.id, action: 'auth.logout' });
      return { redirectUrl: deps.oidc?.endSessionUrl()?.toString() ?? null };
    },
  );

  typed.get(
    '/api/auth/me',
    {
      preHandler: [guards.requireUser],
      schema: {
        response: {
          200: MeSchema,
          401: ApiErrorSchema,
        },
      },
    },
    async (request) => currentUser(request),
  );
}
