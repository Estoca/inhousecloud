# InHouseCloud portal

The app portal of InHouseCloud: one page that shows every internal app of the
company (catalog, owner, health, effective SSO protection, deploys from Gitea
Actions) and the state of the platform services behind them.

Derived from the internal portal of the reference installation.

## What it is

- An app is a repository in the cloud's Gitea with a `company-app.yaml` at its root.
- A push to `main` runs Gitea Actions, which deploys the app on the machine.
- The portal is a **read-only aggregator**: it reads the cloud's `inventory.json`,
  Docker through the cloud's read-only Docker API, each app's health and SSO through the
  proxy, the backup status files and the Gitea Actions run history. It does not deploy,
  does not issue tokens and does not change the proxy or Authentik.
- In the cloud it is a **core service**: `install.sh` builds it from this directory and
  starts it with the core (service `portal` of `docker/compose.yml`). It is not an app of
  `ihc-app`; `company-app.yaml` here only describes it for its own catalog.

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

The cloud's GitHub Actions workflow `.github/workflows/portal.yml` runs, for this
directory, on push and on pull requests:

- `scripts/check-private-names.sh`
- `npm ci`
- `npm test` (builds first)
- `npm run build`

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
`src/config.js`. In the cloud, the `portal` service of `docker/compose.yml` sets every
one of them from the installer's `.env`; for development, `.env.example` lists them.

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | `8080` and `0.0.0.0` in the container (default `127.0.0.1` outside) |
| `COMPANY_NAME`, `BASE_DOMAIN`, `PORTAL_HOST`, `PUBLIC_BASE_URL` | company name, app domain (`<slug>.<BASE_DOMAIN>`), portal host and URL (its scheme is used for every link) |
| `DATABASE_URL`, `MIGRATE_ON_BOOT` | the portal's database (`ihc_platform`, its own role); migrations run at boot unless `MIGRATE_ON_BOOT=false` |
| `INVENTORY_PATH` | the cloud's inventory, `/ihc/catalog/inventory.json` (the install's `catalog/` mounted read only) |
| `PORTAL_MANIFEST_PATH` | this directory's `company-app.yaml`, for the portal's own catalog entry |
| `IHC_PROXY_URL`, `NPM_HEALTH_URL` | the proxy (`http://proxy:80`) that app probes go through, and its health URL (`http://proxy:81/api/`, no login) |
| `DOCKER_HOST` | `tcp://docker-ro:2375`, the cloud's read-only Docker API; never the socket |
| `IHC_PROJECT`, `COMPOSE_PROFILES`, `INGRESS`, `TUNNEL_PROVIDER` | the cloud's Compose project and profiles: which services the Platform page lists |
| `GITEA_URL`, `GITEA_PUBLIC_URL`, `GITEA_ORG`, `GITEA_TOKEN` | Gitea API (`http://gitea:3000`), links, the apps' organization, the read-only token |
| `AUTHENTIK_URL`, `AUTHENTIK_HOST`, `AUTHENTIK_INTERNAL_URL` | Authentik for links, for recognizing its redirects, and for its health and API |
| `AUTHENTIK_PORTAL_TOKEN`, `PEOPLE_CACHE_TTL_SECONDS` | the API token of the read-only service account `ihc-portal` (first-run writes it; `view_user` and `view_group` only), for the People page (`GET /api/people`, `GET /api/groups`, admin); its cache in seconds (60). Empty: those routes answer 503 |
| `GARAGE_HEALTH_URL` | Garage's health (storage profile) |
| `BACKUP_ENABLED`, `BACKUP_REPORTS_DIR`, `BACKUP_MAX_AGE_HOURS` | the backup job's status files, mounted read only |
| `ADMIN_GROUP`, `USER_GROUP` | the cloud's Authentik groups: `ihc-admins` is admin, `ihc-users` is viewer |
| `SUPER_ADMIN_EMAILS` | safety net for the first access |
| `TRUSTED_PROXY_HOSTS` | the proxy's name (`proxy`): the `X-authentik-*` headers count only from it |
| `PORTAL_ALLOW_DOMAIN_USERS`, `ORG_EMAIL_DOMAINS` | outside the cloud: e-mail domains that get in as viewer (`false` in the cloud) |
| `MANIFEST_FILENAME`, `MANIFEST_FILENAME_ALIASES`, `TIMEZONE` | manifest name for the CLI, scheduling time zone |

`GET /api/platform/config` returns a summary without secrets or machine topology.

### Inventory

The source is the cloud's `<install-dir>/inventory.json`, written only by
`ihc-app provision` (contract: `scripts/lib/inventory.py` of the cloud, `schema_version`
1). The file lives in `<install-dir>/catalog/` (the old path is a symlink to it), and the
portal mounts that directory read only, never the install directory. `src/inventory.js`
adapts it: each `apps.<slug>` becomes a catalog app with its URL, repository, Compose
project (the slug), health path and expected status, `auth.required`, description and
`agent_interface.mcp`, all from the app's `company-app.yaml`. Apps a smoke test created
(`kind: system-test`) show under the category `system_test`. A newer `schema_version` is
read for what the portal knows and flagged (`schema_supported: false`). The contract is
tested on both sides on one fixture: `test/fixtures/ihc-inventory.json`,
`test/inventory-ihc.test.js` and the cloud's `scripts/tests/inventory-contract.sh`.

Without `INVENTORY_PATH` (development) the portal reads `inventory/apps.example.json`, the
older list format, and marks the source as an example.

## Run

In the cloud: `install.sh` (stage `portal`). For development:

```bash
cp .env.example .env
npm start
```

## API

Read-only endpoints:

- `GET /health` (also `/api/health`): public; `{ ok, service, commit_hash, migrations }`
- `GET /login`
- `POST /logout` (hands the session back to the Authentik outpost)
- `GET /api/me`
- `GET /api/platform/config`
- `GET /api/apps`
- `GET /api/apps/:slug`
- `GET /api/runtime/docker`
- `GET /api/apps-runtime`
- `GET /api/runtime/health`
- `GET /api/apps-status`
- `GET /api/apps/:slug/deploys` (Gitea Actions history)
- `GET /api/apps/:slug/latest-deploy` (latest Gitea Actions run)
- `GET /api/storage-usage`
- `GET /api/platform/status`

`PATCH /api/apps/:slug/metadata` and `PATCH /api/runtime/docker/:name/metadata` answer
`405 read_only`: description, owner and category change in the app's `company-app.yaml`.

`/api/apps-status` merges the inventory, Docker and the probes, with an
`overall_status` per app. Each app is probed **through the proxy with its Host header**
(`http://proxy:80<path>`, `Host: <slug>.<BASE_DOMAIN>`), as `ihc doctor` does, which works
in every ingress mode: the health path and expected status come from the manifest; a
redirect to Authentik counts as `unknown`, never as healthy. The root, probed the same
way, gives `health.sso_protected` (anonymous visitors go to the sign-in),
`health.sso_effective` (that matches `auth.required`) and `proxy.matched` (the route
exists: the root does not answer 404). The portal never reads the proxy's admin API.

`/api/platform/status` is the platform view: proxy (health only), Authentik, Gitea, the
runners `gitea-runner` and `gitea-deployer`, the read-only Docker API, shared Postgres,
Redis and the backup, plus Garage, the ops tools, the agent and the tunnel when their
profile is on. Each entry is `{ name, kind, healthy, detail, checked_at }`. The backup is
read from `latest-status.json` (how the last run went) and the age of `finished_at` in
`latest-success.json` against `max_age_hours` (the cloud's `docs/backup.md`). Behind the
Authentik session today; a read-only service token for agents comes with the cloud's
PR 6. Served from the cache (60 seconds by default); `?refresh=1` or
`POST /api/platform/status/refresh` (admin) force a new read.

`HEALTHCHECK_TIMEOUT_MS` sets the probe timeout.

The portal accepts no personal token and issues none. It knows two service tokens, each
opening one thing: `CATALOG_MCP_TOKEN` of the provider below, which only opens
`/api/internal/mcp/v1/*`, and `IHC_PORTAL_API_TOKEN`, below too.

### Status API for agents

`GET /api/platform/status` with `Authorization: Bearer` and `IHC_PORTAL_API_TOKEN` answers
the platform status without a session (`src/service-token.js`). The token opens that route
and `/health`, in `GET` or `HEAD`; on any other route it answers `403`, a wrong token `401`,
and a portal without the variable `503` on that route. Without the `Authorization` header
nothing changes. In the cloud, `first-run.sh` generates it and the proxy lets that one path
skip the forward auth when the header is present; the contract (fields, errors, `curl`) is
`docs/portal-api.md` at the repository root. Tests: `test/service-token.test.js`.

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

### Status

Read-only portal wired into the cloud: catalog from `inventory.json`, Docker through the
read-only API, health and SSO through the proxy, Gitea Actions deploy history, backup
status, the platform view, and people and groups from Authentik (admin; `ihc-users`
sign in as viewer). Next, in the cloud's plan: the status API for agents with a service token (PR 6), the MCP gateway as a
second entrypoint of this image (PR 7). The CLI has only `validate`.
