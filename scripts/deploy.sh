#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_DIR="$REPO_ROOT/infra/compose"
CHECK=0
BUILD=1

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

cd "$COMPOSE_DIR"

INGRESS_RUNNING=$(docker compose ps --status running --quiet ingress)
[ -n "$INGRESS_RUNNING" ] || die "ingress is not running; complete the first cutover in docs/operations/deploy.md before deploying"

if [ "$BUILD" -eq 1 ]; then
  echo "==> building api web ingress at $REVISION"
  docker compose build api web ingress
fi

echo "==> running migrations"
docker compose run --rm migrate

echo "==> rolling out api"
docker rollout api -t 180

echo "==> rolling out web"
docker rollout web -t 120

PORT=$(docker compose port ingress 8080 | head -n 1 | sed 's/.*://')
[ -n "$PORT" ] || die "ingress is not running; complete the first cutover in docs/operations/deploy.md"
BASE_URL="http://127.0.0.1:$PORT"

wait_for_code() {
  url=$1
  expected=$2
  attempt=0
  code=000
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    if [ "$code" = "$expected" ]; then
      break
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || die "$url returned '$code', expected $expected"
    sleep 1
  done
  echo "ok: $url -> $code"
}

wait_for_code "$BASE_URL/healthz" 200
wait_for_code "$BASE_URL/api/auth/me" 401

for service in api web; do
  CONTAINERS=$(docker compose ps -q "$service")
  [ -n "$CONTAINERS" ] || die "$service is not running"
  for container in $CONTAINERS; do
    revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
    [ "$revision" = "$REVISION" ] || die "$service container $container carries revision '$revision', expected '$REVISION'"
  done
done

docker compose ps
echo "deployed revision: $REVISION"
