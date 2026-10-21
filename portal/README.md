# InHouseCloud portal

The app portal of InHouseCloud: one page that shows every internal app of the
company (catalog, owner, health, effective SSO protection, deploys from Gitea
Actions) and the state of the platform services behind them.

Derived from the internal portal of the reference installation.

## What it is

- An app is a repository in the cloud's Gitea with a `company-app.yaml` at its root.
- A push to `main` runs Gitea Actions, which deploys the app on the machine.
- The portal is a **read-only aggregator**: it reads the inventory, Docker, Nginx Proxy
  Manager, HTTP health and the Gitea Actions run history. It does not deploy, does not
  issue tokens and does not change the proxy or Authentik.

## Documents

- `docs/COMPANY_APP_YAML.md`: the app manifest contract.
- `docs/DATABASE.md`: the portal's own database.
- `docs/SEGURANCA.md`: how the portal is exposed (only behind the proxy with Authentik), who reaches each route and what still writes.

## Validator

```bash
npm install
npm run validate
```

Or:

```bash
npx ihc-portal validate ./company-app.yaml
```

The example app:

```bash
node src/cli.js validate examples/minimal-docker-app/company-app.yaml
```

## CI

`.gitea/workflows/test.yml` runs on push and on pull requests. It is CI only: the
portal is deployed by the cloud's installer, not from this repository.

- `npm ci`
- `scripts/check-private-names.sh`
- `npm run validate`
- `node src/cli.js validate examples/minimal-docker-app/company-app.yaml`
- `npm test`

### Private names check

`scripts/check-private-names.sh` fails when any word of the tracked files (or of their
paths) is on the list in `scripts/private-names.sha256`. The list holds only SHA-256
hashes, one per line, so the names it guards never appear in clear text in the
repository. Each word is lowercased and taken as a run of letters, digits, `.`, `-`
and `_`; the check hashes the whole word and every run of its parts split at `.`, `-`
and `_` (so a name inside a domain, an e-mail or a path is caught). To add a name,
append `printf '%s' 'name' | shasum -a 256` (the hex part) to the list.

## Configuration

Everything specific to an installation comes from environment variables read in
`src/config.js`. The defaults are those of a local InHouseCloud install
(`cloud.localhost`); every variable is documented in `.env.example`:

| Variable | Purpose |
|---|---|
| `COMPANY_NAME`, `BASE_DOMAIN`, `PORTAL_HOST` | company name, app domain (`<slug>.<BASE_DOMAIN>`), portal host (default `portal.<BASE_DOMAIN>`) |
| `ORG_EMAIL_DOMAINS` | whoever arrives through Authentik with an e-mail in these domains gets in as viewer |
| `GITEA_URL`, `GITEA_PUBLIC_URL`, `GITEA_ORG`, `GITEA_TOKEN` | Gitea API and links, the apps' organization (default `company`), read-only token |
| `AUTHENTIK_URL`, `OUTPOST_HOST`, `OUTPOST_PORT`, `UPSTREAM_HOST` | Authentik and the proxy topology |
| `DEPLOY_ROOT`, `PORT_RANGE`, `TIMEZONE` | deploy root, fixed port range, scheduling time zone (default `UTC`) |
| `MANIFEST_FILENAME`, `MANIFEST_FILENAME_ALIASES` | manifest name (default `company-app.yaml`) and aliases accepted by the CLI |
| `ADMIN_GROUP`, `USER_GROUP` | the cloud's Authentik groups (default `ihc-admins`, `ihc-users`) |
| `INVENTORY_PATH` | the real app inventory, outside the repository and the image |

URLs not set explicitly derive from `BASE_DOMAIN`: `http://` for `*.localhost`,
`https://` otherwise. `GET /api/platform/config` returns this summary (no secrets) for
the UI and for LLMs.

### Inventory

`inventory/apps.json` is the real inventory and is **neither in the repository nor in
the image** (`.gitignore`); the portal reads the path in `INVENTORY_PATH` (in the
compose file, the volume mounted at `/app/inventory`). Without it the portal uses
`inventory/apps.example.json` and marks the source as an example. Optional field per
app: `healthcheck_path`, the manifest's `runtime.healthcheck.path`, used by the HTTP
health check.

## Run

```bash
cp .env.example .env
npm start
```

With Docker:

```bash
docker compose -f docker-compose.prod.yml up -d --build
curl -fsS http://localhost:8016/api/health
```

For the container to reach services on the host, the local `.env` holds:

```bash
DOCKER_NPM_URL=http://host.docker.internal:81
DOCKER_GITEA_URL=http://host.docker.internal:3007
DOCKER_DATABASE_URL=postgresql://ihc_platform:...@host.docker.internal:5432/ihc_platform
```

## API

Read-only endpoints:

- `GET /api/health`
- `GET /login`
- `POST /logout` (hands the session back to the Authentik outpost)
- `GET /api/me`
- `GET /api/platform/config`
- `GET /api/apps`
- `GET /api/apps/:slug`
- `GET /api/runtime/docker`
- `GET /api/apps-runtime`
- `GET /api/runtime/npm`
- `GET /api/apps-npm`
- `GET /api/runtime/health`
- `GET /api/apps-status`
- `GET /api/apps/:slug/deploys` (Gitea Actions history)
- `GET /api/apps/:slug/latest-deploy` (latest Gitea Actions run)
- `GET /api/storage-usage`
- `GET /api/platform/status`

`/api/apps-status` merges inventory, Docker, Nginx Proxy Manager and HTTP health, with
an `overall_status` per app. The HTTP health check uses the path the app's manifest
declares (`runtime.healthcheck.path`, kept in the inventory as `healthcheck_path`); a
redirect to Authentik counts as `unknown`, never as healthy.

`/api/platform/status` is the platform view: for each core service (Gitea, Authentik,
Nginx Proxy Manager, shared Postgres, Redis, MinIO, Cloudflare Tunnel, Gitea runner and
backup) it returns `{ name, kind, healthy, detail, checked_at }`, plus links to
Portainer and Glances. The **Platform** page shows the same JSON. Configuration:
`PLATFORM_PG_READONLY_URL` (read-only user of the shared Postgres), `REDIS_URL`,
`MINIO_ENDPOINT`, `CLOUDFLARED_CONTAINER`, `GITEA_RUNNER_CONTAINER`,
`BACKUP_MANIFEST_GLOB` (without it, the backup shows as "no backup configured"),
`BACKUP_MAX_AGE_HOURS`, `PORTAINER_URL` and `GLANCES_URL`. Served from the cache (60
seconds by default); `?refresh=1` or `POST /api/platform/status/refresh` (admin) force
a new read.

`HEALTHCHECK_TIMEOUT_MS` sets the HTTP health check timeout.

The portal accepts no personal token and issues none. The only token it knows is the
`CATALOG_MCP_TOKEN` of the provider below, which only opens `/api/internal/mcp/v1/*`.

### Catalog provider for the MCP gateway

The portal exposes a read-only view of the catalog to the `mcp-gateway`:

- `GET /api/internal/mcp/v1/tools`
- `POST /api/internal/mcp/v1/tools/{tool}/execute`

Both require `Authorization: Bearer` with `CATALOG_MCP_TOKEN`, a dedicated credential.
Without the variable the provider stays closed. The tools (`ihc_catalog_list_apps`,
`ihc_catalog_get_app`) expose name, description, owner, domain, category and
lifecycle; never runtime, logs, administration or secrets.

`GET /api/apps/:slug/deploys` and `GET /api/apps/:slug/latest-deploy` read the push runs
on `main` of the app's repository in Gitea Actions (`GITEA_URL` + a read-only
`GITEA_TOKEN`), cached for 60 seconds. An app hosted on GitHub or without `repo_url`
shows as `available: false`.

Set `RECORD_STATUS_EVENTS=true` for `/api/apps-status` to record an event only when an
app's `overall_status` changes.

### Status screen cache

Opening or reloading the portal does not redo the reads. `GET /api/apps-status`,
`GET /api/platform/status`, `GET /api/apps-runtime`, `GET /api/apps-npm` and
`GET /api/runtime/*` are served from a **stale-while-revalidate** cache
(`src/status-cache.js`):

- A request returns what is in the cache right away, with `cached`, `stale`,
  `generated_at`, `age_seconds` and `cache_expires_at` in the JSON. Only the first
  request for each view (empty cache) waits for the build.
- After the TTL the answer is marked `stale: true` and **one** refresh runs in the
  background (single-flight); a failed refresh keeps the old data.
- **Status pings** in `deploy_platform.app_status_pings` are written only when a refresh
  of `/api/apps-status` actually runs.
- `?refresh=1` forces a rebuild and waits for it. The dashboard's **Refresh** button
  calls `POST /api/apps-status/refresh` (admin); the Platform page calls
  `POST /api/platform/status/refresh`.
- Editing app or container metadata invalidates the app views.

The cache lives in the **shared Redis** when `STATUS_CACHE_REDIS_URL` (or else
`REDIS_URL`) is set, with keys `deploy-platform:*`; without a URL it stays in process
memory. A Redis failure or timeout never fails the request: the read falls back to
memory and Redis is skipped for 30 seconds.

| Variable | Default | Purpose |
|---|---|---|
| `STATUS_CACHE_REDIS_URL` | empty (uses `REDIS_URL`) | Redis for the cache |
| `STATUS_CACHE_TTL_SECONDS` | `300` | TTL of `/api/apps-status`, `/api/apps-runtime`, `/api/apps-npm` and `/api/runtime/*` |
| `PLATFORM_STATUS_TTL_SECONDS` | `60` | TTL of `/api/platform/status` |
| `STATUS_CACHE_REDIS_TIMEOUT_MS` | `1500` | timeout of each Redis operation |
| `APPS_STATUS_CACHE_TTL_MS` | - | old name, in ms; used only when `STATUS_CACHE_TTL_SECONDS` is empty |

A stale entry stays available for 12x the TTL (at least one hour) while no refresh
succeeds; after that the next request waits for the build again.

### Login and exposure

The portal listens only on `127.0.0.1` by default (`HOST` changes it; the compose file
uses `0.0.0.0` inside the container). It **must only be reachable through the proxy
with Authentik forward auth**, because it trusts the `X-authentik-*` headers. Every
`/api` route requires the Authentik session, except `GET /api/health` and the catalog
provider, which has its own token. Details in `docs/SEGURANCA.md`.

Authentik is the only login. The portal has no login of its own, no session cookie and
no OAuth: it reads the `X-authentik-*` headers from the forward auth and applies the
super admin allowlist:

```bash
SUPER_ADMIN_EMAILS=admin@example.com
```

`SUPER_ADMIN_EMAILS` takes several comma-separated e-mails. `ORG_EMAIL_DOMAINS` decides
who gets in as viewer. `POST /logout` sends the person to
`/outpost.goauthentik.io/sign_out`.

## Guardrails

- Never delete data from any Postgres database.
- Never remove a repository, stack, volume or proxy route automatically.
- Redact secrets in logs, APIs and error responses.
- Any future destructive action needs explicit human approval.

## Operating policy

- New apps should prefer `deploy.port: auto`.
- Fixed ports for new apps use the range `8100-8999`.
- Apps are deployed under `<DEPLOY_ROOT>/{owner_email}/{app_slug}`.
- Compact events are kept indefinitely; detailed logs for 7 days by default.

## Status

Read-only portal with inventory, Docker, Nginx Proxy Manager, HTTP health, Gitea Actions
deploy history and metadata editable by admins. The CLI has only `validate`.
