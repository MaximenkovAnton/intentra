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

GitHub Free does not offer branch protection for private repositories, so the
guard is client-side: `.githooks/pre-push` refuses direct `main`/`master` pushes
and ephemeral branches on any `github.com` remote. Enable it once per clone:

```bash
./scripts/install-git-hooks.sh
```

The guard is a convention, not a security boundary — `--no-verify` bypasses it.
Do not bypass it for feature work. A deliberate bootstrap or release may publish
`main` once:

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
