# LLM Bootstrap Playbook

The execution path for a terminal-connected coding agent. Three jobs: **install** the company cloud on a box, **create an app** and put it on the air, **check** that it works. The rules the agent keeps while doing them are in [`agent-setup-contract.md`](agent-setup-contract.md); read that too.

Conventions in this file:

- `$IHC` is this repository's checkout on the box (the folder `install.sh` is in).
- `$DIR` is the install directory. Default `/opt/inhousecloud`.
- Every command runs **on the box**, as the user that ran the install (the one who can read `$DIR/.env`). If your terminal is on another machine, run each command through `ssh <box> '<command>'` and write files on the box (a heredoc through ssh, or `scp`).
- One exception: an app that already exists on the person's own computer goes on the air from there, by `git push`, with no `ssh` to the box (section 5).

Operating a box that is already installed (diagnosis, disk, backup, restarts) is a different job with its own rules: [`operator-contract.md`](operator-contract.md) and [`runbooks/`](runbooks/); `scripts/ihc-operator.sh brief` prints the map of the box.

## 0. Where am I?

On a fresh box there is no checkout yet: `install.sh` and every later command run from a copy of this repository **on the box**, not from the one your terminal has open. Look for it, and put one there if it is missing:

```bash
ls ~/inhousecloud/install.sh                                         # already there?
git clone https://github.com/Estoca/inhousecloud.git ~/inhousecloud
```

If the box cannot reach GitHub, copy your local folder instead: `scp -r <this folder> <box>:inhousecloud`. Keep the copy on the box after the install: `$IHC` below is that folder. Copying files is not an install; no yes is needed for it.

```bash
cd "$IHC"
./install.sh status --install-dir "$DIR" --json
```

| Result | Meaning | Go to |
|---|---|---|
| JSON with `"status": "completed"` | the cloud is installed | section 2 |
| JSON with a stage `failed` | install stopped half way | section 1.5 |
| `no state.json in <dir>` | nothing installed in `$DIR` (or another install directory: ask) | section 1 |
| you have no `ssh` to the box, only the cloud's addresses (`http://portal.<domain>`, `http://git.<domain>`) and a token in `IHC_GITEA_TOKEN`, and the app is in a folder on this computer | the cloud is installed; the app comes by push | section 5 |

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
| Install directory | `install.directory` | `/opt/inhousecloud` |
| Ingress: `local` (this machine only), `private` (tailnet) or `public` | `ingress.mode` | `local` |
| Base domain | `ingress.base_domain` | `cloud.localhost` for `local` |
| Admin email | `admin.email`, `authentik.bootstrap_email`, `portal.super_admin_emails` | none: ask |
| Gitea organization (the company name, lowercase) | `gitea.organization` | `company` |
| Backup destination (a path on another disk) | `backup.destination` | `<install dir>/backups` (same disk: warned) |
| Object storage (S3-compatible, Garage)? | `install.profile.storage` | `false` |
| Admin tools (Portainer, Glances, a web terminal, a file browser)? | `install.profile.ops` | `false` |
| With the admin tools: may the web terminal sign in as the installing user (one key line added to its `~/.ssh/authorized_keys`)? | `ops.wetty.install_key` | `false`; ask, the interactive installer defaults to yes |

For `private` and `public`, the TLS mode and tunnel follow the matrix in [`install-design.md`](install-design.md); a tunnel token is read from the environment variable named in the config (`ingress.cloudflared.tunnel_token_env`), which the human exports before the run.

If the answer to the web terminal is no, the terminal comes up but cannot sign in until the human authorizes its key. Every `./install.sh handoff` says so for as long as the key is missing from `~/.ssh/authorized_keys` (it checks the file, not the config), with the line to run as the installing user:

```
Web terminal: its key is not authorized yet, so terminal.<BASE_DOMAIN> cannot sign in. To allow it, run as <user>:
     cat <install dir>/local/wetty/id_ed25519.pub >> ~/.ssh/authorized_keys
```

Relay that line to the human; do not run it yourself unless they said yes to the question above.

**Never ask for a password, token or key.** The installer generates every secret into `$DIR/.env` (mode 0600).

If the install directory is under `/opt`, it has to exist and belong to the installing user before the plan: `sudo install -d -o "$USER" -g "$(id -gn)" /opt/inhousecloud`. If `sudo -n true` succeeds on the box, run that one command yourself and say so with the plan; otherwise ask the human to run it (it asks for their password, which you never see). Nothing else in the install needs `sudo`.

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
./install.sh status --install-dir "$DIR"           # state, URLs, service health, backup age, apps
./install.sh handoff --install-dir "$DIR"          # the seven day-zero steps, with the commands
python3 scripts/lib/envfile.py keys "$DIR/.env"    # names of the credentials, never the values
```

Tell the human: the URLs, where `.env` lives and the names of the credentials in it, and the day-zero steps that `handoff` prints, which only they can do: open the portal (the catalog with each app's health, SSO and deploys, and the platform status; read only; to operate, Gitea + `ihc-operator brief`), read the first password on their own screen, sign in as `akadmin` and enroll MFA and change the password, copy `BACKUP_ENCRYPTION_KEY` off the box, the first app, the operator brief, and how to stop or remove a test install ([`cleanup.md`](cleanup.md)). Adding people: [`first-user.md`](first-user.md). DNS or tunnel for non-local ingress.

**Passwords stay off the chat.** Do not read them, and do not paste them. Give the human the command that prints one on their own screen, for example `ssh <box> 'python3 ~/inhousecloud/scripts/lib/envfile.py get /opt/inhousecloud/.env AUTHENTIK_BOOTSTRAP_PASSWORD'`, and say it is theirs to run.

**How the human opens the URLs.** With `ingress.mode: local` the URLs answer only on the box itself. If the human reaches the box from another computer (you got an `ssh` command, not a desktop), the URLs will **not** open on their computer as they are. Do not tell them to just open them. Give them a tunnel that holds **port 80** on their computer, kept open in its own terminal window while they use the cloud:

```bash
sudo ssh -N -L 80:127.0.0.1:80 <the same ssh arguments they gave you>
```

`sudo` because port 80 is privileged (it asks for their computer's password; if their `ssh` command uses a key file or `-F` config, keep those arguments). Another local port does not work: the sign-in redirects drop it and send the browser to port 80. Then they open `http://portal.<BASE_DOMAIN>` in Chrome, Edge or Firefox, which resolve `*.localhost` by themselves; Safari needs the names in `/etc/hosts` pointing at `127.0.0.1`. If something on their computer already listens on port 80, the tunnel fails with "Address already in use": that program has to stop first.

## 2. Create an app and put it on the air

### 2.1 Slug and owner

- **slug**: 3 to 32 characters, lowercase letters, digits and hyphens, short (`expense-report`, `despesas`). It becomes the repository name and the hostname `<slug>.<BASE_DOMAIN>`. Refused: `portal`, `git`, `auth`, `postgres`, `redis`, `app-*`, `ihc-*` and the other platform names. Check it is free: `scripts/ihc-app.sh list --install-dir "$DIR"`.
- **owner**: the email of the person who answers for the app. If the human did not say and you cannot tell, use the admin email of the install (`ihc-app new` does that when `--owner` is left out) and say so in the report.

### 2.2 Generate the repository

```bash
cd "$IHC"
scripts/ihc-app.sh new <slug> --owner <email> --install-dir "$DIR" --dir "$HOME/apps/<slug>"
```

Success: the output says `repository <org>/<slug> created in Gitea` and `Actions enabled`. The folder `$HOME/apps/<slug>` holds a working app on `main` with `origin` set. Nothing is deployed yet. (`--push` deploys the template right away; use it only to put the empty app on the air first.)

| File in the app folder | Change it? |
|---|---|
| `server.js`, `package.json`, `Dockerfile` | yes: this is the app. Another language is fine if the `Dockerfile` builds it |
| `company-app.yaml` | only `app.name`, `app.description`, `runtime.port`, `runtime.healthcheck.path`, `database.required`, `dependencies.redis.required`, `object_storage.required`, and `mcp.scopes` (who may use the app's MCP tools) ([`app-contract.md`](app-contract.md)) |
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
- Never add a `postgres`, `redis` or S3 server service, `network_mode: host`, `privileged` or a mounted Docker socket to `docker-compose.yml`: the deploy refuses them.
- MCP tools (optional, for the human's AI agents): the template already answers `GET /mcp/tools` and `POST /mcp/tools/ping/execute` behind the actor JWT of the cloud's MCP gateway. To expose the app's data to agents, add read-only tools to `TOOLS` in `server.js` that filter by `actor.email`, keep the token check as it is, and set who may use them in `mcp.scopes` ([`app-contract.md`](app-contract.md#mcp)). If the app should have no tools, delete the `mcp` section of `company-app.yaml`.

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
    -c credential.helper="!f() { echo username=ihc; printf 'password=%s\n' \"\$(python3 $IHC/scripts/lib/envfile.py get $DIR/.env GITEA_ADMIN_TOKEN)\"; }; f" \
    push origin main
```

Replace `$IHC` and `$DIR` with the real paths if they are not set in your shell. The credential helper hands git the install's admin token without printing it or putting it in a URL. (A person on a laptop pushes with their own Gitea account instead.) Success: `main -> main`. The deploy workflow starts within seconds.

### 2.5 Wait for the deploy

```bash
cd "$IHC"
scripts/ihc-app.sh wait <slug> --install-dir "$DIR" --manifest "$HOME/apps/<slug>/company-app.yaml" --timeout 300
```

Success: `<slug> is up at http://<slug>.<BASE_DOMAIN>`. It polls the healthcheck through the proxy, so it also passes while an older version is still up: confirm the run of your commit is green (3.2).

## 3. Check

### 3.1 Platform status

The portal serves `GET http(s)://portal.<BASE_DOMAIN>/api/platform/status`, one entry per core service and the newest backup: a person opens it with the browser session, an agent with the read-only token `IHC_PORTAL_API_TOKEN` from `$DIR/.env` as `Authorization: Bearer`. The token opens that route and nothing else (403 on any other). Fields, error codes and a `curl` that keeps the token off the command line: [`portal-api.md`](portal-api.md). On the box you rarely call it by hand, because the two commands below read it for you and say so in `source` (`portal-api` when the portal answered, `local` when it did not, with `portal_api.reason`):

```bash
scripts/ihc-doctor.sh --install-dir "$DIR" --json   # every check (containers, routes, sign-in, runners, data, backup, each app): ok, warn or fail, and what to do; plus the portal's view (check portal-api, field platform)
./install.sh status --install-dir "$DIR" --json      # stages, smoke tests, URLs, and the portal's view of the services (field platform)
scripts/ihc-app.sh list --install-dir "$DIR"     # apps: slug, URL, owner, last provision
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

With `ingress.mode: local`, names under `.localhost` resolve to the box itself (curl and browsers do this): open them in a browser on the box, or from a laptop through the port-80 tunnel of section 1.6 (`sudo ssh -N -L 80:127.0.0.1:80 <box>`). A tunnel on another port (`-L 8080:...`) reaches `/health` but not a page behind the sign-in: the redirect to Authentik drops the port.

To try a page behind the sign-in from the box without a browser, call the app container with the header the proxy would add:

```bash
docker exec <slug>-app-1 node -e "fetch('http://localhost:8080/', {headers: {'X-authentik-email': 'test@example.com'}}).then(r => r.text()).then(console.log)"
```

To check the app's MCP tools from the box, call them the way the gateway does (an unsigned call must be refused):

```bash
docker exec <slug>-app-1 node -e "fetch('http://localhost:8080/mcp/tools').then(r => console.log(r.status))"   # 401
```

The tools themselves show up in the gateway as `<slug>__<tool>` for whoever the manifest grants ([`mcp-gateway.md`](mcp-gateway.md)).

### 3.4 Report to the human

The URL `http://<slug>.<BASE_DOMAIN>`, that it asks for the company sign-in, the owner, the repository `http://git.<BASE_DOMAIN>/<org>/<slug>`, and that every push to `main` redeploys it keeping its data. When it has MCP tools: their names (`<slug>__<tool>`) and that they are reached through the MCP gateway `https://mcp.<BASE_DOMAIN>/mcp` with the company sign-in (client id `ihc-mcp`, [`mcp-gateway.md`](mcp-gateway.md#connecting-a-client)).

## 4. Diagnose

Start with the log of the failed job. `<id>` is the first column of 3.2:

```bash
set -a; . "$DIR/.env"; set +a
curl -s -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "http://127.0.0.1:$GITEA_LOCAL_PORT/api/v1/repos/$GITEA_ORGANIZATION/<slug>/actions/jobs/<id>/logs" | tail -n 60
```

Lines with `[xx]` are the cloud's own errors and say what to change. Then:

| Symptom in the log | Command that shows more | Fix |
|---|---|---|
| `company-app.yaml is not deployable` | `python3 scripts/lib/appmanifest.py vars "$HOME/apps/<slug>/company-app.yaml" <slug>` | the field it names |
| `the compose file brings services the cloud provides` | the lines above it in the log | remove the `postgres` / `redis` / S3 service; use `DATABASE_URL` / `REDIS_URL` / `S3_*` |
| `asks for object storage but the storage profile is off` | — | `object_storage.required: false`, or ask the human to turn the profile on |
| step "Build and start" failed | `cd "$HOME/apps/<slug>" && docker compose build` | the `Dockerfile` must install everything the app imports |
| `did not come up: /health ... answered '502'`, container `running` | `docker logs --tail 50 <slug>-app-1` | the app does not listen on `runtime.port` (8080) or has no `/health`: make them match |
| `did not come up`, container `exited` or `restarting` | `docker logs --tail 50 <slug>-app-1` | crash on start: often SQL against the empty database, or a missing dependency |
| `/ is not protected` | — | `auth.required: true` in `company-app.yaml`, push again |
| `git push` asks for a password or answers 401 | `ls -l "$DIR/.env"` | run as the install user, with the credential helper of 2.4 |
| `new`: `exists and is not empty` or `already has commits` | — | another `--dir`; for an app that exists, `git clone http://git.<BASE_DOMAIN>/<org>/<slug>.git` with the credential helper of 2.4 |
| run stays `waiting` | `docker ps --filter name=gitea-deployer` | the deploy runner is down: ask the human, then `./install.sh --apply --install-dir "$DIR" --from foundation` |

After a fix, commit and push again (2.4). The deploy is idempotent and keeps the app's database and passwords.

## 5. An app that already exists, from a laptop

The person had an agent (maybe you) write an app on their own computer, it runs there, and they want it on the company cloud. You have the cloud's addresses, a token in `IHC_GITEA_TOKEN` and the app's folder; you may have no `ssh` to the box, and you do not need it: the code goes by `git push` and the deploy runs on the box ([`gitops-flow.md`](gitops-flow.md#from-a-laptop)). Do not ask the person for `ssh`, `sudo` or a password.

### 5.1 Check what you have

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://portal.<domain>/       # 302 or 200: the cloud answers
test -n "$IHC_GITEA_TOKEN" && echo token set                           # never print it
```

`000` from a `*.localhost` address: the port-80 tunnel to the box is not open; give the person the command of 1.6 to run in a terminal of their own and wait. A copy of this repository is needed for `scripts/ihc-app.sh`; if the person did not point you to one, `git clone https://github.com/Estoca/inhousecloud.git` next to the app.

Docker on the laptop is not needed: `init` and the push do not use it, and the image is built on the box. If `docker` is missing, do not install it and do not ask for it; test the app the way it runs locally and leave the build to the deploy ([No Docker on the laptop](gitops-flow.md#no-docker-on-the-laptop)).

### 5.2 Make the app fit the contract

The same rules as 2.3, applied to the existing code; change only what they need:

- listen on `0.0.0.0` and `PORT` (laptop apps often bind `127.0.0.1` and a fixed port), and answer `GET /health` with 200;
- data in `DATABASE_URL` (the shared Postgres, created empty: create the tables on start) or files under `DATA_DIR` (`/data`). A local SQLite file next to the code does not survive a redeploy; keeping SQLite for the laptop and Postgres when `DATABASE_URL` is set works;
- the signed-in person from `X-authentik-email` / `X-authentik-name`; no login page;
- a `Dockerfile` that installs what the app imports (for Python, a `requirements.txt` with the Postgres driver).

### 5.3 Adopt and push

```bash
cd <the app's folder>
IHC_GITEA_URL=http://git.<domain> ~/inhousecloud/scripts/ihc-app.sh init <slug> --port <the port the app listens on> --push
```

It adds `company-app.yaml`, the deploy workflow, a compose file and `.env.example` when missing, keeps the code and any compose file the project has, ignores `.env` and local database files, commits, creates `<org>/<slug>` and pushes `main`. Read the manifest it wrote and set `database.required`, `dependencies.redis.required` and the owner if they are wrong, commit and push again. The owner is the person's email from `git config user.email` (or `--owner`), not yours.

| `init` stops with | Who fixes it |
|---|---|
| `does not accept IHC_GITEA_TOKEN` (401) | the person: a new token ([`first-user.md`](first-user.md)) |
| `the token cannot create repositories` | the person: a token with **organization** and **repository** Read and Write |
| `cannot create repositories in <org>` | an admin: the person's team gets "Create repositories" ([`first-user.md`](first-user.md)) |
| `no Dockerfile`, or a compose file with its own Postgres / Redis / S3 | you: write the `Dockerfile`, remove the service and use `DATABASE_URL` / `REDIS_URL` |
| `cannot create <folder>/.git` or `cannot write <folder>/.git` | your sandbox keeps `.git` read-only (Codex's `workspace-write` does): ask to run the same line outside it, or give the person the line to run in their terminal. Do not make a second Git directory beside the project |
| `Authentication failed` on a plain `git push` you ran | the laptop's credential helper (on a Mac, the Keychain) sent an old password: push with the `init … --push` line again, which uses only the token |

### 5.4 Wait and check

Without access to the box, follow the run with the person's token, then check as in 3.3:

```bash
curl -s -H "Authorization: token $IHC_GITEA_TOKEN" "http://git.<domain>/api/v1/repos/<org>/<slug>/actions/tasks"   # status of the run of your commit
curl -s -o /dev/null -w '%{http_code}\n' http://<slug>.<domain>/health                                          # 200
curl -s -o /dev/null -w '%{http_code}\n' http://<slug>.<domain>/                                                # 302 to the sign-in
```

A `failure`: the job's log is in the repository's Actions tab (`http://git.<domain>/<org>/<slug>/actions`), and you read it with the same token: `GET /api/v1/repos/<org>/<slug>/actions/runs/<run id>/jobs`, then `GET /api/v1/repos/<org>/<slug>/actions/jobs/<job id>/logs`. Without Docker on the laptop the `Dockerfile` is first built there, so its errors show up in that log; section 4 has the fixes. Later changes: commit, then the same `init … --push` line (it adds nothing on an adopted project and pushes with the token). Report as in 3.4; the person's local data stays on the laptop, the cloud's database starts empty.
