# LLM Bootstrap Playbook

The execution path for a terminal-connected coding agent. Three jobs: **install** the company cloud on a box, **create an app** and put it on the air, **check** that it works. The rules the agent keeps while doing them are in [`agent-setup-contract.md`](agent-setup-contract.md); read that too.

Conventions in this file:

- `$HARNESS` is this repository's checkout on the box (the folder `install.sh` is in).
- `$DIR` is the install directory. Default `/opt/open-company-harness`.
- Every command runs **on the box**, as the user that ran the install (the one who can read `$DIR/.env`). If your terminal is on another machine, run each command through `ssh <box> '<command>'` and write files on the box (a heredoc through ssh, or `scp`).

## 0. Where am I?

```bash
cd "$HARNESS"
./install.sh status --install-dir "$DIR" --json
```

| Result | Meaning | Go to |
|---|---|---|
| JSON with `"status": "completed"` | the cloud is installed | section 2 |
| JSON with a stage `failed` | install stopped half way | section 1.5 |
| error: no state file | nothing installed in `$DIR` | section 1 |

## 1. Install

Skip this section if section 0 said `completed`.

### 1.1 Prerequisites

```bash
docker version --format '{{.Server.Version}}'   # Docker Engine, usable without sudo
docker compose version                           # Compose v2
python3 --version && curl --version | head -n 1 && git --version
```

Success: all of them print a version. If Docker or Compose is missing, **stop and tell the human**; do not install Docker yourself. On Ubuntu the human runs `curl -fsSL https://get.docker.com | sh` (or sets up rootless Docker) and adds their user to the `docker` group. The box needs 2 CPUs, 4 GiB of memory and 10 GiB of free disk.

### 1.2 Ask the human, all at once, with the defaults

| Question | Config key | Default |
|---|---|---|
| Install directory | `install.directory` | `/opt/open-company-harness` |
| Ingress: `local` (this machine only), `private` (tailnet) or `public` | `ingress.mode` | `local` |
| Base domain | `ingress.base_domain` | `harness.localhost` for `local` |
| Admin email | `admin.email`, `authentik.bootstrap_email`, `portal.super_admin_emails` | none: ask |
| Gitea organization (the company name, lowercase) | `gitea.organization` | `company` |
| Backup destination (a path on another disk) | `backup.destination` | `<install dir>/backups` (same disk: warned) |
| Object storage (MinIO)? | `install.profile.storage` | `false` |
| Portainer and Glances? | `install.profile.ops` | `false` |

For `private` and `public`, the TLS mode and tunnel follow the matrix in [`install-design.md`](install-design.md); a tunnel token is read from the environment variable named in the config (`ingress.cloudflared.tunnel_token_env`), which the human exports before the run.

**Never ask for a password, token or key.** The installer generates every secret into `$DIR/.env` (mode 0600).

If the install directory is under `/opt`, the human creates it once: `sudo install -d -o "$USER" -g "$USER" /opt/open-company-harness`.

### 1.3 Write the answers, show the plan

```bash
mkdir -p local
cp bootstrap/config.example.yaml local/config.yaml
# edit local/config.yaml with the answers (local/ is ignored by Git)
./install.sh --plan --config local/config.yaml
```

Success: the plan prints the preflight checklist, the services, URLs and files, with no `[xx]` line. An `[xx]` line says what to fix (Docker, a used port, disk, memory, an invalid ingress combination). Show the plan to the human and **wait for a yes**.

A human at the terminal can run `./install.sh` with no arguments instead: it asks the same questions, shows the plan and asks before applying.

### 1.4 Apply

```bash
./install.sh --non-interactive --config local/config.yaml --json > local/install-result.json
```

About 4 minutes on a clean box. Progress goes to stderr. Success: exit code 0 and `"status": "completed"` in `local/install-result.json`. The smoke tests ([`smoke-tests.md`](smoke-tests.md)) run inside the install, including a full deploy of a test app; the install is not completed while one fails.

### 1.5 If a stage failed

The output ends with the stage, the cause and the resume command. Fix the cause, then:

```bash
./install.sh --apply --install-dir "$DIR" --from <stage>
```

Completed stages are skipped; every action probes before it creates. Never delete volumes or `$DIR` to start clean without the human's yes.

### 1.6 Report the install

```bash
./install.sh status --install-dir "$DIR"           # URLs, users, smoke test results
python3 scripts/lib/envfile.py keys "$DIR/.env"    # names of the credentials, never the values
```

Tell the human: the URLs, where `.env` lives and the names of the credentials in it, and the steps only they can do ([`first-run.md`](first-run.md), "Left to a human": first sign-in to Authentik as `akadmin`, MFA, SMTP, DNS or tunnel for non-local ingress).

## 2. Create an app and put it on the air

### 2.1 Slug and owner

- **slug**: 3 to 32 characters, lowercase letters, digits and hyphens, short (`expense-report`, `despesas`). It becomes the repository name and the hostname `<slug>.<BASE_DOMAIN>`. Refused: `portal`, `git`, `auth`, `postgres`, `redis`, `app-*`, `harness-*` and the other platform names. Check it is free: `scripts/harness-app.sh list --install-dir "$DIR"`.
- **owner**: the email of the person who answers for the app. If the human did not say and you cannot tell, use the admin email of the install (`harness-app new` does that when `--owner` is left out) and say so in the report.

### 2.2 Generate the repository

```bash
cd "$HARNESS"
scripts/harness-app.sh new <slug> --owner <email> --install-dir "$DIR" --dir "$HOME/apps/<slug>"
```

Success: the output says `repository <org>/<slug> created in Gitea` and `Actions enabled`. The folder `$HOME/apps/<slug>` holds a working app on `main` with `origin` set. Nothing is deployed yet. (`--push` deploys the template right away; use it only to put the empty app on the air first.)

| File in the app folder | Change it? |
|---|---|
| `server.js`, `package.json`, `Dockerfile` | yes: this is the app. Another language is fine if the `Dockerfile` builds it |
| `company-app.yaml` | only `app.name`, `app.description`, `runtime.port`, `runtime.healthcheck.path`, `database.required`, `dependencies.redis.required`, `object_storage.required` ([`app-contract.md`](app-contract.md)) |
| `docker-compose.yml` | rarely: keep the one service `app`, its `env_file` and healthcheck; never add a database, cache or storage service |
| `.env.example` | add the names of variables the app reads; no real values |
| `.gitea/workflows/deploy.yml` | no |

### 2.3 Write the app

Rules the deploy enforces or the app needs on the box:

- Listen on `PORT` (8080, = `runtime.port`) and answer `GET /health` with 200.
- Data goes in the shared Postgres through `DATABASE_URL` (or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`). The database starts **empty**: create the tables on start (`CREATE TABLE IF NOT EXISTS ...`) or run migrations before listening. With Node, add `pg` to `package.json`.
- Cache and queues go in the shared Redis through `REDIS_URL`; every key starts with `REDIS_PREFIX` (`<slug>:`); other keys are refused.
- The signed-in person arrives in the headers `X-authentik-email`, `X-authentik-name`, `X-authentik-username`, `X-authentik-groups`. Do not build a login page or store passwords.
- Every route except `/health` is behind the company sign-in. Use relative links and form actions (`/expenses`, not `http://localhost:8080/expenses`).
- Dependencies are installed by the `Dockerfile`. If you add dependencies and there is no lock file, keep `RUN npm install --omit=dev` (not `npm ci`).
- Never add a `postgres`, `redis` or `minio` service, `network_mode: host`, `privileged` or a mounted Docker socket to `docker-compose.yml`: the deploy refuses them.

Check before pushing, in the app folder:

```bash
docker compose build        # the image builds
```

The deploy is the integration test: there is no need to run Postgres on your own.

### 2.4 Commit and push: that is the deploy

```bash
cd "$HOME/apps/<slug>"
git add -A
git -c user.name="<owner name>" -c user.email="<owner email>" commit -m "<what the app does>"
git -c credential.helper= \
    -c credential.helper="!f() { echo username=harness; printf 'password=%s\n' \"\$(python3 $HARNESS/scripts/lib/envfile.py get $DIR/.env GITEA_ADMIN_TOKEN)\"; }; f" \
    push origin main
```

Replace `$HARNESS` and `$DIR` with the real paths if they are not set in your shell. The credential helper hands git the install's admin token without printing it or putting it in a URL. (A person on a laptop pushes with their own Gitea account instead.) Success: `main -> main`. The deploy workflow starts within seconds.

### 2.5 Wait for the deploy

```bash
cd "$HARNESS"
scripts/harness-app.sh wait <slug> --install-dir "$DIR" --manifest "$HOME/apps/<slug>/company-app.yaml" --timeout 300
```

Success: `<slug> is up at http://<slug>.<BASE_DOMAIN>`. It polls the healthcheck through the proxy, so it also passes while an older version is still up: confirm the run of your commit is green (3.2).

## 3. Check

### 3.1 Platform status

The real portal will serve `GET http(s)://portal.<BASE_DOMAIN>/api/platform/status`, one entry per core service and the newest backup. The portal is still a placeholder without that endpoint; use:

```bash
./install.sh status --install-dir "$DIR" --json      # stages, smoke tests, URLs
scripts/harness-app.sh list --install-dir "$DIR"     # apps: slug, URL, owner, last provision
```

### 3.2 The deploy run

```bash
set -a; . "$DIR/.env"; set +a      # loads the install's names into this shell; prints nothing
curl -s -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "http://127.0.0.1:$GITEA_LOCAL_PORT/api/v1/repos/$GITEA_ORGANIZATION/<slug>/actions/tasks?limit=5" \
  | python3 -c 'import json,sys;[print(r["id"],r["status"],r["head_sha"][:8],r["display_title"]) for r in json.load(sys.stdin)["workflow_runs"]]'
```

Success: the newest line, with the short sha of your commit (`git -C "$HOME/apps/<slug>" rev-parse --short=8 HEAD`), says `success`. `running` or `waiting`: check again in 10 seconds. `failure`: section 4. In a browser: `http://git.<BASE_DOMAIN>/<org>/<slug>/actions`.

### 3.3 The app

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<slug>.<BASE_DOMAIN>/health   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://<slug>.<BASE_DOMAIN>/         # 302: sent to the sign-in
```

With `ingress.mode: local`, names under `.localhost` resolve to the box itself (curl and browsers do this): open them in a browser on the box, or from a laptop through `ssh -L 8080:127.0.0.1:80 <box>` and `http://<slug>.harness.localhost:8080`.

To try a page behind the sign-in from the box without a browser, call the app container with the header the proxy would add:

```bash
docker exec <slug>-app-1 node -e "fetch('http://localhost:8080/', {headers: {'X-authentik-email': 'test@example.com'}}).then(r => r.text()).then(console.log)"
```

### 3.4 Report to the human

The URL `http://<slug>.<BASE_DOMAIN>`, that it asks for the company sign-in, the owner, the repository `http://git.<BASE_DOMAIN>/<org>/<slug>`, and that every push to `main` redeploys it keeping its data.

## 4. Diagnose

Start with the log of the failed job. `<id>` is the first column of 3.2:

```bash
set -a; . "$DIR/.env"; set +a
curl -s -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "http://127.0.0.1:$GITEA_LOCAL_PORT/api/v1/repos/$GITEA_ORGANIZATION/<slug>/actions/jobs/<id>/logs" | tail -n 60
```

Lines with `[xx]` are the harness's own errors and say what to change. Then:

| Symptom in the log | Command that shows more | Fix |
|---|---|---|
| `company-app.yaml is not deployable` | `python3 scripts/lib/appmanifest.py vars "$HOME/apps/<slug>/company-app.yaml" <slug>` | the field it names |
| `the compose file brings services the cloud provides` | the lines above it in the log | remove the `postgres` / `redis` / `minio` service; use `DATABASE_URL` / `REDIS_URL` |
| `asks for object storage but the storage profile is off` | — | `object_storage.required: false`, or ask the human to turn the profile on |
| step "Build and start" failed | `cd "$HOME/apps/<slug>" && docker compose build` | the `Dockerfile` must install everything the app imports |
| `did not come up: /health ... answered '502'`, container `running` | `docker logs --tail 50 <slug>-app-1` | the app does not listen on `runtime.port` (8080) or has no `/health`: make them match |
| `did not come up`, container `exited` or `restarting` | `docker logs --tail 50 <slug>-app-1` | crash on start: often SQL against the empty database, or a missing dependency |
| `/ is not protected` | — | `auth.required: true` in `company-app.yaml`, push again |
| `git push` asks for a password or answers 401 | `ls -l "$DIR/.env"` | run as the install user, with the credential helper of 2.4 |
| `new`: `exists and is not empty` or `already has commits` | — | another `--dir`; for an app that exists, `git clone http://git.<BASE_DOMAIN>/<org>/<slug>.git` with the credential helper of 2.4 |
| run stays `waiting` | `docker ps --filter name=gitea-deployer` | the deploy runner is down: ask the human, then `./install.sh --apply --install-dir "$DIR" --from foundation` |

After a fix, commit and push again (2.4). The deploy is idempotent and keeps the app's database and passwords.
