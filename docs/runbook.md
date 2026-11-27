# Runbook: Intentra v1 slice from zero

This is the operational path for the v1 slice: control plane (web + api + Postgres) on one
host, the memory stack (FalkorDB, Qdrant, Ollama) on a second host, Pocket ID on a third, and
the Rust runner on the machine that holds the code. It repeats what the e2e run did; every step
names the command and what a healthy result looks like. Host provisioning itself
(LXC/VM/Proxmox, addresses, storage, backups) is environment-specific: keep it in the
operator's private infrastructure repository, not here.

## 0. Prerequisites

- Node.js 24 and pnpm 11.28.5 (`corepack enable`), Rust stable with `rustfmt`
  and `clippy`, Docker with Compose v2.
- Three reachable hosts — `<control-host>`, `<memory-host>` and `<idp-host>` — either LXC
  containers, VMs or bare metal. Each needs Docker with Compose v2. The memory stack needs
  about 6 GB RAM and 60 GB disk for `bge-m3`, plus `nesting=1` and `keyctl=1` when it runs
  inside a container.
- A PostgreSQL 18 instance on `<postgres-host>` (it can share a host with the control plane).
- The public origin `<public-url>` that web and api share, and HTTPS for Pocket ID (passkeys
  need a secure context; a private CA is acceptable).
- Ports on the host that runs the control-plane compose file and the Playwright server: `8090`
  (web/api origin) and `4173` (Playwright web server), plus `5432` for the optional local test
  database.

## 1. PostgreSQL

Create the role, the database and the trigram extension once on the Postgres host:

```bash
psql "postgres://postgres@<postgres-host>:5432/postgres" -c \
  "CREATE ROLE intentra LOGIN PASSWORD '<password>'"
psql "postgres://postgres@<postgres-host>:5432/postgres" -c \
  "CREATE DATABASE intentra OWNER intentra"
psql "postgres://intentra@<postgres-host>:5432/intentra" -c \
  "CREATE EXTENSION IF NOT EXISTS pg_trgm"
```

Re-runs are safe if the role/database exist (use `ALTER ROLE ... PASSWORD` for a
new password). The server must accept the control-plane host (adjust `pg_hba.conf`);
migrations run from the compose `migrate` service.

Backups: schedule a `pg_dump` on the Postgres host. A one-off copy:

```bash
pg_dump -Fc "postgres://intentra@<postgres-host>:5432/intentra" > intentra.dump
```

## 2. Memory host

The repository ships the stack as `infra/memory/docker-compose.yml`; copy it to the host and
start it:

```bash
scp infra/memory/docker-compose.yml infra/memory/.env.example user@<memory-host>:/opt/intentra-memory/
ssh user@<memory-host> 'cd /opt/intentra-memory && cp -n .env.example .env && docker compose up -d'
```

Healthy result: `docker compose ps` in `/opt/intentra-memory` shows healthy `falkordb`, `qdrant`
and `ollama`; `redis-cli ping` answers `PONG`; `ollama list` contains `bge-m3`. Details, ports,
degradation and backup: [`memory.md`](operations/memory.md).

The api reaches the services at the addresses in `FALKORDB_URL`, `QDRANT_URL` and
`OLLAMA_URL` in `infra/compose/.env` (ports 16379, 16333 and 11434 by default).

## 3. Pocket ID host

Copy the portable stack to the IdP host, set `APP_URL` and start it:

```bash
scp -r infra/idp user@<idp-host>:/opt/intentra-idp
ssh user@<idp-host> 'cd /opt/intentra-idp && cp -n .env.example .env && $EDITOR .env && docker compose up -d'
```

Set `APP_URL=https://<idp-public-host>` in that `.env`; the certificate in `certs/` must cover
the name. Then, in a browser that trusts the CA (or the public certificate), open
`https://<idp-public-host>/setup`, create the first account and its passkey, and add the account
to `intentra-admins`. Details and the admin API commands: [`idp.md`](operations/idp.md).

Create the `intentra` OIDC client (confidential, PKCE, redirect `<public-url>/api/auth/callback`)
through the Pocket ID admin API or UI, and put its issuer, client id, secret and redirect into
`infra/compose/.env` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI`). With a private CA, copy the certificate to the compose directory:

```bash
cp /path/to/idp-ca.crt infra/compose/idp-ca.crt
```

## 4. Control plane (compose)

```bash
cd infra/compose
cp .env.example .env                  # fill in DATABASE_URL, SESSION_SECRET, memory URLs, OIDC values
docker compose config --quiet         # validate interpolation
IDP_CA_CERT=./idp-ca.crt docker compose \
  -f docker-compose.yml -f docker-compose.idp-ca.yml up -d --build
docker compose ps                     # migrate exited 0; api and web healthy
```

Plain-HTTP development runs `NODE_ENV=development`; `production` requires TLS on `PUBLIC_URL`
and an https OIDC issuer. `migrate` applies the Drizzle migrations before `api` starts; `web`
waits for the api healthcheck.

Checks:

```bash
curl -s -o /dev/null -w '%{http_code}\n' <public-url>/healthz      # 200 (nginx)
docker compose exec api node -e \
  "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1))"
```

Open `<public-url>`, click **Войти через Pocket ID**, sign in with the passkey. The admin must
land with the organisation admin role (member of `intentra-admins`). Degraded path: stop the
memory services on the memory host (`docker compose -p intentra-memory stop`) and confirm the UI
reports memory as degraded while intents still work; start them again and the outbox catches up.

## 5. Runner

Build the binary on the machine that holds the code:

```bash
cargo build --release --workspace
```

The DSH child runs its shell tool inside a `workspace-write` sandbox, so the host needs
`bubblewrap` (`apt-get install -y bubblewrap`); without it every shell tool call is refused
with "no sandbox backend is usable" and an agent can only use file tools and the MCP gates.

Create `~/.intentra/config.toml` (see [`development/adapters.md`](development/adapters.md)):

```toml
server_url = "ws://<public-host>/api/runners/ws"
token_path = "~/.intentra/token"
allow_roots = ["/path/to/projects"]
max_concurrent_jobs = 1

[workspaces]
intentra = "/path/to/intentra"

[runtimes.dsh]
binary = "dsh"
dsh_home = "~/.intentra/dsh"
provider = "deepseek-official"
model = "deepseek-flash"
```

The model credential stays on the runner. Two routes work:

- `provider = "deepseek-official"` with `INTENTRA_MODEL_API_KEY` exported in the
  daemon's environment (and inherited by the dsh child);
- `provider = "deepseek-account"` when the host has a signed-in DSH account in
  `~/.dsh/.credentials.yaml`; the key never leaves that credential store.

A turn that fails at the model (missing credential, provider error) fails the job
with that message instead of reporting an empty success. Register with a one-time token from
`POST /api/projects/<key>/runners/registration-token`, then start the daemon:

```bash
./target/release/intentra-runner register --server ws://<public-host>/api/runners/ws \
  --token <one-time-token> --name local
./target/release/intentra-runner doctor
./target/release/intentra-runner start
```

`doctor` reports config/token/git/workspace checks; `start` connects over the
WebSocket and the runner shows **online** in the UI. The centre receives only
metadata (paths, symbol names, blob hashes, statuses, findings, diff summaries)
— never file contents, diffs, logs or keys.

## 6. Self-dogfood

1. Sign in, create the project `intentra` bound to the runner workspace.
2. Create the intent **«В списке runners показывать версию и предупреждение при
   несовпадении»**; answer the front office's single escalation.
3. Run the spec stage; the mechanical spec-critic must approve without a human
   reading the document.
4. Approve the plan (1–2 build tasks) and let the runner execute them: the
   runner creates a worktree, the DSH adapter edits code and tests, gates run,
   the runner reports status, claims, verdicts and a diff summary.
5. Verify, review (no blocking findings), then accept in the UI. The episode and
   decisions are written to FalkorDB/Qdrant; the second intent finds them with
   memory search, and a changed file marks the claim stale while the critic
   stops using it.

Evidence of the run (commands, outputs, screenshots) lives in
`.agile/e2e-evidence.md` of the task worktree, which is gitignored.

## 7. Gates

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build
cargo fmt --check && cargo clippy -- -D warnings && cargo test
pnpm -w e2e
```

The API integration tests run against `TEST_DATABASE_URL` and skip when it is
unset; Playwright runs the mocked suites in `apps/web/e2e`.

## 8. Restore

| What | How |
| --- | --- |
| Postgres | `pg_restore -d intentra intentra.dump` on the Postgres host, then restart api. |
| Memory host | Restore the host/volume snapshot; the outbox re-indexes missing knowledge after start. |
| Pocket ID host | Restore the host/volume snapshot and keep `/opt/intentra-idp/.env` (the `ENCRYPTION_KEY` decrypts the signing keys). |
| Control plane | Images are rebuilt from the repository; `.env` is the only state. |

Snapshot and backup tooling is host-specific: keep the commands and schedules in the
operator's private infrastructure repository.

## 9. Troubleshooting

| Symptom | Check |
| --- | --- |
| `migrate` exits non-zero | `DATABASE_URL` reachable from the compose network; role owns the database; `pg_trgm` installed. |
| Login loops after Pocket ID | `OIDC_REDIRECT_URI` exactly matches the client callback; `OIDC_ISSUER` equals Pocket ID's `APP_URL`; CA overlay applied. |
| api logs `self-signed certificate` | `IDP_CA_CERT` missing or wrong in the CA overlay. |
| Runner stays offline | `doctor`, `ws://` URL, nginx `/api/runners/ws` upgrade headers, token not expired. |
| Memory degraded | services on the memory host (`docker compose ps`), URLs in `infra/compose/.env`, outbox draining. |
