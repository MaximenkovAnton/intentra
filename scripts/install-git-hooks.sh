#!/bin/sh
# Point git at the repository hooks (push policy for main and ephemeral branches).
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-push scripts/install-git-hooks.sh
echo "installed git hooks from .githooks"
