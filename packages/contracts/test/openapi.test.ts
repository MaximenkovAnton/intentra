import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
    '/api/admin/releases',
    '/api/admin/releases/{version}/yank',
    '/api/runners/update',
    '/api/runners/update/artifact/{fileName}',
    '/api/runners/update/report',
    '/api/runners/{id}/update-policy',
  ])('documents %s', (path) => {
    expect(document.paths?.[path]).toBeDefined();
  });

  it('declares the session cookie security scheme and API error component', () => {
    expect(document.components?.securitySchemes?.session).toMatchObject({
      type: 'apiKey',
      in: 'cookie',
      name: 'intentra_session',
    });
    expect(document.components?.securitySchemes?.releasePublish).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.components?.securitySchemes?.runnerToken).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(document.components?.schemas?.ApiError).toBeDefined();
  });

  it('documents the release channel endpoints', () => {
    expect(document.paths?.['/api/admin/releases']?.post).toBeDefined();
    expect(document.paths?.['/api/admin/releases/{version}/yank']?.post).toBeDefined();
    expect(document.paths?.['/api/runners/update']?.get).toBeDefined();
    expect(document.paths?.['/api/runners/update/artifact/{fileName}']?.get).toBeDefined();
    expect(document.paths?.['/api/runners/update/report']?.post).toBeDefined();
    expect(document.paths?.['/api/runners/{id}/update-policy']?.put).toBeDefined();
  });

  it('registers the release schemas as OpenAPI components', () => {
    for (const name of [
      'UpdateAsset',
      'UpdateManifest',
      'ReleasePublishInput',
      'RunnerUpdate',
      'UpdatePolicyInput',
      'UpdateReportInput',
      'Release',
      'ReleaseYankInput',
      'RunnerLastUpdate',
    ]) {
      expect(document.components?.schemas?.[name]).toBeDefined();
    }
  });

  it('keeps the committed openapi.json in sync with the generator', () => {
    const committed = readFileSync(fileURLToPath(new URL('../openapi.json', import.meta.url)), 'utf8');
    expect(committed).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });
});
