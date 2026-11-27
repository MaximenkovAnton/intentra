rollout_log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$*"
}

container_ip() {
  docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"
}

http_code() {
  curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || true
}

wait_healthy() {
  id=$1
  timeout=$2
  i=0
  while :; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    i=$((i + 1))
    [ "$i" -lt "$timeout" ] || return 1
    sleep 1
  done
}

nginx_reload() {
  docker exec "$1" nginx -t >/dev/null 2>&1 &&
    docker exec "$1" nginx -s reload >/dev/null 2>&1
}

image_config() {
  docker run --rm --entrypoint cat "$1" /etc/nginx/nginx.conf
}

pin_peer() {
  consumer=$1
  service=$2
  peer_ip=$3
  anchor=$4
  dir=$5
  awk -v pat="location $anchor {" -v hdr='      add_header X-Upstream $upstream_addr always;' \
    '{ if (index($0, pat) > 0) { print; print hdr; next } print }' "$dir/dynamic.conf" \
  | sed "s|server $service:8080 resolve;|server $peer_ip:8080;|" > "$dir/pinned.conf"
  grep -q "server $peer_ip:8080;" "$dir/pinned.conf" || return 1
  grep -q 'X-Upstream' "$dir/pinned.conf" || return 1
  docker cp "$dir/pinned.conf" "$consumer:/etc/nginx/nginx.conf" >/dev/null &&
    nginx_reload "$consumer"
}

discard_container() {
  docker stop "$1" >/dev/null 2>&1 || true
  docker rm "$1" >/dev/null 2>&1 || true
}

restore_consumer() {
  consumer=$1
  dir=$2
  [ -n "$consumer" ] && [ -n "$dir" ] || return 0
  [ -f "$dir/dynamic.conf" ] || return 0
  docker cp "$dir/dynamic.conf" "$consumer:/etc/nginx/nginx.conf" >/dev/null 2>&1 &&
    nginx_reload "$consumer" >/dev/null 2>&1
}

peer_reply() {
  url=$1
  expected=$2
  peer_ip=$3
  i=0
  while :; do
    headers=$(mktemp)
    code=$(curl -s --connect-timeout 2 --max-time 5 -D "$headers" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
    upstream=$(awk -F': ' 'tolower($1) == "x-upstream" { print $2 }' "$headers" | tr -d '\r' | head -n 1)
    rm -f "$headers"
    if [ "$code" = "$expected" ] && [ "$upstream" = "$peer_ip:8080" ]; then
      return 0
    fi
    i=$((i + 1))
    [ "$i" -lt 20 ] || return 1
    sleep 0.5
  done
}

dynamic_reply() {
  url=$1
  expected=$2
  i=0
  while :; do
    headers=$(mktemp)
    code=$(curl -s --connect-timeout 2 --max-time 5 -D "$headers" -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
    upstream=$(awk -F': ' 'tolower($1) == "x-upstream" { print $2 }' "$headers" | tr -d '\r' | head -n 1)
    rm -f "$headers"
    if [ "$code" = "$expected" ] && [ -z "$upstream" ]; then
      return 0
    fi
    i=$((i + 1))
    [ "$i" -lt 20 ] || return 1
    sleep 0.5
  done
}

roll_service() {
  service=$1
  consumer_service=$2
  probe_url=$3
  expected_code=$4
  timeout=$5
  anchor=$6
  consumer_image=$7

  old=$(docker compose ps -q "$service")
  old_count=$(printf '%s\n' "$old" | grep -c . || true)
  if [ "$old_count" -ne 1 ]; then
    echo "rollout: $service has $old_count running containers, expected 1" >&2
    return 1
  fi

  rollout_log "==> $service: scaling to 2 (old $old)"
  docker compose up -d --no-deps --no-recreate --scale "$service=2" "$service" >/dev/null || return 1

  new=""
  for id in $(docker compose ps -q "$service"); do
    if [ "$id" != "$old" ]; then
      new=$id
    fi
  done
  if [ -z "$new" ]; then
    echo "rollout: $service did not create a new container" >&2
    return 1
  fi

  rollout_log "==> $service: waiting for $new to become healthy"
  if ! wait_healthy "$new" "$timeout"; then
    echo "rollout: new $service container $new did not become healthy" >&2
    discard_container "$new"
    return 1
  fi

  peer_ip=$(container_ip "$new")
  if [ -z "$peer_ip" ]; then
    echo "rollout: $service container $new has no IP" >&2
    discard_container "$new"
    return 1
  fi

  consumer=$(docker compose ps -q "$consumer_service")
  consumer_count=$(printf '%s\n' "$consumer" | grep -c . || true)
  if [ "$consumer_count" -ne 1 ]; then
    echo "rollout: $consumer_service has $consumer_count running containers, expected 1" >&2
    discard_container "$new"
    return 1
  fi

  DRAIN_DIR=$(mktemp -d)
  image_config "$consumer_image" > "$DRAIN_DIR/dynamic.conf" || {
    discard_container "$new"
    return 1
  }
  DRAIN_CONSUMER=$consumer

  rollout_log "==> $service: pinning $consumer_service $consumer to $peer_ip"
  if ! pin_peer "$consumer" "$service" "$peer_ip" "$anchor" "$DRAIN_DIR"; then
    echo "rollout: could not pin $consumer_service to $peer_ip" >&2
    restore_consumer "$consumer" "$DRAIN_DIR" || true
    discard_container "$new"
    return 1
  fi
  if ! peer_reply "$probe_url" "$expected_code" "$peer_ip"; then
    echo "rollout: $probe_url did not reach pinned $service $peer_ip" >&2
    restore_consumer "$consumer" "$DRAIN_DIR" || true
    discard_container "$new"
    return 1
  fi

  rollout_log "==> $service: removing old container $old"
  if ! docker stop "$old" >/dev/null; then
    restore_consumer "$consumer" "$DRAIN_DIR" || true
    return 1
  fi
  if ! docker rm "$old" >/dev/null; then
    restore_consumer "$consumer" "$DRAIN_DIR" || true
    return 1
  fi

  if ! restore_consumer "$consumer" "$DRAIN_DIR"; then
    echo "rollout: could not restore $consumer_service config" >&2
    return 1
  fi
  if docker exec "$consumer" grep -q 'X-Upstream' /etc/nginx/nginx.conf; then
    echo "rollout: $consumer_service still runs the pinned config" >&2
    return 1
  fi
  if ! dynamic_reply "$probe_url" "$expected_code"; then
    echo "rollout: $probe_url is not served by the dynamic $consumer_service config" >&2
    return 1
  fi
  DRAIN_CONSUMER=
  rm -rf "$DRAIN_DIR"
  DRAIN_DIR=
  rollout_log "==> $service: $new serves, old $old removed"
}
