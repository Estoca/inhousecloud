# App Contract

`company-app.yaml` is the operational contract for a deployable internal app. `ihc-app provision` ([`gitops-flow.md`](gitops-flow.md)) reads it on every push to `main` and refuses to deploy when it breaks a rule below; [`templates/app`](../templates/app) starts every new app with a valid one. Schema: [`schemas/company-app.schema.json`](../schemas/company-app.schema.json).

## Minimal Deployable App

```yaml
schema_version: 1

app:
  slug: example-app                # = repository name = <slug>.<BASE_DOMAIN>
  name: Example App
  owner_email: owner@example.com   # the person who answers for the app
  description: Example internal app.

runtime:
  type: docker-compose
  compose_file: docker-compose.yml
  service: app                     # the service the proxy routes to
  port: 8080                       # the port it listens on inside its container
  healthcheck:
    type: http
    path: /health                  # stays public; everything else is behind the SSO
    expected_status: 200

deploy:
  enabled: true
  domain: example-app.cloud.localhost   # optional; always <slug>.<BASE_DOMAIN>
  port: auto                       # no host port: the proxy reaches the app on the ihc network
  env_example: .env.example

auth:
  required: true                   # forward auth through Authentik; false makes it public
  provider: forward-auth

database:
  required: true                   # own database and role on the shared Postgres
  engine: postgres

dependencies:
  redis:
    required: true                 # ACL user limited to the <slug>: key prefix

object_storage:
  required: false                  # bucket and key on the shared Garage (storage profile)

mcp:                               # optional: tools for AI agents through the MCP gateway
  audience: example-app.mcp
  tools_path: /mcp/tools
  execute_path: /mcp/tools/{tool}/execute
  scopes:
    example-app.read:              # scope -> the groups granted it
      - ihc-users

checks:
  build_command: docker compose build
  test_command: npm test
```

## What the app receives

`ihc-app provision` writes `<install-dir>/apps/<slug>/.env` (mode `0600`, never in Git) and the deploy hands it to every service of the app:

| Variable | When | Value |
|---|---|---|
| `PORT` | always | `runtime.port` |
| `APP_SLUG`, `APP_BASE_URL` | always | the slug, `<scheme>://<slug>.<BASE_DOMAIN>` |
| `DATA_DIR` | always | `/data`: the host directory `<install-dir>/app-data/<slug>`, mounted in the main service, backed up with the install directory and visible to admins in the ops file browser. Written as the container's root user (rootless Docker: the host user); an image that runs as another user must make `/data` writable for it |
| `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `database.required` | database and role `app_<slug>` on `postgres:5432` |
| `REDIS_URL`, `REDIS_PREFIX` | `dependencies.redis.required` | ACL user `app-<slug>` on `redis:6379`, prefix `<slug>:` (every key and channel must start with it) |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | `object_storage.required` (the `storage` profile must be on, or the deploy stops before changing anything) | bucket `app-<slug>` and access key `app-<slug>` on Garage: `S3_ENDPOINT` is `http://garage:3900` (inside the ihc network), `S3_PUBLIC_ENDPOINT` is `<scheme>://s3.<BASE_DOMAIN>` (for presigned URLs a browser opens), `S3_REGION` is `garage`, `S3_FORCE_PATH_STYLE` is `true` (path-style requests: set `forcePathStyle` in the AWS SDK). The key reads and writes this bucket only: it cannot list, create or delete buckets, and gets 403 on another app's |
| `IHC_MCP_ISSUER`, `IHC_MCP_JWKS_URL`, `IHC_MCP_AUDIENCE` | always | the MCP gateway's public URL (the actor JWT's `iss`), `http://mcp:8090/.well-known/jwks.json`, and `mcp.audience` (default `<slug>.mcp`): what the app checks an actor JWT against ([MCP](#mcp)) |
| keys of `.env.example` | when absent | the example's value; `LOCAL_*` keys are for a laptop and never reach the box |

Passwords and keys are created once and kept: redeploys never change them. To set a value the example cannot hold (an API key of a third party), edit the env file on the box; provision keeps it.

Behind the SSO the signed-in person arrives in the request headers `X-authentik-username`, `X-authentik-email`, `X-authentik-name`, `X-authentik-groups` and `X-authentik-uid`. Access is the users group (`AUTHENTIK_APP_GROUP`, `ihc-users` by default); narrower access is a policy binding in Authentik, by hand for now.

Migrations: the app runs its own at start (`database.migrations_command` is documentation for now; the executor does not run it).

## MCP

Layer 1 of the cloud's agent interface: an app that declares `mcp` in `company-app.yaml` gets its tools into the cloud's MCP gateway ([`mcp-gateway.md`](mcp-gateway.md)), where a person signed in with the company account uses them from Claude Code or claude.ai. `ihc-app new` starts every app with the section and a working `ping` tool (`templates/app/server.js`). Delete the section and the app stays out of the gateway; nothing else changes.

| Field | Default | Rule |
|---|---|---|
| `mcp.audience` | `<slug>.mcp` | starts with `<slug>.`: the actor JWT's `aud` for this app |
| `mcp.tools_path` | `/mcp/tools` | a path on the app's container |
| `mcp.execute_path` | `/mcp/tools/{tool}/execute` | a path on the app's container, with `{tool}` |
| `mcp.scopes` | (required) | a map `scope: [groups]`; every scope starts with `<slug>.`; at least one, each granted to at least one group (Authentik groups: `ihc-users`, `ihc-admins`, or any group you create) |
| `mcp.enabled` | `true` | `false` keeps the section and leaves the app out |

Write the lists one item per line (`- ihc-users`), not `[ihc-users]`: on a box without PyYAML the executor's own reader takes only block lists.

**What the gateway does.** It reaches the app on the cloud network, `http://<slug>:<runtime.port>`, never through the proxy. For each person it computes the scopes of `mcp.scopes` granted to that person's groups; with none, the app is never called for them and its tools do not show. Otherwise:

- `GET <tools_path>` → the app answers `{"tools": [{"name": "ping", "description": "…", "input_schema": {"type": "object", …}, "access": "read"}]}`. Names: letters, digits, `_` and `-`, up to 64; the gateway shows them as `<slug>__<name>`. The app may list only the tools the person's scopes allow, or answer `403` when there is none.
- `POST <execute_path>` with `{"arguments": {…}}` → `{"result": <any JSON>}`. Errors: `403` (no access), `404` (no such tool), `400` (bad arguments), each with `{"error": {"code": "…", "message": "…"}}`; the message reaches the person. A `5xx` or a timeout (10 s to list, 30 s to call) counts as the app being down.

Every request carries `Authorization: Bearer <actor JWT>` and `X-Request-ID`.

**What the app must check**, on every request to those two paths, before anything else (the template does all of it with `node:crypto`, no library):

1. A bearer token is present and is a JWT with `alg` `RS256` and a `kid`.
2. Its signature verifies with the key of that `kid` in the gateway's JWKS, `IHC_MCP_JWKS_URL`. Cache the JWKS (5 minutes); fetch it again when a new `kid` arrives.
3. `iss` is `IHC_MCP_ISSUER`, `aud` is (or contains) `IHC_MCP_AUDIENCE`, `exp` is in the future (30 s of leeway).
4. `scope` (space separated) holds the scope the tool needs; otherwise `403`.
5. The person is `email` (also in `sub`), with `groups`: apply the app's own rules (what this person may see) to the data, as the app does for a browser user with `X-authentik-email`.

Answer `401` when any of 1 to 3 fails. Keep the tools read only in this layer.

Example, a tool that lists the person's own records, next to `ping` in `TOOLS` of `server.js`:

```js
list_my_expenses: {
  scope: `${slug}.read`,
  description: "Lists the caller's expenses of the last 30 days.",
  input_schema: { type: "object", properties: { category: { type: "string" } }, additionalProperties: false },
  run: async (actor, args) => ({
    expenses: (await db.query(
      "SELECT day, description, amount FROM expenses WHERE owner = $1 AND ($2::text IS NULL OR category = $2) ORDER BY day DESC LIMIT 100",
      [actor.email, args.category ?? null])).rows,
  }),
},
```

A second scope for a narrower group, granted in the manifest:

```yaml
mcp:
  scopes:
    expenses.read:
      - ihc-users
    expenses.report:
      - finance
```

and `scope: "expenses.report"` on the tool that only `finance` may call.

## Required Rules

Checked by `ihc-app provision`, each failure with the fix in the message:

- `schema_version` is `1`.
- `app.slug` has 3 to 32 lowercase letters, digits and hyphens, is not a name the platform uses, and equals the repository name.
- `app.name` and `app.owner_email` are present.
- `runtime.type` is `docker-compose`, `deploy.enabled` is `true`, the compose file exists and has `runtime.service`.
- `runtime.healthcheck` is `http` with a path; the app answers it with `expected_status` within four minutes of starting.
- `deploy.port` is `auto`. The app publishes no host port; the overlay drops any it declares.
- `deploy.domain`, when present, is `<slug>.<BASE_DOMAIN>`.
- `mcp`, when present, follows [MCP](#mcp): audience and scopes start with the slug, the paths are paths with `{tool}` in `execute_path`, every scope is granted to a group.
- **No local infrastructure**: no compose service runs Postgres, Redis or an S3 server (by image or by name), and the manifest declares no local one. Use `database`, `dependencies.redis` and `object_storage` instead.
- No host networking, no privileged mode, no mounted Docker socket.

By convention, not checked: `.env.example` exists and holds no real secret.

Not enforced by the executor yet: `infrastructure.exception` (refused: an app that needs its own database is deployed by hand until the portal reviews exceptions), `auth.allowed_domains`, `checks.*`.

## Non-Deployable Repository

Documentation or contract-only repositories can declare:

```yaml
runtime:
  type: documentation

deploy:
  enabled: false
  reason: No deployable app.
```

and carry no `.gitea/workflows/deploy.yml`.
