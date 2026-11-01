# GitOps Flow

How an app gets from a folder on someone's laptop to a URL behind the company sign-in. There is no deploy request, no orchestrator and no operator in between: **a push to `main` of the app's repository is the approval**, and Gitea Actions on the box itself does the deploy.

```text
ihc-app new <slug>        repository from templates/app, created in the Gitea organization
        │
git push origin main          the approval: who can push to main decides what runs
        │
Gitea Actions (gitea-deployer runner, label ihc-deploy, on the box)
  1. ihc-app checkout                   the pushed commit
  2. ihc-app build <slug>               a release: the commit's files and images, tagged per release;
                                        no cloud credentials, nothing that runs changes
  3. ihc-app apply <slug>               the reconciler, under the app's lock, head of main only:
                                        journal first, then provision (database, Redis, env file,
                                        route, SSO, inventory), start the release's images on the
                                        ihc network, the manifest's healthcheck through the proxy
        │
https://<slug>.<BASE_DOMAIN>                behind forward auth; /health public

ihc-app rollback <slug>               on the box: back to the release the newest deploy replaced
ihc-app journal <slug>                what every apply and rollback changed (also in the portal)
```

## 1. Create the app

On the box, or anywhere with a Gitea token:

```bash
scripts/ihc-app.sh new expense-report --owner maria@example.com --install-dir /opt/inhousecloud
cd expense-report
```

It copies [`templates/app`](../templates/app) (a runnable Node app, `company-app.yaml`, `docker-compose.yml`, `.env.example`, `.gitea/workflows/deploy.yml`), fills in the slug, name, owner and `<slug>.<BASE_DOMAIN>`, makes the first commit on `main`, creates the private repository `<org>/<slug>` through the Gitea API with Actions enabled, and sets it as `origin`. Away from the box it reads the person's own `IHC_GITEA_URL` and `IHC_GITEA_TOKEN` from the environment instead of the install's `.env` ([From a laptop](#from-a-laptop)). `--push` pushes right away. For an app that already exists in a folder, `ihc-app init` instead (below).

The slug is the repository name, the hostname, the Compose project, the network alias and the base of every resource name. It is 3 to 32 lowercase letters, digits and hyphens; names the platform uses (`portal`, `git`, `auth`, `postgres`, `redis`, the other Compose services, `app-*`, `ihc-*`) are refused.

Then build the app with the coding agent of your choice. The contract it must keep is [`app-contract.md`](app-contract.md).

## 2. Push to main

```bash
git push -u origin main
```

That is the deploy. There is nothing else to request or approve: whoever can push to `main` of a repository in the organization can put that repository on the air. Control it where it belongs, in Gitea: organization membership, team permissions and branch protection on `main` (required reviews, if the team wants a second pair of eyes before a deploy). Pull requests run whatever CI the repository declares on the CI runner, never the deploy.

## From a laptop

The usual case: someone had a coding agent write an app on their own computer, it runs there, and now it should be on the company cloud. Nothing has to happen on the box and nobody needs `ssh` to it: the code arrives by `git push`, like every deploy.

What the person needs, once ([`first-user.md`](first-user.md)):

- a Gitea account (the first "Sign in with authentik" at `http://git.<BASE_DOMAIN>`) in the organization's team `ihc-users`, which the install creates with write access and **Create repositories** ([`first-user.md`](first-user.md));
- a personal token, Gitea > Settings > Applications, with **organization** and **repository** Read and Write, kept in the environment as `IHC_GITEA_TOKEN`;
- with `local` ingress, the port-80 tunnel to the box kept open ([`llm-bootstrap.md`](llm-bootstrap.md#16-report-the-install)): the `*.localhost` names, Gitea's included, answer only through it;
- a copy of this repository on the laptop, for `scripts/ihc-app.sh` (it needs `git`, `curl` and `python3`; not Docker, see [No Docker on the laptop](#no-docker-on-the-laptop)).

Then, in the app's folder:

```bash
export IHC_GITEA_URL=http://git.cloud.localhost      # IHC_GITEA_TOKEN is already set
~/inhousecloud/scripts/ihc-app.sh init room-booking --port 8000 --push
```

`ihc-app init` adopts the project as it is: it never edits the app's code or a compose file the project already has. It refuses before writing anything when the project cannot run on the cloud (no `Dockerfile` and no compose file; a compose file with its own Postgres, Redis or S3 server, with the alternative), then adds only what is missing:

| File | When | What |
|---|---|---|
| `company-app.yaml` | always, unless present | the template's manifest with the slug, owner (`git config user.email`, or `--owner`), domain, the compose service and port (`--port`, else the compose file's, else 8080), `--health` (default `/health`); no `mcp` section, since the app serves no tools yet |
| `.gitea/workflows/deploy.yml` | unless present | the template's deploy job |
| `docker-compose.yml` | only when there is no compose file | one service, `build: .`, the port, the env file optional so it also runs on the laptop |
| `Dockerfile` | only for a Node project without one | `npm install`, `npm start`; any other language brings its own |
| `.env.example` | unless present | `PORT` |
| `.gitignore` | adds what is missing | `.env` and local database files (`*.db`, `*.sqlite`, `*.sqlite3`): the cloud gives the app a fresh database |

It runs `git init` on `main` when the folder is not a repository (and commits everything not ignored), or commits only the files it added when it is; creates the private `<org>/<slug>` with Actions on; and adds it as the remote `origin`, or `cloud` when `origin` already points elsewhere. `--push` pushes the current commit to `main`: the deploy. The token reaches `git` through `GIT_ASKPASS`, never in a URL or `.git/config`. Run twice, it changes nothing. The organization is the one the token belongs to (when the token can list them) or `company`; `IHC_GITEA_ORG` and `IHC_BASE_DOMAIN` override.

What `init` cannot do is change the code, so before the push the app must, as on the box: listen on `0.0.0.0` and `PORT` (a laptop app often binds `127.0.0.1` and a fixed port); answer `GET /health` with 200; keep its data in `DATABASE_URL` (Postgres, created empty) or under `DATA_DIR` (`/data`), never in a file next to the code, which a redeploy throws away; read the person from `X-authentik-email` ([`app-contract.md`](app-contract.md)). A laptop app on SQLite can keep it locally and use `DATABASE_URL` when it is set.

From there on, every `git push` to `main` (of `origin` or `cloud`) is a deploy; follow it in `http://git.<BASE_DOMAIN>/<org>/<slug>/actions` with the same token (`GET /api/v1/repos/<org>/<slug>/actions/tasks`; a job's log: `GET .../actions/runs/<run>/jobs`, then `GET .../actions/jobs/<job>/logs`).

**Pushing with the token.** `init` sends the token to `git` through `GIT_ASKPASS` and turns credential helpers off for its own `ls-remote` and push, so nothing the laptop keeps for the host is used or written: on a Mac, Apple's `git` stores every password that works in the Keychain (helper `osxkeychain`), and an old one, from a deleted token, would be sent before the token and fail with "Authentication failed". A plain `git push` later goes through those helpers. To push the current commit with the token again, run the same `init` line with `--push`: on an adopted project it adds nothing and only pushes. If a plain `git push` answers "Authentication failed", the laptop holds an old password for `git.<BASE_DOMAIN>`: remove it (Keychain Access, or `printf 'protocol=http\nhost=git.<BASE_DOMAIN>\n\n' | git credential reject`).

**An agent in a sandbox.** `init` writes the project's `.git` (the first commit, the remote). Some agents run commands where `.git` is read-only: Codex's `workspace-write` sandbox protects the `.git` at the root of its folder. `init` then stops before writing anything, with "cannot create …/.git" (or "cannot write …"). The agent asks to run that one line outside the sandbox, or the person runs it in their own terminal; a second Git directory beside the project, which agents improvised in two runs, works for the push but leaves a folder plain `git` does not see.

### No Docker on the laptop

Nothing in this path needs Docker on the laptop: `init` reads a compose file with Docker when it is there and with its own YAML reader when not, and the image is built on the box by the deploy job. What changes without it:

- the app runs on the laptop the way it was written (`python3 app.py`, `npm start`), reading `PORT`, `DATA_DIR` and `DATABASE_URL` with local defaults when they are not set; the compose file `init` writes is for the box and for laptops that have Docker;
- the `Dockerfile` is not built before the push, so the first deploy is its first build. Keep it to the language's official slim image, `COPY` of what the app needs, the install of its dependencies (for Python, `requirements.txt`; none for the standard library) and the start command; a mistake there fails the run, not the app already on the air (the job builds the release before `apply` touches the running container);
- when the run fails, its log says why (the build's error is in the `deploy` job, step "Build the release"): read it with the token as above, fix, commit, push again.

## 3. What the deploy job does

The workflow in the template ([`templates/app/.gitea/workflows/deploy.yml`](../templates/app/.gitea/workflows/deploy.yml)) has three steps, each readable on its own. Who builds is separated from who applies: the build makes an artifact and changes nothing that runs; the apply is the only step that changes the app, one at a time per app, and only for a commit merged into `main`.

1. **`ihc-app checkout`** fetches the pushed commit from Gitea over the internal network with the job's own token (through `GIT_ASKPASS`, never in a URL).
2. **`ihc-app build <slug>`** makes a *release* `<UTC time>-<commit>` in `<install-dir>/deploys/<slug>/releases/<release>/`, without loading the install's `.env` (it needs no credential of the cloud):
   - `src/`: the files of the commit (`git archive`), never what else lies in the workspace; the build context is this copy;
   - the manifest and compose file validated (the same rules as `provision`), plus the build rules: no build secrets, no SSH agent, no host network, no context, Dockerfile or extra context outside the repository (Compose would read those on the machine that runs the build, which has the install directory);
   - `docker compose build`, then every service's image, built or pulled, tagged `ihc-release/<slug>/<service>:<release>`, so the image a rollback finds is exactly the one the release ran;
   - `pin.yml`, the overlay that runs each service from its release tag (`build` reset, `pull_policy: never`), and `release.json`: commit, repository, who built it, the sha256 of the manifest and compose file, and every image with its id.
3. **`ihc-app apply <slug>`** is the reconciler. In order:
   - takes the app's lock (`<install-dir>/deploys/<slug>/lock`, a `flock` released if the process dies): one apply or rollback per app at a time; a second one waits, then refuses saying who holds it;
   - checks in Gitea that the release's commit is the head of `main` of `<org>/<slug>`. A run for any other ref is refused; an older commit of `main` (a newer push is queued behind it) is skipped as superseded, exit 0, nothing changed; a commit that is not on `main` is refused;
   - writes the `begin` of the transaction to the deploy journal, **before changing anything**: the release before and after, their commits and image ids, the sha256 of the compose overlay and the names of the keys of the env file;
   - **provision** with the release's manifest: it refuses before changing anything when the manifest or the compose file breaks a rule, then makes sure, idempotently, of:
     - a valid manifest whose slug is the repository name and the argument;
     - a compose file that brings no Postgres, Redis or S3 server of its own (the rule below);
     - with `database.required: true`, a database `app_<slug>` owned by a role `app_<slug>` on the shared Postgres: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`, random password, `CONNECT` and `TEMPORARY` revoked from `PUBLIC`;
     - with `dependencies.redis.required: true`, a Redis ACL user `app-<slug>` that can only touch keys and channels under `<slug>:`, persisted in the ACL file the shared Redis loads at start;
     - with `object_storage.required: true` and the `storage` profile on, a bucket `app-<slug>` on Garage and an access key `app-<slug>` that reads and writes that bucket only (never Garage's RPC secret or admin token; [`scripts/lib/garage.sh`](../scripts/lib/garage.sh)); with the profile off, a clear failure before anything changes;
     - `<install-dir>/apps/<slug>/.env`, mode `0600`, with `PORT`, `APP_SLUG`, `APP_BASE_URL`, `DATABASE_URL` and `PG*`, `REDIS_URL` and `REDIS_PREFIX`, `S3_*`, plus the keys of the app's `.env.example` it does not have yet (`LOCAL_*` keys excluded). Existing values are kept: a second run never changes a password;
     - `<install-dir>/apps/<slug>/compose.ihc.yml`, an overlay that puts every service of the app on the ihc network (the main one with the alias `<slug>`), drops published host ports and points `env_file` at the file above;
     - an Authentik proxy provider `app-<slug>` (forward auth, single application, the healthcheck path skipped), an application `<slug>` bound to the users group (`AUTHENTIK_APP_GROUP`), and the provider added to the embedded outpost;
     - the proxy host `<slug>.<BASE_DOMAIN>` to `<slug>:<runtime.port>` with the same forward-auth snippet as the portal (from [`scripts/lib/sso.sh`](../scripts/lib/sso.sh), shared with `first-run.sh`), the healthcheck path left public;
     - the app in `<install-dir>/inventory.json` under `apps.<slug>`: name, owner, URL, repository, last commit, the release, the resources above, `runtime` (the service, port, health path, expected status and `auth.required` of the manifest: what `ihc-doctor` checks), `created_at` on the first run and `provisioned_at` on every run;
   - journals the env keys provision added, removed or changed (names only, never a value);
   - **`docker compose -p <slug> -f <compose file> -f compose.ihc.yml -f pin.yml up -d --no-build --pull never --remove-orphans`** from the release's files: the apply never builds and never pulls, it starts what the build produced; journals `applied`;
   - waits for the manifest's healthcheck through the proxy until it answers the expected status, then checks that an anonymous `GET /` is sent to the Authentik sign-in (`ihc-app wait` is the same check on its own). If the container exits or the time runs out it fails the job with the status it got, the container's state and the last 40 lines of its log; the journal ends the transaction `unhealthy`, and the job says how to roll back;
   - keeps the newest five releases (plus the one running and the one it replaced) and removes the others' files and tags.

The job is the record of who pushed and what each step printed, in the repository's Actions tab; the deploy journal is the record of what changed on the box. The portal reads both; nobody writes to it.

`provision` never deletes a database, role, bucket, ACL user, route or Authentik object, and never takes over what it did not create: a slug registered in `inventory.json` for another repository, or a proxy host for `<slug>.<BASE_DOMAIN>` that points somewhere else, stops the job with nothing changed. Removing an app is a human's job, by hand.

An app whose repository still has the workflow from before the journal (checkout, provision, `docker compose up -d --build`, wait) keeps deploying that way, with no lock, no journal and nothing for rollback to go back to; `ihc-app wait` says so in the job's log. Copy the template's `deploy.yml` into the repository (`sed s/__APP_SLUG__/<slug>/`) and push to switch it.

## The deploy journal

`<install-dir>/catalog/deploys/<slug>.jsonl`, append-only, one JSON line per event ([`scripts/lib/deployjournal.py`](../scripts/lib/deployjournal.py) has the format). Every apply and rollback is a transaction:

| Line | Written | What it holds |
|---|---|---|
| `begin` | before anything changes | `op` (`deploy`, `rollback`), who (`actor`: the pusher, or the person on the box), the run URL, `reason`, `reverts` (for a rollback), `before` (release, commit, image of each running service, sha256 of the overlay, the env file's key names) and `after` (release, commit, images, sha256 of manifest and compose file) |
| `step provision` | after provision | the env keys added, removed and changed (names), the overlay's new sha256 |
| `step applied` | once the containers run the new release | the images running |
| `end` | at the end | `result`: `ok`, `unhealthy` (running, healthcheck failed), `failed` (stopped at `step`, with the error); none means interrupted |

No value of the env file ever reaches the journal, only key names. Admins read it with `ihc-app journal <slug>` (`--json`) on the box and in the portal, on the app's page ("Journal de deploys", `GET /api/apps/<slug>/deploy-journal`, admins only); the portal mounts `catalog/` read only and never writes it.

## Rollback

```bash
scripts/ihc-app.sh rollback <slug> --install-dir /opt/inhousecloud [--reason "..."] [--yes]
```

On the box, as the user that installed it. It undoes the newest deploy in the journal that changed the app and has not been undone yet, going back to the release that deploy replaced: its images (by release tag, checked against the recorded image ids) and its config (its manifest and compose file, provisioned again, so the overlay, route and health path are the old ones). It takes the same lock as `apply`, is a journaled transaction (`op: rollback`, `reverts: <tx>`) and is health-checked the same way. A second rollback undoes the deploy before that one: deploys are undone in reverse order.

It refuses, changing nothing and writing nothing to the journal, when there is nothing to go back to: no journal, the app's first deploy (it replaced nothing), a deploy made before the journal existed, a target release already pruned (five are kept), a release image that is gone or different. If the rolled-back release is unhealthy too, it says so, records `unhealthy` and stops: it never rolls back again on its own.

What it does not undo: the env file's values (provision only adds keys and keeps every password, so the old release reads the same credentials), database migrations (that is [database-migration](runbooks/database-migration.md)), and the history of `main`. The next push to `main` deploys over a rollback, so the rollback is the brake, not the fix: `git revert` the bad commit on `main` (or fix it) and push.

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

What the deploy runner needs, and why: the socket to build and start containers (both steps, `build` and `apply`, still run in the same job); the ihc network to reach the services by name (`IHC_ENDPOINTS=internal` tells `ihc-app` to use `http://authentik-server:9000`, `http://gitea:3000` and `http://proxy:81` instead of the loopback control ports); the install directory at the same path, because `.env` holds the credentials `provision` uses and because Compose reads the app's env file and overlay by host path. `force_pull: false` lets it use the locally built image. The deployer image is rebuilt on every `install.sh` foundation run, so it follows the cloud checkout: after updating the cloud, run `install.sh --apply --from foundation`.

**A job on the deploy runner is root on the box.** The Docker socket alone is root-equivalent, and the job can read every secret in `.env`. That is acceptable only because the runner serves the organization's repositories and nothing else: anyone with write access to a repository in the organization can deploy, and anyone who can push a workflow that says `runs-on: ihc-deploy` can run anything on the box. Give write access in the organization to people you would give a shell on the box. Gitea asks for approval before running workflows from forks of first-time contributors; do not approve a fork's run that touches `.gitea/workflows`.

What the build/apply split guarantees today, and what not yet. `apply` refuses anything but the head of `main`, and the template's workflow runs only on a push to `main`, so a pull request or a branch never reaches the running app through the template. But the guarantee lives in the workflow, which the repository owns: a workflow that says `on: push` for every branch and `runs-on: ihc-deploy`, and calls `docker` itself instead of `ihc-app apply`, still runs on the box with the socket. The full separation, where deploy jobs have no socket and the reconciler with the lock runs outside them, building as an unprivileged user and fetching the commit itself, is the next step ([roadmap](roadmap.md)).

## Why there is no deploy request

The first box started with a deploy-request repository: a pull request with `requests/<slug>.yaml`, merged as the approval, a workflow posting it to an orchestrator API, and a terminal-connected operator agent on the box that turned the request into containers, routes and SSO. It worked, and it was retired:

- the approval was already there: the merge in the deploy-request repository approved a change someone had already pushed to the app repository, and the app's own `main` is where review happens;
- the write API that received deploy events let anyone with a token repoint any domain; removing it removed that class of bug ([`install-design.md`](install-design.md), "The Portal");
- the operator's steps were the same every time, so they became a script that runs in the job, and the job log replaced the operator's report.

`install.sh` therefore no longer creates a `deploy-requests` repository (`first-run.sh` creates `<org>/ihc-smoke` for the authenticated-clone smoke test instead); one left by an older install is kept and can be archived by hand. The `templates/gitops-request` template and `schemas/deploy-request.schema.json` are gone.

## Proving it

Smoke test 16 ([`smoke-tests.md`](smoke-tests.md)) does the whole loop with the template app `smoke-app`: creates it (or clones it when it exists), pushes a commit to `main`, waits for the run, checks `/health` through the proxy, the redirect of `/` to Authentik, and the database and role on the shared Postgres, redeploys it, then removes it with `ihc-app remove` (it is the test's own: `kind: system-test`). Before the removal, test 26 checks the journal of the two deploys, rolls back to the first release (health checked, journaled) and checks that a second rollback is refused. Times from a clean VM are in [`first-run.md`](first-run.md).
