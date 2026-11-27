import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHarness, hasDatabase, resetDatabase, type Harness } from './harness.js';
import { users } from '../src/db/schema.js';

describe.skipIf(!hasDatabase)('AUTH_MODE=dev', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ AUTH_MODE: 'dev' });
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const sessionCookieFrom = (response: { cookies: { name: string; value: string }[] }): string => {
    const session = response.cookies.find((cookie) => cookie.name === 'intentra_session');
    return `intentra_session=${session?.value ?? ''}`;
  };

  it('logs in the test user without an IdP and reuses the same user', async () => {
    const first = await harness.app.inject({ method: 'GET', url: '/api/auth/login' });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`${harness.config.publicUrl}/`);

    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookieFrom(first) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ email: string; isAdmin: boolean }>()).toMatchObject({
      email: 'dev@intentra.local',
      isAdmin: true,
    });

    const second = await harness.app.inject({ method: 'GET', url: '/api/auth/login?redirect=/projects' });
    expect(second.headers.location).toBe(`${harness.config.publicUrl}/projects`);
    const rows = await harness.db.select().from(users).where(eq(users.idpSubject, 'dev:local'));
    expect(rows).toHaveLength(1);
  });

  it('does not expose the OIDC callback in dev mode', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=x&state=y',
    });
    expect(response.statusCode).toBe(404);
  });
});
