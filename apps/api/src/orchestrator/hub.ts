import { and, eq, isNull } from 'drizzle-orm';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  RunnerToCenterMessageSchema,
  type JobAnswer,
  type JobOffer,
  type RunnerToCenterMessage,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import { hashToken } from '../auth/session.js';
import { projectRunners, runners } from '../db/schema.js';
import { requeueRunnerJobs } from './jobs.js';

export const RUNNER_WS_PATH = '/api/runners/ws';

export interface RunnerConnectionView {
  readonly runnerId: string;
  readonly activeJobId: string | null;
  readonly projectIds: ReadonlySet<string>;
  readonly adapters: ReadonlySet<string>;
}

export interface RunnerControl {
  setActiveJob(jobId: string | null): void;
}

export interface RunnerHubHandler {
  onMessage(runnerId: string, message: RunnerToCenterMessage, control: RunnerControl): Promise<void>;
  onReady(runnerId: string): Promise<void>;
  onDisconnect(runnerId: string): Promise<void>;
}

export interface RunnerHub {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  setHandler(handler: RunnerHubHandler): void;
  sessions(): RunnerConnectionView[];
  sendOffer(runnerId: string, offer: JobOffer): boolean;
  sendCancel(runnerId: string, jobId: string, reason: string | undefined): boolean;
  sendAnswer(runnerId: string, answer: JobAnswer): boolean;
  online(runnerId: string): boolean;
  close(): void;
}

interface Connection {
  readonly runnerId: string;
  readonly ws: WebSocket;
  readonly projectIds: Set<string>;
  readonly adapters: Set<string>;
  activeJobId: string | null;
  hello: boolean;
  queue: Promise<void>;
}

const tokenFrom = (request: IncomingMessage): string | null => {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const [scheme, value] = authorization.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0) return value;
  }
  const url = new URL(request.url ?? '/', 'http://runner.invalid');
  const fromQuery = url.searchParams.get('token');
  return fromQuery !== null && fromQuery.length > 0 ? fromQuery : null;
};

const reject = (socket: Duplex, status: number, message: string): void => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

const send = (ws: WebSocket, payload: unknown): boolean => {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
};

export function createRunnerHub(deps: AppDeps): RunnerHub {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<string, Connection>();
  let handler: RunnerHubHandler | null = null;

  const publishRunner = (projectIds: Iterable<string>, data: Record<string, unknown>): void => {
    for (const projectId of projectIds) {
      deps.events.publish({ type: 'runner.updated', projectId, data });
    }
  };

  const loadBindings = async (runnerId: string): Promise<Set<string>> => {
    const rows = await deps.db
      .select({ projectId: projectRunners.projectId })
      .from(projectRunners)
      .where(eq(projectRunners.runnerId, runnerId));
    return new Set(rows.map((row) => row.projectId));
  };

  const markOnline = async (connection: Connection, hello: boolean): Promise<void> => {
    const now = deps.now();
    const [runner] = await deps.db
      .update(runners)
      .set({ status: 'online', lastSeenAt: now })
      .where(eq(runners.id, connection.runnerId))
      .returning();
    if (runner) {
      publishRunner(connection.projectIds, { runnerId: runner.id, status: 'online', version: runner.version });
    }
    if (hello) {
      deps.logger.info({ runnerId: connection.runnerId }, 'runner connected');
    }
  };

  const handleHello = async (connection: Connection, message: RunnerToCenterMessage): Promise<void> => {
    if (message.type !== 'hello') return;
    for (const adapter of message.adapters) connection.adapters.add(adapter.id);
    connection.hello = true;
    const [runner] = await deps.db
      .update(runners)
      .set({
        version: message.runnerVersion,
        os: message.os,
        arch: message.arch,
        capabilities: message.adapters.map((adapter) => adapter.id),
        status: 'online',
        lastSeenAt: deps.now(),
      })
      .where(eq(runners.id, connection.runnerId))
      .returning();
    if (runner) {
      publishRunner(connection.projectIds, {
        runnerId: runner.id,
        status: 'online',
        version: runner.version,
      });
    }
    if (handler) await handler.onReady(connection.runnerId);
  };

  const handleHeartbeat = async (connection: Connection): Promise<void> => {
    await deps.db
      .update(runners)
      .set({ status: 'online', lastSeenAt: deps.now() })
      .where(eq(runners.id, connection.runnerId));
  };

  const handleClose = async (connection: Connection): Promise<void> => {
    if (connections.get(connection.runnerId) !== connection) return;
    connections.delete(connection.runnerId);
    const now = deps.now();
    await deps.db
      .update(runners)
      .set({ status: 'offline', lastSeenAt: now })
      .where(eq(runners.id, connection.runnerId));
    publishRunner(connection.projectIds, { runnerId: connection.runnerId, status: 'offline' });
    await requeueRunnerJobs(deps, connection.runnerId, now);
    deps.logger.info({ runnerId: connection.runnerId }, 'runner disconnected');
    if (handler) await handler.onDisconnect(connection.runnerId);
  };

  const handleMessage = async (connection: Connection, raw: RawData): Promise<void> => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString());
    } catch {
      connection.ws.close(4400, 'invalid JSON');
      return;
    }
    const parsed = RunnerToCenterMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      deps.logger.warn({ runnerId: connection.runnerId }, 'runner sent an invalid message');
      connection.ws.close(4400, 'invalid message');
      return;
    }
    const message = parsed.data;
    if (message.type === 'hello') {
      await handleHello(connection, message);
      return;
    }
    if (message.type === 'heartbeat') {
      await handleHeartbeat(connection);
      return;
    }
    if (!connection.hello) {
      connection.ws.close(4400, 'hello required');
      return;
    }
    const control: RunnerControl = {
      setActiveJob: (jobId) => {
        connection.activeJobId = jobId;
      },
    };
    if (handler) await handler.onMessage(connection.runnerId, message, control);
  };

  const register = (ws: WebSocket, runnerId: string, projectIds: Set<string>): void => {
    const previous = connections.get(runnerId);
    if (previous) previous.ws.close(4401, 'replaced by a newer connection');
    const connection: Connection = {
      runnerId,
      ws,
      projectIds,
      adapters: new Set(),
      activeJobId: null,
      hello: false,
      queue: Promise.resolve(),
    };
    connections.set(runnerId, connection);

    ws.on('message', (data) => {
      connection.queue = connection.queue
        .then(() => handleMessage(connection, data))
        .catch((error: unknown) => {
          deps.logger.warn({ err: error, runnerId }, 'runner message failed');
        });
    });
    ws.on('close', () => {
      void handleClose(connection).catch((error: unknown) => {
        deps.logger.warn({ err: error, runnerId }, 'runner disconnect failed');
      });
    });
    ws.on('error', (error) => {
      deps.logger.warn({ err: error, runnerId }, 'runner socket error');
    });
    void markOnline(connection, false);
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? '/', 'http://runner.invalid');
    if (url.pathname !== RUNNER_WS_PATH) return;
    const token = tokenFrom(request);
    if (token === null) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    void (async () => {
      const [runner] = await deps.db
        .select()
        .from(runners)
        .where(and(eq(runners.tokenHash, hashToken(token)), isNull(runners.revokedAt)))
        .limit(1);
      if (!runner) {
        reject(socket, 401, 'Unauthorized');
        return;
      }
      const projectIds = await loadBindings(runner.id);
      wss.handleUpgrade(request, socket, head, (ws) => {
        register(ws, runner.id, projectIds);
      });
    })().catch((error: unknown) => {
      deps.logger.warn({ err: error }, 'runner upgrade failed');
      socket.destroy();
    });
  };

  return {
    handleUpgrade,
    setHandler: (next) => {
      handler = next;
    },
    sessions: () =>
      [...connections.values()].map((connection) => ({
        runnerId: connection.runnerId,
        activeJobId: connection.activeJobId,
        projectIds: new Set(connection.projectIds),
        adapters: new Set(connection.adapters),
      })),
    sendOffer: (runnerId, offer) => {
      const connection = connections.get(runnerId);
      return connection !== undefined && send(connection.ws, offer);
    },
    sendCancel: (runnerId, jobId, reason) => {
      const connection = connections.get(runnerId);
      if (!connection) return false;
      return send(connection.ws, { type: 'job.cancel', jobId, ...(reason === undefined ? {} : { reason }) });
    },
    sendAnswer: (runnerId, answer) => {
      const connection = connections.get(runnerId);
      return connection !== undefined && send(connection.ws, answer);
    },
    online: (runnerId) => connections.has(runnerId),
    close: () => {
      handler = null;
      for (const connection of connections.values()) connection.ws.terminate();
      connections.clear();
      wss.close();
    },
  };
}
