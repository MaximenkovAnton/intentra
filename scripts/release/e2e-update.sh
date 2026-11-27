#!/usr/bin/env bash
# End-to-end proof of the runner self-update against a real centre:
# 0.1.0 -> 0.2.0 auto-update, signature refusal, deferral while a job is active,
# rollback of a broken binary. The centre runs the real Fastify app on the real
# database; only the release key (test fixture) and the artifact source (a local
# directory instead of GitHub) are injected, because the test host is offline.
#
# Required: TEST_DATABASE_URL pointing at a database owned by this script.
# Optional: E2E_RUNNER_OLD_BIN (0.1.0), E2E_RUNNER_NEW_BIN (0.2.0),
#           E2E_SCENARIOS (comma list: happy,bad-signature,defer,rollback),
#           E2E_WORK (kept when set), E2E_EVIDENCE (default .agile/e2e-evidence.md),
#           E2E_DEFER_TIMEOUT_SECS (default 420).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL must name a disposable PostgreSQL database}"
E2E_SCENARIOS="${E2E_SCENARIOS:-happy,bad-signature,defer,rollback}"
DEFER_TIMEOUT="${E2E_DEFER_TIMEOUT_SECS:-420}"
EVIDENCE="${E2E_EVIDENCE:-$ROOT/.agile/e2e-evidence.md}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux-aarch64 | Linux-arm64) TARGET=aarch64-unknown-linux-gnu ;;
  Darwin-arm64) TARGET=aarch64-apple-darwin ;;
  Darwin-x86_64) TARGET=x86_64-apple-darwin ;;
  *)
    echo "e2e-update: unsupported host $(uname -s)-$(uname -m)" >&2
    exit 2
    ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/intentra-e2e-update.XXXXXX")"
if [ -n "${E2E_WORK:-}" ]; then
  WORK="$E2E_WORK"
  mkdir -p "$WORK"
else
  trap 'rm -rf "$WORK"' EXIT
fi
BIN_DIR="$WORK/bin"
ART_DIR="$WORK/artifacts"
mkdir -p "$BIN_DIR" "$ART_DIR"
EVIDENCE_DIR="$(dirname "$EVIDENCE")"
mkdir -p "$EVIDENCE_DIR"

echo "e2e-update: host target $TARGET"
echo "e2e-update: work $WORK"
echo "e2e-update: database $TEST_DATABASE_URL"
echo "e2e-update: scenarios $E2E_SCENARIOS"

if [ ! -f "$ROOT/packages/contracts/dist/index.js" ]; then
  pnpm --dir "$ROOT" --filter @intentra/contracts build
fi

build_old() {
  local build="$WORK/build-0.1.0"
  rm -rf "$build"
  mkdir -p "$build"
  tar -C "$ROOT" \
    --exclude=./.git --exclude=./node_modules --exclude=./target --exclude=./.agile \
    --exclude='./apps/*/node_modules' --exclude='./apps/*/dist' --exclude='./packages/*/dist' \
    --exclude='./apps/*/coverage' -cf - . | tar -x -C "$build"
  sed -i 's/^version = "0.2.0"$/version = "0.1.0"/' "$build/Cargo.toml"
  ( cd "$build" && CARGO_TARGET_DIR="$ROOT/target" cargo build -p intentra-runner )
  cp "$ROOT/target/debug/intentra-runner" "$BIN_DIR/runner-0.1.0"
  chmod 755 "$BIN_DIR/runner-0.1.0"
}

build_new() {
  ( cd "$ROOT" && cargo build -p intentra-runner )
  cp "$ROOT/target/debug/intentra-runner" "$BIN_DIR/runner-0.2.0"
  chmod 755 "$BIN_DIR/runner-0.2.0"
}

OLD_BIN="${E2E_RUNNER_OLD_BIN:-}"
NEW_BIN="${E2E_RUNNER_NEW_BIN:-}"
if [ -z "$NEW_BIN" ]; then
  build_new
  NEW_BIN="$BIN_DIR/runner-0.2.0"
fi
if [ -z "$OLD_BIN" ]; then
  if [ -f "$BIN_DIR/runner-0.1.0" ]; then
    OLD_BIN="$BIN_DIR/runner-0.1.0"
  else
    build_old
    OLD_BIN="$BIN_DIR/runner-0.1.0"
  fi
fi
chmod 755 "$NEW_BIN" "$OLD_BIN"

OLD_VERSION="$("$OLD_BIN" --version | awk '{print $2}')"
NEW_VERSION="$("$NEW_BIN" --version | awk '{print $2}')"
if [ "$OLD_VERSION" != "0.1.0" ]; then
  echo "e2e-update: the old runner reports $OLD_VERSION, expected 0.1.0" >&2
  exit 1
fi
if [ "$NEW_VERSION" != "0.2.0" ]; then
  echo "e2e-update: the new runner reports $NEW_VERSION, expected 0.2.0" >&2
  exit 1
fi
echo "e2e-update: old runner $OLD_VERSION, new runner $NEW_VERSION"

STAGE="$ART_DIR/stage"
mkdir -p "$STAGE"
cp "$NEW_BIN" "$STAGE/intentra-runner"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
tar -C "$STAGE" -czf "$ART_DIR/intentra-runner-0.2.0-$TARGET.tar.gz" intentra-runner LICENSE
rm -rf "$STAGE"

for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc; do
  if [ "$target" = "$TARGET" ]; then
    continue
  fi
  case "$target" in
    *windows*) printf 'offline e2e placeholder for %s\n' "$target" > "$ART_DIR/intentra-runner-0.2.0-$target.zip" ;;
    *) printf 'offline e2e placeholder for %s\n' "$target" > "$ART_DIR/intentra-runner-0.2.0-$target.tar.gz" ;;
  esac
done

RELEASE_SIGNING_KEY="$(tr -d '\n' < "$ROOT/fixtures/release/test.seed")" \
  node "$ROOT/scripts/release/manifest.mjs" \
    --version 0.2.0 \
    --assets "$ART_DIR" \
    --out "$ART_DIR" \
    --public-key "$ROOT/fixtures/release/test.pub"
cp "$ART_DIR/update-manifest.json" "$WORK/update-manifest.json"
cp "$ART_DIR/update-manifest.json.sig" "$WORK/update-manifest.json.sig"

CORRUPT_DIR="$WORK/corrupt"
mkdir -p "$CORRUPT_DIR"
printf '#!/nonexistent/e2e-update-interpreter\necho broken runner\n' > "$CORRUPT_DIR/intentra-runner"
chmod 755 "$CORRUPT_DIR/intentra-runner"
tar -C "$CORRUPT_DIR" -czf "$ART_DIR/intentra-runner-0.3.0-$TARGET.tar.gz" intentra-runner

{
  echo "# E2E update evidence"
  echo
  echo "Produced by \`scripts/release/e2e-update.sh\` on $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  echo
  echo '```'
  echo "host: $(uname -s)-$(uname -m) ($TARGET)"
  echo "test database: $TEST_DATABASE_URL"
  echo "old runner: $OLD_VERSION ($OLD_BIN)"
  echo "new runner: $NEW_VERSION ($NEW_BIN)"
  echo "scenarios: $E2E_SCENARIOS"
  echo
  echo '$ tar -C . --exclude=./target -cf - . | tar -x -C "$build" && sed -i "s/^version = \"0.2.0\"/version = \"0.1.0\"/" "$build/Cargo.toml" && cargo build -p intentra-runner'
  echo '$ cargo build -p intentra-runner'
  echo '$ node scripts/release/manifest.mjs --version 0.2.0 --assets artifacts --out artifacts --public-key fixtures/release/test.pub'
  echo
  echo '$ apps/api/node_modules/.bin/tsx scripts/release/e2e-update.ts'
  echo '```'
  echo
} > "$EVIDENCE"

set +e
E2E_WORK="$WORK" \
E2E_ARTIFACTS_DIR="$ART_DIR" \
E2E_MANIFEST="$WORK/update-manifest.json" \
E2E_SIGNATURE="$WORK/update-manifest.json.sig" \
E2E_CORRUPT_ARCHIVE="$ART_DIR/intentra-runner-0.3.0-$TARGET.tar.gz" \
E2E_OLD_BIN="$OLD_BIN" \
E2E_NEW_BIN="$NEW_BIN" \
E2E_TARGET="$TARGET" \
E2E_TEST_PUBKEY="$(tr -d '\n' < "$ROOT/fixtures/release/test.pub")" \
E2E_SCENARIOS="$E2E_SCENARIOS" \
E2E_EVIDENCE="$EVIDENCE" \
E2E_DEFER_TIMEOUT_SECS="$DEFER_TIMEOUT" \
"$ROOT/apps/api/node_modules/.bin/tsx" "$ROOT/scripts/release/e2e-update.ts"
STATUS=$?
set -e

echo "e2e-update: evidence $EVIDENCE"
exit "$STATUS"
