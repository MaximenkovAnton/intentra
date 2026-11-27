# Capability map

What a user or operator can do with Intentra, where it starts in the code, and which test proves
it. `Status` is `delivered` (in the tree, proven), `partial` (works with a documented limit) or
`planned` (specced, not in the tree). A change that alters observable behaviour updates the row in
the same diff; entry points and test paths must exist in the tree, and the docs link is the
operator-facing description.

| Capability | Status | Entry points | Tests | Docs |
| --- | --- | --- | --- | --- |
| Runner releases: one tag builds the `intentra-runner` binary for five targets, publishes archives, checksums and an Ed25519-signed update manifest on GitHub Releases, and ingests the manifest into the control plane | delivered | `.github/workflows/release.yml`; `scripts/release/package.sh`; `scripts/release/manifest.mjs`; `POST /api/admin/releases`; `POST /api/admin/releases/:version/yank` | `pnpm -w test:release` (`scripts/release/release.test.mjs`); `apps/api/test/releases-publish.test.ts`; `packages/contracts/test/release.test.ts` | [`docs/operations/releases.md`](../operations/releases.md) |
| Runner updates: the runner checks the centre, verifies the signature and archive hash, applies only when no job is active, restarts, confirms or rolls back; channels, pin and yank are admin controls and the Runners screen shows the state | partial | `intentra-runner update [--apply]` (`crates/runner/src/main.rs`); update daemon and apply/rollback (`crates/runner-core/src/update/`); `GET /api/runners/update`, `GET /api/runners/update/artifact/:fileName`, `POST /api/runners/update/report`, `PUT /api/runners/:id/update-policy` (`apps/api/src/routes/runner-updates.ts`); `RunnerUpdateCell` (`apps/web/src/components/RunnerUpdateCell.tsx`) | `cargo test -p intentra-runner-core update::`; `cargo test -p intentra-runner --test cli`; `apps/api/test/releases-policy.test.ts`, `release-artifacts.test.ts`, `release-report-policy.test.ts`; `apps/web/src/components/RunnerUpdateCell.test.tsx`; `scripts/release/e2e-update.sh` | [`docs/operations/updates.md`](../operations/updates.md) |

Known limit in the updates row: the centre exposes `autoUpdate` and the API returns it, but the
runner daemon does not yet gate its cycle on it; `[update] enabled = false` is the host switch.
The upgrade condition is recorded in [`docs/operations/updates.md`](../operations/updates.md).
