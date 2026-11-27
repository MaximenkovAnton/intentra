import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/index.js';

describe('OpenAPI 3.1 document', () => {
  const document = buildOpenApiDocument();

  it('is an OpenAPI 3.1 document with info and servers', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('Intentra API');
    expect(document.servers).toBeDefined();
  });

  it.each([
    '/api/auth/login',
    '/api/auth/callback',
    '/api/auth/logout',
    '/api/auth/me',
    '/api/projects',
    '/api/projects/{key}',
    '/api/projects/{key}/members',
    '/api/runners',
    '/api/runners/register',
    '/api/runners/ws',
    '/metrics',
    '/api/runners/{id}/rotate-token',
    '/api/events',
    '/api/projects/{key}/intents',
    '/api/intents/{id}',
    '/api/intents/{id}/messages',
    '/api/intents/{id}/answer',
    '/api/intents/{id}/accept',
    '/api/intents/{id}/rework',
    '/api/intents/{id}/cancel',
    '/api/intents/{id}/retry',
    '/api/intents/{id}/spec',
    '/api/intents/{id}/findings',
    '/api/intents/{id}/plan',
    '/api/intents/{id}/jobs',
    '/api/intents/{id}/evidence',
  ])('documents %s', (path) => {
    expect(document.paths?.[path]).toBeDefined();
  });

  it('declares the session cookie security scheme and API error component', () => {
    expect(document.components?.securitySchemes?.session).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'intentra_session',
    });
    expect(document.components?.schemas?.ApiError).toBeDefined();
  });
});
