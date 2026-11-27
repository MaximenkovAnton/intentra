import type { FastifyBaseLogger } from 'fastify';
import type { MemoryService } from './types.js';

export interface ServiceState {
  readonly ok: boolean;
  readonly since: string;
  readonly error: string | null;
}

export interface DegradedSnapshot {
  readonly degraded: boolean;
  readonly services: Readonly<Record<MemoryService, ServiceState>>;
}

const SERVICES: readonly MemoryService[] = ['falkordb', 'qdrant', 'ollama'];

const describe = (error: unknown): string => {
  if (error instanceof Error) return error.name;
  return 'unknown';
};

export class DegradedRegistry {
  private readonly states = new Map<MemoryService, ServiceState>();
  private readonly now: () => Date;
  private readonly logger: FastifyBaseLogger;

  constructor(now: () => Date, logger: FastifyBaseLogger) {
    this.now = now;
    this.logger = logger;
    const since = now().toISOString();
    for (const service of SERVICES) this.states.set(service, { ok: true, since, error: null });
  }

  markUp(service: MemoryService): void {
    const state = this.state(service);
    if (state.ok) return;
    this.states.set(service, { ok: true, since: this.now().toISOString(), error: null });
    this.logger.info({ service }, 'memory service recovered');
  }

  markDown(service: MemoryService, error: unknown): void {
    const state = this.state(service);
    if (!state.ok) return;
    this.states.set(service, { ok: false, since: this.now().toISOString(), error: describe(error) });
    this.logger.warn({ service, error: describe(error) }, 'memory service degraded');
  }

  isUp(service: MemoryService): boolean {
    return this.state(service).ok;
  }

  snapshot(): DegradedSnapshot {
    const services = {} as Record<MemoryService, ServiceState>;
    let degraded = false;
    for (const service of SERVICES) {
      const state = this.state(service);
      services[service] = state;
      if (!state.ok) degraded = true;
    }
    return { degraded, services };
  }

  private state(service: MemoryService): ServiceState {
    const state = this.states.get(service);
    if (!state) throw new Error(`unknown memory service ${service}`);
    return state;
  }
}
