import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  ClaimStatus,
  DecisionStatus,
  EscalationOption,
  EscalationStatus,
  FindingClass,
  FindingStatus,
  IntentStatus,
  JobStatus,
  MemoryCodeRef,
  MemoryProbe,
  ProjectRole,
  RunnerStatus,
  SpecStatus,
  StageKind,
  StageStatus,
  VerdictDecision,
} from '@intentra/contracts';

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    idpSubject: text('idp_subject').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    avatarUrl: text('avatar_url'),
    groups: jsonb('groups').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    locale: text('locale').$type<'ru' | 'en'>().notNull().default('ru'),
    isAdmin: boolean('is_admin').notNull().default(false),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('users_idp_subject_uq').on(table.idpSubject),
    uniqueIndex('users_email_uq').on(table.email),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: at('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    authMethod: text('auth_method').$type<'oidc' | 'dev'>().notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_expires_at_idx').on(table.expiresAt),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    repoUrl: text('repo_url'),
    defaultBranch: text('default_branch').notNull().default('main'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    archivedAt: at('archived_at'),
  },
  (table) => [
    uniqueIndex('projects_key_uq').on(table.key),
    index('projects_created_at_idx').on(table.createdAt),
    index('projects_created_by_idx').on(table.createdBy),
  ],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<ProjectRole>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index('project_members_user_idx').on(table.userId),
    index('project_members_project_created_idx').on(table.projectId, table.createdAt),
  ],
);

export const runners = pgTable(
  'runners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    os: text('os').notNull(),
    arch: text('arch').notNull(),
    version: text('version').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text('status').$type<RunnerStatus>().notNull().default('offline'),
    lastSeenAt: at('last_seen_at'),
    revokedAt: at('revoked_at'),
  },
  (table) => [
    uniqueIndex('runners_token_hash_uq').on(table.tokenHash),
    index('runners_owner_idx').on(table.ownerUserId),
  ],
);

export const runnerRegistrationTokens = pgTable(
  'runner_registration_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('runner_registration_tokens_hash_uq').on(table.tokenHash),
    index('runner_registration_tokens_expires_idx').on(table.expiresAt),
    index('runner_registration_tokens_project_idx').on(table.projectId),
    index('runner_registration_tokens_created_by_idx').on(table.createdBy),
  ],
);

export const projectRunners = pgTable(
  'project_runners',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runnerId: uuid('runner_id')
      .notNull()
      .references(() => runners.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.runnerId] }),
    uniqueIndex('project_runners_runner_project_uq').on(table.runnerId, table.projectId),
  ],
);

export const intents = pgTable(
  'intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    statement: text('statement').notNull(),
    status: text('status').$type<IntentStatus>().notNull().default('draft'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    acceptedAt: at('accepted_at'),
  },
  (table) => [
    index('intents_project_status_created_idx').on(table.projectId, table.status, table.createdAt),
    index('intents_created_at_idx').on(table.createdAt),
    index('intents_created_by_idx').on(table.createdBy),
  ],
);

export const intentMessages = pgTable(
  'intent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('intent_messages_intent_created_idx').on(table.intentId, table.createdAt)],
);

export const specs = pgTable(
  'specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    bodyMd: text('body_md').notNull(),
    status: text('status').$type<SpecStatus>().notNull().default('draft'),
    sha256: text('sha256').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('specs_intent_version_uq').on(table.intentId, table.version),
    index('specs_intent_status_idx').on(table.intentId, table.status),
  ],
);

export const requirements = pgTable(
  'requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    specId: uuid('spec_id')
      .notNull()
      .references(() => specs.id, { onDelete: 'cascade' }),
    acId: text('ac_id').notNull(),
    text: text('text').notNull(),
    kind: text('kind').$type<'functional' | 'nonfunctional'>().notNull(),
    status: text('status').$type<'open' | 'met' | 'waived'>().notNull().default('open'),
  },
  (table) => [uniqueIndex('requirements_spec_ac_uq').on(table.specId, table.acId)],
);

export const dodRows = pgTable(
  'dod_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requirementId: uuid('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
    testRef: text('test_ref'),
    probe: text('probe'),
    status: text('status').$type<'pending' | 'pass' | 'fail'>().notNull().default('pending'),
  },
  (table) => [index('dod_rows_requirement_idx').on(table.requirementId)],
);

export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id').references(() => intents.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    rationale: text('rationale'),
    alternatives: jsonb('alternatives').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    status: text('status').$type<DecisionStatus>().notNull().default('accepted'),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => decisions.id, { onDelete: 'set null' }),
    authorKind: text('author_kind').notNull(),
    authorId: text('author_id').notNull(),
    evidence: text('evidence'),
    createdAt: createdAt(),
  },
  (table) => [
    index('decisions_project_created_idx').on(table.projectId, table.createdAt),
    index('decisions_intent_idx').on(table.intentId),
    index('decisions_supersedes_idx').on(table.supersedesId),
  ],
);

export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    question: text('question').notNull(),
    context: text('context').notNull(),
    options: jsonb('options').$type<EscalationOption[]>().notNull().default(sql`'[]'::jsonb`),
    recommendation: text('recommendation'),
    defaultOption: text('default_option').notNull(),
    status: text('status').$type<EscalationStatus>().notNull().default('open'),
    answerOption: text('answer_option'),
    answerNote: text('answer_note'),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: at('answered_at'),
    decisionId: uuid('decision_id').references(() => decisions.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (table) => [
    index('escalations_intent_status_idx').on(table.intentId, table.status),
    index('escalations_answered_by_idx').on(table.answeredBy),
    index('escalations_decision_idx').on(table.decisionId),
  ],
);

export const stages = pgTable(
  'stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<StageKind>().notNull(),
    status: text('status').$type<StageStatus>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
    error: text('error'),
  },
  (table) => [index('stages_intent_status_idx').on(table.intentId, table.status)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id').references(() => stages.id, { onDelete: 'set null' }),
    runnerId: uuid('runner_id').references(() => runners.id, { onDelete: 'set null' }),
    runtime: text('runtime').notNull(),
    status: text('status').$type<JobStatus>().notNull().default('queued'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    result: jsonb('result').$type<Record<string, unknown>>(),
    leaseUntil: at('lease_until'),
    attempt: integer('attempt').notNull().default(0),
    runnerSeq: integer('runner_seq'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: createdAt(),
    startedAt: at('started_at'),
    finishedAt: at('finished_at'),
  },
  (table) => [
    index('jobs_intent_status_idx').on(table.intentId, table.status),
    index('jobs_status_created_idx').on(table.status, table.createdAt),
    index('jobs_lease_until_idx').on(table.leaseUntil),
    index('jobs_stage_idx').on(table.stageId),
    index('jobs_runner_idx').on(table.runnerId),
  ],
);

export const findings = pgTable(
  'findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    role: text('role').notNull(),
    acId: text('ac_id'),
    class: text('class').$type<FindingClass>().notNull(),
    severity: text('severity').$type<'blocking' | 'nit'>().notNull(),
    requirement: text('requirement').notNull(),
    evidence: text('evidence'),
    requiredChange: text('required_change'),
    status: text('status').$type<FindingStatus>().notNull().default('open'),
    round: integer('round').notNull().default(1),
  },
  (table) => [
    index('findings_intent_status_idx').on(table.intentId, table.status),
    index('findings_job_idx').on(table.jobId),
  ],
);

export const verdicts = pgTable(
  'verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    decision: text('decision').$type<VerdictDecision>().notNull(),
    artifactSha256: text('artifact_sha256').notNull(),
    round: integer('round').notNull().default(1),
  },
  (table) => [index('verdicts_job_idx').on(table.jobId)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intents.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    uri: text('uri').notNull(),
    sha256: text('sha256'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('artifacts_intent_kind_idx').on(table.intentId, table.kind),
    index('artifacts_job_idx').on(table.jobId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('audit_log_at_idx').on(table.at), index('audit_log_action_idx').on(table.action)],
);

export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [index('outbox_next_attempt_idx').on(table.nextAttemptAt)],
);

export const embeddingCache = pgTable(
  'embedding_cache',
  {
    contentSha256: text('content_sha256').primaryKey(),
    vector: jsonb('vector').$type<number[]>().notNull(),
    model: text('model').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('embedding_cache_model_idx').on(table.model)],
);

export const memoryClaims = pgTable(
  'memory_claims',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id').references(() => intents.id, { onDelete: 'set null' }),
    key: text('key').notNull(),
    statement: text('statement').notNull(),
    probe: jsonb('probe').$type<MemoryProbe>().notNull(),
    expected: text('expected').notNull(),
    status: text('status').$type<ClaimStatus>().notNull().default('unverified'),
    codeRef: jsonb('code_ref').$type<MemoryCodeRef>(),
    verifiedBy: text('verified_by'),
    verifiedAt: at('verified_at'),
    commit: text('commit'),
    blobSha: text('blob_sha'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memory_claims_project_key_uq').on(table.projectId, table.key),
    index('memory_claims_project_status_idx').on(table.projectId, table.status),
    index('memory_claims_intent_idx').on(table.intentId),
  ],
);

export type MemoryClaimRow = typeof memoryClaims.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type RunnerRow = typeof runners.$inferSelect;
export type IntentRow = typeof intents.$inferSelect;
export type IntentMessageRow = typeof intentMessages.$inferSelect;
export type SpecRow = typeof specs.$inferSelect;
export type RequirementRow = typeof requirements.$inferSelect;
export type DodRowRow = typeof dodRows.$inferSelect;
export type DecisionRow = typeof decisions.$inferSelect;
export type EscalationRow = typeof escalations.$inferSelect;
export type StageRow = typeof stages.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type VerdictRow = typeof verdicts.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
