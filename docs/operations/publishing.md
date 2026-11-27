# Publishing and remote policy

The canonical repository is `github.com/MaximenkovAnton/intentra`. A local bare
mirror (the `origin` remote in the dogfood setup) is scratch space for the
runner and is not published.

## Branch layout

| Ref | Lives on GitHub | Rule |
| --- | --- | --- |
| `main` | yes | Only through a pull request merged by a human. The default branch. |
| `feat/*`, `fix/*` | yes, while the work is open | Push freely; open a PR into `main`. |
| `intentra/*`, `*--bt-*` | no | Ephemeral task/worktree branches; never pushed. |
| `archive/*` | no | Local history snapshots; never pushed. |

`main` is protected server-side, because the repository is public: a pull
request is required, the CI checks `Node · typecheck, lint, test, build`,
`Rust · ubuntu-latest`/`macos-latest`/`windows-latest` and `CLA Signed` must
pass, force pushes and deletions are rejected, and the rules apply to
administrators too.

A second guard is client-side: `.githooks/pre-push` refuses direct
`main`/`master` pushes and ephemeral branches on any `github.com` remote. Enable
it once per clone:

```bash
./scripts/install-git-hooks.sh
```

The hook saves an accidental push before it reaches the protection rules. A
deliberate bootstrap or release may publish `main` once:

```bash
INTENTRA_PUBLISH_MAIN=1 git push github main
```

## What is never published

The repository ships only portable deployment assets. Host provisioning,
Proxmox/VM/container scripts, internal IPs and hostnames, CT IDs and cluster
conventions stay in the operator's private infrastructure repository or in
gitignored local paths (`infra/local/`, `infra/proxmox/`). The task state under
`.agile/` is local as well.

The v1 tree was published as one clean initial commit: earlier task history
contains internal topology, so it stays local. From here on, `main` advances
through small, reviewable commits and pull requests.

## CLA signatures

Contribution terms are in [`CLA.md`](../../CLA.md). The `CLA Signed` check is
run by `.github/workflows/cla.yml` on `pull_request_target` (opened,
synchronize, reopened) and on `issue_comment`; a contributor signs by commenting
`I have read the CLA Document and I hereby sign the CLA` on their pull request.

Signatures live on the `cla-signatures` branch, in `signatures/cla.json`. That
branch is separate from `main` and is written only by the workflow. Two rules
keep the check working:

- The branch must exist and the file must parse as `{"signedContributors": []}`.
  The action updates the file but never creates the branch, so a deleted branch
  fails every pull request with `Branch cla-signatures not found`, and a file
  seeded as a bare `[]` fails with `Cannot read properties of undefined`.
- The branch must stay unprotected: the action pushes with the workflow token.

After a signature arrives the action re-runs the pull request's failed check, so
the check turns green without a new commit; the `recheck` comment retriggers it
manually. The job needs the `actions: write` permission for that re-run — without
it the signature is recorded but the job ends red.

The check is a required status on `main`. It turns green for allowlisted
accounts (`MaximenkovAnton`, bots) without a signature, and for everyone else
once the signing comment is recorded and the failed pull request check is
re-run. A red or missing `CLA Signed` therefore blocks the merge, so a change to
the action, a lost `actions: write` permission or a deleted `cla-signatures`
branch blocks every pull request until it is repaired — check that path first
when merge is blocked and every other gate is green.
