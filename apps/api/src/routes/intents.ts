import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  AnswerIntentInputSchema,
  ApiErrorSchema,
  CreateIntentInputSchema,
  EvidenceSchema,
  FindingListSchema,
  IntentAnswerResultSchema,
  IntentCardSchema,
  IntentDetailSchema,
  IntentListSchema,
  IntentMessageSchema,
  IntentSchema,
  JobListSchema,
  PlanSchema,
  PostIntentMessageInputSchema,
  ReworkIntentInputSchema,
  SpecBundleSchema,
} from '@intentra/contracts';
import type { AppDeps } from '../deps.js';
import type { Guards } from '../auth/rbac.js';
import { currentIntent, currentProject, currentUser } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import {
  toEscalationDto,
  toFindingDto,
  toIntentDto,
  toIntentMessageDto,
  toJobDto,
} from '../dto.js';
import {
  afterCreatedAt,
  createdAtText,
  decodeCursor,
  decodeIdCursor,
  encodeCursor,
  encodeIdCursor,
  pageOf,
} from '../pagination.js';
import { escalations, findings, intents, jobs } from '../db/schema.js';
import { readArtifactMeta } from '../intents/artifacts.js';
import {
  INTENT_CARD_ARTIFACT,
  createIntent,
  expireDueEscalations,
  loadSpecBundle,
  postMessage,
  readPlan,
  type Actor,
  type IntentDeps,
} from '../intents/service.js';

const ProjectParams = z.object({ key: z.string() });
const IntentParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'system:expiry' };

export function registerIntentRoutes(app: FastifyInstance, deps: AppDeps, guards: Guards): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const intentDeps: IntentDeps = { db: deps.db, events: deps.events, memory: deps.memory, now: deps.now };

  typed.get(
    '/api/projects/:key/intents',
    {
      preHandler: [guards.requireUser, guards.projectAccess('viewer')],
      schema: {
        params: ProjectParams,
        querystring: ListQuery,
        response: { 200: IntentListSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const project = currentProject(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const conditions = [eq(intents.projectId, project.id)];
      if (cursor) conditions.push(afterCreatedAt(intents.createdAt, intents.id, cursor));
      const rows = await deps.db
        .select({ intent: intents, cursorAt: createdAtText(intents.createdAt) })
        .from(intents)
        .where(and(...conditions))
        .orderBy(desc(intents.createdAt), desc(intents.id))
        .limit(limit + 1);
      const { page, nextCursor } = pageOf(rows, limit, (row) =>
        encodeCursor({ createdAt: row.cursorAt, id: row.intent.id }),
      );
      return { items: page.map((row) => toIntentDto(row.intent)), nextCursor };
    },
  );

  typed.post(
    '/api/projects/:key/intents',
    {
      preHandler: [guards.requireUser, guards.projectAccess('editor')],
      schema: {
        params: ProjectParams,
        body: CreateIntentInputSchema,
        response: {
          201: IntentSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const project = currentProject(request);
      const user = currentUser(request);
      const created = await createIntent(intentDeps, { kind: 'user', id: user.id }, {
        projectId: project.id,
        title: request.body.title,
        statement: request.body.statement,
      });
      await app.orchestrator.startIntake(created);
      reply.status(201);
      return toIntentDto(created);
    },
  );

  typed.get(
    '/api/intents/:id',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        response: {
          200: IntentDetailSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      await expireDueEscalations(intentDeps, SYSTEM_ACTOR, intent);
      const open = await deps.db
        .select()
        .from(escalations)
        .where(and(eq(escalations.intentId, intent.id), eq(escalations.status, 'open')))
        .orderBy(desc(escalations.createdAt));
      const meta = await readArtifactMeta(deps.db, intent.id, INTENT_CARD_ARTIFACT);
      const card = meta === null ? null : IntentCardSchema.safeParse(meta);
      return {
        intent: toIntentDto(intent),
        card: card !== null && card.success ? card.data : null,
        openEscalations: open.map(toEscalationDto),
      };
    },
  );

  typed.post(
    '/api/intents/:id/messages',
    {
      preHandler: [guards.requireUser, guards.intentAccess('editor')],
      schema: {
        params: IntentParams,
        body: PostIntentMessageInputSchema,
        response: {
          201: IntentMessageSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      const { message } = await postMessage(
        intentDeps,
        { kind: 'user', id: user.id },
        intent,
        request.body,
      );
      reply.status(201);
      return toIntentMessageDto(message);
    },
  );

  typed.post(
    '/api/intents/:id/answer',
    {
      preHandler: [guards.requireUser, guards.intentAccess('editor')],
      schema: {
        params: IntentParams,
        body: AnswerIntentInputSchema,
        response: {
          200: IntentAnswerResultSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
          410: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      return app.orchestrator.answerEscalation(
        { kind: 'user', id: user.id },
        intent,
        request.body,
      );
    },
  );

  typed.post(
    '/api/intents/:id/accept',
    {
      preHandler: [guards.requireUser, guards.intentAccess('owner')],
      schema: {
        params: IntentParams,
        response: {
          200: IntentSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      const accepted = await app.orchestrator.accept({ kind: 'user', id: user.id }, intent);
      return toIntentDto(accepted.intent);
    },
  );

  typed.post(
    '/api/intents/:id/rework',
    {
      preHandler: [guards.requireUser, guards.intentAccess('owner')],
      schema: {
        params: IntentParams,
        body: ReworkIntentInputSchema,
        response: {
          200: IntentSchema,
          400: ApiErrorSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      return toIntentDto(await app.orchestrator.rework({ kind: 'user', id: user.id }, intent, request.body));
    },
  );

  typed.post(
    '/api/intents/:id/cancel',
    {
      preHandler: [guards.requireUser, guards.intentAccess('editor')],
      schema: {
        params: IntentParams,
        response: {
          200: IntentSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      return toIntentDto(await app.orchestrator.cancel({ kind: 'user', id: user.id }, intent));
    },
  );

  typed.post(
    '/api/intents/:id/retry',
    {
      preHandler: [guards.requireUser, guards.intentAccess('editor', { foreignProject: 'notfound' })],
      schema: {
        params: IntentParams,
        response: {
          200: IntentSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
          409: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const user = currentUser(request);
      return toIntentDto(await app.orchestrator.retry({ kind: 'user', id: user.id }, intent));
    },
  );

  typed.get(
    '/api/intents/:id/spec',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        response: {
          200: SpecBundleSchema,
          403: ApiErrorSchema,
          404: ApiErrorSchema,
        },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const bundle = await loadSpecBundle(deps.db, intent.id);
      if (!bundle) throw new HttpError('NOT_FOUND', 'Spec not found');
      return bundle;
    },
  );

  typed.get(
    '/api/intents/:id/findings',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        querystring: ListQuery,
        response: { 200: FindingListSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeIdCursor(request.query.cursor) : null;
      const conditions = [eq(findings.intentId, intent.id)];
      if (cursor) conditions.push(sql`${findings.id} < ${cursor}`);
      const rows = await deps.db
        .select()
        .from(findings)
        .where(and(...conditions))
        .orderBy(desc(findings.id))
        .limit(limit + 1);
      const { page, nextCursor } = pageOf(rows, limit, (row) => encodeIdCursor(row.id));
      return { items: page.map(toFindingDto), nextCursor };
    },
  );

  typed.get(
    '/api/intents/:id/plan',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        response: { 200: PlanSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const plan = await readPlan(deps.db, intent.id);
      if (!plan) throw new HttpError('NOT_FOUND', 'Plan not found');
      return plan;
    },
  );

  typed.get(
    '/api/intents/:id/jobs',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        querystring: ListQuery,
        response: { 200: JobListSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => {
      const intent = currentIntent(request);
      const { limit } = request.query;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const conditions = [eq(jobs.intentId, intent.id)];
      if (cursor) conditions.push(afterCreatedAt(jobs.createdAt, jobs.id, cursor));
      const rows = await deps.db
        .select({ job: jobs, cursorAt: createdAtText(jobs.createdAt) })
        .from(jobs)
        .where(and(...conditions))
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(limit + 1);
      const { page, nextCursor } = pageOf(rows, limit, (row) =>
        encodeCursor({ createdAt: row.cursorAt, id: row.job.id }),
      );
      return { items: page.map((row) => toJobDto(row.job)), nextCursor };
    },
  );

  typed.get(
    '/api/intents/:id/evidence',
    {
      preHandler: [guards.requireUser, guards.intentAccess('viewer')],
      schema: {
        params: IntentParams,
        response: { 200: EvidenceSchema, 403: ApiErrorSchema, 404: ApiErrorSchema },
      },
    },
    async (request) => app.orchestrator.evidence(currentIntent(request)),
  );
}
