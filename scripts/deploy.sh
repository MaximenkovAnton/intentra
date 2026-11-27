#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_DIR="$REPO_ROOT/infra/compose"
CHECK=0
BUILD=1
DRAIN_CONSUMER=
DRAIN_DIR=

. "$REPO_ROOT/scripts/rollout.sh"

die() {
  echo "deploy: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [--check] [--no-build]

  --check     run preflight checks only; change nothing
  --no-build  deploy the current images without rebuilding them
EOF
}

cleanup() {
  if [ -n "$DRAIN_CONSUMER" ] && [ -n "$DRAIN_DIR" ]; then
    restore_consumer "$DRAIN_CONSUMER" "$DRAIN_DIR" || true
  fi
  if [ -n "$DRAIN_DIR" ]; then
    rm -rf "$DRAIN_DIR"
  fi
}

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $arg" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker CLI not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
[ -f "$COMPOSE_DIR/.env" ] || die "missing $COMPOSE_DIR/.env; copy .env.example and fill it in"
docker rollout --version >/dev/null 2>&1 || die "docker-rollout is not installed; run scripts/install-docker-rollout.sh"
( cd "$COMPOSE_DIR" && docker compose config --quiet ) || die "docker compose config failed"

if [ "$CHECK" -eq 1 ]; then
  echo "preflight ok: .env present, compose config valid, docker-rollout $(docker rollout --version | awk '{print $NF}')"
  exit 0
fi

[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die "working tree is dirty (tracked changes or untracked files); commit or stash before deploying so the revision label matches the image"

REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD)
export INTENTRA_GIT_REVISION="$REVISION"
IMAGE_TAG=${INTENTRA_IMAGE_TAG:-local}

trap cleanup EXIT INT TERM HUP

cd "$COMPOSE_DIR"

INGRESS_RUNNING=$(docker compose ps --status running --quiet ingress)
[ -n "$INGRESS_RUNNING" ] || die "ingress is not running; complete the first cutover in docs/operations/deploy.md before deploying"

PORT=$(docker compose port ingress 8080 | head -n 1 | sed 's/.*://')
[ -n "$PORT" ] || die "ingress publishes no port; complete the first cutover in docs/operations/deploy.md"
BASE_URL="http://127.0.0.1:$PORT"

wait_for_code() {
  url=$1
  expected=$2
  attempt=0
  while :; do
    code=$(http_code "$url")
    if [ "$code" = "$expected" ]; then
      echo "ok: $url -> $code"
      return 0
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || die "$url returned '$code', expected $expected"
    sleep 1
  done
}

if [ "$BUILD" -eq 1 ]; then
  rollout_log "==> building api web ingress at $REVISION"
  docker compose build api web ingress
fi

rollout_log "==> running migrations"
docker compose run --rm migrate

roll_service api web "$BASE_URL/api/auth/me" 401 180 '/api/' "intentra-web:$IMAGE_TAG" ||
  die "api rollout failed; the old container was not removed"
roll_service web ingress "$BASE_URL/healthz" 200 120 '= /healthz' "intentra-ingress:$IMAGE_TAG" ||
  die "web rollout failed; the old container was not removed"

rollout_log "==> recreating ingress at $REVISION (the only non-rolling step)"
docker compose up -d --no-deps --force-recreate ingress >/dev/null
INGRESS_ID=$(docker compose ps -q ingress)
[ "$(printf '%s\n' "$INGRESS_ID" | grep -c .)" -eq 1 ] || die "ingress is not running after the recreate"
wait_healthy "$INGRESS_ID" 60 || die "ingress did not become healthy after the recreate"

wait_for_code "$BASE_URL/healthz" 200
wait_for_code "$BASE_URL/api/auth/me" 401

for service in api web ingress; do
  CONTAINERS=$(docker compose ps -q "$service")
  [ -n "$CONTAINERS" ] || die "$service is not running"
  for container in $CONTAINERS; do
    revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
    [ "$revision" = "$REVISION" ] || die "$service container $container carries revision '$revision', expected '$REVISION'"
  done
done

MIGRATE=$(docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate)
[ "$MIGRATE" = "migrate exited 0" ] || die "migrate state '$MIGRATE', expected 'migrate exited 0'"

docker compose ps -a
echo "deployed revision: $REVISION"
