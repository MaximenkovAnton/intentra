# Control plane: rolling updates

The control plane is the compose project in `infra/compose`:

```
browser → NPM (TLS on the public origin)
        → ingress:${WEB_PORT:-8090}   (nginx, the only published port)
        → web:8080                    (nginx, static SPA + /api proxy)
        → api:8080                    (Fastify, sessions, SSE, runner WSS)
```

`ingress` and `web` resolve their upstream through the Docker DNS (`resolver 127.0.0.11 valid=5s`
plus `zone` and `server ... resolve`), so a new container is picked up without restarting the
proxy. `api` and `web` publish no host ports and have no `container_name`, which is what makes
them rollable.

A plain `docker rollout` doubles a service, waits for the replacement to report healthy and then
removes the old container. That leaves a race: the consuming proxy may still hold only the old
container's address when it disappears, and a request then has no healthy peer to retry to
(observed once on 2026-11-27: a 504 at the old web's removal while ingress held only the old
address). The deploy therefore drains deterministically, after the replacement is healthy:

1. write a runtime config into the consuming proxy that pins the replacement container's address
   (`docker cp`, `nginx -t`, `nginx -s reload`);
2. verify that a real request through that proxy is answered by the pinned address;
3. stop and remove the old container;
4. restore the dynamic `resolver` + `zone` + `server ... resolve` config and reload.

`scripts/rollout.sh` implements that sequence; `scripts/deploy.sh` runs it for `api` (consumer
`web`) and then `web` (consumer `ingress`). `docker-rollout` v0.14 is installed and pinned by
`scripts/install-docker-rollout.sh`, but it has no hook between "healthy" and "removal", so
`deploy.sh` performs the scale-up/health/removal steps itself with the same compose primitives.

Both proxies deliberately omit the upstream `keepalive` and set `proxy_connect_timeout 1s`: a
pooled idle connection to a container that was just removed does not fail cleanly, while a fresh
connect that times out after one second is retried on the resolved healthy peer instead of hanging
the request for the kernel's ARP timeout.

## One-time setup

```bash
scripts/install-docker-rollout.sh
docker rollout --version             # docker-rollout version v0.14
```

The script downloads the `v0.14` file pinned by sha256, installs it into
`/usr/local/lib/docker/cli-plugins` (fallback `~/.docker/cli-plugins`), and updates a user-level
copy if it shadows the system one. Re-running it is safe; it never pipes the download into a
shell.

## First cutover (once)

The old `web` container publishes `8090`; the ingress cannot bind the port until that container
is gone. This is the only step that is not rolling:

```bash
cd infra/compose
set -eu
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) \
  docker compose up -d --no-deps --scale web=1 --build web   # new web, no published ports
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) docker compose up -d --no-deps --build ingress
docker compose ps -a                                            # ingress, api, web healthy
[ "$(docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate)" = "migrate exited 0" ]
curl -fsS http://127.0.0.1:8090/healthz                         # ok
```

`--build web` is not optional on the first cutover: the new web image is the one that carries the
runtime `api` resolver. Recreating whatever `intentra-web:local` already points at would keep the
old static upstream, and the first `docker rollout api` would answer `/api` from the removed api
container's address until web was rolled.

The cutover is a one-time topology change: on 2026-11-27 it measured **11.5 s** wall time
(11.15 s of probe samples), because compose recreates the old `web` that published 8090 and only
then starts `ingress` on that port. Later deploys do not pay it.

After the cutover, `docker compose up -d --build` is no longer the deployment path: it recreates
containers in place and drops traffic.

## Deploying an update

```bash
scripts/deploy.sh --check     # preflight only: .env, compose config, docker-rollout; changes nothing
scripts/deploy.sh             # build → migrate → drain-roll api → drain-roll web → recreate ingress → verify
scripts/deploy.sh --no-build  # deploy the images that are already built
```

`scripts/deploy.sh` runs, in order:

1. preflight: `docker compose config --quiet`, `infra/compose/.env` present, `docker rollout`
   available;
2. `docker compose build api web ingress` with `INTENTRA_GIT_REVISION=$(git rev-parse HEAD)`
   (the runtime image carries `org.opencontainers.image.revision`);
3. `docker compose run --rm migrate` — migrations run once, before any new api container serves;
4. `api`: scale to two containers with `docker compose up --no-deps --no-recreate --scale`,
   wait for the new container's healthcheck, pin `web` to its address, verify a real `/api` request
   answers from it, stop and remove the old api, restore `web`'s dynamic config;
5. `web`: the same with `ingress` as the consumer and `/healthz` as the probe;
6. recreate `ingress` from the new image (it publishes the fixed port, so it cannot roll); this is
   the only non-rolling step and is bounded by `stop_grace_period: 2s`;
7. verification with time-bounded requests (`--connect-timeout 2 --max-time 5`):
   `http://127.0.0.1:${WEB_PORT:-8090}/healthz` returns 200, the same origin's `/api/auth/me`
   returns 401 — api answers it through web, so a stale web→api upstream fails the deploy instead
   of passing on web's static `healthz`; every running api, web and ingress container carries the
   deployed revision label; the migrate container is `exited 0`; `docker compose ps -a` is
   printed, and the deployed revision is printed last.

Any failed step exits non-zero. A failed healthcheck removes the new container and leaves the old
one serving. A failed pin or pin verification restores the consumer's dynamic config and removes
the new container before exiting; the old container has not been touched. A deploy refuses a dirty
working tree before building — any tracked change or untracked non-ignored file, because the build
context bakes those bytes into the image while the label stays at HEAD; gitignored files are not
considered. `--check` validates only the static preconditions and changes nothing. A real run (not
`--check`) also requires `ingress` to be running: without it the first cutover was not completed,
and rolling `web` would drop the only publisher of `${WEB_PORT}`.

The consumers are restored to the image's own `nginx.conf` after every drain, and the rollout
fails if the running config still differs (the pinned config is visible as an `X-Upstream`
response header during the drain only).

### Ingress

`ingress` publishes the fixed port, so it is not rolled out; `scripts/deploy.sh` recreates it from
the newly built image at the end of every deploy so that its revision label names the deployed
commit. With `stop_grace_period: 2s` the interruption is sub-second: on 2026-11-27 it cost **2
probe samples per endpoint (0.24 s)** instead of the 10.1 s measured with the default 10 s stop
timeout. To update ingress alone:

```bash
cd infra/compose
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) docker compose build ingress
docker compose up -d --no-deps ingress
```

## Checks after a deployment

Run these with `set -eu`: the `[ ... = ... ]` comparisons exit non-zero on a wrong code or label,
whereas `curl ...; echo ok` always exits 0 and proves nothing.

```bash
set -eu
[ "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' <public-url>/healthz)" = 200 ]
[ "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' <public-url>/)" = 200 ]
[ "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' <public-url>/api/auth/me)" = 401 ]
[ "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/healthz)" = 200 ]
cd infra/compose
[ "$(docker compose ps -a --format '{{.Service}} {{.State}} {{.ExitCode}}' migrate)" = "migrate exited 0" ]
REV=$(git rev-parse HEAD)
for service in api web ingress; do
  for container in $(docker compose ps -q "$service"); do
    revision=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container")
    [ "$revision" = "$REV" ]
  done
done
docker compose ps -a
```

`migrate` is a one-shot container: the deploy itself fails on a non-zero migration exit code
(`set -e` and the `docker compose run` exit status), and `ps -a` shows the compose-managed migrate
container's last state.

## Rollback

Images are local and tagged `intentra-<service>:local`; a rollback is a deployment of the
previous revision with the same script:

```bash
git checkout <previous-revision>
scripts/deploy.sh
```

Migrations are forward-only. Rolling the code back across a migration that already ran is a
separate decision: either restore the database from a backup or ship a forward fix. The deploy
script never reverses migrations.

## Limitations

- `ingress` is not rolled out: its published port is fixed. `scripts/deploy.sh` recreates it, which
  is a sub-second interruption, and `stop_grace_period: 2s` caps a stuck shutdown.
- `migrate` runs once, before the rollouts, while the old api container is still serving. The
  schema is migrated first, and the old api keeps querying that newer schema until the api rollout
  removes it after the new container is healthy. Every migration must therefore be
  backward-compatible (expand/contract); a migration that breaks the old code must be split over
  two deploys. The script never rolls the schema back.
- The drain rollouts use `--no-deps`, so they do not restart the one-shot `migrate` service. A
  plain `docker rollout api` on this compose file would restart it through the `depends_on`
  condition; use `scripts/deploy.sh` rather than the plugin for api and web.
- Long-lived connections to the old api (SSE streams on `/api/events`, runner WebSocket on
  `/api/runners/ws`) end when that container is removed; the browser's EventSource and the runner
  reconnect automatically.
- api is rolled before web because web waits for api to be healthy. Do not roll web first.
- There is no registry and no CI deploy: images are built on the host and labelled `local`.
- Keep `ports` and `container_name` off `api` and `web`; the drain rollout scales services and
  refuses such a service.
- The base images are tags (`nginx:1.29-alpine`, `node:24-alpine`), not digests: a rebuild of the
  same revision can bake different base-layer bytes. Pin by digest if that matters.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| deploy refuses the service | `docker compose config` shows `ports` or `container_name` on it; remove them. |
| `could not pin <consumer>` or `did not reach pinned` | the consumer's `nginx -t` failed or the new peer did not answer; the deploy restored the dynamic config and removed the new container. Check `docker compose logs <consumer>`. |
| 502 after a rollout | web or ingress lost the dynamic upstream: `resolver`, `zone` and `server ... resolve` must be present; `nginx -t` in the image. |
| ingress unhealthy | web is not ready yet: `docker compose logs web`, `docker compose logs ingress`. |
| rollout times out waiting for health | new container's own healthcheck fails: `docker compose ps`, container logs; the old containers remain. |
| healthz 200 locally but not from NPM | NPM upstream must point at `:${WEB_PORT:-8090}`; ingress must be running. |
| login loops after a deploy | `PUBLIC_URL`, `OIDC_REDIRECT_URI` and the OIDC client must still match; a revision label check does not cover that. |
