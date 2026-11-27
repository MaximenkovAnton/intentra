#!/bin/sh
set -eu

VERSION=v0.14
SHA256=cdeaba6ae9eee3b0b606286e585bbda6787283d801a6ad6d9b9d2bc347fda05b
URL="https://raw.githubusercontent.com/wowu/docker-rollout/$VERSION/docker-rollout"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

TMP_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE"' EXIT HUP INT TERM

curl -fsSL "$URL" -o "$TMP_FILE"
ACTUAL=$(hash_file "$TMP_FILE")
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "sha256 mismatch for $URL: expected $SHA256, got $ACTUAL" >&2
  exit 1
fi

install_plugin() {
  destination_dir=$1
  destination="$destination_dir/docker-rollout"
  mkdir -p "$destination_dir"
  if [ -f "$destination" ] && [ "$(hash_file "$destination")" = "$SHA256" ]; then
    chmod 0755 "$destination"
    echo "docker-rollout $VERSION already installed at $destination"
  else
    cp "$TMP_FILE" "$destination"
    chmod 0755 "$destination"
    echo "installed docker-rollout $VERSION at $destination"
  fi
}

SYSTEM_DIR=/usr/local/lib/docker/cli-plugins
USER_DIR="$HOME/.docker/cli-plugins"

if [ "$(id -u)" -eq 0 ] && mkdir -p "$SYSTEM_DIR" 2>/dev/null && [ -w "$SYSTEM_DIR" ]; then
  PRIMARY_DIR=$SYSTEM_DIR
else
  PRIMARY_DIR=$USER_DIR
fi
install_plugin "$PRIMARY_DIR"

if [ "$PRIMARY_DIR" != "$USER_DIR" ] && [ -f "$USER_DIR/docker-rollout" ]; then
  install_plugin "$USER_DIR"
fi

docker rollout --version
