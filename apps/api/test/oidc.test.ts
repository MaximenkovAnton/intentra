import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createHarness,
  hasDatabase,
  provisionTestUser,
  resetDatabase,
  seedUser,
  type Harness,
} from './harness.js';
import { startMockOidc, type MockIdentity, type MockOidc } from './mock-oidc.js';
import { users } from '../src/db/schema.js';

const identity: MockIdentity = {
  sub: 'oidc-subject-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  picture: 'https://avatar.example.com/ada.png',
  groups: ['engineering'],
};

describe.skipIf(!hasDatabase)('OIDC login', () => {
  let oidc: MockOidc;
  let harness: Harness;

  beforeAll(async () => {
    oidc = await startMockOidc(identity);
    harness = await createHarness({
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: oidc.issuer,
      OIDC_CLIENT_ID: oidc.clientId,
      OIDC_CLIENT_SECRET: oidc.clientSecret,
      OIDC_REDIRECT_URI: oidc.redirectUri,
      OIDC_ADMIN_GROUP: 'intentra-admins',
    });
  });
  afterAll(async () => {
    await harness.close();
    await oidc.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  const login = async (): Promise<{ sessionCookie: string; stateCookie: string }> => {
    const loginResponse = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/login?redirect=/projects',
      headers: { 'user-agent': 'vitest' },
    });
    expect(loginResponse.statusCode).toBe(302);
    const location = loginResponse.headers.location;
    expect(typeof location).toBe('string');
    const stateCookie = loginResponse.cookies.find((cookie) => cookie.name === 'intentra_oidc');
    expect(stateCookie).toBeDefined();

    const authorizeResponse = await fetch(String(location), { redirect: 'manual' });
    expect(authorizeResponse.status).toBe(302);
    const callbackLocation = authorizeResponse.headers.get('location');
    expect(callbackLocation).not.toBeNull();
    const callbackUrl = new URL(String(callbackLocation));

    const callbackResponse = await harness.app.inject({
      method: 'GET',
      url: `${callbackUrl.pathname}${callbackUrl.search}`,
      headers: { cookie: `intentra_oidc=${stateCookie?.value ?? ''}`, 'user-agent': 'vitest' },
    });
    expect(callbackResponse.statusCode).toBe(302);
    expect(callbackResponse.headers.location).toBe(`${harness.config.publicUrl}/projects`);
    const session = callbackResponse.cookies.find((cookie) => cookie.name === 'intentra_session');
    expect(session).toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite?.toLowerCase()).toBe('lax');
    return { sessionCookie: `intentra_session=${session?.value ?? ''}`, stateCookie: `intentra_oidc=${stateCookie?.value ?? ''}` };
  };

  it('completes login -> callback -> cookie -> me and JIT-provisions the user', async () => {
    const { sessionCookie } = await login();
    const meResponse = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookie },
    });
    expect(meResponse.statusCode).toBe(200);
    const me = meResponse.json<{ id: string; email: string; name: string; isAdmin: boolean; avatarUrl: string }>();
    expect(me.email).toBe('ada@example.com');
    expect(me.name).toBe('Ada Lovelace');
    expect(me.avatarUrl).toBe('https://avatar.example.com/ada.png');
    expect(me.isAdmin).toBe(false);

    const rows = await harness.db.select().from(users).where(eq(users.idpSubject, identity.sub));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('ada@example.com');
  });

  it('updates the JIT user on the next login and grants org-admin from the IdP group', async () => {
    const first = await login();
    expect(first.sessionCookie).toContain('intentra_session=');

    oidc.setIdentity({ ...identity, email: 'ada.new@example.com', groups: ['intentra-admins'] });
    const second = await login();
    const meResponse = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: second.sessionCookie },
    });
    const me = meResponse.json<{ email: string; isAdmin: boolean }>();
    expect(me.email).toBe('ada.new@example.com');
    expect(me.isAdmin).toBe(true);

    const rows = await harness.db.select().from(users).where(eq(users.idpSubject, identity.sub));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isAdmin).toBe(true);
  });

  it('rejects a callback whose state does not match the sealed state', async () => {
    const loginResponse = await harness.app.inject({ method: 'GET', url: '/api/auth/login' });
    const stateCookie = loginResponse.cookies.find((cookie) => cookie.name === 'intentra_oidc');
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=abc&state=tampered',
      headers: { cookie: `intentra_oidc=${stateCookie?.value ?? ''}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a callback without the sealed state cookie', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/callback?code=abc&state=abc',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('links an existing account by email only when the IdP marks it verified', async () => {
    const existing = await seedUser(harness.db, { email: 'taken@example.com' });
    await expect(
      provisionTestUser(harness.db, {
        subject: 'unverified-subject',
        email: 'taken@example.com',
        name: 'Mallory',
        groups: [],
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const linked = await provisionTestUser(harness.db, {
      subject: 'verified-subject',
      email: 'taken@example.com',
      name: 'Ada',
      groups: [],
      emailVerified: true,
    });
    expect(linked.id).toBe(existing.id);
    expect(linked.idpSubject).toBe('verified-subject');
  });

  it('refuses to link an existing account through the login flow when the IdP marks the email unverified', async () => {
    const existing = await seedUser(harness.db, { email: 'taken@example.com' });
    oidc.setIdentity({
      ...identity,
      sub: 'unverified-subject',
      email: 'taken@example.com',
      emailVerified: false,
    });
    try {
      const loginResponse = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/login?redirect=/projects',
        headers: { 'user-agent': 'vitest' },
      });
      expect(loginResponse.statusCode).toBe(302);
      const stateCookie = loginResponse.cookies.find((cookie) => cookie.name === 'intentra_oidc');
      const authorizeResponse = await fetch(String(loginResponse.headers.location), { redirect: 'manual' });
      const callbackLocation = authorizeResponse.headers.get('location');
      expect(callbackLocation).not.toBeNull();
      const callbackUrl = new URL(String(callbackLocation));
      const callbackResponse = await harness.app.inject({
        method: 'GET',
        url: `${callbackUrl.pathname}${callbackUrl.search}`,
        headers: { cookie: `intentra_oidc=${stateCookie?.value ?? ''}` },
      });
      expect(callbackResponse.statusCode).toBe(401);
      expect(callbackResponse.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
      const rows = await harness.db.select().from(users).where(eq(users.email, 'taken@example.com'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(existing.id);
      expect(rows[0]?.idpSubject).not.toBe('unverified-subject');
    } finally {
      oidc.setIdentity(identity);
    }
  });

  it('logs out, deletes the session and returns the RP-initiated logout URL', async () => {
    const { sessionCookie } = await login();
    const logout = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: sessionCookie, origin: harness.config.publicUrl },
    });
    expect(logout.statusCode).toBe(200);
    const body = logout.json<{ redirectUrl: string | null }>();
    expect(body.redirectUrl).toContain('/logout');
    const me = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookie },
    });
    expect(me.statusCode).toBe(401);
  });
});
