import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface MockIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
  groups: string[];
  emailVerified?: boolean;
}

export interface MockOidc {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  setIdentity(identity: MockIdentity): void;
  close(): Promise<void>;
}

const CLIENT_ID = 'intentra-test';
const CLIENT_SECRET = 'test-client-secret';
export const MOCK_REDIRECT_URI = 'http://localhost:8080/api/auth/callback';

interface AuthorizationCode {
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const base64url = (value: Buffer): string => value.toString('base64url');

export async function startMockOidc(initialIdentity: MockIdentity): Promise<MockOidc> {
  let identity = initialIdentity;
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'intentra-test-key';
  const codes = new Map<string, AuthorizationCode>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        jwks_uri: `${issuerUrl}/jwks`,
        end_session_endpoint: `${issuerUrl}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email', 'groups'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      sendJson(response, 200, { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] });
      return;
    }
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      const codeChallenge = url.searchParams.get('code_challenge') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const code = base64url(createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest());
      codes.set(code, { nonce, codeChallenge, redirectUri });
      const target = new URL(redirectUri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      response.writeHead(302, { location: target.toString() });
      response.end();
      return;
    }
    if (url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(request));
      if (body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) {
        sendJson(response, 401, { error: 'invalid_client' });
        return;
      }
      const code = body.get('code') ?? '';
      const pending = codes.get(code);
      if (!pending) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }
      codes.delete(code);
      const verifier = body.get('code_verifier') ?? '';
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      if (challenge !== pending.codeChallenge) {
        sendJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      const idToken = await new SignJWT({
        sub: identity.sub,
        email: identity.email,
        email_verified: identity.emailVerified ?? true,
        name: identity.name,
        ...(identity.picture ? { picture: identity.picture } : {}),
        groups: identity.groups,
        nonce: pending.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(issuerUrl)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      sendJson(response, 200, {
        access_token: 'mock-access-token',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock OIDC has no port');
  const issuerUrl = `http://127.0.0.1:${address.port}`;

  return {
    issuer: issuerUrl,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: MOCK_REDIRECT_URI,
    setIdentity(next: MockIdentity) {
      identity = next;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
