# Runner updates

An installed `intentra-runner` can replace itself with a newer release. The control plane offers
the release; the runner verifies an Ed25519 signature over the update manifest and the SHA-256 of
the archive, backs up the running binary, restarts itself only when no job is active, and rolls
back when the new binary does not come up. The runner never contacts GitHub: the centre streams the
artifacts it cached from GitHub Releases (see [`docs/operations/releases.md`](releases.md) for the
producer side).

## Configuration

The `[update]` section of `~/.intentra/config.toml` (or the file passed with `--config`):

```toml
[update]
enabled = true               # automatic checks on start and on the interval
channel = "stable"           # stable | beta
check_interval_min = 360     # minutes; minimum 5
allow_insecure_http = false  # local tests only; production uses https
```

All fields have these defaults; unknown fields are rejected. `enabled = false` turns off automatic
checking (and the check interval), but a pending update is still reconciled on start so a half-done
update cannot stay half-done. `allow_insecure_http = true` is only for a local centre on plain
HTTP — with it off, a derived `http://` update endpoint is refused before any request.

## What the centre offers

After the first successful `hello`, the runner calls
`GET /api/runners/update?current=<version>&channel=<channel>` with the runner token. The response
is `{available, channel, latestVersion, pinnedVersion, autoUpdate, manifest?, signature?, reason?}`.
The centre builds it from stored releases and the runner's policy row (`runners.pinned_version`,
`runners.auto_update`):

- only releases with `yanked = false` and `protocolVersion` equal to the centre's
  `PROTOCOL_VERSION` are considered;
- `stable` picks the highest stable version; `beta` picks the highest of stable **and** beta, so a
  beta runner still sees a newer stable release;
- without a pin, a candidate that is not newer than the runner's version is not offered
  (`available: false`, reason `no newer version`) — no downgrades;
- a `pinnedVersion` overrides the channel and is offered even when it is older (that is the
  intended way to roll a runner back); a pin that is missing from the visible pool or yanked yields
  `available: false` with reason `pinned version is unavailable`;
- `autoUpdate: false` currently yields `available: true` with reason `auto-update is disabled` so
  the UI can show it. **Known limitation:** the runner daemon does not consult this flag and
  applies any offered release; to stop automatic application on a host set `[update] enabled =
  false`. Upgrade condition: the daemon gates its cycle on `autoUpdate`.

A protocol bump makes old runners see nothing until they are updated by hand, which is deliberate:
the centre never offers a release the runner cannot speak.

## Verification before anything is written

The runner validates the answer before downloading:

1. `available` must be true and the response must parse (`RunnerUpdate::validate`).
2. The signature is verified over the exact bytes of `manifest` (a JSON string, byte-for-byte as
   signed) with the public key compiled into the binary from
   `crates/runner-core/keys/release.pub`. A placeholder all-zero key fails closed. Debug builds
   may override the key with `INTENTRA_UPDATE_PUBKEY` (raw base64 32 bytes); release builds ignore
   that variable.
3. The manifest's `channel` must equal the configured channel, its `protocolVersion` must equal the
   runner's protocol, and `latestVersion` must equal the manifest `version`.
4. The manifest must contain an asset for the current target, with a positive `sizeBytes`, a
   64-character lowercase hex `sha256`, and an absolute `https` URL (the URL is validated but not
   used).
5. The archive is downloaded from the centre at
   `<server_url→https>/api/runners/update/artifact/<fileName>` (bearing the runner token) and
   streamed to disk; the SHA-256 is computed while writing and compared with the manifest. The
   declared size and the transfer are capped at 256 MiB, a larger archive is refused before
   download. The centre serves the bytes with a `Digest: sha-256=...` header after checking them
   against the manifest; unknown or yanked artifact names answer `404` and bytes that do not match
   answer `502` instead of being streamed.
6. The archive is extracted in memory: entries with absolute paths or `..` are refused, exactly one
   `intentra-runner` (`intentra-runner.exe` on Windows) entry is required, then the binary is
   staged under the state directory.

A failure at any of these steps is logged as a warning, reported to the centre as `failed` and
retried on the next cycle. The running binary is untouched.

## When an update is applied

`start` spawns the update daemon only when `[update] enabled` is true (or a pending update exists
on disk) and the embedded key is not the placeholder. The daemon waits for the first successful
`hello`, confirms or rolls back a pending update (see below), then checks immediately and after
every `check_interval_min * 60` seconds with ±10% jitter — the interval is randomised per cycle so
a fleet does not poll the centre in lockstep.

A check is skipped while a job is active. The runner uses one atomic gate: a running job, an
accepted-but-not-started job, or a job reservation all block the update, and while the update holds
the gate the centre's offers are declined, so a restart never interrupts work. A failed check does
not block the next cycle.

## Applying, restarting and rollback

Before replacing anything the runner copies the running executable to `<exe>.prev` and writes
`update-state.json` next to the token (`~/.intentra/update-state.json`, or the token's directory):

```json
{"pending": {"from": "0.1.0", "to": "0.2.0", "attempts": 0, "stagedAt": "..."}}
```

It then installs the staged binary and restarts:

- **Unix** — `exec` of the same argv in place, so PID and supervisor are preserved and the old
  process never returns.
- **Windows** — spawn the new binary, wait up to 10 seconds for it to write its state file with the
  child PID, then the parent exits; a timeout or early exit restores `.prev` and reports
  `rolled_back`.

The new process reconciles the pending record before connecting: if `pending.to` equals its own
version and `attempts` is 0, it sets `attempts = 1`, runs a self-check (config loads, token loads,
`git` is on `PATH`; no network) and waits for its own `hello`; the update is then confirmed —
`pending` is removed, `confirmed` is recorded, and the centre receives `applied`. If the self-check
fails, if the process does not confirm on a later start (`attempts ≥ 1`), or if the restart could
not be performed, the runner restores `<exe>.prev`, reports `rolled_back` with the reason, and
restarts the previous binary. If `.prev` is missing the report is `failed` with that reason. A
`pending` record for a different version is discarded with a warning.

The report is `POST /api/runners/update/report` with `{fromVersion, toVersion, status, reason?}`
(`applied`/`rolled_back`/`failed`, `204`); the centre stores it in `runner_update_events`, publishes
the SSE event `runner.updated` and the Runners screen shows the version and the last update. Reports
are best effort: an unreachable centre does not block the runner.

`intentra-runner update --apply` applies immediately in the current process and does not restart;
run `intentra-runner start` afterwards to load the new binary, and the next start confirms the
update. It refuses with exit code 1 while the daemon is running, so stop the daemon first.

## Channels, pinning and admin controls

- **Channels** are set per runner in `[update]`. Tag a beta release (`X.Y.Z-beta.N`) to publish to
  `beta`; stable runners never see it. There are no other channels.
- **Pin** in the Runners screen (admin or project owner): `PUT /api/runners/:id/update-policy`
  with `{pinnedVersion: "0.2.0", autoUpdate: true}`. Clearing the pin is `pinnedVersion: null`.
  The route is audited and the Runners screen refreshes over SSE `runner.updated`.
- **Yank** a bad release at the centre (see
  [`docs/operations/releases.md`](releases.md#publish-to-the-centre)); it stops being offered and
  its artifact answers `404`, so a runner that has not downloaded it yet fails the check instead of
  installing it. A runner that already staged it still rolls back if the new binary is broken.
- **`autoUpdate`** is stored and returned but, as noted above, the current daemon applies any
  offered release. Use `[update] enabled = false` to stop automatic application on a host.

## Manual and offline operation

Manual check, with the token already stored by `intentra-runner register`:

```bash
intentra-runner update --config ~/.intentra/config.toml
```

It prints one JSON object: `current`, `latest`, `channel`, `available`, `pinnedVersion`,
`autoUpdate`, `reason`. Exit code 0 means the check completed (with or without an update), 4 means
no token, 3 means the config could not be loaded, 1 means the centre or the update failed. `update
--apply` installs the offered release in the same way as the daemon, prints the applied version,
and exits 1 with the reason when the release is refused or the install fails.

Air-gapped mode — the host cannot reach the centre, or the operator does not want automatic
updates:

1. Set `enabled = false` in `[update]` (or leave the host without a reachable centre; the daemon
   then logs a warning per cycle and keeps the current binary).
2. Download the archive for the target on a connected machine, copy it over and verify it with
   `sha256sum -c` (or the release's verification snippet in
   [`docs/operations/releases.md`](releases.md#verify-a-release)).
3. Stop the daemon (Ctrl-C or `SIGTERM`), unpack the archive, keep the old binary as
   `intentra-runner.prev`, put the new binary in place and start the daemon.
4. Confirm with `intentra-runner --version` and `intentra-runner status`. To revert, stop the
   daemon, restore the `.prev` copy and start it again.

The centre itself can serve artifacts when GitHub is unreachable from the runner host: the centre
caches them in `RELEASE_CACHE_DIR`, so only the centre needs `GITHUB_RELEASE_TOKEN` and network
access.

## Observability and troubleshooting

The runner logs update events with `tracing` (no secrets, no tokens): `deferring the update check
while a job is active`, `installed an update`, `the update failed`, `the update rolled back`,
`automatic update checks are off`. The centre records every report and shows it in the Runners
screen; `GET /api/runners` exposes `pinnedVersion`, `autoUpdate`, `latestVersion`,
`updateAvailable` and `lastUpdate`.

| Symptom | Check |
| --- | --- |
| `update` exits 4 | No token: run `intentra-runner register` first. |
| `refusing to derive a plain http update endpoint` | Use `https`, or set `allow_insecure_http = true` only for a local test centre. |
| `the update signature is not valid` | The centre stored a manifest the runner key cannot verify; check that the centre serves the bytes signed with `RELEASE_SIGNING_KEY` and that `release.pub` matches it. |
| `the update channel ... does not match ...` | The manifest channel differs from `[update] channel`; release a version for the right channel. |
| `the update protocolVersion ... does not match` | The release is for another protocol; upgrade the runner by hand. |
| `artifact digest mismatch` | The centre streamed corrupted bytes; check `RELEASE_CACHE_DIR` and re-yank/re-publish. |
| `pinned version is unavailable` / `already on the pinned version` | The pin is missing or yanked, or the runner is already on it; clear or change it. |
| `no newer version` | The runner is current for its channel (and protocol). |
| Update never applies while a job runs | Expected: the check is deferred and the offer is declined until jobs finish. |
| A rolled-back update repeats every cycle | Yank the release or pin the runner to a good version. |
| The state file is unreadable | The runner logs a warning, ignores it, and keeps going; delete `update-state.json` if it blocks a manual `--apply`. |

## Tests and evidence

| Area | Proof |
| --- | --- |
| manifest/signature contract | `packages/contracts/test/release.test.ts`, `crates/runner-core/src/update/{manifest,signature}.rs` unit tests, `fixtures/release/manifest.json` |
| policy (channel, pin, yanked, protocol, no downgrade) | `apps/api/test/releases-policy.test.ts` |
| artifact stream (hash, cache, 404, 502) | `apps/api/test/release-artifacts.test.ts` |
| report and SSE | `apps/api/test/release-report-policy.test.ts` |
| apply, defer and rollback | `crates/runner-core/src/update/{apply,daemon}.rs` unit tests |
| CLI status and `--apply` | `crates/runner/tests/cli.rs` |
| real centre, `0.1.0` → `0.2.0`, forged signature, deferral, rollback | `scripts/release/e2e-update.sh`; evidence in `.agile/e2e-evidence.md` of the task worktree (gitignored) |
| release pipeline | `pnpm -w test:release` |
