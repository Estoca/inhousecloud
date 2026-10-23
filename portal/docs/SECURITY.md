# Portal security

The portal is a **read-only** aggregator. It issues no tokens, runs no deploy, and does not
change the proxy, Authentik, any database or any app's `.env`. This page says how it must be
exposed and what still writes.

## Exposure: only behind the proxy

- Node listens on `127.0.0.1` by default (`HOST` changes that). In the cloud, the `portal`
  service of `docker/compose.yml` listens on `0.0.0.0:8080` inside the container, with no
  port published on the host: only the `ihc` network reaches the portal, and people come in
  through the proxy.
- Every person's request comes through **Nginx Proxy Manager with Authentik's forward
  auth**. The portal trusts the `X-authentik-email`, `X-authentik-name` and
  `X-authentik-groups` headers **only when the request comes from the proxy**
  (`TRUSTED_PROXY_HOSTS=proxy`: the source address must be one the name `proxy` resolves
  to). Any app container on the `ihc` network reaches port 8080; a request from it with
  forged headers is anonymous (`401`). The cloud's smoke test 22 proves it.
- `GET /health` (and `/api/health`) is the only route the proxy lets through without
  Authentik (`location = /health`; the container, the proxy and the installer use it as a
  healthcheck). The answer holds no secret.
- The portal does not have the Docker socket: it reads through `docker-ro` (GET on an
  allowlist, `Env` with names only, on an internal network of its own and the Docker proxy),
  and never receives the proxy's admin password nor Authentik's or Gitea's admin token (only
  Gitea's read-only token and the token of Authentik's `ihc-portal` service account, which
  has only `view_user` and `view_group`: a `POST` with it gets 403, smoke test 24). The
  container runs as `node` (uid 1000), with no capabilities.

## Route authentication

| Route | Who reaches it |
|---|---|
| `GET /health`, `GET /api/health` | public |
| other `GET /api/*` | anyone signed in through Authentik (group `ihc-users` or `ihc-admins`) |
| `GET /api/platform/status`, `GET /api/storage-usage`, `GET /api/people`, `GET /api/groups` | admin (group `ihc-admins`); `ihc-users` gets `403` |
| `POST /api/apps-status/refresh`, `POST /api/platform/status/refresh` | admin (group `ihc-admins`) |
| `PATCH /api/apps/:slug/metadata`, `PATCH /api/runtime/docker/:name/metadata` | nobody: `405 read_only` |
| `/api/admins*`, `/api/disk-usage-*` | super admin |
| `/api/internal/mcp/v1/*` | only `CATALOG_MCP_TOKEN` (`Authorization: Bearer`); the session does not open it |
| `GET /api/platform/status` | also `IHC_PORTAL_API_TOKEN` (`Authorization: Bearer`, read only, for agents; the cloud's `docs/portal-api.md`) |

Without an Authentik session, every `/api` route outside the public list answers `401`. An
`Authorization: Bearer` replaces the session only on `GET /api/platform/status`, and only
with `IHC_PORTAL_API_TOKEN`: with that token, any other route answers `403`; a wrong token,
`401`; a portal without the variable, `503` on that route. The test
`test/auth-matrix.test.js` walks Express's route table and checks the `401`;
`test/service-token.test.js` checks the token's `403` on every other route.

## What still writes in the portal

- **The portal itself** writes status and disk snapshots to its own Postgres, and applies
  its own migrations at boot.
- **Super admins** manage the `portal_admins` table (`/api/admins`).
- The inventory is read only (the `catalog/` directory mounted `:ro`): description, owner
  and category change in the app's `company-app.yaml`, by a push.

Removed in 2026-10: per-user and admin tokens (`/api/me/api-tokens`, `/api/api-tokens`),
`POST /api/events` and `POST /api/apps/:slug/events`, NPM/Authentik reconciliation
triggered by an event, the local go-live executor, and the LLM agent with an OpenAI key.
Before that, any viewer of the domain could issue a token and, with `details.deploy`, point
any domain at another port.

Removed when the portal was brought into the cloud: the runner's service token
(`EVENTS_API_TOKEN`) and the routes it opened (`/api/gitops/*`, `/api/claude-code/*`), the
deploy request queue, repository discovery, access metrics and the Google login.

## Sign-in

- Authentik is the only provider: the portal reads the person from the forward-auth
  headers and has no login of its own, no session cookie and no OAuth. `POST /logout`
  redirects to `/outpost.goauthentik.io/sign_out`.
- Who may come in: the `ihc-admins` group (admin) and `ihc-users` (viewer), read from
  `X-authentik-groups`; super admins from `SUPER_ADMIN_EMAILS`; admins from the
  `portal_admins` table. In the cloud, the e-mail domain alone gives no access
  (`PORTAL_ALLOW_DOMAIN_USERS=false`). The portal's application in Authentik is bound to
  `ihc-admins` and `ihc-users` (first-run); the group-to-role map is `src/roles.js`.
