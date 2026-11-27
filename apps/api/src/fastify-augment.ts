import type { IntentRow, ProjectRow, RunnerRow } from './db/schema.js';
import type { AuthUser } from './auth/session.js';
import type { Orchestrator } from './orchestrator/service.js';

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator: Orchestrator;
  }

  interface FastifyRequest {
    user: AuthUser | null;
    project: ProjectRow | null;
    intent: IntentRow | null;
    runner: RunnerRow | null;
  }
}
