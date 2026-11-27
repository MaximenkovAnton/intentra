import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32).optional(),
  AUTH_MODE: z.enum(['oidc', 'dev']).optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_ADMIN_GROUP: z.string().min(1).default('intentra-admins'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FALKORDB_URL: z.string().min(1).default('redis://localhost:6379'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().min(1).optional(),
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),
  MEMORY_EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
  MEMORY_INTERNAL_TOKEN: z.string().min(16).optional(),
  MEMORY_OUTBOX_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  RELEASE_PUBLISH_TOKEN: z.string().min(16).optional(),
  RELEASE_CACHE_DIR: z.string().min(1).default('/data/releases'),
  RELEASE_MAX_ARTIFACT_BYTES: z.coerce.number().int().min(1).default(268_435_456),
  GITHUB_RELEASE_TOKEN: z.string().min(1).optional(),
});

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly adminGroup: string;
}

export interface MemoryConfig {
  readonly falkordbUrl: string;
  readonly graphName: string;
  readonly qdrantUrl: string;
  readonly qdrantApiKey: string | null;
  readonly ollamaUrl: string;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly timeoutMs: number;
  readonly internalToken: string | null;
  readonly outboxIntervalMs: number;
}

export interface ReleaseConfig {
  readonly publishToken: string | null;
  readonly cacheDir: string;
  readonly maxArtifactBytes: number;
  readonly githubToken: string | null;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly authMode: 'oidc' | 'dev';
  readonly oidc: OidcConfig | null;
  readonly logLevel: string;
  readonly cookieSecure: boolean;
  readonly memory: MemoryConfig;
  readonly release: ReleaseConfig;
}

const GRAPH_NAME = 'intentra';
const EMBEDDING_DIMENSION = 1024;
const MEMORY_TIMEOUT_MS = 10_000;

const memoryConfig = (value: z.infer<typeof EnvSchema>): MemoryConfig => ({
  falkordbUrl: value.FALKORDB_URL,
  graphName: GRAPH_NAME,
  qdrantUrl: value.QDRANT_URL,
  qdrantApiKey: value.QDRANT_API_KEY ?? null,
  ollamaUrl: value.OLLAMA_URL,
  embeddingModel: value.MEMORY_EMBEDDING_MODEL,
  embeddingDimension: EMBEDDING_DIMENSION,
  timeoutMs: MEMORY_TIMEOUT_MS,
  internalToken: value.MEMORY_INTERNAL_TOKEN ?? null,
  outboxIntervalMs: value.MEMORY_OUTBOX_INTERVAL_MS,
});

const releaseConfig = (value: z.infer<typeof EnvSchema>): ReleaseConfig => ({
  publishToken: value.RELEASE_PUBLISH_TOKEN ?? null,
  cacheDir: value.RELEASE_CACHE_DIR,
  maxArtifactBytes: value.RELEASE_MAX_ARTIFACT_BYTES,
  githubToken: value.GITHUB_RELEASE_TOKEN ?? null,
});

const DEV_SESSION_SECRET = 'intentra-development-session-secret-000000';
const DEFAULT_OIDC_REDIRECT = (publicUrl: string) => `${publicUrl.replace(/\/$/, '')}/api/auth/callback`;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = EnvSchema.safeParse(definedEnv);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`invalid environment: ${details}`);
  }
  const value = parsed.data;
  const isProduction = value.NODE_ENV === 'production';
  const authMode = value.AUTH_MODE ?? (isProduction || value.OIDC_ISSUER ? 'oidc' : 'dev');

  if (isProduction && authMode === 'dev') {
    throw new ConfigError('AUTH_MODE=dev is not allowed in production');
  }
  if (isProduction && !value.SESSION_SECRET) {
    throw new ConfigError('SESSION_SECRET is required in production');
  }
  if (isProduction && value.OIDC_ISSUER !== undefined && !value.OIDC_ISSUER.startsWith('https:')) {
    throw new ConfigError('OIDC_ISSUER must use https in production');
  }

  if (authMode === 'dev') {
    return {
      nodeEnv: value.NODE_ENV,
      host: value.HOST,
      port: value.PORT,
      publicUrl: value.PUBLIC_URL,
      databaseUrl: value.DATABASE_URL,
      sessionSecret: value.SESSION_SECRET ?? DEV_SESSION_SECRET,
      authMode,
      oidc: null,
      logLevel: value.LOG_LEVEL,
      cookieSecure: isProduction,
      memory: memoryConfig(value),
      release: releaseConfig(value),
    };
  }

  if (!value.OIDC_ISSUER || !value.OIDC_CLIENT_ID || !value.OIDC_CLIENT_SECRET || !value.SESSION_SECRET) {
    const missing = [
      !value.OIDC_ISSUER ? 'OIDC_ISSUER' : null,
      !value.OIDC_CLIENT_ID ? 'OIDC_CLIENT_ID' : null,
      !value.OIDC_CLIENT_SECRET ? 'OIDC_CLIENT_SECRET' : null,
      !value.SESSION_SECRET ? 'SESSION_SECRET' : null,
    ].filter((name): name is string => name !== null);
    throw new ConfigError(`OIDC mode requires ${missing.join(', ')}`);
  }

  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    publicUrl: value.PUBLIC_URL,
    databaseUrl: value.DATABASE_URL,
    sessionSecret: value.SESSION_SECRET,
    authMode,
    oidc: {
      issuer: value.OIDC_ISSUER,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      redirectUri: value.OIDC_REDIRECT_URI ?? DEFAULT_OIDC_REDIRECT(value.PUBLIC_URL),
      adminGroup: value.OIDC_ADMIN_GROUP,
    },
    logLevel: value.LOG_LEVEL,
    cookieSecure: isProduction,
    memory: memoryConfig(value),
    release: releaseConfig(value),
  };
}
