import './zod-openapi.js';
import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ApiErrorSchema } from './errors.js';
import { LogoutResponseSchema, MeSchema } from './auth.js';
import {
  CreateProjectInputSchema,
  ProjectListSchema,
  ProjectSchema,
  UpdateProjectInputSchema,
} from './project.js';
import { AddMemberInputSchema, MemberListSchema, MemberSchema } from './member.js';
import {
  CreateRegistrationTokenInputSchema,
  RegisterRunnerInputSchema,
  RegisterRunnerResponseSchema,
  RegistrationTokenSchema,
  RotateRunnerTokenResponseSchema,
  RunnerListSchema,
} from './runner.js';
import { CursorSchema, IdSchema, LimitSchema, ProjectKeySchema } from './common.js';
import { SseEventSchema } from './events.js';
import {
  AnswerIntentInputSchema,
  CreateIntentInputSchema,
  IntentAnswerResultSchema,
  IntentCardSchema,
  IntentDetailSchema,
  IntentListSchema,
  IntentMessageSchema,
  IntentSchema,
  PostIntentMessageInputSchema,
  ReworkIntentInputSchema,
} from './intent.js';
import { SpecBundleSchema } from './spec.js';
import { FindingListSchema, FindingSchema } from './finding.js';
import { PlanSchema, PlanTaskSchema } from './plan.js';
import { JobListSchema, JobSchema, StageSchema } from './job.js';
import { ClaimCheckSchema, GateStatusSchema, VerifyReportSchema } from './verify.js';
import { DecisionSchema } from './decision.js';
import { EvidenceSchema } from './evidence.js';
import { EscalationSchema } from './escalation.js';
import { MemoryGraphSchema, MemorySearchQuerySchema, MemorySearchResultSchema } from './memory.js';
import {
  ChannelSchema,
  ReleasePublishInputSchema,
  ReleaseSchema,
  ReleaseYankInputSchema,
  RunnerLastUpdateSchema,
  RunnerUpdateSchema,
  SemVerSchema,
  UpdateAssetSchema,
  UpdateManifestSchema,
  UpdatePolicyInputSchema,
  UpdateReportInputSchema,
} from './release.js';

const ProjectParams = z.object({ key: ProjectKeySchema });
const RunnerParams = z.object({ id: IdSchema });
const MemberParams = z.object({ key: ProjectKeySchema, userId: IdSchema });
const IntentParams = z.object({ id: IdSchema });
const CursorQuery = z.object({ cursor: CursorSchema, limit: LimitSchema });

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ApiErrorSchema } },
});

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'session', {
    type: 'apiKey',
    in: 'cookie',
    name: 'intentra_session',
  });
  registry.registerComponent('securitySchemes', 'releasePublish', { type: 'http', scheme: 'bearer' });
  registry.registerComponent('securitySchemes', 'runnerToken', { type: 'http', scheme: 'bearer' });

  registry.register('Me', MeSchema);
  registry.register('LogoutResponse', LogoutResponseSchema);
  registry.register('Project', ProjectSchema);
  registry.register('ProjectList', ProjectListSchema);
  registry.register('CreateProjectInput', CreateProjectInputSchema);
  registry.register('UpdateProjectInput', UpdateProjectInputSchema);
  registry.register('Member', MemberSchema);
  registry.register('MemberList', MemberListSchema);
  registry.register('AddMemberInput', AddMemberInputSchema);
  registry.register('Runner', RunnerListSchema.shape.items.element);
  registry.register('RunnerList', RunnerListSchema);
  registry.register('RegisterRunnerInput', RegisterRunnerInputSchema);
  registry.register('RegisterRunnerResponse', RegisterRunnerResponseSchema);
  registry.register('RegistrationToken', RegistrationTokenSchema);
  registry.register('CreateRegistrationTokenInput', CreateRegistrationTokenInputSchema);
  registry.register('RotateRunnerTokenResponse', RotateRunnerTokenResponseSchema);
  registry.register('SseEvent', SseEventSchema);
  registry.register('MemorySearchResult', MemorySearchResultSchema);
  registry.register('MemoryGraph', MemoryGraphSchema);
  registry.register('ApiError', ApiErrorSchema);
  registry.register('Intent', IntentSchema);
  registry.register('IntentList', IntentListSchema);
  registry.register('IntentDetail', IntentDetailSchema);
  registry.register('IntentCard', IntentCardSchema);
  registry.register('IntentMessage', IntentMessageSchema);
  registry.register('IntentAnswerResult', IntentAnswerResultSchema);
  registry.register('CreateIntentInput', CreateIntentInputSchema);
  registry.register('PostIntentMessageInput', PostIntentMessageInputSchema);
  registry.register('AnswerIntentInput', AnswerIntentInputSchema);
  registry.register('ReworkIntentInput', ReworkIntentInputSchema);
  registry.register('SpecBundle', SpecBundleSchema);
  registry.register('Finding', FindingSchema);
  registry.register('FindingList', FindingListSchema);
  registry.register('Plan', PlanSchema);
  registry.register('PlanTask', PlanTaskSchema);
  registry.register('Job', JobSchema);
  registry.register('JobList', JobListSchema);
  registry.register('Decision', DecisionSchema);
  registry.register('Evidence', EvidenceSchema);
  registry.register('Escalation', EscalationSchema);
  registry.register('Stage', StageSchema);
  registry.register('GateStatus', GateStatusSchema);
  registry.register('ClaimCheck', ClaimCheckSchema);
  registry.register('VerifyReport', VerifyReportSchema);
  registry.register('UpdateAsset', UpdateAssetSchema);
  registry.register('UpdateManifest', UpdateManifestSchema);
  registry.register('ReleasePublishInput', ReleasePublishInputSchema);
  registry.register('RunnerUpdate', RunnerUpdateSchema);
  registry.register('UpdatePolicyInput', UpdatePolicyInputSchema);
  registry.register('UpdateReportInput', UpdateReportInputSchema);
  registry.register('Release', ReleaseSchema);
  registry.register('ReleaseYankInput', ReleaseYankInputSchema);
  registry.register('RunnerLastUpdate', RunnerLastUpdateSchema);

  registry.registerPath({
    method: 'get',
    path: '/api/auth/login',
    tags: ['auth'],
    summary: 'Start the OIDC authorization code + PKCE flow',
    request: { query: z.object({ redirect: z.string().max(500).optional() }) },
    responses: {
      302: { description: 'Redirect to the OIDC provider' },
      503: errorResponse('OIDC is not configured'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/auth/callback',
    tags: ['auth'],
    summary: 'Finish the OIDC flow: verify state, exchange the code, provision the user, set the session cookie',
    request: { query: z.object({ code: z.string(), state: z.string(), iss: z.string().optional() }) },
    responses: {
      302: { description: 'Session established, redirect to the app' },
      400: errorResponse('Invalid state or code'),
      401: errorResponse('OIDC token validation failed'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/auth/logout',
    tags: ['auth'],
    summary: 'Delete the local session and clear the cookie',
    security: [{ session: [] }],
    responses: {
      200: {
        description: 'Session deleted; redirectUrl is the RP-initiated logout URL when the IdP supports it',
        content: { 'application/json': { schema: LogoutResponseSchema } },
      },
      401: errorResponse('Authentication required'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/auth/me',
    tags: ['auth'],
    summary: 'Current user',
    security: [{ session: [] }],
    responses: {
      200: { description: 'Current user', content: { 'application/json': { schema: MeSchema } } },
      401: errorResponse('Authentication required'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects',
    tags: ['projects'],
    security: [{ session: [] }],
    request: { query: CursorQuery },
    responses: {
      200: { description: 'Projects visible to the user', content: { 'application/json': { schema: ProjectListSchema } } },
      401: errorResponse('Authentication required'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/projects',
    tags: ['projects'],
    security: [{ session: [] }],
    request: { body: { content: { 'application/json': { schema: CreateProjectInputSchema } } } },
    responses: {
      201: { description: 'Created project', content: { 'application/json': { schema: ProjectSchema } } },
      400: errorResponse('Validation failed'),
      401: errorResponse('Authentication required'),
      409: errorResponse('Project key already exists'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/projects/{key}',
    tags: ['projects'],
    security: [{ session: [] }],
    request: { params: ProjectParams },
    responses: {
      200: { description: 'Project', content: { 'application/json': { schema: ProjectSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/projects/{key}',
    tags: ['projects'],
    security: [{ session: [] }],
    request: {
      params: ProjectParams,
      body: { content: { 'application/json': { schema: UpdateProjectInputSchema } } },
    },
    responses: {
      200: { description: 'Updated project', content: { 'application/json': { schema: ProjectSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/projects/{key}',
    tags: ['projects'],
    security: [{ session: [] }],
    request: { params: ProjectParams },
    responses: {
      204: { description: 'Project archived' },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{key}/members',
    tags: ['members'],
    security: [{ session: [] }],
    request: { params: ProjectParams },
    responses: {
      200: { description: 'Project members', content: { 'application/json': { schema: MemberListSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/projects/{key}/members',
    tags: ['members'],
    security: [{ session: [] }],
    request: {
      params: ProjectParams,
      body: { content: { 'application/json': { schema: AddMemberInputSchema } } },
    },
    responses: {
      201: { description: 'Member added', content: { 'application/json': { schema: MemberSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('User not found'),
      409: errorResponse('Member already exists'),
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/projects/{key}/members/{userId}',
    tags: ['members'],
    security: [{ session: [] }],
    request: { params: MemberParams },
    responses: {
      204: { description: 'Member removed' },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/runners',
    tags: ['runners'],
    security: [{ session: [] }],
    request: { query: CursorQuery },
    responses: {
      200: { description: 'Runners visible to the user', content: { 'application/json': { schema: RunnerListSchema } } },
      401: errorResponse('Authentication required'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/projects/{key}/runners/registration-token',
    tags: ['runners'],
    security: [{ session: [] }],
    summary: 'Create a one-time runner registration token (TTL 15 minutes)',
    request: { params: ProjectParams },
    responses: {
      201: { description: 'Registration token, shown once', content: { 'application/json': { schema: RegistrationTokenSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/runners/register',
    tags: ['runners'],
    summary: 'Redeem a registration token; the runner token is returned once and stored hashed',
    request: { body: { content: { 'application/json': { schema: RegisterRunnerInputSchema } } } },
    responses: {
      201: { description: 'Registered runner', content: { 'application/json': { schema: RegisterRunnerResponseSchema } } },
      400: errorResponse('Validation failed'),
      401: errorResponse('Unknown or expired registration token'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/runners/{id}/rotate-token',
    tags: ['runners'],
    security: [{ session: [] }],
    request: { params: RunnerParams },
    responses: {
      200: { description: 'New runner token, shown once', content: { 'application/json': { schema: RotateRunnerTokenResponseSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'delete',
    path: '/api/runners/{id}',
    tags: ['runners'],
    security: [{ session: [] }],
    request: { params: RunnerParams },
    responses: {
      204: { description: 'Runner revoked' },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/admin/releases',
    tags: ['runners'],
    security: [{ releasePublish: [] }],
    summary: 'Publish a signed runner release; a repeat publish updates the same version',
    request: { body: { content: { 'application/json': { schema: ReleasePublishInputSchema } } } },
    responses: {
      201: { description: 'Release published', content: { 'application/json': { schema: ReleaseSchema } } },
      200: { description: 'Release republished', content: { 'application/json': { schema: ReleaseSchema } } },
      400: errorResponse('The manifest, its signature or its size is invalid'),
      401: errorResponse('Wrong publish token'),
      503: errorResponse('Release publishing or the release key is not configured'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/admin/releases/{version}/yank',
    tags: ['runners'],
    security: [{ releasePublish: [] }],
    summary: 'Yank or un-yank a release',
    request: {
      params: z.object({ version: SemVerSchema }),
      body: { content: { 'application/json': { schema: ReleaseYankInputSchema } } },
    },
    responses: {
      204: { description: 'Release yanked or restored' },
      400: errorResponse('Validation failed'),
      401: errorResponse('Wrong publish token'),
      404: errorResponse('Unknown release'),
      503: errorResponse('Release publishing or the release key is not configured'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/runners/update',
    tags: ['runners'],
    security: [{ runnerToken: [] }],
    summary: 'Resolve the update for the authenticated runner',
    request: {
      query: z.object({ current: z.string().optional(), channel: ChannelSchema.optional() }),
    },
    responses: {
      200: { description: 'Update decision', content: { 'application/json': { schema: RunnerUpdateSchema } } },
      400: errorResponse('Validation failed'),
      401: errorResponse('Unknown or revoked runner token'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/runners/update/artifact/{fileName}',
    tags: ['runners'],
    security: [{ runnerToken: [] }],
    summary: 'Stream a release artifact verified against the signed manifest',
    request: { params: z.object({ fileName: z.string().min(1).max(255) }) },
    responses: {
      200: {
        description: 'Artifact bytes with Content-Length and a sha-256 Digest',
        content: { 'application/octet-stream': { schema: z.string() } },
      },
      401: errorResponse('Unknown or revoked runner token'),
      404: errorResponse('Unknown or yanked artifact'),
      502: errorResponse('The artifact source failed, timed out or returned other bytes'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/runners/update/report',
    tags: ['runners'],
    security: [{ runnerToken: [] }],
    summary: 'Record an applied, rolled-back or failed runner update',
    request: { body: { content: { 'application/json': { schema: UpdateReportInputSchema } } } },
    responses: {
      204: { description: 'Update report recorded' },
      400: errorResponse('Validation failed'),
      401: errorResponse('Unknown or revoked runner token'),
    },
  });
  registry.registerPath({
    method: 'put',
    path: '/api/runners/{id}/update-policy',
    tags: ['runners'],
    security: [{ session: [] }],
    summary: 'Pin a runner version or disable auto-update',
    request: {
      params: RunnerParams,
      body: { content: { 'application/json': { schema: UpdatePolicyInputSchema } } },
    },
    responses: {
      204: { description: 'Update policy changed' },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('Runner is revoked'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{key}/intents',
    tags: ['intents'],
    security: [{ session: [] }],
    request: { params: ProjectParams, query: CursorQuery },
    responses: {
      200: { description: 'Intents of the project', content: { 'application/json': { schema: IntentListSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/projects/{key}/intents',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Create an intent in draft',
    request: {
      params: ProjectParams,
      body: { content: { 'application/json': { schema: CreateIntentInputSchema } } },
    },
    responses: {
      201: { description: 'Created intent', content: { 'application/json': { schema: IntentSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Intent with its front-office card and open escalations',
    request: { params: IntentParams },
    responses: {
      200: { description: 'Intent detail', content: { 'application/json': { schema: IntentDetailSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/intents/{id}/messages',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Post a user message to the front-office conversation',
    request: {
      params: IntentParams,
      body: { content: { 'application/json': { schema: PostIntentMessageInputSchema } } },
    },
    responses: {
      201: { description: 'Stored message', content: { 'application/json': { schema: IntentMessageSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('The intent is closed'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/intents/{id}/answer',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Answer an escalation; the answer becomes an accepted decision',
    request: {
      params: IntentParams,
      body: { content: { 'application/json': { schema: AnswerIntentInputSchema } } },
    },
    responses: {
      200: { description: 'Escalation answered', content: { 'application/json': { schema: IntentAnswerResultSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('Escalation is already resolved'),
      410: errorResponse('Escalation expired and applied its default'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/intents/{id}/accept',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Accept a verified intent',
    request: { params: IntentParams },
    responses: {
      200: { description: 'Accepted intent', content: { 'application/json': { schema: IntentSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('Intent is not awaiting acceptance'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/intents/{id}/rework',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Send an intent back to build with a reason',
    request: {
      params: IntentParams,
      body: { content: { 'application/json': { schema: ReworkIntentInputSchema } } },
    },
    responses: {
      200: { description: 'Intent sent back to build', content: { 'application/json': { schema: IntentSchema } } },
      400: errorResponse('Validation failed'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('Intent is not awaiting acceptance'),
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/intents/{id}/cancel',
    tags: ['intents'],
    security: [{ session: [] }],
    summary: 'Cancel the intent',
    request: { params: IntentParams },
    responses: {
      200: { description: 'Cancelled intent', content: { 'application/json': { schema: IntentSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
      409: errorResponse('The intent is already terminal'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}/spec',
    tags: ['spec'],
    security: [{ session: [] }],
    summary: 'Latest spec with its acceptance criteria and definition of done',
    request: { params: IntentParams },
    responses: {
      200: { description: 'Spec bundle', content: { 'application/json': { schema: SpecBundleSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}/findings',
    tags: ['spec'],
    security: [{ session: [] }],
    request: { params: IntentParams, query: CursorQuery },
    responses: {
      200: { description: 'Findings, newest first', content: { 'application/json': { schema: FindingListSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}/plan',
    tags: ['spec'],
    security: [{ session: [] }],
    request: { params: IntentParams },
    responses: {
      200: { description: 'Build plan', content: { 'application/json': { schema: PlanSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}/jobs',
    tags: ['intents'],
    security: [{ session: [] }],
    request: { params: IntentParams, query: CursorQuery },
    responses: {
      200: { description: 'Agent jobs, newest first', content: { 'application/json': { schema: JobListSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/intents/{id}/evidence',
    tags: ['spec'],
    security: [{ session: [] }],
    summary: 'Decisions, findings and verdicts behind the intent',
    request: { params: IntentParams },
    responses: {
      200: { description: 'Evidence pack', content: { 'application/json': { schema: EvidenceSchema } } },
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/runners/ws',
    tags: ['runners'],
    summary: 'Runner WebSocket: hello, heartbeat, job offers and job events',
    description:
      'Upgrade with the runner token in the Authorization header (Bearer) or the token query parameter. ' +
      'Job-scoped messages carry jobId and a monotonically increasing seq; seq is idempotent.',
    responses: {
      101: { description: 'Switching protocols to WebSocket' },
      401: errorResponse('Unknown, revoked or expired runner token'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/metrics',
    tags: ['ops'],
    summary: 'Prometheus text metrics for stages, jobs, findings and tokens',
    responses: { 200: { description: 'Prometheus exposition format', content: { 'text/plain': { schema: z.string() } } } },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/events',
    tags: ['events'],
    security: [{ session: [] }],
    summary: 'Server-sent events for one project',
    request: { query: z.object({ project: z.string().min(1), lastEventId: z.string().optional() }) },
    responses: {
      200: { description: 'Server-sent event stream', content: { 'text/event-stream': { schema: z.string() } } },
      401: errorResponse('Authentication required'),
      403: errorResponse('Forbidden'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/{key}/memory/search',
    tags: ['memory'],
    security: [{ session: [] }],
    summary: 'Hybrid memory search inside one project',
    request: { params: ProjectParams, query: MemorySearchQuerySchema },
    responses: {
      200: {
        description: 'Ranked memory hits',
        content: { 'application/json': { schema: MemorySearchResultSchema } },
      },
      401: errorResponse('Authentication required'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/projects/{key}/memory/graph',
    tags: ['memory'],
    security: [{ session: [] }],
    summary: 'Project memory graph, served from Postgres when FalkorDB is degraded',
    request: { params: ProjectParams },
    responses: {
      200: { description: 'Memory graph', content: { 'application/json': { schema: MemoryGraphSchema } } },
      401: errorResponse('Authentication required'),
      403: errorResponse('Forbidden'),
      404: errorResponse('Not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['ops'],
    responses: { 200: { description: 'Process is alive' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/readyz',
    tags: ['ops'],
    responses: { 200: { description: 'Database reachable' }, 503: errorResponse('Database unreachable') },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Intentra API',
      version: '0.1.0',
      description: 'Intentra control plane: OIDC identity, projects, members, runners and events.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'auth' },
      { name: 'projects' },
      { name: 'members' },
      { name: 'intents' },
      { name: 'spec' },
      { name: 'runners' },
      { name: 'events' },
      { name: 'memory' },
      { name: 'ops' },
    ],
  });
}

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
