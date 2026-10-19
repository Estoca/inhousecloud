# __APP_NAME__

Internal app on the company cloud. Owner: __OWNER_EMAIL__. URL: http://__APP_DOMAIN__ (behind the company sign-in; `/health` is public).

## Change it

Edit `server.js` (or replace it: any language works if the `Dockerfile` builds it). Keep:

- listen on `PORT` (8080) and answer `GET /health` with 200;
- data in `DATABASE_URL` (Postgres, starts empty: create tables on start), cache in `REDIS_URL` with every key under `REDIS_PREFIX`;
- the signed-in person from the `X-authentik-email`, `X-authentik-name`, `X-authentik-username`, `X-authentik-groups` headers; no login page;
- relative links (`/items`, not `http://localhost:8080/items`).

Never add `postgres`, `redis` or `minio` services, the Docker socket or host networking to `docker-compose.yml`: the deploy refuses them. Do not edit `.gitea/workflows/deploy.yml`.

## Deploy

Commit and push to `main`. That is the whole deploy. The workflow in `.gitea/workflows/deploy.yml` runs on the box:

1. checks out the commit;
2. `harness-app provision __APP_SLUG__` validates `company-app.yaml` and the compose file, then makes sure of the app's database and role on the shared Postgres, its Redis user and `__APP_SLUG__:` key prefix, its env file, the route `__APP_DOMAIN__` and the SSO application;
3. builds and starts the app on the harness network;
4. waits for `/health` through the proxy.

Check it: the run is green in the repository's Actions tab, `curl http://__APP_DOMAIN__/health` answers 200, and `/` sends an anonymous visitor to the sign-in. When a run fails, its log says what to change; the harness's `docs/llm-bootstrap.md`, section 4, lists the usual causes.

## Configuration the app receives

`PORT`, `APP_SLUG`, `APP_BASE_URL`, `DATABASE_URL` (and `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `REDIS_URL`, `REDIS_PREFIX`, and with `object_storage.required: true` the `S3_*` variables. New variables: add the name to `.env.example`; values that are not secrets can go in `docker-compose.yml` under `environment:`.

## Run it on your machine

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:8080/health
```

Locally there is no database or Redis unless you start them yourself; `LOCAL_AUTH_MOCK_EMAIL` stands in for the sign-in on `/me`.
