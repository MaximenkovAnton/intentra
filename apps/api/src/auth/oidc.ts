import * as client from 'openid-client';
import type { OidcConfig } from '../config.js';
import { HttpError } from '../errors.js';
import type { PendingOidcState } from './state.js';

export interface OidcIdentity {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly groups: string[];
}

export interface OidcService {
  createAuthorizationRequest(redirectPath: string): Promise<{ url: URL; pending: PendingOidcState }>;
  completeLogin(callbackUrl: URL, pending: PendingOidcState): Promise<OidcIdentity>;
  endSessionUrl(): URL | null;
}

const OIDC_SCOPES = 'openid profile email groups';

const readString = (claims: Record<string, unknown>, key: string): string | null => {
  const value = claims[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const normalizeGroups = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
};

export async function createOidcService(config: OidcConfig, publicUrl: string): Promise<OidcService> {
  const issuerUrl = new URL(config.issuer);
  // shortcut: plain HTTP issuers are accepted for local/dev Pocket ID; production config uses HTTPS.
  const discoveryOptions = issuerUrl.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : undefined;
  const configuration = await client.discovery(
    issuerUrl,
    config.clientId,
    {},
    client.ClientSecretPost(config.clientSecret),
    discoveryOptions,
  );

  return {
    async createAuthorizationRequest(redirectPath: string) {
      const state = client.randomState();
      const nonce = client.randomNonce();
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const url = client.buildAuthorizationUrl(configuration, {
        redirect_uri: config.redirectUri,
        scope: OIDC_SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url, pending: { state, nonce, codeVerifier, redirectPath } };
    },

    async completeLogin(callbackUrl: URL, pending: PendingOidcState): Promise<OidcIdentity> {
      const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new HttpError('AUTH_REQUIRED', 'OIDC response has no ID token');
      if (claims.iss !== config.issuer) throw new HttpError('AUTH_REQUIRED', 'Unexpected OIDC issuer');
      const subject = typeof claims.sub === 'string' ? claims.sub : '';
      const email = readString(claims, 'email');
      if (!subject || !email) throw new HttpError('AUTH_REQUIRED', 'OIDC identity has no subject or email');
      const name = readString(claims, 'name') ?? readString(claims, 'preferred_username') ?? email;
      return {
        subject,
        email,
        emailVerified: claims.email_verified === true,
        name,
        avatarUrl: readString(claims, 'picture'),
        groups: normalizeGroups(claims.groups),
      };
    },

    endSessionUrl(): URL | null {
      const metadata = configuration.serverMetadata();
      if (!metadata.end_session_endpoint) return null;
      try {
        return client.buildEndSessionUrl(configuration, {
          post_logout_redirect_uri: `${publicUrl.replace(/\/$/, '')}/login`,
        });
      } catch {
        return null;
      }
    },
  };
}
