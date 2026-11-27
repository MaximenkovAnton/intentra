import type { IntentCard } from '@intentra/contracts';

export const VALID_SPEC = `# Intent: reviewed intent to spec

## Context

Teams want to ship intent-driven work without a human reading every spec.

## Goal

Deliver a control plane that turns an intent into a mechanically reviewed spec.

## Non-goals

- No runner in this increment.

## Scenarios

- A product owner creates an intent and talks to the front office.

## Constraints

- Everything runs online in the control plane.
- Session state is stored in Postgres.

## Acceptance criteria

| AC | Text | Type | Priority |
| --- | --- | --- | --- |
| AC-1 | An intent can be created and messaged | functional | must |
| AC-2 | Every route is documented in OpenAPI | nonfunctional | must |

## Definition of done

| AC | Test ref | Probe |
| --- | --- | --- |
| AC-1 | apps/api/test/intents-api.test.ts::creates an intent | - |
| AC-2 | - | pnpm -w typecheck |

## Decisions

- Postgres is the only store; no cache.

## Risks

- Scope creep into the runner.
`;

export const INTENT_CARD: IntentCard = {
  objective: 'Turn an intent conversation into a mechanically reviewed spec.',
  users: ['product owner'],
  jobs: ['describe an intent', 'answer escalations'],
  inScope: ['intent state machine', 'mechanical spec critic'],
  outOfScope: ['runner', 'UI'],
  constraints: ['control plane only'],
  successSignals: ['a spec without DoD is rejected'],
  assumptions: ['Postgres stores everything'],
  risks: ['mechanical critic false positives'],
  openQuestions: [],
};
