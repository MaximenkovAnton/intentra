import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/client.js';
import type { OidcService } from './auth/oidc.js';
import type { EventBus } from './events/bus.js';
import type { MemoryApi } from './memory/index.js';

export interface AppDeps {
  readonly config: AppConfig;
  readonly db: Database;
  readonly pool: Pool;
  readonly logger: FastifyBaseLogger;
  readonly oidc: OidcService | null;
  readonly events: EventBus;
  readonly memory: MemoryApi;
  readonly now: () => Date;
}
