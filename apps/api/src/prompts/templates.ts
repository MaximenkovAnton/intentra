import type { FindingInput, IntentCard } from '@intentra/contracts';
import type { AcceptedDecisionSummary } from '../spec/critic.js';
import { renderContextPack, type ContextPack, type MemoryContext } from './context.js';

export const FRONT_OFFICE_MAX_REPLY_BYTES = 6 * 1024;

const INTENT_CARD_SCHEMA = JSON.stringify(
  {
    objective: 'string',
    users: ['string'],
    jobs: ['string'],
    inScope: ['string'],
    outOfScope: ['string'],
    constraints: ['string'],
    successSignals: ['string'],
    assumptions: ['string'],
    risks: ['string'],
    openQuestions: ['string'],
  },
  null,
  2,
);

const SPEC_FORMAT = `# <title>

## Context

## Goal

## Non-goals
- ...

## Scenarios
- ...

## Constraints
- ...

## Acceptance criteria
| AC | Text | Type | Priority |
| --- | --- | --- | --- |
| AC-1 | <observable behaviour> | functional | must |

## Definition of done
| AC | Test ref | Probe |
| --- | --- | --- |
| AC-1 | <path/to/test.ts::test name> | - |

## Decisions
- ...

## Risks
- ...`;

const SPEC_CRITIC_SCHEMA = JSON.stringify(
  {
    findings: [
      {
        acId: 'AC-1',
        class: 'ambiguous|missing-evidence|contradiction|unprovable|stale-doc|scope',
        severity: 'blocking|nit',
        requirement: 'string',
        evidence: 'string (required for blocking findings)',
        requiredChange: 'string',
      },
    ],
    verdict: { decision: 'approve|changes|block', artifactSha256: '<sha256 of the spec you reviewed>' },
  },
  null,
  2,
);

const decisionLines = (decisions: readonly AcceptedDecisionSummary[]): string =>
  decisions.length === 0 ? '(none)' : decisions.map((item) => `- ${item.question} -> ${item.answer}`).join('\n');

export interface FrontOfficePromptInput {
  readonly title: string;
  readonly statement: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly body: string }[];
  readonly contextPack: ContextPack;
  readonly capabilities: readonly string[];
}

export function frontOfficePrompt(input: FrontOfficePromptInput): string {
  const messages = input.messages
    .slice(-20)
    .map((message) => `${message.role}: ${message.body}`)
    .join('\n');
  return [
    'You are product_front_office, the product front office of Intentra.',
    'Gather evidence first: memory, capabilities and the local code outline.',
    'Ask only questions you cannot answer, at most one batch of three questions.',
    'You never write the spec and never make decisions: contradictions and gaps are closed by memory, code and judgement.',
    `Reply with markdown under ${FRONT_OFFICE_MAX_REPLY_BYTES / 1024} KB, then call submit_intent_card.`,
    '',
    `## Intent\nTitle: ${input.title}\nStatement: ${input.statement}`,
    '',
    `## Conversation (last 20 messages)\n${messages === '' ? '(none)' : messages}`,
    '',
    `## Capabilities\n${input.capabilities.length === 0 ? '(none)' : input.capabilities.map((item) => `- ${item}`).join('\n')}`,
    '',
    `## Context pack\n${renderContextPack(input.contextPack) === '' ? '(empty)' : renderContextPack(input.contextPack)}`,
    '',
    `## submit_intent_card input schema\n${INTENT_CARD_SCHEMA}`,
  ].join('\n');
}

export interface SpecWriterPromptInput {
  readonly card: IntentCard;
  readonly acceptedDecisions: readonly AcceptedDecisionSummary[];
  readonly contextPack: ContextPack;
  readonly findings?: readonly FindingInput[];
}

const findingLine = (finding: FindingInput): string => {
  const evidence = finding.evidence === undefined ? '' : ` (evidence: ${finding.evidence})`;
  const fix = finding.requiredChange === undefined ? '' : ` -> fix: ${finding.requiredChange}`;
  return `- [${finding.class}] ${finding.requirement}${evidence}${fix}`;
};

const cardLines = (card: IntentCard): string =>
  [
    `Objective: ${card.objective}`,
    `Users: ${card.users.join('; ')}`,
    `Jobs: ${card.jobs.join('; ')}`,
    `In scope: ${card.inScope.join('; ')}`,
    `Out of scope: ${card.outOfScope.join('; ')}`,
    `Constraints: ${card.constraints.join('; ')}`,
    `Success signals: ${card.successSignals.join('; ')}`,
    `Assumptions: ${card.assumptions.join('; ')}`,
    `Risks: ${card.risks.join('; ')}`,
    `Open questions: ${card.openQuestions.join('; ')}`,
  ].join('\n');

export function specWriterPrompt(input: SpecWriterPromptInput): string {
  const findings = input.findings ?? [];
  return [
    'You are spec_writer for Intentra. Turn the intent card into a spec a mechanical critic can check.',
    'Rules: AC ids are AC-1..n; every criterion has exactly one DoD row with a test_ref or a probe;',
    'the acceptance criteria table has exactly the columns | AC | Text | Type | Priority |;',
    'Type is exactly functional or nonfunctional and Priority is must, should or could — no other values;',
    'never leave TBD, TODO or placeholder brackets; keep the whole spec under 24 KB;',
    'the sections below are mandatory, in this order; call submit_spec with the finished markdown.',
    '',
    `## Intent card\n${cardLines(input.card)}`,
    '',
    `## Accepted decisions\n${decisionLines(input.acceptedDecisions)}`,
    '',
    `## Context pack\n${renderContextPack(input.contextPack) === '' ? '(empty)' : renderContextPack(input.contextPack)}`,
    '',
    `## Previous findings\n${findings.length === 0 ? '(none)' : findings.map(findingLine).join('\n')}`,
    '',
    `## Spec format\n${SPEC_FORMAT}`,
    '',
    '## submit_spec input schema\n{"bodyMd":"markdown spec in the format above"}',
  ].join('\n');
}

export interface SpecCriticPromptInput {
  readonly specMd: string;
  readonly specSha256: string;
  readonly acceptedDecisions: readonly AcceptedDecisionSummary[];
  readonly contextPack: ContextPack;
}

export function specCriticPrompt(input: SpecCriticPromptInput): string {
  return [
    'You are spec_critic for Intentra. The human does not review the spec: your findings are the review.',
    'Read the spec against the accepted decisions and the context pack, then call submit_findings and submit_verdict.',
    'Blocking findings need evidence; a blocking finding without evidence is rejected by the control plane.',
    'A verdict is bound to the sha256 of the spec you reviewed. At most two rounds.',
    '',
    `## Accepted decisions\n${decisionLines(input.acceptedDecisions)}`,
    '',
    `## Context pack\n${renderContextPack(input.contextPack) === '' ? '(empty)' : renderContextPack(input.contextPack)}`,
    '',
    `## Spec sha256\n${input.specSha256}`,
    '',
    `## Spec\n${input.specMd}`,
    '',
    `## submit_findings and submit_verdict input schema\n${SPEC_CRITIC_SCHEMA}`,
  ].join('\n');
}

export async function assembleFrontOfficePrompt(
  memory: MemoryContext,
  input: Omit<FrontOfficePromptInput, 'contextPack'> & { readonly projectId: string; readonly intentId: string },
): Promise<string> {
  const contextPack = await memory.buildContextPack({
    projectId: input.projectId,
    intentId: input.intentId,
    query: input.statement,
  });
  return frontOfficePrompt({ ...input, contextPack });
}

export async function assembleSpecWriterPrompt(
  memory: MemoryContext,
  input: Omit<SpecWriterPromptInput, 'contextPack'> & { readonly projectId: string; readonly intentId: string },
): Promise<string> {
  const contextPack = await memory.buildContextPack({
    projectId: input.projectId,
    intentId: input.intentId,
    query: input.card.objective,
  });
  return specWriterPrompt({ ...input, contextPack });
}

export async function assembleSpecCriticPrompt(
  memory: MemoryContext,
  input: Omit<SpecCriticPromptInput, 'contextPack'> & { readonly projectId: string; readonly intentId: string },
): Promise<string> {
  const contextPack = await memory.buildContextPack({
    projectId: input.projectId,
    intentId: input.intentId,
    query: input.specSha256,
  });
  return specCriticPrompt({ ...input, contextPack });
}
