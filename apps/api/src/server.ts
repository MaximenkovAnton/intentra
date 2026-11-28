import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/client.js';
import { buildApp } from './app.js';
import { EventBus } from './events/bus.js';
import { createOidcService } from './auth/oidc.js';
import { createMemory } from './memory/index.js';
import { createReleaseService } from './services/releases.js';
import { createGitHubArtifactSource, createReleaseArtifacts } from './services/release-artifacts.js';

const RELEASE_PUBLIC_KEY_PATH = fileURLToPath(
  new URL('../../../crates/runner-core/keys/release.pub', import.meta.url),
);
const ARTIFACT_FETCH_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { db, pool } = createDatabase(config.databaseUrl);
  const oidc = config.oidc ? await createOidcService(config.oidc, config.publicUrl) : null;
  const memory = createMemory({ config, db, logger, now: () => new Date() });
  const now = (): Date => new Date();
  const releases = createReleaseService({
    db,
    now,
    publicKeyBase64: (await readFile(RELEASE_PUBLIC_KEY_PATH, 'utf8')).trim(),
    maxArtifactBytes: config.release.maxArtifactBytes,
  });
  const releaseArtifacts = createReleaseArtifacts({
    cacheDir: config.release.cacheDir,
    maxBytes: config.release.maxArtifactBytes,
    timeoutMs: ARTIFACT_FETCH_TIMEOUT_MS,
    source: createGitHubArtifactSource(config.release.githubToken),
  });
  const app = await buildApp({
    config,
    db,
    pool,
    logger,
    oidc,
    events: new EventBus(),
    memory,
    releases,
    releaseArtifacts,
    now,
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
