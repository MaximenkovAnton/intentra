import type {
  Decision,
  DodRow,
  Escalation,
  Finding,
  Intent,
  IntentMessage,
  Job,
  Member,
  Project,
  Requirement,
  Runner,
  RunnerLastUpdate,
  Spec,
  Stage,
  Verdict,
} from '@intentra/contracts';
import { expiresAtFor } from './escalation/policy.js';
import type {
  DecisionRow,
  DodRowRow,
  EscalationRow,
  FindingRow,
  IntentMessageRow,
  IntentRow,
  JobRow,
  ProjectMemberRow,
  ProjectRow,
  RequirementRow,
  RunnerRow,
  RunnerUpdateEventRow,
  SpecRow,
  StageRow,
  UserRow,
  VerdictRow,
} from './db/schema.js';

const iso = (value: Date): string => value.toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toProjectDto(project: ProjectRow): Project {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    createdBy: project.createdBy,
    createdAt: iso(project.createdAt),
    archivedAt: isoOrNull(project.archivedAt),
  };
}

export function toMemberDto(member: ProjectMemberRow, user: UserRow): Member {
  return {
    userId: member.userId,
    email: user.email,
    name: user.name,
    role: member.role,
    createdAt: iso(member.createdAt),
  };
}

export interface RunnerUpdateView {
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly lastUpdate: RunnerUpdateEventRow | null;
}

export function toRunnerDto(runner: RunnerRow, view: RunnerUpdateView): Runner {
  const lastUpdate: RunnerLastUpdate | null =
    view.lastUpdate === null
      ? null
      : {
          fromVersion: view.lastUpdate.fromVersion,
          toVersion: view.lastUpdate.toVersion,
          status: view.lastUpdate.status,
          reason: view.lastUpdate.reason,
          createdAt: iso(view.lastUpdate.createdAt),
        };
  return {
    id: runner.id,
    name: runner.name,
    ownerUserId: runner.ownerUserId,
    os: runner.os,
    arch: runner.arch,
    version: runner.version,
    capabilities: runner.capabilities,
    status: runner.status,
    lastSeenAt: isoOrNull(runner.lastSeenAt),
    revokedAt: isoOrNull(runner.revokedAt),
    pinnedVersion: runner.pinnedVersion,
    autoUpdate: runner.autoUpdate,
    latestVersion: view.latestVersion,
    updateAvailable: view.updateAvailable,
    lastUpdate,
  };
}

export function toIntentDto(intent: IntentRow): Intent {
  return {
    id: intent.id,
    projectId: intent.projectId,
    title: intent.title,
    statement: intent.statement,
    status: intent.status,
    createdBy: intent.createdBy,
    createdAt: iso(intent.createdAt),
    acceptedAt: isoOrNull(intent.acceptedAt),
  };
}

export function toIntentMessageDto(message: IntentMessageRow): IntentMessage {
  return {
    id: message.id,
    intentId: message.intentId,
    role: message.role,
    body: message.body,
    createdAt: iso(message.createdAt),
  };
}

export function toSpecDto(spec: SpecRow): Spec {
  return {
    id: spec.id,
    intentId: spec.intentId,
    version: spec.version,
    bodyMd: spec.bodyMd,
    status: spec.status,
    sha256: spec.sha256,
    createdAt: iso(spec.createdAt),
  };
}

export function toRequirementDto(requirement: RequirementRow): Requirement {
  return {
    id: requirement.id,
    specId: requirement.specId,
    acId: requirement.acId,
    text: requirement.text,
    kind: requirement.kind,
    status: requirement.status,
  };
}

export function toDodRowDto(row: DodRowRow): DodRow {
  return {
    id: row.id,
    requirementId: row.requirementId,
    testRef: row.testRef,
    probe: row.probe,
    status: row.status,
  };
}

export function toEscalationDto(escalation: EscalationRow): Escalation {
  return {
    id: escalation.id,
    intentId: escalation.intentId,
    stage: escalation.stage,
    question: escalation.question,
    context: escalation.context,
    options: escalation.options,
    recommendation: escalation.recommendation,
    defaultOption: escalation.defaultOption,
    expiresAt: iso(expiresAtFor(escalation.createdAt)),
    status: escalation.status,
    answerOption: escalation.answerOption,
    answerNote: escalation.answerNote,
    answeredBy: escalation.answeredBy,
    answeredAt: isoOrNull(escalation.answeredAt),
    decisionId: escalation.decisionId,
  };
}

export function toDecisionDto(decision: DecisionRow): Decision {
  return {
    id: decision.id,
    projectId: decision.projectId,
    intentId: decision.intentId,
    question: decision.question,
    answer: decision.answer,
    rationale: decision.rationale,
    alternatives: decision.alternatives,
    status: decision.status,
    supersedesId: decision.supersedesId,
    authorKind: decision.authorKind,
    authorId: decision.authorId,
    evidence: decision.evidence,
    createdAt: iso(decision.createdAt),
  };
}

export function toFindingDto(finding: FindingRow): Finding {
  return {
    id: finding.id,
    intentId: finding.intentId,
    jobId: finding.jobId,
    role: finding.role,
    acId: finding.acId,
    class: finding.class,
    severity: finding.severity,
    requirement: finding.requirement,
    evidence: finding.evidence,
    requiredChange: finding.requiredChange,
    status: finding.status,
    round: finding.round,
  };
}

export function toVerdictDto(verdict: VerdictRow): Verdict {
  return {
    id: verdict.id,
    jobId: verdict.jobId,
    role: verdict.role,
    decision: verdict.decision,
    artifactSha256: verdict.artifactSha256,
    round: verdict.round,
  };
}

export function toStageDto(stage: StageRow): Stage {
  return {
    id: stage.id,
    intentId: stage.intentId,
    kind: stage.kind,
    status: stage.status,
    attempt: stage.attempt,
    startedAt: isoOrNull(stage.startedAt),
    finishedAt: isoOrNull(stage.finishedAt),
    error: stage.error,
  };
}

export function toJobDto(job: JobRow): Job {
  return {
    id: job.id,
    intentId: job.intentId,
    stageId: job.stageId,
    runnerId: job.runnerId,
    runtime: job.runtime,
    status: job.status,
    payload: job.payload,
    result: job.result,
    leaseUntil: isoOrNull(job.leaseUntil),
    attempt: job.attempt,
    createdAt: iso(job.createdAt),
    startedAt: isoOrNull(job.startedAt),
    finishedAt: isoOrNull(job.finishedAt),
  };
}
