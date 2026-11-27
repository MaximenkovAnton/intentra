import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/client.js';
import { buildApp } from './app.js';
import { EventBus } from './events/bus.js';
import { createOidcService } from './auth/oidc.js';
import { createMemory } from './memory/index.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { db, pool } = createDatabase(config.databaseUrl);
  const oidc = config.oidc ? await createOidcService(config.oidc, config.publicUrl) : null;
  const memory = createMemory({ config, db, logger, now: () => new Date() });
  const app = await buildApp({
    config,
    db,
    pool,
    logger,
    oidc,
    events: new EventBus(),
    memory,
    now: () => new Date(),
  });

  app.orchestrator.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await memory.stop();
    await pool.end();
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await app.listen({ host: config.host, port: config.port });
  memory.start();
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown startup error';
  process.stderr.write(`intentra-api failed to start: ${message}\n`);
  process.exitCode = 1;
}
