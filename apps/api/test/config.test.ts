import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/intentra',
  SESSION_SECRET: 'a-session-secret-that-is-long-enough',
};

describe('configuration', () => {
  it('defaults to dev auth outside production and keeps OIDC disabled', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'development', PUBLIC_URL: 'http://localhost:5173' });
    expect(config.authMode).toBe('dev');
    expect(config.oidc).toBeNull();
    expect(config.cookieSecure).toBe(false);
  });

  it('refuses to start production without OIDC configuration', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/OIDC_ISSUER/);
  });

  it('refuses dev auth in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        AUTH_MODE: 'dev',
        OIDC_ISSUER: 'https://idp.example.com',
        OIDC_CLIENT_ID: 'intentra',
        OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/AUTH_MODE=dev/);
  });

  it('requires a session secret in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: base.DATABASE_URL,
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://idp.example.com',
        OIDC_CLIENT_ID: 'intentra',
        OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('builds the OIDC configuration and derives the redirect URI', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      PUBLIC_URL: 'https://intentra.example.com',
      OIDC_ISSUER: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'intentra',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_ADMIN_GROUP: 'intentra-admins',
    });
    expect(config.authMode).toBe('oidc');
    expect(config.cookieSecure).toBe(true);
    expect(config.oidc).toMatchObject({
      issuer: 'https://idp.example.com',
      clientId: 'intentra',
      redirectUri: 'https://intentra.example.com/api/auth/callback',
      adminGroup: 'intentra-admins',
    });
  });

  it('rejects a plaintext OIDC issuer in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        PUBLIC_URL: 'https://intentra.example.com',
        OIDC_ISSUER: 'http://idp.example.com',
        OIDC_CLIENT_ID: 'intentra',
        OIDC_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/https/);
  });

  it('selects OIDC from a configured issuer even when AUTH_MODE is unset', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'test',
      OIDC_ISSUER: 'http://localhost:9090',
      OIDC_CLIENT_ID: 'intentra',
      OIDC_CLIENT_SECRET: 'secret',
    });
    expect(config.authMode).toBe('oidc');
    expect(config.oidc).not.toBeNull();
  });

  it('rejects invalid values with one ConfigError', () => {
    expect(() => loadConfig({ DATABASE_URL: '', PORT: 'not-a-port' })).toThrow(ConfigError);
  });

  it('reads release configuration with defaults and treats an empty publish token as unset', () => {
    const defaults = loadConfig({ ...base, NODE_ENV: 'test' });
    expect(defaults.release).toEqual({
      publishToken: null,
      cacheDir: '/data/releases',
      maxArtifactBytes: 268_435_456,
      githubToken: null,
    });

    const overridden = loadConfig({
      ...base,
      NODE_ENV: 'test',
      RELEASE_CACHE_DIR: '/tmp/releases',
      RELEASE_MAX_ARTIFACT_BYTES: '1024',
      RELEASE_PUBLISH_TOKEN: 'test-publish-token',
      GITHUB_RELEASE_TOKEN: 'gh-token',
    });
    expect(overridden.release).toEqual({
      publishToken: 'test-publish-token',
      cacheDir: '/tmp/releases',
      maxArtifactBytes: 1024,
      githubToken: 'gh-token',
    });

    expect(loadConfig({ ...base, NODE_ENV: 'test', RELEASE_PUBLISH_TOKEN: '' }).release.publishToken).toBeNull();
  });

  it('treats empty optional values from compose interpolation as unset', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'development',
      OIDC_ISSUER: '',
      QDRANT_API_KEY: '',
      MEMORY_INTERNAL_TOKEN: '',
    });
    expect(config.authMode).toBe('dev');
    expect(config.memory.qdrantApiKey).toBeNull();
    expect(config.memory.internalToken).toBeNull();
  });
});
