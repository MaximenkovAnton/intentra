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
proxy. `docker-rollout` doubles a service (`--scale`), waits for the new container to report
healthy, then stops and removes the old one. `api` and `web` publish no host ports and have no
`container_name`, which is what makes them rollable.

## One-time setup

```bash
scripts/install-docker-rollout.sh
docker rollout --version             # docker-rollout version v0.14
```

The script downloads the `v0.14` file pinned by sha256, installs it into
`/usr/local/lib/docker/cli-plugins` (fallback `~/.docker/cli-plugins`), and updates a user-level
copy if it shadows the system one. Re-running it is safe; it never pipes the download into a
shell.

## First cutover (once, brief interruption)

The old `web` container publishes `8090`; the ingress cannot bind the port until that container
is gone. This is the only step that is not rolling:

```bash
cd infra/compose
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) \
  docker compose up -d --no-deps --scale web=1 --build web   # new web, no published ports
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) docker compose up -d --no-deps --build ingress
docker compose ps                                  # ingress, api, web healthy; migrate exited 0
curl -fsS http://127.0.0.1:8090/healthz            # ok
```

`--build web` is not optional on the first cutover: the new web image is the one that carries the
runtime `api` resolver. Recreating whatever `intentra-web:local` already points at would keep the
old static upstream, and the first `docker rollout api` would answer `/api` from the removed api
container's address until web was rolled.

After the cutover, `docker compose up -d --build` is no longer the deployment path: it recreates
containers in place and drops traffic.

## Deploying an update

From `infra/compose` (where the cutover leaves you), the script is two levels up:

```bash
../../scripts/deploy.sh --check     # preflight only: .env, compose config, docker-rollout; changes nothing
../../scripts/deploy.sh             # build → migrate → rollout api → rollout web → verify
../../scripts/deploy.sh --no-build  # deploy the images that are already built
```

`scripts/deploy.sh` runs, in order:

1. preflight: `docker compose config --quiet`, `infra/compose/.env` present, `docker rollout`
   available;
2. `docker compose build api web ingress` with `INTENTRA_GIT_REVISION=$(git rev-parse HEAD)`
   (the runtime image carries `org.opencontainers.image.revision`);
3. `docker compose run --rm migrate` — migrations run before any new api container serves;
4. `docker rollout api -t 180` — old api is removed only after the new one is healthy;
5. `docker rollout web -t 120`;
6. verification: `http://127.0.0.1:${WEB_PORT:-8090}/healthz` returns 200, the same origin's
   `/api/auth/me` returns 401 — api answers it through web, so a stale web→api upstream fails the
   deploy instead of passing on web's static `healthz`; every running api and web container
   carries the deployed revision label, `docker compose ps` is printed, and the deployed revision
   is printed last.

Any failed step exits non-zero. A failed health check during `docker rollout` leaves the old
containers serving and removes the new ones. A deploy refuses a dirty working tree before
building — any tracked change or untracked non-ignored file, because the build context bakes
those bytes into the image while the label stays at HEAD; gitignored files are not considered.
`--check` validates only the static preconditions and changes nothing. A real run (not
`--check`) also requires `ingress` to be running: without it the first cutover was not
completed, and rolling `web` would drop the only publisher of `${WEB_PORT}`.

`ingress` itself publishes the fixed port, so it is not rolled out. Update it explicitly when its
image or config changes:

```bash
cd infra/compose
INTENTRA_GIT_REVISION=$(git rev-parse HEAD) docker compose build ingress
docker compose up -d --no-deps ingress
```

Expect a short interruption while the ingress container is recreated.

## Checks after a deployment

```bash
curl -s -o /dev/null -w '%{http_code}\n' <public-url>/healthz      # 200
curl -s -o /dev/null -w '%{http_code}\n' <public-url>/             # 200
curl -s -o /dev/null -w '%{http_code}\n' <public-url>/api/auth/me  # 401 without a session
cd infra/compose && docker compose ps
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
  $(docker compose ps -q api)
```

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

- `ingress` is not rolled out: its published port is fixed. Updating it is a short interruption.
- `migrate` runs once, before the rollouts, while the old api container is still serving. The
  schema is migrated first, and the old api keeps querying that newer schema until
  `docker rollout api` removes it after the new container is healthy. Every migration must
  therefore be backward-compatible (expand/contract); a migration that breaks the old code must
  be split over two deploys. The script never rolls the schema back.
- Long-lived connections to the old api (SSE streams on `/api/events`, runner WebSocket on
  `/api/runners/ws`) end when that container is removed; the browser's EventSource and the runner
  reconnect automatically.
- api is rolled before web because web waits for api to be healthy. Do not roll web first.
- There is no registry and no CI deploy: images are built on the host and labelled `local`.
- Keep `ports` and `container_name` off `api` and `web`; `docker-rollout` refuses such services.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `docker rollout` refuses the service | `docker compose config` shows `ports` or `container_name` on it; remove them. |
| 502 after a rollout | web nginx lost the dynamic upstream: `resolver`, `zone` and `server ... resolve` must be present; `nginx -t` in the image. |
| ingress unhealthy | web is not ready yet: `docker compose logs web`, `docker compose logs ingress`. |
| rollout times out waiting for health | new container's own healthcheck fails: `docker compose ps`, container logs; the old containers remain. |
| healthz 200 locally but not from NPM | NPM upstream must point at `:${WEB_PORT:-8090}`; ingress must be running. |
| login loops after a deploy | `PUBLIC_URL`, `OIDC_REDIRECT_URI` and the OIDC client must still match; a revision label check does not cover that. |
