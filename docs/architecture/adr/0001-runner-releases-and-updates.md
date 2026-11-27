# ADR 0001 — Runner releases and self-updates

Status: accepted (2026-11-27). Task: runner release and automatic updates. Related documents:
[`docs/operations/releases.md`](../../operations/releases.md),
[`docs/operations/updates.md`](../../operations/updates.md).

## Context

The runner is installed on machines that hold the code, and until now it could only be replaced by
rebuilding it in place. There was no release artefact, no version tag, no way for a control plane
to tell an installed runner that a newer build exists, and no safe way to swap the binary while
jobs might be running. The centre already learns the runner version from `hello`, so it can act
as the delivery channel, but it must not become a second source of truth for what is official.

Constraints that shaped the decision: the runner runs jobs for real projects, so an update must
never interrupt or corrupt a job; a compromised centre must not be able to push a forged binary to
every runner; releases must be reproducible and inspectable; and the centre is a self-hosted
Fastify service that may have limited or no egress to GitHub.

## Decision

1. **GitHub Releases store the artifacts; the centre delivers them.** One tag on `main` builds the
   binary for five targets, publishes the archives with SHA-256 checksums and a signed update
   manifest, and the centre ingests the same manifest and streams the archives from its own cache.
   Runners derive the delivery URL from their configured centre URL and never call GitHub, so a
   firewalled runner works as long as the centre does, and the centre can audit and withdraw
   releases. Alternatives rejected: runners fetching GitHub directly (breaks air-gapped
   installs and the private-repository token would have to live on every runner); a separate
   update service (another component and another trust boundary for no gain at this scale).

2. **Ed25519 over the exact manifest bytes, signatures verified in the runner.** The manifest is a
   canonical compact JSON string; the signature is made over those bytes, not over a re-serialised
   object, so field order and escaping can never invalidate it. The centre stores and returns the
   bytes verbatim. The 32-byte raw public key is compiled into the runner
   (`crates/runner-core/keys/release.pub`) and read from the same file by the centre, so one
   committed key identifies the release channel. An all-zero placeholder key fails closed: the
   release job refuses to produce the manifest and the runner refuses every update. Alternatives
   rejected: signing
   each archive (the manifest already binds the archive by SHA-256, and signing five files means
   five failures to handle); sigstore/transparency logs (external infrastructure and keyless
   identity are out of scope for a self-hosted install).

3. **SHA-256 binds the archive to the manifest.** The runner checks the archive digest while
   streaming it to disk and refuses a mismatch before extracting anything. A release signature
   without archive digests would let the storage layer swap a binary after signing.

4. **Automatic application is on by default, disabled per host by `[update] enabled = false`,
   deferred while work exists, and reversible.** The daemon applies an offered release only when no
   job is running, reserved or being accepted; the apply and job-acceptance paths share one gate. It backs up the running executable to
   `<exe>.prev`, records the pending update in `update-state.json`, then replaces and restarts the
   binary. The new process self-checks (config, token, git) and must confirm through `hello`;
   failure, or a start that does not confirm, restores `.prev` and reports `rolled_back`.
   Alternatives rejected: a supervisor/PID-1 restart (the platform may be Windows and there is no
   supervisor contract), and applying between jobs without a backup (a failed new binary would
   leave a machine that cannot run jobs).

5. **Channels are stable and beta, expressed in SemVer.** Prerelease versions (`0.2.0-beta.1`) are
   published to `beta`; stable runners see stable releases only, beta runners see the newest of
   stable and beta. A per-runner pin overrides the channel, including for a downgrade, which is the
   supported way to move a runner back. The centre offers only releases for its own
   `PROTOCOL_VERSION`; a protocol bump therefore requires a deliberate manual runner upgrade before
   it can self-update again.

## Consequences

- Two secrets must exist before the first release: `RELEASE_SIGNING_KEY` in CI and the centre's
  `RELEASE_PUBLISH_TOKEN` (mirrored as `CENTER_RELEASE_TOKEN`); a private GitHub repository also
  needs `GITHUB_RELEASE_TOKEN` on the centre. The public key is a committed file, not a secret.
- Losing the signing key means existing runners cannot be updated automatically again; rotating the
  key requires shipping a release signed with the old key. The key is therefore backed up like any
  release credential.
- A release is effectively immutable: changing a published manifest breaks its signature, so the
  remedy is a new version or a yank, not an edit.
- Runners need a token and network access to the centre for updates; fully offline hosts update by
  copying an archive and swapping the binary as described in the updates document.
- The `autoUpdate` toggle is currently informational on the runner side (the daemon applies any
  offered release); the host-level `[update] enabled` switch is what disables automatic updates.
  This is recorded as a known limitation in the updates document.
