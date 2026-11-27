import { Buffer } from 'node:buffer';
import type { FindingInput, Plan, VerdictDecision } from '@intentra/contracts';
import { parseSpec, SPEC_MAX_BYTES, type ParsedSpec } from './parse.js';
import { validatePlan } from './plan.js';
import type { TestRefChecker } from './test-refs.js';

export interface AcceptedDecisionSummary {
  readonly question: string;
  readonly answer: string;
}

export interface CriticInput {
  readonly bodyMd: string;
  readonly testRefs: TestRefChecker;
  readonly acceptedDecisions?: readonly AcceptedDecisionSummary[];
  readonly supersededDecisions?: readonly AcceptedDecisionSummary[];
  readonly plan?: Plan | null;
}

export interface CriticResult {
  readonly parsed: ParsedSpec;
  readonly findings: readonly FindingInput[];
  readonly verdict: VerdictDecision;
}

interface AntonymPair {
  readonly name: string;
  readonly left: RegExp;
  readonly right: RegExp;
}

const ANTONYMS: readonly AntonymPair[] = [
  { name: 'offline/online', left: /\boffline\b/i, right: /\bonline\b/i },
  { name: 'sync/async', left: /\bsync(?:hronous(?:ly)?)?\b/i, right: /\basync(?:hronous(?:ly)?)?\b/i },
  { name: 'public/private', left: /\bpublic\b/i, right: /\bprivate\b/i },
  { name: 'delete/keep', left: /\bdelete\b/i, right: /\bkeep\b/i },
];

const NEGATION_BEFORE = /(?:\b(?:no|not|never)\s+|\bбез\s+|\bне\s*)$/i;

const firstNonNegated = (text: string, pattern: RegExp): string | null => {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    const start = match.index;
    if (start === undefined) continue;
    const before = text.slice(Math.max(0, start - 24), start);
    if (NEGATION_BEFORE.test(before)) continue;
    return match[0];
  }
  return null;
};

const finding = (
  findingClass: FindingInput['class'],
  requirement: string,
  extra: Partial<FindingInput> = {},
): FindingInput => ({ class: findingClass, severity: 'blocking', requirement, ...extra });

const dedupe = (findings: readonly FindingInput[]): FindingInput[] => {
  const seen = new Set<string>();
  const unique: FindingInput[] = [];
  for (const item of findings) {
    const key = `${item.class}|${item.acId ?? ''}|${item.requirement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
};

const contradictionFindings = (
  constraints: string,
  acceptedDecisions: readonly AcceptedDecisionSummary[],
): FindingInput[] => {
  const findings: FindingInput[] = [];
  for (const pair of ANTONYMS) {
    const left = firstNonNegated(constraints, pair.left);
    const right = firstNonNegated(constraints, pair.right);
    if (left !== null && right !== null) {
      findings.push(
        finding('contradiction', `Spec constraints contain both sides of ${pair.name}`, {
          evidence: `found "${left}" and "${right}" in the constraints section`,
          requiredChange: `Keep one side of ${pair.name} or qualify when each applies`,
        }),
      );
    }
    for (const decision of acceptedDecisions) {
      const decisionLeft = firstNonNegated(decision.answer, pair.left);
      const decisionRight = firstNonNegated(decision.answer, pair.right);
      const conflict =
        (decisionLeft !== null && right !== null) || (decisionRight !== null && left !== null);
      if (!conflict) continue;
      findings.push(
        finding('contradiction', `Spec constraints contradict the accepted decision "${decision.question}"`, {
          evidence: `decision answer "${decision.answer}"; constraints name the opposite side of ${pair.name}`,
          requiredChange: 'Align the spec with the accepted decision or supersede the decision',
        }),
      );
    }
  }
  return findings;
};

export function critiqueSpec(input: CriticInput): CriticResult {
  const parsed = parseSpec(input.bodyMd);
  const findings: FindingInput[] = [...parsed.findings];

  const bytes = Buffer.byteLength(input.bodyMd, 'utf8');
  if (bytes > SPEC_MAX_BYTES) {
    findings.push(
      finding('scope', `Spec is ${bytes} bytes; the limit is ${SPEC_MAX_BYTES}`, {
        evidence: `${bytes} > ${SPEC_MAX_BYTES}`,
        requiredChange: 'Move appendixes out of the spec and keep it under 24 KB',
      }),
    );
  }

  for (const row of parsed.parsed.dodRows) {
    if (row.testRef === null) continue;
    if (!input.testRefs.exists(row.testRef)) {
      findings.push(
        finding('unprovable', `Test ref "${row.testRef}" for "${row.acId}" does not exist`, {
          acId: row.acId,
          evidence: row.testRef,
          requiredChange: 'Point the DoD row at a test that exists in the repository',
        }),
      );
    }
  }

  const constraints = parsed.parsed.sections.get('constraints') ?? '';
  findings.push(...contradictionFindings(constraints, input.acceptedDecisions ?? []));

  for (const decision of input.supersededDecisions ?? []) {
    if (decision.answer.length < 12 || !input.bodyMd.includes(decision.answer)) continue;
    findings.push(
      finding('stale-doc', `Spec repeats the superseded decision "${decision.question}"`, {
        evidence: decision.answer,
        requiredChange: 'Use the current accepted decision instead of the superseded text',
      }),
    );
  }

  if (input.plan) {
    findings.push(...validatePlan(input.plan, new Set(parsed.parsed.acRows.map((row) => row.acId))));
  }

  const unique = dedupe(findings);
  return {
    parsed: parsed.parsed,
    findings: unique,
    verdict: unique.some((item) => item.severity === 'blocking') ? 'changes' : 'approve',
  };
}
