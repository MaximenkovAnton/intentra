import { z } from 'zod';
import { asc, eq, lte } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { outbox } from '../db/schema.js';
import { GRAPH_KINDS, MEMORY_RELATIONS, type GraphParam } from './types.js';

const GraphParamSchema: z.ZodType<GraphParam> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(GraphParamSchema),
    z.record(z.string(), GraphParamSchema),
  ]),
);

export const NodeUpsertSchema = z.object({
  kind: z.enum(GRAPH_KINDS),
  projectId: z.string().uuid(),
  key: z.string().min(1),
  props: z.record(z.string(), GraphParamSchema),
});

export const EdgeUpsertSchema = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
  relation: z.enum(MEMORY_RELATIONS),
  props: z.record(z.string(), GraphParamSchema).optional(),
});

export const OutboxPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('graph.node'), node: NodeUpsertSchema }),
  z.object({ type: z.literal('graph.edge'), edge: EdgeUpsertSchema }),
  z.object({
    type: z.literal('qdrant.point'),
    point: z.object({
      id: z.string().uuid(),
      projectId: z.string().uuid(),
      nodeId: z.string().uuid(),
      kind: z.string(),
      status: z.string(),
      text: z.string(),
      path: z.string().optional(),
      createdAt: z.string(),
    }),
  }),
]);

export type OutboxPayload = z.infer<typeof OutboxPayloadSchema>;

export interface OutboxRow {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export type OutboxHandler = (payload: OutboxPayload) => Promise<void>;

export interface OutboxStore {
  enqueue(payload: OutboxPayload): Promise<void>;
  due(now: Date, limit: number): Promise<readonly OutboxRow[]>;
  complete(id: string): Promise<void>;
  fail(id: string, attempts: number, nextAttemptAt: Date): Promise<void>;
}

export class DbOutboxStore implements OutboxStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, now: () => Date) {
    this.db = db;
    this.now = now;
  }

  async enqueue(payload: OutboxPayload): Promise<void> {
    await this.db.insert(outbox).values({
      kind: payload.type,
      payload,
      nextAttemptAt: this.now(),
    });
  }

  async due(now: Date, limit: number): Promise<readonly OutboxRow[]> {
    const rows = await this.db
      .select({ id: outbox.id, kind: outbox.kind, payload: outbox.payload, attempts: outbox.attempts })
      .from(outbox)
      .where(lte(outbox.nextAttemptAt, now))
      .orderBy(asc(outbox.nextAttemptAt), asc(outbox.createdAt))
      .limit(limit);
    return rows;
  }

  async complete(id: string): Promise<void> {
    await this.db.delete(outbox).where(eq(outbox.id, id));
  }

  async fail(id: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    await this.db.update(outbox).set({ attempts, nextAttemptAt }).where(eq(outbox.id, id));
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(1_000 * 2 ** attempts, 300_000);
}

export class OutboxWorker {
  private readonly store: OutboxStore;
  private readonly handler: OutboxHandler;
  private readonly logger: FastifyBaseLogger;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(input: {
    readonly store: OutboxStore;
    readonly handler: OutboxHandler;
    readonly logger: FastifyBaseLogger;
    readonly now: () => Date;
    readonly intervalMs: number;
  }) {
    this.store = input.store;
    this.handler = input.handler;
    this.logger = input.logger;
    this.now = input.now;
    this.intervalMs = input.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.name : 'unknown' },
          'outbox tick failed',
        );
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async tick(limit = 25): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      const rows = await this.store.due(this.now(), limit);
      for (const row of rows) {
        const parsed = OutboxPayloadSchema.safeParse(row.payload);
        if (!parsed.success) {
          this.logger.error({ outboxId: row.id, kind: row.kind }, 'outbox payload is invalid');
          await this.store.fail(row.id, row.attempts + 1, new Date(this.now().getTime() + backoffMs(row.attempts + 1)));
          continue;
        }
        try {
          await this.handler(parsed.data);
          await this.store.complete(row.id);
          processed += 1;
        } catch (error: unknown) {
          const attempts = row.attempts + 1;
          await this.store.fail(row.id, attempts, new Date(this.now().getTime() + backoffMs(attempts)));
          this.logger.warn(
            { outboxId: row.id, kind: row.kind, attempts, error: error instanceof Error ? error.name : 'unknown' },
            'outbox replay failed',
          );
        }
      }
    } finally {
      this.running = false;
    }
    return processed;
  }
}
