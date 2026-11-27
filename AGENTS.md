# AGENTS.md

Repository guide for coding agents working on Intentra. Read
[`docs/architecture/overview.md`](docs/architecture/overview.md) for the component map and
[`docs/development/commands.md`](docs/development/commands.md) for the full command list.

## Layout

- `apps/api` — control-plane API: Fastify 5, Node 24, TypeScript strict, Zod, Drizzle + `pg`,
  pino, `openid-client` (OIDC), sessions in Postgres.
- `apps/web` — React 19 SPA: Vite 7, TanStack Router/Query, react-i18next (ru/en), CSS tokens.
- `packages/contracts` — Zod REST schemas, OpenAPI 3.1 generation, WS runner protocol and adapter
  types; consumed by api and web.
- `crates/runner-core` — Rust runner protocol structs shared with the centre; `crates/runner` —
  the `intentra-runner` CLI binary (stubs in this scaffold).
- `infra/compose` — Dockerfiles, nginx config, `docker-compose.yml`, `.env.example`.
- `fixtures/runner` — JSON fixtures checked by the Rust contract tests.
- `docs/` — architecture and development docs.

Board/task automation state lives in `.agile/`, which is gitignored and not part of the
repository.

## Commands

Install once with `pnpm install`. The gates that must pass before any change is done:

```bash
pnpm -w typecheck
pnpm -w lint
pnpm -w test
pnpm -w build
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

Other commands (dev servers, database migrations, OpenAPI, Playwright, Docker Compose) are
documented in `docs/development/commands.md`; use those names instead of inventing new ones.

## Conventions — TypeScript

- ESM everywhere (`"type": "module"`). `apps/api` and `packages/contracts` compile with NodeNext
  (relative imports need the `.js` extension); `apps/web` uses the Bundler resolver.
- TypeScript is strict with `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and
  `noUnusedLocals`/`noUnusedParameters`. `any` is an ESLint error — use `unknown` plus Zod.
- Use named exports; do not add default exports.
- Validate every boundary with Zod: HTTP request/response bodies, environment configuration, WS
  messages and data crossing trust boundaries. Derive types with `z.infer`.
- HTTP errors use one shape: `{ code, message, details? }`.
- Persistence is Drizzle + `pg`; migrations are generated into git (`apps/api/drizzle`). No
  ad-hoc SQL in route handlers.
- Configuration comes only from validated environment variables. Never commit `.env`, tokens or
  keys; never log them. Application logging is pino (ESLint bans `console` outside tests/scripts).
- Authentication is OIDC only (Pocket ID). Do not add passwords, registration, password reset or
  stored identity-provider credentials.
- Web UI: use CSS tokens for colors, typography and spacing (no raw hex or px for colors/fonts),
  keep RU/EN strings in i18n resources, preserve accessibility, and do not add a mobile UI (out of
  scope for v1).
- Tests: Vitest; colocate package tests under `test/` (`apps/api/test`,
  `packages/contracts/test`) and Playwright e2e under `apps/web/e2e`. API tests use
  `fastify.inject`; Postgres integration tests use `TEST_DATABASE_URL` and skip when it is unset.
  A test must fail when an auth, RBAC or OIDC validation check regresses.

## Conventions — Rust

- Edition 2024 workspace (`crates/`); `cargo fmt --check` and `cargo clippy -- -D warnings` are
  gates. Keep dependencies minimal, and keep `fixtures/runner` in sync with the serialized
  protocol structs.

## Conventions — infrastructure

- Containers are non-root (api runs as uid 10001, web and ingress as the `nginx` user); every
  long-running service has a healthcheck. Only `ingress` publishes a host port
  (`${WEB_PORT:-8090}`); `api` and `web` have no `ports` and no `container_name`, because
  `docker rollout` cannot replace a service that has them.
- One public origin: ingress proxies to web, web proxies `/api`, `/api/events` and
  `/api/runners/ws` to api. Ingress and web resolve their upstream through Docker DNS
  (`resolver` + `zone` + `server ... resolve`), so a rolled container is picked up without
  restarting the proxy.
- On a live host, updates go through `docker rollout` — `scripts/deploy.sh` builds with
  `INTENTRA_GIT_REVISION=$(git rev-parse HEAD)`, runs migrations, rolls api then web, and
  verifies the revision label; never use `docker compose up -d --build` for an update. `ingress`
  publishes the fixed port and is updated from `infra/compose` explicitly with
  `INTENTRA_GIT_REVISION=$(git rev-parse HEAD) docker compose build ingress` followed by
  `docker compose up -d --no-deps ingress`
  ([`docs/operations/deploy.md`](docs/operations/deploy.md)).
- Images carry `org.opencontainers.image.revision`; `docker-rollout` v0.14 is installed by
  `scripts/install-docker-rollout.sh`, which pins the downloaded file by sha256.
- No secrets in `docker-compose.yml` or `.env.example`; runtime values come from
  `infra/compose/.env` (gitignored). Never commit `.env`.
- The repository ships only portable deployment assets (`infra/compose`, `infra/memory`).
  Host-specific operations — Proxmox/VM/container provisioning, backup scripts, internal IPs,
  hostnames, CT IDs and cluster conventions — stay local in gitignored paths (`infra/local/`,
  `infra/proxmox/`) or in the operator's private infrastructure repository. Never commit or
  document internal topology here.

## Git and publication

- `origin` is a local bare mirror for self-dogfood; the canonical remote is GitHub (`github`).
- Feature branches (`feat/*`, `fix/*`) push freely. `main` never takes a direct push: open a pull
  request and merge it as a human. Ephemeral `intentra/*` and `*--bt-*` worktree branches are not
  published. Enable the push guard once per clone with `./scripts/install-git-hooks.sh`; the full
  policy is in [`docs/operations/publishing.md`](docs/operations/publishing.md).
