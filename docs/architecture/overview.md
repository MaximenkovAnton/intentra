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
| ingress | `infra/compose/ingress.conf` | nginx 1.29, Docker DNS resolver | The only published port (`${WEB_PORT:-8090}`); proxies to the web upstream and re-resolves it so a rolled web container is picked up without a restart. |
| api | `apps/api` | Fastify 5, Node 24, TypeScript strict, Zod, Drizzle + `pg`, pino, `openid-client`, SSE | OIDC login/session, RBAC, projects/members/runners; the resting place for orchestration (stages, jobs, leases, retries, budgets), memory context API and the WSS runner hub. |
| contracts | `packages/contracts` | Zod, OpenAPI 3.1 via `@asteasolutions/zod-to-openapi`, WS protocol and adapter types | Single source of REST/WS shapes; emits the OpenAPI document consumed by web via `openapi-typescript`. |
| Postgres 18 | external instance | — | Users, sessions, projects, members, runners, and the planned intent/spec/job/finding tables. |

Supporting services are deployed separately and reached by URL, not by this compose file: Pocket
ID (OIDC identity) and FalkorDB + Qdrant + Ollama with bge-m3 (memory).

### Runner (Rust, on the machine with the code)

- `crates/runner-core` — protocol structs shared by centre and runner (hello/heartbeat now, job
  messages later).
- `crates/runner` — the `intentra-runner` CLI binary: `register`/`start`/`status`/`doctor`/`mcp`.
- Outbound WSS transport with reconnect, job executor, worktrees and git operations, local
  tree-sitter index, MCP stdio server, claim verifier, gate runner, diff summary, and the DSH,
  generic-CLI and mock adapters — see `docs/development/adapters.md`.

## Data flow

1. The browser loads the SPA through the deployment proxy (NPM, TLS), which forwards to
   `ingress`; ingress proxies to web, and web proxies `/api` and `/api/events` to api, so web and
   api share one origin. Both proxies re-resolve their upstream through Docker DNS, and the
   rolling deploy pins the replacement container in the consuming proxy before it removes the
   old one, so traffic never has a removed address as its only peer.
2. Login: web redirects to `/api/auth/login`; api performs OIDC authorization code + PKCE with
   Pocket ID and returns to `/api/auth/callback`; api stores a server-side session and sets an
   httpOnly, Secure, SameSite=Lax cookie. Intentra has no passwords, registration or reset.
3. Authenticated requests carry the session cookie; api resolves the user and the project RBAC
   role (admin/owner/editor/viewer).
4. Intent flow: the user creates an intent → api runs stages (`intake`, `spec`, `spec_critic`,
   `plan`, `build`, `review`, `verify`, `accept`) and offers jobs to a runner → the runner
   executes locally with the configured agent runtime → statuses, findings, verdicts and a
   content-free diff summary come back → the human accepts. A `draft` intent whose intake
   failed or expired is restarted through `POST /api/intents/{id}/retry`, which enqueues a fresh
   intake stage and job.
5. Privacy: the centre receives intent/spec/AC/findings texts, statuses, metadata
   (path/symbol/blobSha), links and numbers — never file contents, diffs, logs, test output,
   transcripts or keys.

## Deployment shape

`infra/compose/docker-compose.yml` runs four services: `migrate` (one-shot Drizzle migrations),
`api` (Node 24, non-root), `web` (nginx, non-root, static SPA + `/api` proxy) and `ingress`
(nginx, the only published port, `${WEB_PORT:-8090}`). `api` and `web` have no published ports,
so the rolling deploy can replace them one container at a time; the ingress and web configs
resolve their upstream dynamically, and `scripts/deploy.sh` runs migrations, rolls api then web
with a deterministic drain, recreates ingress and verifies the endpoints and the revision
labels. Postgres,
Pocket ID (`infra/idp`) and FalkorDB/Qdrant/Ollama (`infra/memory`) run on their own hosts; the
API reaches them over the network. Host provisioning and addressing are environment-specific and
stay in the operator's private infrastructure repository. CI (`.github/workflows/ci.yml`) runs
the Node gates with a PostgreSQL 18 service and the Rust gates in a separate job.

Self-hosted self-dogfood on the slice: the runner executes build jobs on the machine with the
repository, and only statuses, findings, metadata and a content-free diff summary leave it.

See `docs/development/commands.md` for commands and `AGENTS.md` for coding conventions.
