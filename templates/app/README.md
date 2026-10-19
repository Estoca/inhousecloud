# __APP_NAME__

Internal app on the company cloud. Owner: __OWNER_EMAIL__. URL: http://__APP_DOMAIN__ (behind the company sign-in; `/health` is public).

## Change it

Edit `server.js` (or replace it: any language works if the `Dockerfile` builds it). Keep:

- listen on `PORT` (8080) and answer `GET /health` with 200;
- data in `DATABASE_URL` (Postgres, starts empty: create tables on start), cache in `REDIS_URL` with every key under `REDIS_PREFIX`;
- the signed-in person from the `X-authentik-email`, `X-authentik-name`, `X-authentik-username`, `X-authentik-groups` headers; no login page;
- relative links (`/items`, not `http://localhost:8080/items`).

Never add `postgres`, `redis` or object storage services, the Docker socket or host networking to `docker-compose.yml`: the deploy refuses them. Do not edit `.gitea/workflows/deploy.yml`.

## Deploy

Commit and push to `main`. That is the whole deploy. The workflow in `.gitea/workflows/deploy.yml` runs on the box:

1. checks out the commit;
2. `harness-app provision __APP_SLUG__` validates `company-app.yaml` and the compose file, then makes sure of the app's database and role on the shared Postgres, its Redis user and `__APP_SLUG__:` key prefix, its env file, the route `__APP_DOMAIN__` and the SSO application;
3. builds and starts the app on the harness network;
4. waits for `/health` through the proxy.

Check it: the run is green in the repository's Actions tab, `curl http://__APP_DOMAIN__/health` answers 200, and `/` sends an anonymous visitor to the sign-in. When a run fails, its log says what to change; the harness's `docs/llm-bootstrap.md`, section 4, lists the usual causes.

## Configuration the app receives

`PORT`, `APP_SLUG`, `APP_BASE_URL`, `DATABASE_URL` (and `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), `REDIS_URL`, `REDIS_PREFIX`, and with `object_storage.required: true` the `S3_*` variables (below). New variables: add the name to `.env.example`; values that are not secrets can go in `docker-compose.yml` under `environment:`.

## Files: object storage

For files (uploads, exports, images), set `object_storage.required: true` in `company-app.yaml`. The deploy gives the app its own bucket and a key that can only use it: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE=true`, and `S3_PUBLIC_ENDPOINT` for links a browser opens. Any S3 client works; with the AWS SDK (`npm install @aws-sdk/client-s3`):

```js
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
});
await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: "hello.txt", Body: "hello" }));
const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: "hello.txt" }));
console.log(await obj.Body.transformToString());
```

The bucket already exists; the key cannot create, list or delete buckets. Small files the app keeps for itself can also go in `DATA_DIR` (`/data`).

## Run it on your machine

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:8080/health
```

Locally there is no database or Redis unless you start them yourself; `LOCAL_AUTH_MOCK_EMAIL` stands in for the sign-in on `/me`.
