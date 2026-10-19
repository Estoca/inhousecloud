# App Contract

`company-app.yaml` is the operational contract for a deployable internal app. `harness-app provision` ([`gitops-flow.md`](gitops-flow.md)) reads it on every push to `main` and refuses to deploy when it breaks a rule below; [`templates/app`](../templates/app) starts every new app with a valid one. Schema: [`schemas/company-app.schema.json`](../schemas/company-app.schema.json).

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
  domain: example-app.harness.localhost   # optional; always <slug>.<BASE_DOMAIN>
  port: auto                       # no host port: the proxy reaches the app on the harness network
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
  required: false                  # bucket on the shared MinIO (storage profile)

checks:
  build_command: docker compose build
  test_command: npm test
```

## What the app receives

`harness-app provision` writes `<install-dir>/apps/<slug>/.env` (mode `0600`, never in Git) and the deploy hands it to every service of the app:

| Variable | When | Value |
|---|---|---|
| `PORT` | always | `runtime.port` |
| `APP_SLUG`, `APP_BASE_URL` | always | the slug, `<scheme>://<slug>.<BASE_DOMAIN>` |
| `DATA_DIR` | always | `/data`: the host directory `<install-dir>/app-data/<slug>`, mounted in the main service, backed up with the install directory and visible to admins in the ops file browser. Written as the container's root user (rootless Docker: the host user); an image that runs as another user must make `/data` writable for it |
| `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | `database.required` | database and role `app_<slug>` on `postgres:5432` |
| `REDIS_URL`, `REDIS_PREFIX` | `dependencies.redis.required` | ACL user `app-<slug>` on `redis:6379`, prefix `<slug>:` (every key and channel must start with it) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | `object_storage.required` | bucket and user `app-<slug>` on `minio:9000` |
| keys of `.env.example` | when absent | the example's value; `LOCAL_*` keys are for a laptop and never reach the box |

Passwords are created once and kept: redeploys never change them. To set a value the example cannot hold (an API key of a third party), edit the env file on the box; provision keeps it.

Behind the SSO the signed-in person arrives in the request headers `X-authentik-username`, `X-authentik-email`, `X-authentik-name`, `X-authentik-groups` and `X-authentik-uid`. Access is the users group (`AUTHENTIK_APP_GROUP`, `harness-users` by default); narrower access is a policy binding in Authentik, by hand for now.

Migrations: the app runs its own at start (`database.migrations_command` is documentation for now; the executor does not run it).

## Required Rules

Checked by `harness-app provision`, each failure with the fix in the message:

- `schema_version` is `1`.
- `app.slug` has 3 to 32 lowercase letters, digits and hyphens, is not a name the platform uses, and equals the repository name.
- `app.name` and `app.owner_email` are present.
- `runtime.type` is `docker-compose`, `deploy.enabled` is `true`, the compose file exists and has `runtime.service`.
- `runtime.healthcheck` is `http` with a path; the app answers it with `expected_status` within four minutes of starting.
- `deploy.port` is `auto`. The app publishes no host port; the overlay drops any it declares.
- `deploy.domain`, when present, is `<slug>.<BASE_DOMAIN>`.
- **No local infrastructure**: no compose service runs Postgres, Redis or MinIO (by image or by name), and the manifest declares no local one. Use `database`, `dependencies.redis` and `object_storage` instead.
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
