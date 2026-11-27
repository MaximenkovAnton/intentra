# Development commands

Run commands from the repository root unless stated otherwise. These are the scripts declared in
the root and package manifests; nothing else is required.

## Prerequisites

- Node.js 24 (`.nvmrc`) and pnpm 11.28.5 (`packageManager`; `corepack enable`).
- Rust stable with `rustfmt` and `clippy` (edition 2024) for the `crates/` workspace.
- Docker with Compose v2 for `infra/compose`.

## Install

```bash
pnpm install
```

## Workspace scripts (root `package.json`)

| Command | What it does |
| --- | --- |
| `pnpm dev` | Builds `@intentra/contracts`, then runs the contracts/api/web dev watchers in parallel. |
| `pnpm build` | Builds every workspace package that has a `build` script (`tsc` and Vite). |
| `pnpm typecheck` | Builds contracts, then type-checks all packages with `tsc --noEmit`. |
| `pnpm test` | Builds contracts, then runs Vitest in every package that has tests. |
| `pnpm lint` | ESLint over the repository (`eslint .`). |
| `pnpm db:generate` | Generates Drizzle SQL migrations in `apps/api` from the schema. |
| `pnpm db:migrate` | Applies migrations (`apps/api`, `tsx src/db/migrate.ts`; needs `DATABASE_URL`). |
| `pnpm openapi` | Emits `packages/contracts/openapi.json` from the Zod schemas. |
| `pnpm e2e` | Runs the Playwright suite in `apps/web`. |

## Package scripts

Run a package script from the root with `pnpm --filter <name> <script>`, for example
`pnpm --filter @intentra/api dev`.

- `@intentra/api`: `dev` (`tsx watch src/server.ts`), `build` (`tsc -p tsconfig.build.json`),
  `start` (`node dist/server.js`), `typecheck`, `test` (`vitest run`), `db:generate`, `db:migrate`.
- `@intentra/web`: `dev` (Vite), `build`, `preview`, `typecheck`, `test`, `e2e` (Playwright),
  `api:types` (`openapi-typescript` against `packages/contracts/openapi.json`).
- `@intentra/contracts`: `build`, `dev` (watch), `typecheck`, `test`, `openapi`.

## API tests against Postgres

Integration tests use `TEST_DATABASE_URL` and are skipped when it is not set. Point it at a
disposable PostgreSQL 18 database, apply migrations, then run the API suite:

```bash
export DATABASE_URL='postgres://intentra:intentra@localhost:5432/intentra'
export TEST_DATABASE_URL='postgres://intentra:intentra@localhost:5432/intentra_test'
pnpm db:migrate
pnpm --filter @intentra/api test
```

`pnpm -w test` runs the same suite as part of all workspace tests.

## Rust

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
```

These cover `crates/runner-core` and `crates/runner`; the contract fixtures live in
`fixtures/runner/`.

## Docker Compose

```bash
cp infra/compose/.env.example infra/compose/.env   # then fill in the values
docker compose -f infra/compose/docker-compose.yml config
docker compose -f infra/compose/docker-compose.yml up --build
```

`migrate` runs once and must succeed before `api` starts; `web` waits for the api healthcheck and
serves the SPA on `http://localhost:${WEB_PORT:-8090}` (one origin, `/api` and `/api/events`
proxied). Postgres, Pocket ID and the memory services are external; set their URLs in the same
`.env` file. `.env` is gitignored. Prometheus scrapes the api from inside the compose network at
`http://api:8080/metrics`; the endpoint is deliberately not exposed through the single origin.

When Pocket ID serves a private/self-signed certificate, copy its CA into the compose
directory and add the overlay so the api container trusts it:

```bash
cp /path/to/idp-ca.crt infra/compose/idp-ca.crt
cd infra/compose
IDP_CA_CERT=./idp-ca.crt docker compose \
  -f docker-compose.yml -f docker-compose.idp-ca.yml up -d --build
```

Plain-HTTP development runs `NODE_ENV=development`; `production` requires TLS on
`PUBLIC_URL` and an https OIDC issuer. See [`docs/runbook.md`](../runbook.md).

## Memory and IdP hosts

The repository ships the portable stacks `infra/memory` (FalkorDB, Qdrant, Ollama) and
`infra/idp` (Pocket ID); copy either to a host with Docker Compose and start it there:

```bash
scp -r infra/memory user@<memory-host>:/opt/intentra-memory
ssh user@<memory-host> 'cd /opt/intentra-memory && cp -n .env.example .env && docker compose up -d'
scp -r infra/idp user@<idp-host>:/opt/intentra-idp
ssh user@<idp-host> 'cd /opt/intentra-idp && cp -n .env.example .env && docker compose up -d'
```

Host provisioning (LXC/VM/Proxmox templates, static addresses, storage, backup schedules) is
environment-specific and lives in the operator's private infrastructure repository, never here.
Details: [`docs/operations/memory.md`](../operations/memory.md) and
[`docs/operations/idp.md`](../operations/idp.md).

## Runner

```bash
cargo build --release --workspace
./target/release/intentra-runner register --server ws://<origin>/api/runners/ws --token <token> --name local
./target/release/intentra-runner doctor
./target/release/intentra-runner start
./target/release/intentra-runner status
```

The config file is `~/.intentra/config.toml` (or `INTENTRA_CONFIG`); see
[`adapters.md`](adapters.md) for runtimes, workspaces and the model key variables. Register with a
one-time token from `POST /api/projects/<key>/runners/registration-token`.

## Acceptance gates

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build
cargo fmt --check && cargo clippy -- -D warnings && cargo test
pnpm -w e2e
```

`pnpm -w e2e` runs the Playwright suites in `apps/web/e2e` (mocked API and the full mock flow).
The API integration tests use `TEST_DATABASE_URL` and are skipped without it.

## CI

`.github/workflows/ci.yml` runs two jobs: `node` (pnpm install with `--frozen-lockfile`, then
typecheck, lint, test and build, with a PostgreSQL 18 service and `TEST_DATABASE_URL`) and `rust`
(`cargo fmt --check`, `cargo clippy`, `cargo test`).
