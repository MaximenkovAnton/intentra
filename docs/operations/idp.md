# Identity provider operations (Pocket ID)

Intentra has no authentication of its own: every sign-in goes through Pocket ID
over OIDC. Pocket ID runs on its own host with a SQLite database on a Docker
volume; the control plane and the runner never see a password.

| Item | Value |
| --- | --- |
| Host | one host with Docker Compose (LXC container, VM or bare metal) |
| Stack | `infra/idp/compose.yml`, image `ghcr.io/pocket-id/pocket-id:v2.19.3` |
| Data | SQLite + uploads in the `pocket-id-data` volume (`/app/data`) |
| Public URL | `https://<idp-public-host>` (HTTPS is required for passkeys) |
| OIDC client | `intentra`, redirect `<public-url>/api/auth/callback` |
| Admin group | `intentra-admins` (members become organisation admins) |

Passkeys are bound to the host in `APP_URL`, and browsers only allow them on
HTTPS origins (or `localhost`). Use a publicly trusted certificate, or serve
Pocket ID with a private certificate on a private host and let the api trust
that CA through the compose CA overlay (see below). Changing the domain later
only touches `APP_URL`, the certificate and the OIDC client redirect.

## Deploy

The stack is portable; only `APP_URL` (and, with a private CA, the files in
`certs/`) is environment-specific:

```bash
scp -r infra/idp user@<idp-host>:/opt/intentra-idp
ssh user@<idp-host> 'cd /opt/intentra-idp && cp -n .env.example .env && $EDITOR .env'
ssh user@<idp-host> 'cd /opt/intentra-idp && docker compose up -d'
```

`infra/idp/.env` (copied from `.env.example`, gitignored) holds the values
below. The `certs/` directory is gitignored too: put `tls.crt` and `tls.key`
there, or terminate TLS in a reverse proxy in front of Pocket ID.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | address users open; passkey domain and OIDC issuer |
| `IDP_PORT` | host port mapped to Pocket ID's 1411 |
| `ENCRYPTION_KEY` | encrypts the token signing keys in SQLite (>= 16 bytes) |
| `TRUST_PROXY` | proxies whose `X-Forwarded-For` may be trusted |
| `EMAILS_VERIFIED` | mark configured e-mails verified, so the control plane links the account |
| `STATIC_API_KEY` | fixed admin API key for declarative provisioning |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | certificate and key inside the container |
| `OIDC_CLIENT_NAME`, `OIDC_REDIRECT_URIS`, `ADMIN_GROUP` | optional bootstrap values for local provisioning tooling |

Never commit `.env`, `certs/` or `oidc-client.env`.

## First admin account and passkey

Open `https://<idp-public-host>/setup` in a browser that trusts the certificate.
Fill in the first user and register its passkey — the setup page disappears once
an account exists. This is the human sign-in proof for the slice.

Add the account to the admin group with the admin API; members of
`intentra-admins` become organisation admins in Intentra:

```bash
KEY=$(ssh user@<idp-host> 'grep ^STATIC_API_KEY= /opt/intentra-idp/.env | cut -d= -f2-')
IDP=https://<idp-public-host>
USER_ID=$(curl -s -H "X-API-KEY: $KEY" "$IDP/api/users" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
GROUP_ID=$(curl -s -H "X-API-KEY: $KEY" "$IDP/api/user-groups" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["id"])')
curl -s -X PUT -H "X-API-KEY: $KEY" -H 'Content-Type: application/json' \
  -d "{\"userIds\":[\"$USER_ID\"]}" \
  "$IDP/api/user-groups/$GROUP_ID/users"
```

## OIDC client

Create the `intentra` client in Pocket ID (Administration → OIDC clients, or the
same admin API): confidential, PKCE enabled, redirect `<public-url>/api/auth/callback`,
consent screen skipped. Copy its issuer, client id and secret into the control
plane's `infra/compose/.env` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`). The group restriction is left open
so every Pocket ID user can sign in to Intentra and get a project role there.

When Pocket ID serves a private/self-signed certificate, copy its CA to the
compose directory and apply the overlay so the api container trusts it:

```bash
cp /path/to/ca.crt infra/compose/idp-ca.crt
cd infra/compose
IDP_CA_CERT=./idp-ca.crt docker compose \
  -f docker-compose.yml -f docker-compose.idp-ca.yml up -d --build
```

## Health and discovery

```bash
ssh user@<idp-host> 'cd /opt/intentra-idp && docker compose ps'
curl -sk https://<idp-public-host>/.well-known/openid-configuration \
  | python3 -m json.tool | head
curl -sk https://<idp-public-host>/healthz
curl -sk -H "X-API-KEY: $KEY" https://<idp-public-host>/api/oidc/clients
```

`docker compose ps` must show `pocket-id` healthy; the discovery document must
report `issuer` equal to `APP_URL`. If the api container logs
`self-signed certificate`, the CA overlay is missing or `IDP_CA_CERT` points at
the wrong file.

## Backup and restore

Back up the IdP host (the container/VM snapshot or a dump of the
`pocket-id-data` volume) with the host's own tooling; keep the `.env`, because
the `ENCRYPTION_KEY` in it decrypts the signing keys stored in SQLite. After a
restore, start the stack again; host-specific backup commands and schedules stay
in the operator's private infrastructure repository.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Passkey setup fails in the browser | The page is not a secure context. Use the HTTPS origin in `APP_URL`, not a plain-HTTP address, and trust the certificate. |
| `certificate is not trusted` in api logs | The CA overlay is not applied; copy the IdP CA to `infra/compose/idp-ca.crt` and set `IDP_CA_CERT`. |
| Login redirects back with `invalid_redirect_uri` | `OIDC_REDIRECT_URI` must exactly match one of the client's callback URLs; update the client and retry. |
| Sign-in works but the user is not org-admin | The user is not a member of `intentra-admins`; add it with `PUT /api/user-groups/<id>/users`. |
| Pocket ID restart loses accounts | The compose file was started without the `pocket-id-data` volume or with a different project directory. Keep `/opt/intentra-idp` as the project directory. |
