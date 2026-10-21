# GitOps Flow

How an app gets from a folder on someone's laptop to a URL behind the company sign-in. There is no deploy request, no orchestrator and no operator in between: **a push to `main` of the app's repository is the approval**, and Gitea Actions on the box itself does the deploy.

```text
ihc-app new <slug>        repository from templates/app, created in the Gitea organization
        │
git push origin main          the approval: who can push to main decides what runs
        │
Gitea Actions (gitea-deployer runner, label ihc-deploy, on the box)
  1. ihc-app checkout                   the pushed commit
  2. ihc-app provision <slug>           database, Redis, env file, route, SSO, inventory
  3. docker compose up -d --build           on the ihc network, no host port
  4. ihc-app wait <slug>                the manifest's healthcheck, through the proxy
        │
https://<slug>.<BASE_DOMAIN>                behind forward auth; /health public
```

## 1. Create the app

On the box, or anywhere with a Gitea token:

```bash
scripts/ihc-app.sh new expense-report --owner maria@example.com --install-dir /opt/inhousecloud
cd expense-report
```

It copies [`templates/app`](../templates/app) (a runnable Node app, `company-app.yaml`, `docker-compose.yml`, `.env.example`, `.gitea/workflows/deploy.yml`), fills in the slug, name, owner and `<slug>.<BASE_DOMAIN>`, makes the first commit on `main`, creates the private repository `<org>/<slug>` through the Gitea API with Actions enabled, and sets it as `origin`. Away from the box it reads `IHC_GITEA_URL`, `IHC_GITEA_TOKEN` (the person's own token, with repository write), `IHC_GITEA_ORG` and `IHC_BASE_DOMAIN` from the environment instead of the install's `.env`. `--push` pushes right away.

The slug is the repository name, the hostname, the Compose project, the network alias and the base of every resource name. It is 3 to 32 lowercase letters, digits and hyphens; names the platform uses (`portal`, `git`, `auth`, `postgres`, `redis`, the other Compose services, `app-*`, `ihc-*`) are refused.

Then build the app with the coding agent of your choice. The contract it must keep is [`app-contract.md`](app-contract.md).

## 2. Push to main

```bash
git push -u origin main
```

That is the deploy. There is nothing else to request or approve: whoever can push to `main` of a repository in the organization can put that repository on the air. Control it where it belongs, in Gitea: organization membership, team permissions and branch protection on `main` (required reviews, if the team wants a second pair of eyes before a deploy). Pull requests run whatever CI the repository declares on the CI runner, never the deploy.

## 3. What the deploy job does

The workflow in the template ([`templates/app/.gitea/workflows/deploy.yml`](../templates/app/.gitea/workflows/deploy.yml)) has four steps, each readable on its own:

1. **`ihc-app checkout`** fetches the pushed commit from Gitea over the internal network with the job's own token (through `GIT_ASKPASS`, never in a URL).
2. **`ihc-app provision <slug>`** is the executor. It refuses before changing anything when the manifest or the compose file breaks a rule, then makes sure, idempotently, of:
   - a valid manifest whose slug is the repository name and the argument;
   - a compose file that brings no Postgres, Redis or S3 server of its own (the rule below);
   - with `database.required: true`, a database `app_<slug>` owned by a role `app_<slug>` on the shared Postgres: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, random password, `CONNECT` and `TEMPORARY` revoked from `PUBLIC`;
   - with `dependencies.redis.required: true`, a Redis ACL user `app-<slug>` that can only touch keys and channels under `<slug>:`, persisted in the ACL file the shared Redis loads at start;
   - with `object_storage.required: true` and the `storage` profile on, a bucket `app-<slug>` on Garage and an access key `app-<slug>` that reads and writes that bucket only (never Garage's RPC secret or admin token; [`scripts/lib/garage.sh`](../scripts/lib/garage.sh)); with the profile off, a clear failure before anything changes;
   - `<install-dir>/apps/<slug>/.env`, mode `0600`, with `PORT`, `APP_SLUG`, `APP_BASE_URL`, `DATABASE_URL` and `PG*`, `REDIS_URL` and `REDIS_PREFIX`, `S3_*`, plus the keys of the app's `.env.example` it does not have yet (`LOCAL_*` keys excluded). Existing values are kept: a second run never changes a password;
   - `<install-dir>/apps/<slug>/compose.ihc.yml`, an overlay that puts every service of the app on the ihc network (the main one with the alias `<slug>`), drops published host ports and points `env_file` at the file above;
   - an Authentik proxy provider `app-<slug>` (forward auth, single application, the healthcheck path skipped), an application `<slug>` bound to the users group (`AUTHENTIK_APP_GROUP`), and the provider added to the embedded outpost;
   - the proxy host `<slug>.<BASE_DOMAIN>` to `<slug>:<runtime.port>` with the same forward-auth snippet as the portal (from [`scripts/lib/sso.sh`](../scripts/lib/sso.sh), shared with `first-run.sh`), the healthcheck path left public;
   - the app in `<install-dir>/inventory.json` under `apps.<slug>`: name, owner, URL, repository, last commit, the resources above, `created_at` on the first run and `provisioned_at` on every run.
3. **`docker compose -p <slug> -f docker-compose.yml -f <install-dir>/apps/<slug>/compose.ihc.yml up -d --build`** builds and starts the app.
4. **`ihc-app wait <slug>`** polls the manifest's healthcheck through the proxy until it answers the expected status, then checks that an anonymous `GET /` is sent to the Authentik sign-in. If the container exits or the time runs out it fails the job with the status it got, the container's state and the last 40 lines of its log.

The job is the record: who pushed, which commit, what each step printed, in the repository's Actions tab. The portal reads those runs; nobody writes to it.

`provision` never deletes a database, role, bucket, ACL user, route or Authentik object, and never takes over what it did not create: a slug registered in `inventory.json` for another repository, or a proxy host for `<slug>.<BASE_DOMAIN>` that points somewhere else, stops the job with nothing changed. Removing an app is a human's job, by hand.

## The rule: no local infrastructure

Apps built inside the cloud use the shared Postgres, Redis and object storage; they do not bring their own. `provision` refuses, with the alternative in the message:

- a compose service whose image is `postgres` (or `postgis`, `timescaledb`, `pgvector`), `redis` (or `valkey`, `keydb`, `redis-stack`) or an S3 server, or a service named like one;
- a manifest that declares a local one (`database.shared: false`, `dependencies.<redis|postgres|s3>.shared: false`, a `provider: local...`);
- `infrastructure.exception`: exceptions need a review the executor cannot do; such an app is deployed by hand until the portal reviews them.

It also refuses host networking, privileged mode and a mounted Docker socket.

The point is that the box's data lives in one place, is backed up by one job and is visible in one inventory. On the first box the shared services existed and nothing used them: every app came with its own database.

## The runners

The core runs two `act_runner` daemons ([`docker/compose.yml`](../docker/compose.yml)); `install.sh` renders their configuration into `<install-dir>/runner/`:

| | `gitea-runner` | `gitea-deployer` |
|---|---|---|
| Label | `ubuntu-latest` (`GITEA_RUNNER_LABELS`) | `ihc-deploy` |
| Registered for | the whole instance | the organization `GITEA_ORGANIZATION` only |
| Job image | `node:22-bookworm` | `<project>-deployer:local`, built from [`docker/deployer`](../docker/deployer/Dockerfile) with this checkout's scripts |
| Docker socket in jobs | no | yes (`DOCKER_SOCKET`, the host path: `$XDG_RUNTIME_DIR/docker.sock` under rootless Docker) |
| Network | a fresh one per job | the ihc network: `postgres`, `redis`, `proxy`, `gitea`, `authentik-server` by name |
| Install directory | no | mounted at the same path, `IHC_INSTALL_DIR` set |
| Capacity | 2 | 1 (deploys run one at a time) |

What the deploy runner needs, and why: the socket to build and start containers; the ihc network to reach the services by name (`IHC_ENDPOINTS=internal` tells `ihc-app` to use `http://authentik-server:9000`, `http://gitea:3000` and `http://proxy:81` instead of the loopback control ports); the install directory at the same path, because `.env` holds the credentials `provision` uses and because Compose reads the app's env file and overlay by host path. `force_pull: false` lets it use the locally built image. The deployer image is rebuilt on every `install.sh` foundation run, so it follows the cloud checkout: after updating the cloud, run `install.sh --apply --from foundation`.

**A job on the deploy runner is root on the box.** The Docker socket alone is root-equivalent, and the job can read every secret in `.env`. That is acceptable only because the runner serves the organization's repositories and nothing else: anyone with write access to a repository in the organization can deploy, and anyone who can push a workflow that says `runs-on: ihc-deploy` can run anything on the box. Give write access in the organization to people you would give a shell on the box. Gitea asks for approval before running workflows from forks of first-time contributors; do not approve a fork's run that touches `.gitea/workflows`.

## Why there is no deploy request

The first box started with a deploy-request repository: a pull request with `requests/<slug>.yaml`, merged as the approval, a workflow posting it to an orchestrator API, and a terminal-connected operator agent on the box that turned the request into containers, routes and SSO. It worked, and it was retired:

- the approval was already there: the merge in the deploy-request repository approved a change someone had already pushed to the app repository, and the app's own `main` is where review happens;
- the write API that received deploy events let anyone with a token repoint any domain; removing it removed that class of bug ([`install-design.md`](install-design.md), "The Portal");
- the operator's steps were the same every time, so they became a script that runs in the job, and the job log replaced the operator's report.

`install.sh` therefore no longer creates a `deploy-requests` repository (`first-run.sh` creates `<org>/ihc-smoke` for the authenticated-clone smoke test instead); one left by an older install is kept and can be archived by hand. The `templates/gitops-request` template and `schemas/deploy-request.schema.json` are gone.

## Proving it

Smoke test 16 ([`smoke-tests.md`](smoke-tests.md)) does the whole loop with the template app `smoke-app`: creates it (or clones it when it exists), pushes a commit to `main`, waits for the run, checks `/health` through the proxy, the redirect of `/` to Authentik, and the database and role on the shared Postgres, redeploys it, then removes it with `ihc-app remove` (it is the test's own: `kind: system-test`). Times from a clean VM are in [`first-run.md`](first-run.md).
