import type { EscalationTrigger } from '@intentra/contracts';
import { sameQuestion } from './policy.js';

export interface DecisionCandidate {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly evidence: string | null;
}

export interface ClaimCandidate {
  readonly id: string;
  readonly statement: string;
  readonly commit: string;
  readonly currentCommit: string;
}

export interface CodeEvidence {
  readonly probe: string;
  readonly output: string;
  readonly resolves: boolean;
}

export interface ResolutionInput {
  readonly question: string;
  readonly assumption: string;
  readonly trigger: EscalationTrigger | null;
  readonly acceptedDecisions?: readonly DecisionCandidate[];
  readonly claims?: readonly ClaimCandidate[];
  readonly codeEvidence?: readonly CodeEvidence[];
  readonly conventions?: readonly string[];
}

export type Resolution =
  | { readonly kind: 'accepted-decision'; readonly decisionId: string; readonly answer: string }
  | { readonly kind: 'claim'; readonly claimId: string; readonly statement: string }
  | { readonly kind: 'code-evidence'; readonly probe: string; readonly output: string }
  | { readonly kind: 'convention'; readonly convention: string }
  | { readonly kind: 'assumption'; readonly assumption: string }
  | { readonly kind: 'escalate'; readonly trigger: EscalationTrigger; readonly reason: string };

export function resolveQuestion(input: ResolutionInput): Resolution {
  const decision = input.acceptedDecisions?.find(
    (candidate) => candidate.evidence !== null && sameQuestion(candidate.question, input.question),
  );
  if (decision) {
    return { kind: 'accepted-decision', decisionId: decision.id, answer: decision.answer };
  }

  const claim = input.claims?.find(
    (candidate) => sameQuestion(candidate.statement, input.question) && candidate.commit === candidate.currentCommit,
  );
  if (claim) return { kind: 'claim', claimId: claim.id, statement: claim.statement };

  const evidence = input.codeEvidence?.find((candidate) => candidate.resolves);
  if (evidence) {
    return { kind: 'code-evidence', probe: evidence.probe, output: evidence.output };
  }

  const convention = input.conventions?.[0];
  if (convention !== undefined) return { kind: 'convention', convention };

  if (input.trigger !== null) {
    return { kind: 'escalate', trigger: input.trigger, reason: 'No decision, claim, code evidence or convention resolves the question' };
  }

  return { kind: 'assumption', assumption: input.assumption };
}
