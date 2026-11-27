# Web UI (React SPA)

The SPA in `apps/web` renders the Intentra control plane: projects, intents, the intent
workspace with its seven tabs, runners, memory and settings. It talks to the API only through
the generated `openapi-fetch` client (`src/api/schema.d.ts`), keeps server state in TanStack
Query and subscribes to `/api/events` for live updates.

## Screens and routes

| Route | Screen | Data |
|---|---|---|
| `/login`, `/auth/error` | Pocket ID sign-in, callback errors | `GET /api/auth/login` redirect, `error` search param |
| `/projects`, `/` | project list and creation | `GET/POST /api/projects` |
| `/projects/:key` | project shell with tabs (overview, members, settings, runners, intents) | `GET /api/projects/:key`, members, intents |
| `/projects/:key/intents` | intent list and creation | `GET/POST /api/projects/:key/intents` |
| `/intents/:id` (+ `/spec`, `/critic`, `/plan`, `/build`, `/memory`, `/evidence`) | intent workspace | intent detail, spec, findings, plan, jobs, evidence |
| `/runners` | all runners available to the user | `GET /api/runners` |
| `/memory` | memory search and graph | not available, see below |
| `/settings` | profile, language, theme | `GET /api/auth/me` |

## Roles

Roles come from `GET /api/projects/:key/members` (`owner`, `editor`, `viewer`); organisation
admins are treated as `admin` from `GET /api/auth/me`. `src/auth/permissions.ts` is the single
source of truth: viewers never get mutation controls, editors create intents, answer
escalations, send messages and cancel; owners additionally accept, rework, manage members,
project settings and runner registration tokens; only the runner owner or an admin rotates or
revokes a runner. The API enforces the same rules server-side, so the UI hides controls but
never relies on hiding for authorisation.

## Realtime

`src/api/events.ts` opens `EventSource("/api/events?project=<key>")`, listens to every
contract event type, invalidates the affected query prefixes (`intents*`, `runners`, `memory`)
and reconnects with exponential backoff from 1 s to 30 s, passing the last event id. The stream
is opened once per project shell or intent workspace.

## Diff summary and privacy

The Build tab renders `diffSummary` from the stored job result: file paths, statuses, additions
and deletions, plus branch, commit, PR link and artifact links. It never renders file content,
patches, logs or test output. `src/api/results.ts` parses that unknown JSON defensively and
returns only those fields.

## Gaps in the API of this increment

The web board task may not change the API/DB, so screens degrade where the control plane has no
endpoint yet (they stay reachable and explain the state):

- **Memory.** `GET /api/projects/:key/memory/search` and `.../memory/graph` do not exist in this
  increment (the memory board task is a separate, currently blocked integration), so `/memory`
  and the intent Memory tab show a notice instead of inventing data.
- **Chat history.** `POST /api/intents/:id/messages` exists, `GET` does not: the Office tab
  shows messages sent in the current session (and the API response for each send) and says so.
- **Spec versions.** `GET /api/intents/:id/spec` returns the latest spec only; the Spec tab
  shows its version, status and sha256, not a version history.
- **Settings.** User and organisation management is delegated to Pocket ID per the
  specification; settings shows identity, language and theme only.
- **Artifacts.** There is no artifacts endpoint; diff summary and links are read from
  `job.result`, which is where the runner stores them.
- **AUTH_MODE=dev indicator.** `AUTH_MODE` is server-side only (`apps/api/src/config.ts`):
  `/api/auth/me` exposes no auth mode and the web board task may not change the API, so this
  increment shows no `dev` badge. The mode still governs the API login path.

## Tests

- Unit/component (Vitest + Testing Library): `src/router.test.tsx` (auth guard, 401 → `/login`,
  a table that renders every route of this increment, viewer read-only on members/settings/
  runners, evidence errors on Office/Critic), `src/pages/IntentShellPage.test.tsx` (rework only
  while awaiting acceptance, cancel confirmation closes on Escape and traps focus), `src/api/events.test.tsx` (SSE invalidation,
  reconnect, last event id, cleanup), `src/pages/IntentOfficeTab.test.tsx` (escalation options,
  recommendation/default, answer payload, viewer read-only), `src/pages/IntentBuildTab.test.tsx`
  (diff summary files/counts only, gates, links), `src/pages/IntentSpecTab.test.tsx` (AC/DoD/sha,
  not-ready state), `src/auth/permissions.test.ts` and `src/api/results.test.ts` (tables).
- End-to-end (Playwright, mocked API and mocked Pocket ID redirect): `e2e/full-flow.spec.ts`
  covers login → project → intent creation → escalation answer → spec → build diff summary →
  accept, asserts no console errors and no password fields; a second test proves the viewer sees
  no mutation controls. `e2e/smoke.spec.ts` keeps the auth, RU/EN switch and logout smoke.

Commands: `pnpm --filter @intentra/web test`, `pnpm --filter @intentra/web e2e`,
`pnpm --filter @intentra/web build`.
