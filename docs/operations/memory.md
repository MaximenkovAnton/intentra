# Memory operations (FalkorDB, Qdrant, Ollama)

The control-plane memory keeps knowledge in three services outside the
`infra/compose` stack:

| Service | Purpose | Default local port | Container port |
| --- | --- | --- | --- |
| FalkorDB 6.2.1 | graph of intents, decisions, claims, episodes, capabilities, traps | 16379 | 6379 |
| Qdrant 1.20.0 | dense bge-m3 + sparse BM25 vectors for `intentra_text` | 16333 / 16334 | 6333 / 6334 |
| Ollama 0.12.3 | `bge-m3` embeddings (1024 dimensions) | 11434 | 11434 |

Postgres stays the durable store for claims (`memory_claims`), the outbox
(`outbox`) and the embedding cache (`embedding_cache`); the graph and the vector
collection are derived indexes.

## Deploy on a host

The repository ships the memory stack as `infra/memory/docker-compose.yml` but
does not ship host provisioning. Containers, VMs or LXC guests, their addresses,
storage and backup schedules are environment-specific: keep them in the
operator's private infrastructure repository, never in this one. The product
side only needs a host with Docker Compose and the values from
`infra/memory/.env.example`.

On such a host:

```bash
scp infra/memory/docker-compose.yml infra/memory/.env.example user@host:/opt/intentra-memory/
ssh user@host 'cd /opt/intentra-memory && cp -n .env.example .env && docker compose up -d'
```

The stack needs roughly 6 GB RAM and 60 GB disk for the `bge-m3` model, plus
`nesting=1` and `keyctl=1` when it runs inside an LXC container. A reverse proxy
or the control-plane nginx exposes only the API; FalkorDB, Qdrant and Ollama stay
on the private network.

## Run locally (integration tests)

The compose file maps the services onto the high local ports used by the test
suite:

```bash
cd infra/memory
cp .env.example .env
docker compose up -d
docker compose ps
docker compose exec falkordb redis-cli -p 6379 ping
docker compose exec -T qdrant bash -c 'exec 3<>/dev/tcp/127.0.0.1/6333'
docker compose exec ollama ollama list          # bge-m3 after ollama-init
```

`docker compose down` stops the stack and keeps the named volumes; `down -v`
also removes the graph, vectors and the downloaded model.

## Configure the API

The API reads these environment variables (validated at startup in
`apps/api/src/config.ts`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `FALKORDB_URL` | `redis://localhost:6379` | FalkorDB connection string |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant REST base URL |
| `QDRANT_API_KEY` | unset | Qdrant API key when the instance requires one |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `MEMORY_EMBEDDING_MODEL` | `bge-m3` | embedding model |
| `MEMORY_INTERNAL_TOKEN` | unset | bearer token for `/api/internal/memory/*`, used by the orchestrator/runner; when unset those routes answer 401 |
| `MEMORY_OUTBOX_INTERVAL_MS` | `5000` | outbox replay interval |

The graph name is always `intentra`; the embedding dimension is fixed at 1024.
`pnpm db:migrate` creates the Postgres tables and indexes the memory module
needs. Schema of the graph (`ensureSchema` → range indexes on Project, Intent,
Spec, Decision, Claim, CodeRef, Episode, Task) and of the Qdrant collection
(`intentra_text`: dense 1024/Cosine, sparse BM25 with `modifier: idf`, payload
indexes on `project_id`, `kind`, `status`) are created lazily by the API on its
first read or write and are safe to run repeatedly.

## Health and degradation

`DegradedRegistry` tracks FalkorDB, Qdrant and Ollama independently. A failed
call marks the service down and every response that depends on it degrades:

- FalkorDB down: writes are queued in `outbox`, reads fall back to the Postgres
  cache (`memory_claims` + `decisions`); `GET /api/projects/:key/memory/graph`
  answers with `degraded: true`.
- Qdrant or Ollama down: search falls back to FalkorDB text search plus the
  Postgres `pg_trgm` index; `GET .../memory/search` answers `degraded: true`.
- All three down: the API keeps working on Postgres; knowledge writes and
  vectorization stay in `outbox`.

The outbox worker starts with the API (`memory.start()`), replays due rows in
`next_attempt_at` order and backs off exponentially from 1 s to 300 s. A
recovered service is picked up by the next attempt; no manual replay is needed.
Rows are removed only after the handler succeeded.

## Claims

`/api/internal/memory/claims` is the write path for the runner/orchestrator; a
claim without a probe is rejected with 400. `POST /claims/:id/validate` takes
the runner's observation (`outcome: passed | failed | stale`, `commit`, optional
`blobSha`) and sets `fresh`, `contradicted` or `stale`. The control plane never
marks a claim fresh on its own. A contradicted claim is not used as evidence:
context packs omit accepted decisions whose `evidence` references it.

The context pack (`/api/internal/memory/context-pack`) is deterministic and
capped at 3072 bytes; the test `apps/api/test/memory-api.test.ts` snapshots it.
With `stage`, the AC section lists the current spec of that stage: `draft` /
`in_review` for `spec` and `spec_critic`, `approved` from `plan` onward, and no
ACs for `intake`. Without `stage` it lists the latest spec version.

## Backup and restore

The memory stack keeps all state in named Docker volumes, so back it up on the
host that runs `infra/memory/docker-compose.yml` (a `docker compose stop` plus a
volume snapshot, or the host's own VM/container backup). Backups contain the
FalkorDB graph, the Qdrant collection and the downloaded `bge-m3` model; Postgres
is backed up separately as the durable store.

After a restore, start the stack and the API; the API recreates indexes and
re-indexes anything still in `outbox`. Host-specific backup commands, storage
names and schedules belong to the operator's private infrastructure repository,
not to this repository.

## Integration tests

```bash
cd infra/memory && docker compose up -d
DATABASE_URL=postgres://intentra:intentra@localhost:55432/intentra_test \
TEST_DATABASE_URL=postgres://intentra:intentra@localhost:55432/intentra_test \
MEMORY_IT=1 FALKORDB_URL=redis://127.0.0.1:16379 \
QDRANT_URL=http://127.0.0.1:16333 OLLAMA_URL=http://127.0.0.1:11434 \
pnpm --filter @intentra/api test
```

Without `MEMORY_IT=1` the integration suite is skipped and the unit/API suites
run with fakes and with the services absent.
