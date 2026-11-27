import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  authCookie,
  createHarness,
  hasDatabase,
  resetDatabase,
  seedProject,
  seedSession,
  seedUser,
  type Harness,
} from './harness.js';
import { projectMembers } from '../src/db/schema.js';
import { EventBus } from '../src/events/bus.js';

interface EventStream {
  readUntil(predicate: (buffer: string) => boolean): Promise<string>;
  waitForEnd(): Promise<string>;
  abort(): void;
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

const readWithTimeout = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadResult> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE read timed out')), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

async function openEventStream(address: string, cookie: string): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(`${address}/api/events?project=acme`, {
    headers: { cookie },
    signal: controller.signal,
  });
  if (response.status !== 200 || !response.body) throw new Error(`SSE handshake failed: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = async (): Promise<ReadResult> => {
    const result = await readWithTimeout(reader);
    if (!result.done) buffer += decoder.decode(result.value, { stream: true });
    return result;
  };
  return {
    async readUntil(predicate) {
      while (!predicate(buffer)) {
        if ((await pump()).done) throw new Error(`SSE stream ended before the expected frame: ${buffer}`);
      }
      return buffer;
    },
    async waitForEnd() {
      while (!(await pump()).done) {
        continue;
      }
      return buffer;
    },
    abort() {
      controller.abort();
    },
  };
}

describe.skipIf(!hasDatabase)('ops and error envelope', () => {
  let harness: Harness;
  let address = '';

  beforeAll(async () => {
    harness = await createHarness();
    address = await harness.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(async () => {
    await resetDatabase(harness.db);
  });

  it('answers healthz without touching the database', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers readyz when Postgres is reachable', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('serves a valid OpenAPI 3.1 document with the auth and resource routes', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/login',
        '/api/auth/callback',
        '/api/auth/logout',
        '/api/auth/me',
        '/api/projects',
        '/api/runners/register',
        '/api/events',
      ]),
    );
  });

  it('returns AUTH_REQUIRED in the shared error shape without a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/projects' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('streams project events to a member and rejects an outsider', async () => {
    const owner = await seedUser(harness.db);
    const project = await seedProject(harness.db, owner.id, 'acme');
    const cookie = authCookie(await seedSession(harness.db, owner.id)).cookie;
    const stream = await openEventStream(address, cookie);
    try {
      const event = harness.events.publish({
        type: 'runner.updated',
        projectId: project.id,
        data: { status: 'online' },
      });
      const frame = await stream.readUntil((buffer) => buffer.includes(`id: ${event.id}`));
      expect(frame).toContain(`event: runner.updated\ndata: ${JSON.stringify(event)}\n\n`);
    } finally {
      stream.abort();
    }

    const outsider = await seedUser(harness.db);
    const forbidden = await harness.app.inject({
      method: 'GET',
      url: '/api/events?project=acme',
      headers: authCookie(await seedSession(harness.db, outsider.id)),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('stops an open stream when the member is removed or the session ends', async () => {
    const owner = await seedUser(harness.db);
    const ownerToken = await seedSession(harness.db, owner.id);
    const project = await seedProject(harness.db, owner.id, 'acme');
    const viewer = await seedUser(harness.db);
    const viewerToken = await seedSession(harness.db, viewer.id);
    await harness.db.insert(projectMembers).values({ projectId: project.id, userId: viewer.id, role: 'viewer' });

    const ownerStream = await openEventStream(address, `intentra_session=${ownerToken}`);
    const viewerStream = await openEventStream(address, `intentra_session=${viewerToken}`);
    try {
      await harness.db
        .delete(projectMembers)
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, owner.id)));
      await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `intentra_session=${viewerToken}`, origin: harness.config.publicUrl },
      });
      const event = harness.events.publish({
        type: 'runner.updated',
        projectId: project.id,
        data: { status: 'offline' },
      });
      const [ownerBytes, viewerBytes] = await Promise.all([ownerStream.waitForEnd(), viewerStream.waitForEnd()]);
      expect(ownerBytes).not.toContain(event.id);
      expect(viewerBytes).not.toContain(event.id);
    } finally {
      ownerStream.abort();
      viewerStream.abort();
    }
  });

  it('returns VALIDATION with issues for a rejected body', async () => {
    const user = await seedUser(harness.db);
    const token = await seedSession(harness.db, user.id);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: authCookie(token),
      payload: { key: 'NOT VALID', name: '' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; details: unknown[] }>();
    expect(body.code).toBe('VALIDATION');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns NOT_FOUND in the shared error shape for unknown routes', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('event bus', () => {
  it('replays only events after the last seen id and filters by subscription', () => {
    const bus = new EventBus();
    const projectId = '00000000-0000-4000-8000-000000000000';
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.id));
    const first = bus.publish({ type: 'runner.updated', projectId, data: { status: 'offline' } });
    const second = bus.publish({ type: 'runner.updated', projectId, data: { status: 'online' } });
    expect(seen).toEqual([first.id, second.id]);
    expect(bus.replay(first.id).map((event) => event.id)).toEqual([second.id]);
    unsubscribe();
    bus.publish({ type: 'runner.updated', projectId, data: { status: 'revoked' } });
    expect(seen).toEqual([first.id, second.id]);
    expect(bus.replay('missing')).toEqual([]);
    expect(bus.replay(undefined)).toEqual([]);
  });
});
