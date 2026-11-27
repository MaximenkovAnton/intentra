# Intentra

Intent-driven delivery orchestrator: a control plane and a local runner that turn intent into
reviewed, verified code with pluggable coding-agent runtimes.

Status: the v1 slice is implemented. The control plane (projects, intents, front office, specs
with AC/DoD and a mechanical critic, plan/build/review/verify/accept, memory, SSE, RU/EN UI) and
the Rust runner (WebSocket transport, worktree/git, code index, MCP stdio, DSH/generic-CLI/mock
adapters, claims, gates, diff summary) are in the tree and green on the gates below. Pocket ID
(OIDC) is the only authentication. The centre never stores or receives code, diffs, logs or model
keys.

## Quick start

```bash
pnpm install
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build
cargo fmt --check && cargo clippy -- -D warnings && cargo test
```

Full deployment from zero, including Postgres, the memory stack and Pocket ID, is in
[`docs/runbook.md`](docs/runbook.md). The short version:

```bash
# hosts: Docker with Compose v2 — one for the control plane, one for memory, one for Pocket ID.
# LXC/VM provisioning and addressing are environment-specific and live outside this repository.
cd infra/compose
cp .env.example .env    # fill in DATABASE_URL, OIDC_*, SESSION_SECRET and the memory URLs
docker compose up -d --build
# with a private/self-signed IdP, add the CA overlay:
IDP_CA_CERT=./idp-ca.crt docker compose -f docker-compose.yml -f docker-compose.idp-ca.yml up -d
```

The control plane is served on `${PUBLIC_URL}` (the dev default is `http://localhost:8090`);
sign-in goes through Pocket ID. The runner is the `intentra-runner` binary built from
`crates/runner`.

## Architecture

| Component | Path | What it does |
| --- | --- | --- |
| web | `apps/web` | React 19 SPA: projects, intents, spec/critic/plan/build/evidence, runners, memory; RU/EN, SSE, light/dark theme |
| api | `apps/api` | Fastify 5 control plane: OIDC sessions + RBAC, projects/members, intents + front office, specs + AC/DoD + mechanical critic, planner, orchestrator (jobs/leases/verify/accept), memory (FalkorDB + Qdrant + Ollama), SSE, runner hub |
| contracts | `packages/contracts` | Zod REST schemas, OpenAPI 3.1, WS runner protocol, adapter types |
| runner | `crates/runner` | `intentra-runner` CLI: register/start/status/doctor/mcp, WSS transport, worktree/git, tree-sitter index, verify/claims/diff, DSH + generic CLI + mock adapters |
| runner-core | `crates/runner-core` | Shared protocol, config, job/adapter types, git and index primitives |
| infrastructure | `infra/` | portable compose stacks: control plane (api/web/migrate), memory (FalkorDB/Qdrant/Ollama), Pocket ID; nginx |
| docs | `docs/` | architecture, development commands and adapters, operations (memory, IdP), runbook |

Postgres, FalkorDB/Qdrant/Ollama and Pocket ID run on their own hosts and are reached by URL.
Host provisioning (LXC/VM/Proxmox, addressing, storage, backups) is environment-specific and
stays in the operator's private infrastructure repository; this repository ships only the
portable compose stacks. The privacy boundary is deliberate: the runner reports statuses,
findings, metadata and a content-free diff summary — see
[`docs/architecture/overview.md`](docs/architecture/overview.md).

## Development

- [`docs/development/commands.md`](docs/development/commands.md) — every script and command.
- [`docs/development/adapters.md`](docs/development/adapters.md) — runner runtime adapters and config.
- [`docs/development/web-ui.md`](docs/development/web-ui.md) — UI screens, i18n, theme, tests.
- [`docs/operations/memory.md`](docs/operations/memory.md) — memory stack and degradation.
- [`docs/operations/idp.md`](docs/operations/idp.md) — Pocket ID deployment and OIDC setup.
- [`docs/runbook.md`](docs/runbook.md) — deploy, verify, self-dogfood, restore.

`AGENTS.md` holds the coding conventions (ESM/NodeNext, strict TypeScript, Zod at boundaries,
CSS tokens, i18n, Rust gates).

## License

Proprietary. Copyright (c) 2026 Anton Maksimenkau, all rights reserved. The
source is publicly available for viewing and evaluation only; no license to
use, modify or distribute it is granted. External contributions are accepted
only after signing the [Contributor License Agreement](CLA.md); see
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`LICENSE`](LICENSE).
