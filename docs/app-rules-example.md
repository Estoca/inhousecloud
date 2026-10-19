# Example App-Building Rules For Coding Agents

This document is a generalized example of the kind of `rules.md` a company can publish for coding agents that build internal apps.

The goal is to give agents one live source of truth before they create repositories, manifests, Docker Compose files, or deploy workflows.

In a real installation, serve this document from the app portal, for example:

```text
GET https://apps.company.example/api/agent/rules.md
GET https://apps.company.example/api/agent/rules.json
```

Agents should read the live rules before looking at old app repositories. Existing apps often contain legacy exceptions, stale workflows, fixed ports, or one-off deploy behavior.

## Required Agent Workflow

1. Read the live `rules.md`.
2. Read the official app template.
3. Read the manifest schema before creating or editing `company-app.yaml`.
4. Keep the repository where it already lives if the harness supports that source.
5. Create or update `company-app.yaml` at the repo root.
6. Create or update `docker-compose.yml`.
7. Create or update `.env.example`.
8. Never commit the real `.env`.
9. Validate the manifest, Compose file, env example, and healthcheck before pushing.
10. Fix every failed check before pushing to `main`.
11. Treat a push to `main` as the deploy: it is the approval, for the first deploy and every later one.
12. When a deploy fails, read the run log in the repository's Actions tab; it says which rule or step failed and what to change.

## Supported Repository Sources

- Company Git server repositories are supported.
- GitHub repositories are supported when the harness has a CI/image/deploy path for them.
- Do not migrate repositories just to fit a single deployment mechanism.
- All repositories must follow the same manifest, Compose, env, healthcheck, auth, and deploy-event contract.

## Official Template Rule

Use the official template before copying from another app.

Example:

```text
GET https://apps.company.example/api/agent/app-template.md
git clone https://git.company.example/platform/company-app-template.git
```

Existing app repositories may contain:

- older auth patterns;
- fixed port exceptions;
- custom proxy rules;
- stale CI workflows;
- app-local databases or caches that should now be shared services.

Use them for product context, not as the deployment source of truth.

## Manifest Contract

Every deployable app should include a manifest like:

```yaml
schema_version: 1

app:
  slug: example-app
  name: Example App
  owner_email: owner@company.example

runtime:
  type: docker-compose
  compose_file: docker-compose.yml
  service: app
  healthcheck:
    type: http
    path: /health
    expected_status: 200

deploy:
  enabled: true
  domain: example-app.company.example
  port: auto
  env_file: .env
  env_example: .env.example

auth:
  required: true
  provider: forward-auth
  allowed_domains:
    - company.example
```

## Docker Compose Rules

Compose should be deployable on the runtime host and valid in CI.

Recommended pattern:

```yaml
services:
  app:
    build: .
    network_mode: bridge
    env_file:
      - ${COMPANY_ENV_FILE:-.env}
    ports:
      - "${APP_PORT:-8080}:8080"
    environment:
      COMMIT_SHA: ${COMMIT_SHA:-local}
```

Rules:

- Single-service apps should usually use one main `app` service.
- Production Compose files should be small.
- Use shared company infrastructure instead of app-local Postgres, Redis, object storage, auth, reverse proxy, queues, workers, or caches unless an approved exception exists (the executor refuses them today).
- CI should validate with the example env file, for example `COMPANY_ENV_FILE=.env.example`.
- Production deploy uses the persistent env file the executor writes in the install directory (`apps/<slug>/.env`), not a temporary CI checkout file.

## Healthcheck Rules

Every deployable app must expose an HTTP healthcheck.

Recommended response:

```json
{
  "ok": true,
  "service": "example-app",
  "commit_hash": "abc1234"
}
```

The healthcheck should:

- return a non-2xx status when the app is not ready;
- include build or commit metadata when available;
- avoid exposing secrets, connection strings, tokens, or private customer data.

## Auth Rules

Internal apps should be protected by the shared auth gateway by default.

Recommended default:

```yaml
auth:
  required: true
  provider: forward-auth
```

Apps can trust identity headers only from the reverse proxy/auth gateway path. Local development can use explicit local-only mock users, but mock auth must never be enabled in production.

## Deploy Flow

Publication happens by push to `main`, not tokens pasted in chat and not a separate request.

1. Push to `main` of the app's repository in the company organization.
2. The deploy workflow (`.gitea/workflows/deploy.yml`, from the template) runs on the box.
3. `harness-app provision <slug>` validates the manifest and Compose file and creates or confirms the database, cache user, bucket, env file, route, SSO application and inventory record.
4. The workflow builds and starts the app and waits for its healthcheck through the proxy.
5. A failed step fails the run with the reason; fix it and push again.

## MUST

- Include `company-app.yaml`.
- Include `docker-compose.yml`.
- Include `.env.example`.
- Keep the real `.env` only on the deploy machine or in approved secret storage.
- Declare an owner.
- Expose an HTTP healthcheck.
- Require auth for internal apps unless an exception is approved.
- Use automatic port allocation unless an exception is approved.
- Prefer shared Postgres, Redis, object storage, auth, proxy, and queues.
- Declare database migrations when the app owns database schema.
- Isolate shared databases and caches by app.
- Validate before pushing to `main`.

## SHOULD

- Use one clear main service.
- Keep logs and errors actionable.
- Include README instructions to run, validate, and deploy.
- Include tests or a smoke-test command.
- Expose build or commit metadata.
- Use consistent service names and environment variable names.
- Keep production Compose files focused on production runtime only.
- Document any exception in the app's README and `company-app.yaml`.

## NICE TO HAVE

- Recommended stacks by app type.
- UI theme or design-system bootstrap instructions.
- App-specific admin bootstrap convention.
- Agent checks that review Compose quality, migrations, auth, security, and logs.
- A build info page with commit, version, deploy time, and changelog.

## MUST NOT

- Do not commit real `.env` files.
- Do not expose tokens, passwords, or credentials in logs.
- Do not ask users to paste platform deploy tokens into chat.
- Do not deploy production from pull request events.
- Do not run untrusted pull request code with deploy credentials.
- Do not delete production data automatically.
- Do not run `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, broad deletes, `FLUSHALL`, or `FLUSHDB` automatically.
- Do not access another app's database, schema, bucket, queue, or cache namespace.
- Do not create app-local databases, caches, proxies, or auth services unless the app genuinely needs them and the exception is approved.
- Do not choose a fixed port without justification.
- Do not ignore a failing healthcheck.

## Why This Rules File Matters

The app template gives agents a starting shape. The live rules tell them what the current company platform expects.

This makes the deploy path teachable:

- agents can build apps that pass checks on the first try;
- humans can review a standard shape instead of one-off infrastructure;
- production credentials stay on the box, in the install directory;
- the executor in the deploy job has a clear contract to enforce.
