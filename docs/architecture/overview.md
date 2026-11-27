# Architecture overview

Intentra turns an intent into reviewed, verified code without making a human read internal
documents. A **control plane** (web + API + Postgres) orchestrates the work; a **runner** on the
user's machine executes agent jobs locally. The control plane never receives code, diffs, logs,
transcripts or keys (privacy boundary, spec §3.3).

Status: the v1 slice is implemented. The contracts package, the control plane (OIDC + RBAC,
projects/members, intents and the front office, specs with AC/DoD and the mechanical critic, the
planner, the orchestrator with jobs/leases/verify/accept, memory, SSE, the RU/EN UI) and the Rust
runner (transport, worktree/git, index, MCP, claims/gates/diff summary, DSH/generic-CLI/mock
adapters) are in the tree. Deployment and operating steps are in `docs/runbook.md`.

## Components

### Control plane (deployed with Docker)

| Component | Location | Stack | Responsibility |
| --- | --- | --- | --- |
| web | `apps/web` | React 19, Vite 7, TanStack Router/Query, react-i18next (ru/en), CSS tokens | Product front office: identity, projects/members, runners, intents; talks to the API over HTTP/SSE on one origin. |
| api | `apps/api` | Fastify 5, Node 24, TypeScript strict, Zod, Drizzle + `pg`, pino, `openid-client`, SSE | OIDC login/session, RBAC, projects/members/runners; the resting place for orchestration (stages, jobs, leases, retries, budgets), memory context API and the WSS runner hub. |
| contracts | `packages/contracts` | Zod, OpenAPI 3.1 via `@asteasolutions/zod-to-openapi`, WS protocol and adapter types | Single source of REST/WS shapes; emits the OpenAPI document consumed by web via `openapi-typescript`. |
| Postgres 18 | external instance | — | Users, sessions, projects, members, runners, and the planned intent/spec/job/finding tables. |

Supporting services are deployed separately and reached by URL, not by this compose file: Pocket
ID (OIDC identity) and FalkorDB + Qdrant + Ollama with bge-m3 (memory).

### Runner (Rust, on the machine with the code)

- `crates/runner-core` — protocol structs shared by centre and runner (hello/heartbeat now, job
  messages later).
- `crates/runner` — the `intentra-runner` CLI binary:
  `register`/`start`/`status`/`doctor`/`mcp`/`update`.
- Outbound WSS transport with reconnect, job executor, worktrees and git operations, local
  tree-sitter index, MCP stdio server, claim verifier, gate runner, diff summary, and the DSH,
  generic-CLI and mock adapters — see `docs/development/adapters.md`.
- Signed releases and self-update: a `vX.Y.Z` tag builds the binary for five targets and publishes
  an Ed25519-signed update manifest (`.github/workflows/release.yml`); the centre stores the
  manifest and streams the archives, and the runner verifies both signature and SHA-256, applies
  only when no job is active, and rolls back a binary that fails to start. See
  `docs/operations/releases.md` and `docs/operations/updates.md`; the decision is recorded in
  `docs/architecture/adr/0001-runner-releases-and-updates.md`.

## Data flow

1. The browser loads the SPA from web (nginx). `/api` and `/api/events` are proxied to api, so
   web and api share one origin.
2. Login: web redirects to `/api/auth/login`; api performs OIDC authorization code + PKCE with
   Pocket ID and returns to `/api/auth/callback`; api stores a server-side session and sets an
   httpOnly, Secure, SameSite=Lax cookie. Intentra has no passwords, registration or reset.
3. Authenticated requests carry the session cookie; api resolves the user and the project RBAC
   role (admin/owner/editor/viewer).
4. Intent flow: the user creates an intent → api runs stages (`intake`, `spec`, `spec_critic`,
   `plan`, `build`, `review`, `verify`, `accept`) and offers jobs to a runner → the runner
   executes locally with the configured agent runtime → statuses, findings, verdicts and a
   content-free diff summary come back → the human accepts.
5. Privacy: the centre receives intent/spec/AC/findings texts, statuses, metadata
   (path/symbol/blobSha), links and numbers — never file contents, diffs, logs, test output,
   transcripts or keys.

## Deployment shape

`infra/compose/docker-compose.yml` runs three services: `migrate` (one-shot Drizzle migrations),
`api` (Node 24, non-root) and `web` (nginx, non-root, static SPA + `/api` proxy). Postgres,
Pocket ID (`infra/idp`) and FalkorDB/Qdrant/Ollama (`infra/memory`) run on their own hosts; the
API reaches them over the network. Host provisioning and addressing are environment-specific and
stay in the operator's private infrastructure repository. CI (`.github/workflows/ci.yml`) runs
the Node gates with a PostgreSQL 18 service and the Rust gates in a separate job.

Self-hosted self-dogfood on the slice: the runner executes build jobs on the machine with the
repository, and only statuses, findings, metadata and a content-free diff summary leave it.

See `docs/development/commands.md` for commands, `docs/capabilities/index.md` for the capability
rows with their entry points and tests, and `AGENTS.md` for coding conventions.
