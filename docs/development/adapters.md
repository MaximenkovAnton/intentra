# Runtime adapters

The runner talks to an agent runtime through one trait,
`intentra_runner_core::adapter::AgentAdapter`. The centre never calls a runtime
directly: it offers a job with `runtime: "<id>"`, the runner selects the adapter
whose `info().id` matches, and the adapter runs the agent inside the job
worktree.

## The contract

`crates/runner-core/src/adapter.rs` owns the types shared with the centre
(`AdapterCapabilities`, `JobSpec`, `AgentEvent`, `AgentResult`, `DetectResult`).
`packages/contracts/src/adapter.ts` is a different contract — the adapter
request/event/result of the WebSocket runner protocol — and not a mirror of
these Rust types. An adapter also implements:

- `info()` — stable `{ id, label }`; the id is what `job.offer.runtime` names.
- `capabilities()` — what the runtime can do (`sessions`, `streaming`,
  `mcp_tools`, `approvals`, `user_questions`, `model_selection`, `resume`).
- `detect()` — whether the runtime is installed, with a version or a reason.
  `from_config` calls it at `start`, so an unavailable runtime is not offered in
  the runner `hello`.
- `run(spec)` — the job; returns an `AgentResult` or an `AdapterError`.
- `cancel(job_id)` — stop a running job (kills the child process).

`AdapterHost` is the only channel back to the runner: `event()` streams an
`AgentEvent` as `job.event`, and `ask()` sends `job.question` to the centre and
waits up to 30 minutes for `job.answer`. An adapter never opens a connection to
the centre itself and never receives the runner token.

## Accepting a job

`JobManager::accept` opens the workspace repository before the adapter runs. An
offer is declined when the workspace has uncommitted changes to tracked files
(modified, deleted or added). Untracked files do not block the offer: the job
worktree is created from `HEAD`, so those files never reach the agent.

## The adapters in this tree

| id | file | notes |
| --- | --- | --- |
| `dsh` | `src/adapters/dsh.rs` | `dsh --profile` child speaking the `dsh-sdk-protocol` JSON-RPC over stdio; profile generated under `~/.intentra/dsh/profiles` with `sdk-app`, the `mcp-client` stdio row (`intentra-runner mcp --job …`) and the model route |
| `cli` | `src/adapters/cli.rs` | generic CLI run without a shell: prompt on stdin or as the last argument, output text or JSONL, final JSON validated against the findings/verdict schema |
| `mock` | `src/adapters/mock.rs` | deterministic events and result for orchestrator and runner tests |

`from_config` in `src/adapters/mod.rs` builds the registry from
`[runtimes.*]` entries. Any `[runtimes.<id>]` table enables a runtime;
`dsh`, `cli` and `mock` are the known ids.

## Configuration

```toml
[runtimes.dsh]
binary = "dsh"
dsh_home = "~/.intentra/dsh"
provider = "deepseek-official"
model = "deepseek-flash"

[runtimes.cli]
binary = "codex"
args = ["exec"]
prompt_mode = "arg"   # stdin | arg
output_mode = "jsonl" # text | jsonl
timeout_sec = 900
result_file = ".intentra/result.json"

[runtimes.cli.env]
CODEX_HOME = "/var/lib/codex"
```

The DSH adapter passes the model key from `INTENTRA_MODEL_API_KEY` and the
per-job MCP token from `INTENTRA_JOB_TOKEN` to the child; neither value is ever
written to the profile, stdout, stderr or the centre. The profile patch refers
to them as `!!js process.env.*` instead of literals.

## Final JSON for a generic CLI

In `jsonl` mode the last JSON object on stdout (or the file named by
`result_file`, relative to the worktree) is validated:

```json
{
  "summary": "review done",
  "status": "succeeded",
  "findings": [
    {"acId": "AC-1", "class": "scope", "severity": "nit", "requirement": "stay in scope"}
  ],
  "verdict": {"role": "reviewer", "decision": "approve"}
}
```

`class` is one of `ambiguous`, `missing-evidence`, `contradiction`,
`unprovable`, `stale-doc`, `scope`; `severity` is `blocking` or `nit`;
`decision` is `approve`, `changes` or `block`. An invalid final JSON fails the
job instead of inventing a result.

## Adding an adapter

1. Create `crates/runner-core/src/adapters/<id>.rs` with a config struct
   (`from_runtime`) and an `AgentAdapter` implementation. Take an
   `Arc<dyn AdapterHost>` in the constructor.
2. Register it in `adapters/mod.rs::from_config` when its `[runtimes.<id>]`
   table is present, and call `detect()` before registering.
3. Test it against a local fake runtime (a script that speaks the protocol),
   plus `detect()` for both a present and an absent binary. Skip tests that need
   a real runtime when the binary is missing instead of failing.
4. Add a row to the table above and a config example here.
