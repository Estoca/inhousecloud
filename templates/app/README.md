# __APP_NAME__

Internal app on the company cloud. Owner: __OWNER_EMAIL__.

## Run it on your machine

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:8080/health
```

## Deploy

Push to `main`. The workflow in `.gitea/workflows/deploy.yml` runs on the box:

1. checks out the commit;
2. `harness-app provision __APP_SLUG__` validates `company-app.yaml` and the compose file, and makes sure the app has its database and role on the shared Postgres, its Redis user and `__APP_SLUG__:` key prefix, its env file, the route `__APP_DOMAIN__` and the SSO application;
3. builds and starts the app on the harness network;
4. waits for `/health` through the proxy.

The app answers at `__APP_DOMAIN__`, behind the company sign-in. `/health` stays public.

Configuration the app receives: `PORT`, `APP_BASE_URL`, `DATABASE_URL` (and `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `REDIS_URL`, `REDIS_PREFIX` (prefix every key with it), and with `object_storage.required: true` the `S3_*` variables. The signed-in user arrives in the `X-authentik-email`, `X-authentik-name`, `X-authentik-username` and `X-authentik-groups` headers.

Do not add `postgres`, `redis` or `minio` services to `docker-compose.yml`: the deploy refuses them. The cloud provides them.
