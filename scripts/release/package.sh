#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="$ROOT/dist/release"
LICENSE="$ROOT/LICENSE"
TARGETS=(
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-apple-darwin
  aarch64-apple-darwin
  x86_64-pc-windows-msvc
)

fail() {
  echo "release: $*" >&2
  exit 1
}

workspace_version() {
  awk '
    /^\[workspace.package\]/ { section = 1; next }
    /^\[/ { section = 0 }
    section && /^version = "/ { line = $0; sub(/^version = "/, "", line); sub(/"$/, "", line); print line; exit }
  ' "$ROOT/Cargo.toml"
}

host_target() {
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) echo x86_64-unknown-linux-gnu ;;
    Linux:aarch64 | Linux:arm64) echo aarch64-unknown-linux-gnu ;;
    Darwin:x86_64) echo x86_64-apple-darwin ;;
    Darwin:arm64) echo aarch64-apple-darwin ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64) echo x86_64-pc-windows-msvc ;;
    *) return 1 ;;
  esac
}

VERSION="$(workspace_version)"
[[ -n "$VERSION" ]] || fail "cannot read the workspace version from Cargo.toml"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  TARGET="$(host_target)" || fail "unsupported host $(uname -s)/$(uname -m); pass a target explicitly"
fi
case " ${TARGETS[*]} " in
  *" $TARGET "*) ;;
  *) fail "unsupported target $TARGET; expected one of: ${TARGETS[*]}" ;;
esac

TAG="${GITHUB_REF_NAME:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null || true)"
fi
if [[ -n "$TAG" && "$TAG" != "v$VERSION" ]]; then
  fail "tag $TAG does not match the workspace version v$VERSION"
fi

read -r -a CARGO_CMD <<< "${CARGO_COMMAND:-cargo build}"
"${CARGO_CMD[@]}" --release --locked --package intentra-runner --target "$TARGET"

BIN_NAME=intentra-runner
[[ "$TARGET" == *windows* ]] && BIN_NAME=intentra-runner.exe
BIN="$ROOT/target/$TARGET/release/$BIN_NAME"
[[ -f "$BIN" ]] || fail "build produced no binary at $BIN"

HOST_TARGET="$(host_target || true)"
if [[ "$TARGET" == "$HOST_TARGET" ]]; then
  REPORTED="$("$BIN" --version)"
  [[ "$REPORTED" == *" $VERSION" ]] || fail "binary reports '$REPORTED', expected $VERSION"
fi

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp "$BIN" "$STAGING/$BIN_NAME"
cp "$LICENSE" "$STAGING/LICENSE"

EXTENSION=tar.gz
[[ "$TARGET" == *windows* ]] && EXTENSION=zip
NAME="intentra-runner-$VERSION-$TARGET.$EXTENSION"
mkdir -p "$DIST"
ARCHIVE="$DIST/$NAME"

if [[ "$EXTENSION" == tar.gz ]]; then
  tar -czf "$ARCHIVE" -C "$STAGING" "$BIN_NAME" LICENSE
elif command -v zip >/dev/null 2>&1; then
  (cd "$STAGING" && zip -q "$ARCHIVE" "$BIN_NAME" LICENSE)
elif [[ -x /c/Windows/System32/tar.exe ]]; then
  /c/Windows/System32/tar.exe -a -c -f "$ARCHIVE" -C "$STAGING" "$BIN_NAME" LICENSE
else
  fail "packaging a Windows zip needs zip or the Windows tar at /c/Windows/System32/tar.exe"
fi

if command -v sha256sum >/dev/null 2>&1; then
  HASH=(sha256sum)
else
  HASH=(shasum -a 256)
fi
(cd "$DIST" && "${HASH[@]}" "$NAME" > "$NAME.sha256")

echo "release: version $VERSION, target $TARGET"
echo "release: archive $ARCHIVE"
echo "release: checksum $ARCHIVE.sha256"
