# Portal API for agents

The portal serves one read-only endpoint that an agent, a script or a monitor may call without a browser: the health of the cloud's own services. It is the same JSON the portal's Platform page shows. Everything else in the portal needs a person signed in through Authentik.

## Endpoint

```text
GET  <PORTAL_BASE_URL>/api/platform/status          e.g. http://portal.cloud.localhost/api/platform/status
GET  <PORTAL_BASE_URL>/api/platform/status?refresh=1   probe everything now and wait for it (a few seconds)
```

`HEAD` is accepted too. There is no write, no other route and no other method for the token.

## Authentication

```text
Authorization: Bearer <IHC_PORTAL_API_TOKEN>
```

- **The token.** `IHC_PORTAL_API_TOKEN`, 48 random characters, generated once by `scripts/first-run.sh` into `<install-dir>/.env` (0600) and passed to the portal container by Compose. It is never printed; `state.json` keeps only its fingerprint (`stages.first_run.probe.portal_api_token_fingerprint`), and `inventory.json` says where it lives (`portal_api`). The agent profile does not receive it.
- **Read only, one route.** The token opens `GET /api/platform/status` and the public `/health`. With the token, every other portal route answers `403`, whatever identity headers come with it.
- **The proxy's rule.** The portal's route has forward auth (Authentik). One exception, in `scripts/lib/portal-api.sh` and installed by `first-run.sh` on the portal's proxy host: a request for exactly `/api/platform/status` **that carries an `Authorization` header** skips the forward auth and goes to the portal, which checks the token. The proxy drops any `X-authentik-*` header such a request brings, so it can never pass as a signed-in person. Without the header, the same path goes through Authentik like every other path, so a browser still signs in. Every other path with a token still meets the forward auth (a `302` to the sign-in, or `401`).
- **Rotating it.** Empty `IHC_PORTAL_API_TOKEN` in `.env`, run `scripts/first-run.sh --install-dir <dir>` (it makes a new one), then `docker compose --project-directory <dir> -f <dir>/compose.yml up -d portal`.

## Response

`200`, `application/json`:

| Field | Meaning |
|---|---|
| `checked_at` | When the portal last probed the services (ISO 8601, UTC). |
| `overall` | `healthy` when no service is unhealthy, `degraded` when at least one is. A service that is not configured (`healthy: null`) does not degrade it. |
| `summary.total` | Number of entries in `services`. |
| `summary.healthy` / `unhealthy` / `unknown` | How many have `healthy` `true`, `false`, `null`. |
| `services[]` | One entry per service, in a fixed order: proxy, Authentik, Gitea, the CI runner, the deploy runner, the read-only Docker API (`docker-ro`), the shared Postgres, the shared Redis, the backup; then, by profile, Garage (storage), Portainer, Glances, FileBrowser and the web terminal (ops), the operator agent (agent), and the tunnel (Cloudflare Tunnel, or Tailscale and its DNS). |
| `services[].name` | A person's label for it (in Portuguese, as on the page). Match on `kind` and `container`, not on the label. |
| `services[].kind` | `proxy`, `auth`, `git`, `ci`, `docker`, `database`, `cache`, `backup`, `storage`, `ops`, `agent`, `tunnel`. |
| `services[].healthy` | `true` answered as expected; `false` did not (down, unhealthy, error, backup too old or failed); `null` not configured or not measurable (Docker unreachable, backup off). |
| `services[].detail` | One line on what was seen (version, `PONG`, the error, the backup's age). |
| `services[].checked_at` | When this service was probed. |
| `services[].latency_ms` | For HTTP, Postgres and Redis probes: how long the answer took. |
| `services[].url` | For Gitea and Authentik: the internal URL probed. |
| `services[].version` | Gitea's version, when it answered. |
| `services[].container`, `state`, `status`, `image` | For services read from Docker: the container's name, state (`running`, `exited`, …), Docker's status line and image. |
| `services[].configured` | `false` when the portal has nothing to probe it with (the reason is in `detail`). |
| `services[].databases`, `total_bytes` | Postgres: each database and its size, for the ones the portal's role may open. |
| `services[].last_status`, `last_run_id`, `last_error`, `newest_at`, `snapshot_id`, `age_hours`, `max_age_hours` | Backup: the last run's status, id and error, when the newest successful run finished, its snapshot, its age and the limit ([`backup.md`](backup.md)). |
| `links` | Public URLs of Gitea, Authentik and, with the ops profile, Portainer, Glances and the file browser (`null` when the profile is off). |
| `topology` | The installation without secrets: `base_domain`, `portal_url`, `gitea_url`, `gitea_org`, `authentik_url`, `ingress`, `tunnel_provider`, `profiles`, `timezone`, `admin_group`, `user_group`, and the manifest's file name. |
| `cached` | `true` when served from the portal's cache (Redis), `false` when probed for this request. |
| `stale` | `true` when the cached reading is older than its TTL: a refresh is running in the background; ask again or use `?refresh=1`. A client that acts on the answer (an agent) should not use a stale reading as the current state: the MCP gateway's `ihc_platform_status` asks again with `?refresh=1` whenever it gets `stale: true` ([`mcp-gateway.md`](mcp-gateway.md#tools-of-the-platform)). |
| `generated_at`, `age_seconds` | When the served reading was built, and its age. |
| `cache_ttl_seconds`, `cache_expires_at` | The cache's lifetime for this reading (`PLATFORM_STATUS_TTL_SECONDS`, default 60). |

The required fields, which a client may rely on and the installer checks (`scripts/lib/portalapi.py`, smoke test 23): `checked_at`, `overall`, `summary` with the four integers, and `services` with `name`, `kind`, `healthy` and `detail` in every entry. The others are added as the portal learns more; a client ignores what it does not know.

## Errors

| Code | Body | When |
|---|---|---|
| `401` | `{"error":"unauthorized"}` | The token is wrong, or the header is not `Bearer <token>`. |
| `401` | `{"error":"unauthenticated"}` | No `Authorization` header and no session (straight to the portal; through the proxy this is a `302` to the sign-in). |
| `302` | to `/outpost.goauthentik.io/start` | Through the proxy without the header: the browser's path. With the token, the route has no API rule yet: run `first-run.sh`. |
| `403` | `{"error":"forbidden"}` | The right token on any other route or method. |
| `503` | `{"error":"portal_api_token_not_configured"}` | The portal container has no token: recreate it after `first-run.sh` (`docker compose … up -d portal`). |

## Example

From the box, through the proxy. The token goes in a curl config file read from stdin, so it never appears on a command line or in the shell history:

```bash
I=/opt/inhousecloud
printf 'header = "Authorization: Bearer %s"\n' "$(grep '^IHC_PORTAL_API_TOKEN=' $I/.env | cut -d= -f2-)" \
  | curl -sS -K - -H "Host: portal.cloud.localhost" http://127.0.0.1/api/platform/status \
  | python3 -m json.tool
```

With TLS internal, `https://portal.<BASE_DOMAIN>/api/platform/status` and `--cacert $I/local/ca/ca.crt` instead of the `Host` header; from another computer, the portal's public URL. A short answer:

```json
{
  "checked_at": "2026-10-22T12:00:00.000Z",
  "overall": "healthy",
  "summary": { "total": 9, "healthy": 9, "unhealthy": 0, "unknown": 0 },
  "services": [
    { "name": "Proxy (Nginx Proxy Manager)", "kind": "proxy", "healthy": true, "detail": "respondendo", "checked_at": "…", "latency_ms": 4 },
    { "name": "Redis compartilhado", "kind": "cache", "healthy": true, "detail": "PONG", "checked_at": "…", "latency_ms": 1 }
  ],
  "links": { "gitea": "http://git.cloud.localhost", "authentik": "http://auth.cloud.localhost" },
  "topology": { "base_domain": "cloud.localhost", "ingress": "local", "profiles": [] },
  "cached": true, "stale": false, "generated_at": "…", "age_seconds": 12, "cache_ttl_seconds": 60, "cache_expires_at": "…"
}
```

## Who reads it on the box

- `install.sh status --json` adds `source`, `platform` and `portal_api` to the state's summary. `source: "portal-api"`: `platform` is this response. `source: "local"`: the portal did not answer with it, `platform` is `null` and `portal_api.reason` says why (no token in `.env`, no answer, a `302`, `401` or `503`, a body that is not the status); the rest of the output is the same as before.
- `ihc doctor --json` adds the same three fields and a `portal-api` check: `ok` when the portal sees every service healthy, `warn` naming the unhealthy ones, `warn` with what to do when it cannot read the API (then the report is the doctor's local checks alone).

## Older installations

An installation made before this API has no token and its portal route has no rule. Update it from the checkout, at the new version:

```bash
cd ~/inhousecloud && git pull
./install.sh --apply --from foundation --install-dir /opt/inhousecloud
```

`first-run` generates the token (only if `.env` has none), puts the rule on the portal's route and the portal is recreated with the token; nothing else is recreated beyond what an update always does. Then `./install.sh status --install-dir /opt/inhousecloud --json` says `"source": "portal-api"`.
