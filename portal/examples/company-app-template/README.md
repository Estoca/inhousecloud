# Company App Template

Starting point for an internal app published at `<slug>.<BASE_DOMAIN>` (for a local
install, `*.cloud.localhost`). Use it instead of copying deploy patterns from an
existing app: older apps may carry exceptions or workflows that no longer apply.

## Minimal contract

Every deployable app keeps at its root:

- `company-app.yaml`
- `docker-compose.yml`
- `.env.example`
- `README.md`
- an HTTP `/health` endpoint

For internal apps `auth.required` is `true` and `auth.provider` is `authentik`.

## Create an app from the template

1. Copy these files into the new repository.
2. Replace `company-app-template` with the app slug.
3. Replace `template.cloud.localhost` with `<slug>.<BASE_DOMAIN>`.
4. Set `owner_email`.
5. Add the variables the app needs to `.env.example`, never with real secret values.
6. Run the checks below.
7. Push to `main` in the cloud's Gitea: the push is the approval, and the deploy job
   provisions and starts the app.

## Run locally

```bash
cp .env.example .env
docker compose up --build
```

Health check:

```bash
curl http://localhost:8100/health
```

`/health` returns JSON with `ok: true` and `commit_hash`, read from
`COMMIT_SHA`/`GIT_SHA`. The deploy workflow exports `COMMIT_SHA`; keep it passed
through in `docker-compose.yml`.

Local mock user:

```bash
curl http://localhost:8100/me
```

In local development, do not run or simulate the SSO flow. Set
`LOCAL_AUTH_MOCK_EMAIL` and `LOCAL_AUTH_MOCK_NAME` in `.env` to test screens that
need a user. In production the app reads the `X-authentik-*` headers sent by the
proxy, and `LOCAL_AUTH_MOCK_*` must not be set.

## Validate

From the portal repository:

```bash
node ../../src/cli.js validate ./company-app.yaml
APP_ENV_FILE=.env.example docker compose config
```
