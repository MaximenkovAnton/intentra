import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { sessions, users, type SessionRow, type UserRow } from '../db/schema.js';

export const SESSION_COOKIE = 'intentra_session';
export const OIDC_STATE_COOKIE = 'intentra_oidc';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly locale: 'ru' | 'en';
  readonly isAdmin: boolean;
}

export interface AuthSession {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedSession {
  readonly user: UserRow;
  readonly session: SessionRow;
}

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    locale: row.locale,
    isAdmin: row.isAdmin,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  db: Database,
  input: { userId: string; authMethod: 'oidc' | 'dev'; ip: string | null; userAgent: string | null; now: Date },
): Promise<AuthSession> {
  const token = generateToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  const [row] = await db
    .insert(sessions)
    .values({
      userId: input.userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
      authMethod: input.authMethod,
    })
    .returning({ id: sessions.id });
  if (!row) throw new Error('session insert returned no row');
  return { token, sessionId: row.id, expiresAt };
}

export async function findSession(db: Database, token: string, now: Date): Promise<AuthenticatedSession | null> {
  const rows = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(db: Database, session: SessionRow, now: Date): Promise<SessionRow> {
  if (session.expiresAt.getTime() - now.getTime() >= SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) return session;
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, session.id));
  return { ...session, expiresAt };
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export function sessionCookieOptions(config: AppConfig, expiresAt: Date): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

export function oidcStateCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 10 * 60,
  };
}
