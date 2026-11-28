# Runner releases

A release is one tag on `main`: `.github/workflows/release.yml` builds the `intentra-runner`
binary for five targets, packages each one, writes an Ed25519-signed update manifest and publishes
everything as a GitHub Release. The control plane then stores the same manifest and serves it to
runners, so a runner never talks to GitHub itself (see
[`docs/operations/updates.md`](updates.md) for the consumer side).

| Piece | Path |
| --- | --- |
| workflow | `.github/workflows/release.yml` |
| packaging | `scripts/release/package.sh` |
| manifest and signature | `scripts/release/manifest.mjs`, `scripts/release/channel.mjs` |
| release-script tests | `scripts/release/release.test.mjs` |
| embedded public key | `crates/runner-core/keys/release.pub` |
| manifest contract | `packages/contracts/src/release.ts` (Zod), `crates/runner-core/src/update/manifest.rs` (serde) |
| first consumer | `GET /api/runners/update`, `GET /api/runners/update/artifact/:fileName` in `apps/api/src/routes/runner-updates.ts` |

The version lives in `[workspace.package] version` in `Cargo.toml`; the tag is `v` plus that
version, and `intentra-runner --version` reports `CARGO_PKG_VERSION`, so the binary version equals
the tag. A version with a SemVer prerelease (`0.2.0-beta.1`) is published to the `beta` channel;
every other version goes to `stable` (`deriveChannel` in `scripts/release/channel.mjs`).

## What a release contains

Five archives, one per target: `intentra-runner-<version>-<target>.tar.gz` (Linux, macOS) and
`.zip` (Windows). Each archive holds the binary and `LICENSE`; next to each archive sits
`<archive>.sha256` in `sha256sum` format. The release also carries:

- `update-manifest.json` — compact JSON with `schemaVersion`, `version`, `channel`,
  `protocolVersion`, `publishedAt`, `notes` and one asset per target (`target`, `fileName`, `url`,
  `sizeBytes`, `sha256`); `sha256` is the archive hash, `url` points at the GitHub asset.
- `update-manifest.json.sig` — the base64 Ed25519 signature over the exact manifest bytes;
  `update-manifest.json` is never reformatted after signing, because the signature is checked
  against those bytes.

## Signing key (generated once)

The release key pair is generated and the public half is committed: the Ed25519 public key is
`crates/runner-core/keys/release.pub`, raw base64, 32 bytes (44 characters), not the all-zero
placeholder. The runner embeds this file and the API reads the same file at startup
(`apps/api/src/server.ts`), so one committed key serves the whole system. The seed lives outside
the repository in a gitignored file with mode `0600`; it is never committed, pasted into a
document or a report, printed, or written to a fixture.

The one action that makes the committed key usable for releases is storing the seed as the
repository secret `RELEASE_SIGNING_KEY`; `manifest.mjs` reads it only from the environment. Then:

1. Set the repository variable `CENTER_URL` (the control plane's public origin, e.g.
   `https://intentra.example`) and the repository secret `CENTER_RELEASE_TOKEN`. The token must be
   the same string as the centre's `RELEASE_PUBLISH_TOKEN` (at least 16 characters).
2. Configure the centre (`infra/compose/.env`, then restart `api`):

   | Centre variable | Effect |
   | --- | --- |
   | `RELEASE_PUBLISH_TOKEN` | Bearer token for `POST /api/admin/releases` and the yank route; unset means both answer `503 RELEASE_DISABLED`. |
   | `RELEASE_CACHE_DIR` | Where streamed archives are cached (default `/data/releases`). |
   | `RELEASE_MAX_ARTIFACT_BYTES` | Publish/stream size limit (default `268435456`, 256 MiB). |
   | `GITHUB_RELEASE_TOKEN` | Token used to download assets from a private GitHub repository; only needed while the repository is private. |

A release build with the all-zero placeholder public key fails closed: `manifest.mjs` refuses to
write the manifest and the workflow fails before creating a Release. That is the diagnostic for a
reverted key, not the normal state.

Changing the key after a release is not a routine operation: runners verify every future manifest
with the key they were built with, so a new key requires shipping a release signed with the old
key first. Key rotation is out of scope here.

## Prepare a release (pull request)

1. Bump `[workspace.package] version` in `Cargo.toml` and refresh `Cargo.lock` (any `cargo`
   command that resolves the workspace, e.g. `cargo check`, rewrites the lock entry).
2. Add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` in Keep a Changelog style. The
   manifest `notes` come from exactly this section; `manifest.mjs` trims a trailing block of link
   references so `[0.2.0]: https://...` does not leak into release notes, and it rejects an empty
   section. Beta versions use `X.Y.Z-beta.N` (for example `## [0.3.0-beta.1]`).
3. Open a pull request into `main` and merge it as a human. The workflow refuses a tag whose commit
   is not an ancestor of `origin/main`.

## Local dry run

Run both commands before tagging; they need no secret and no network:

```bash
pnpm -w test:release
bash scripts/release/package.sh
```

`pnpm -w test:release` builds `@intentra/contracts` and runs `scripts/release/release.test.mjs`:
it checks the channel derivation, that a tag which disagrees with `Cargo.toml` is rejected, that
`manifest.mjs` writes a manifest the shared schema accepts and signs it, that a signature the
chosen public key cannot verify is refused, that the committed `release.pub` is a real 32-byte key
and the all-zero placeholder is refused, that a `--version` different from `Cargo.toml` is
refused, and that `release.yml` still builds every target on its runner. Observed:

```text
✔ deriveChannel reads the SemVer prerelease and ignores build metadata
✔ package.sh rejects a tag that does not match the workspace version
✔ manifest.mjs writes a manifest the shared schema accepts and signs it
✔ manifest.mjs refuses a signature the runner public key cannot verify
✔ committed release.pub is a real 32-byte key
✔ manifest.mjs refuses a placeholder release public key
✔ manifest.mjs refuses a version that differs from Cargo.toml
✔ release.yml parses and builds every target on its runner
ℹ tests 8; pass 8; fail 0
```

`bash scripts/release/package.sh` builds the release binary for the host target (or the target you
pass), checks that the binary reports the workspace version, and writes the archive and checksum
into `dist/release/`:

```text
release: version 0.2.0, target x86_64-unknown-linux-gnu
release: archive .../dist/release/intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz
release: checksum .../intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz.sha256
```

Verify the archive the same way a user would:

```bash
cd dist/release
tar -tzvf intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz
sha256sum -c intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz.sha256
```

Observed: the archive lists `intentra-runner` (mode `-rwxr-xr-x`) and `LICENSE`, and the checksum
line reports `intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz: OK`. A locally built
`--target` binary reports the version too:
`target/x86_64-unknown-linux-gnu/release/intentra-runner --version` prints
`intentra-runner 0.2.0`.

## Cut the release (human)

The workflow is triggered only by a tag push and never creates the tag itself:

```bash
git tag -a v0.2.0 -m "intentra-runner 0.2.0"
git push github v0.2.0
```

This step needs write access to GitHub and is a human action. `main` requires a pull request, so
tag the merge commit on `main`, not a feature branch. No tag exists yet in the repository history;
the first tag is the first release. If the workflow fails after the tag was pushed, delete the tag
locally and on GitHub, fix the cause and tag again — a Release that already exists must be removed
by a human before re-tagging.

## What the workflow does

`gate` (ubuntu-latest, PostgreSQL 18 service) checks that the tag is on `main`, then runs
`pnpm -w typecheck`, `lint`, `test`, `build`, `pnpm -w test:release`, `cargo fmt --check`,
`cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`.

`build` is a matrix of five targets, each with an explicit runner:

| Target | Runner | Build |
| --- | --- | --- |
| `x86_64-unknown-linux-gnu` | ubuntu-latest | `cargo zigbuild`, Zig 0.14.0, `cargo-zigbuild` |
| `aarch64-unknown-linux-gnu` | ubuntu-latest | `cargo zigbuild`, Zig 0.14.0, `cargo-zigbuild` |
| `x86_64-apple-darwin` | macos-15-intel | `cargo build` |
| `aarch64-apple-darwin` | macos-14 | `cargo build` |
| `x86_64-pc-windows-msvc` | windows-latest | `cargo build` |

Each job runs `scripts/release/package.sh <target>` and uploads `dist/release/*` as a workflow
artifact. `publish` downloads all archives, resolves the version from the tag, runs
`scripts/release/manifest.mjs` (manifest + signature), creates the GitHub Release with
`gh release create --verify-tag`, and finally posts the manifest and signature to the centre when
`CENTER_URL` and `CENTER_RELEASE_TOKEN` are set.

## Verify a release

On GitHub (needs `gh` with an authenticated session; it is a human or CI step, not part of the
local gate):

```bash
gh release view v0.2.0
gh release download v0.2.0
```

Then check the downloaded files from the release directory:

```bash
sha256sum -c *.sha256
```

Verify the signature and every archive hash against the committed public key:

```bash
node --input-type=module -e '
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const spki = Buffer.from("302a300506032b6570032100", "hex");
const raw = Buffer.from(readFileSync(process.env.RELEASE_PUBKEY ?? "crates/runner-core/keys/release.pub", "utf8").trim(), "base64");
const key = createPublicKey({ key: Buffer.concat([spki, raw]), format: "der", type: "spki" });
const manifestBytes = readFileSync("update-manifest.json");
const signature = Buffer.from(readFileSync("update-manifest.json.sig", "utf8").trim(), "base64");
if (!verify(null, manifestBytes, key, signature)) { console.error("signature: FAIL"); process.exit(1); }
const manifest = JSON.parse(manifestBytes);
for (const asset of manifest.assets) {
  const digest = createHash("sha256").update(readFileSync(asset.fileName)).digest("hex");
  if (digest !== asset.sha256) { console.error(`sha256: FAIL ${asset.fileName}`); process.exit(1); }
}
console.log(`signature: ok; sha256: ok for ${manifest.assets.length} assets; version ${manifest.version} channel ${manifest.channel}`);
'
```

Run from the directory that holds `update-manifest.json`, its `.sig` and the archives, with
`RELEASE_PUBKEY` set to the path of the `release.pub` you want to verify against. When the release
files are in the repository root, leave `RELEASE_PUBKEY` unset: the default
`crates/runner-core/keys/release.pub` then resolves to the committed key. Observed with a manifest
signed with a freshly generated throwaway key and five archives, run from a repository root with
the default key path: `signature: ok; sha256: ok for 5 assets; version 0.2.0 channel stable`.

The binary itself prints its version; the `package.sh` run already checks this for the host
target:

```bash
tar -xzf intentra-runner-0.2.0-x86_64-unknown-linux-gnu.tar.gz
./intentra-runner --version   # intentra-runner 0.2.0
```

A runner with a runner token can confirm what the centre offers:

```bash
./intentra-runner update --config ~/.intentra/config.toml
```

See [`docs/operations/updates.md`](updates.md) for the fields and exit codes.

## Publish to the centre

The `publish` job posts the manifest and signature automatically. A manual fallback, for example
when the centre was unreachable during the workflow run (needs a running centre and the
`RELEASE_PUBLISH_TOKEN` secret; run from the repository root after downloading the manifest):

```bash
CENTER_URL=https://intentra.example RELEASE_PUBLISH_TOKEN=... node --input-type=module -e '
import { readFileSync } from "node:fs";
const manifest = readFileSync("dist/release/update-manifest.json", "utf8");
const signature = readFileSync("dist/release/update-manifest.json.sig", "utf8").trim();
const url = `${process.env.CENTER_URL.replace(/\/$/, "")}/api/admin/releases`;
const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.RELEASE_PUBLISH_TOKEN}`,
  },
  body: JSON.stringify({ manifest, signature }),
});
if (!response.ok) {
  console.error(`centre rejected the release: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`centre accepted the release: ${response.status}`);
'
```

The route validates the manifest schema, the signature against the committed key and the
`protocolVersion`, then upserts by version: `201` for a new release, `200` for an overwrite,
`400` for a manifest or signature it rejects, `401` for a wrong token, `503` when
`RELEASE_PUBLISH_TOKEN` is unset or the centre has no release key configured (its `release.pub` is
still the placeholder). The call is audited (`release.publish`). This command needs the
secret and a reachable centre, so it is not part of the local gate; the same request shape is
exercised by `apps/api/test/releases-publish.test.ts` and by the e2e run
(`scripts/release/e2e-update.sh`).

Withdraw a release instead of editing its bytes — the signature covers them:

```bash
CENTER_URL=https://intentra.example RELEASE_PUBLISH_TOKEN=... \
  curl -fsS -X POST "$CENTER_URL/api/admin/releases/0.2.0/yank" \
  -H "authorization: Bearer $RELEASE_PUBLISH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"yanked":true}'
```

`204` means the change was stored; a yanked release is no longer offered and its artifacts answer
`404`. Unknown version → `404`, unset publishing → `503`. This command needs the same secret and
a running centre; the e2e run exercised the yank path and observed `HTTP 204`.

## First release, in order

The first release is `v0.2.0`; use it as the rehearsal for everything below.

1. Store the seed as the repository secret `RELEASE_SIGNING_KEY` (the pair is already generated
   and `crates/runner-core/keys/release.pub` is committed), set `CENTER_URL` and
   `CENTER_RELEASE_TOKEN`, and configure the centre's `RELEASE_PUBLISH_TOKEN`, `RELEASE_CACHE_DIR`
   and (if the repository is private) `GITHUB_RELEASE_TOKEN`.
2. Prove that the CI secret matches the committed public key before tagging (needs the
   `RELEASE_SIGNING_KEY` value and no other input):

   ```bash
   RELEASE_SIGNING_KEY=... node --input-type=module -e '
   import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
   import { readFileSync } from "node:fs";
   const seed = Buffer.from(process.env.RELEASE_SIGNING_KEY ?? "", "base64");
   if (seed.length !== 32) { console.error("RELEASE_SIGNING_KEY must decode to 32 bytes"); process.exit(1); }
   const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
   const raw = Buffer.from(readFileSync(process.env.RELEASE_PUBKEY ?? "crates/runner-core/keys/release.pub", "utf8").trim(), "base64");
   const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
   const probe = Buffer.from("intentra release key probe");
   if (verify(null, probe, publicKey, sign(null, probe, privateKey))) {
     console.log("key pair: ok");
   } else {
     console.error("key pair: MISMATCH (RELEASE_SIGNING_KEY does not match release.pub)");
     process.exit(1);
   }
   '
   ```

   Observed with the committed pair: `key pair: ok`; with a different seed the command exits 1 and
   prints `key pair: MISMATCH (RELEASE_SIGNING_KEY does not match release.pub)`. If the committed
   key has been reverted to the all-zero placeholder, `manifest.mjs` refuses to write the manifest
   even with a valid seed:

   ```text
   release: .../crates/runner-core/keys/release.pub is still the all-zero placeholder; embed the release public key first
   ```
3. Run `pnpm -w test:release` and `bash scripts/release/package.sh` locally (both are in this
   document with their observed output).
4. Merge the version bump and `CHANGELOG.md` entry, then tag and push as in "Cut the release".
5. Watch the workflow: a failure in `gate` leaves no release, a failure in `build` leaves one
   target missing and `publish` fails on the missing asset, a failure in `publish` means the key
   or signature did not verify.
6. After `publish` succeeds, confirm the centre accepted the release (workflow log line
   `centre accepted the release: 201`) and that a `0.1.0` runner sees it:
   `intentra-runner update` prints the `latest` version and `available: true`.

## Troubleshooting

| Symptom | Cause and check |
| --- | --- |
| `tag vX.Y.Z does not match the workspace version` | `Cargo.toml` and the tag disagree; bump, merge, re-tag. |
| Workflow gate: tag not on `main` | Tag the merge commit of `main`. |
| `RELEASE_SIGNING_KEY is not set` / `must be a base64-encoded 32-byte Ed25519 seed` | Repository secret missing or wrong. |
| `is still the all-zero placeholder` | The committed `crates/runner-core/keys/release.pub` was reverted to the placeholder; restore the real key. |
| `the manifest signature does not verify against ...release.pub` | `RELEASE_SIGNING_KEY` and the committed key are from different key pairs; set the secret from the seed that matches `release.pub`. |
| `missing asset ...; run scripts/release/package.sh <target>` | A build matrix job failed; rerun it before publishing. |
| Centre `503 RELEASE_DISABLED` | `RELEASE_PUBLISH_TOKEN` is unset on the centre, or the centre has no release key configured (its `release.pub` is still the all-zero placeholder). |
| Centre `401 AUTH_REQUIRED` | `CENTER_RELEASE_TOKEN` and `RELEASE_PUBLISH_TOKEN` differ. |
| Centre `400 VALIDATION` | Manifest schema, signature or `protocolVersion` mismatch — check the runner/centre protocol version. |
| Runners do not see the release | The centre offers only its own `PROTOCOL_VERSION`; also check `yanked`, the channel and a `pinnedVersion` on that runner. |
| Artifact stream answers `502` | The centre cached bytes that do not match the manifest `sha256`; check `GITHUB_RELEASE_TOKEN` and the asset. |

See [`docs/operations/updates.md`](updates.md) for the runner side and
[`docs/runbook.md`](../runbook.md) section 5 for the operating path.
