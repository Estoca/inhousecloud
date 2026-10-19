# First Run

What `scripts/first-run.sh` automates after the stack is healthy, what it leaves to a human, and how to re-run it. It is stage `first_run` of [`install.sh`](../install.sh) (steps 14 and 15 of the sequence in [`install-design.md`](install-design.md)) and can also be run on its own:

```bash
scripts/first-run.sh --install-dir /opt/open-company-harness
```

It is repeatable. Every action probes before it creates and reconciles what exists, so running it twice changes nothing, and running it after a half-finished attempt completes the missing pieces.

## Automated

Talks to the three control planes on their loopback ports (`127.0.0.1:9000` Authentik, `127.0.0.1:3000` Gitea, `127.0.0.1:81` proxy admin). Tokens travel in curl config files and on stdin, never on a command line, and nothing secret is printed.

### Authentik

| Resource | Probe | Create or reconcile |
|---|---|---|
| Groups `harness-admins`, `harness-users` (names from config) | by name | created, not superuser |
| OAuth2 provider `gitea` | by name | client id and secret from `.env`, callback `<GITEA_BASE_URL>/user/oauth2/authentik/callback`, scopes openid/email/profile, signed with the self-signed certificate Authentik generates on first start, issuer per provider |
| Application `gitea` | by slug | launch URL `GITEA_BASE_URL` |
| Proxy provider `portal` | by name | mode forward auth (single application), external host `PORTAL_BASE_URL`, `/health` skipped |
| Application `portal` | by slug | launch URL `PORTAL_BASE_URL` |
| Embedded outpost | managed id | the portal provider is added; `authentik_host` set to `AUTHENTIK_BASE_URL` so browsers are sent to the public name |
| Policy bindings | by target and group | `portal` requires `harness-admins`, `gitea` requires `harness-users` |
| `akadmin` membership | by group users | added to both groups |

The outpost id is written to `.env` as `AUTHENTIK_OUTPOST_ID` (it is not a secret).

### Proxy (Nginx Proxy Manager)

Logs in with `PROXY_ADMIN_EMAIL` / `PROXY_ADMIN_PASSWORD` (the admin the proxy created on its first start from those same values), then ensures one proxy host per public name, matched by domain name:

- `auth.<BASE_DOMAIN>` to `authentik-server:9000`
- `git.<BASE_DOMAIN>` to `gitea:3000`
- `portal.<BASE_DOMAIN>` to `portal:8080` with the forward-auth snippet (below)
- with the `storage` profile: `s3.<BASE_DOMAIN>` to Garage's S3 API (`garage:3900`), no forward auth: every request is signed with an app's key
- with the `ops` profile: `portainer.<BASE_DOMAIN>`, `glances.<BASE_DOMAIN>`, `files.<BASE_DOMAIN>` and, when the installer found an sshd for it, `terminal.<BASE_DOMAIN>`, each with the forward-auth snippet and nothing public, its Authentik application bound to `harness-admins` only (an existing binding to another group is removed). Portainer keeps its own login behind the SSO. The same block creates `harness-smoke-user`, a member of `harness-users` only, with the password `AUTHENTIK_SMOKE_USER_PASSWORD` from `.env`, for smoke test 18

The forward-auth snippet is the one Authentik documents for nginx, in the host's advanced configuration: `auth_request` against `/outpost.goauthentik.io/auth/nginx`, the `X-authentik-*` headers passed to the app, anonymous requests redirected to `/outpost.goauthentik.io/start`. `GET /health` is left public so the installer and monitors can probe the app.

TLS per mode: `off` and `edge` create plain HTTP hosts (the Cloudflare edge terminates TLS in `edge`); `acme` requests a Let's Encrypt certificate for each host and forces HTTPS; `internal` creates the hosts without a certificate and leaves the development certificate to you (see below).

Containers resolve the public names to the proxy through network aliases, so Gitea fetches Authentik's discovery document by its public URL and the issuer in the tokens is the same one browsers see.

### Gitea

| Resource | Probe | Create or reconcile |
|---|---|---|
| Admin user | `gitea admin user list --admin` | created with `GITEA_ADMIN_PASSWORD`, no forced password change |
| Admin API token (`GITEA_ADMIN_TOKEN`) | the token answers `/api/v1/user` | generated with scope `all`, written to `.env` |
| Organization (`GITEA_ORGANIZATION`) | `GET /api/v1/orgs/<org>` | visibility limited (members and signed-in users) |
| Repository `<org>/harness-smoke` | `GET /api/v1/repos/...` | private, initialised with a README on `main`; the target of smoke test 12 (`GITEA_SMOKE_REPOSITORY`). Apps get their own repositories from `harness-app new` ([`gitops-flow.md`](gitops-flow.md)); older installs created `<org>/deploy-requests`, which is kept |
| Read-only API token (`GITEA_READONLY_TOKEN`) | the token answers `/api/v1/user` | scopes `read:misc,read:repository,read:organization,read:user`, written to `.env`; smoke test 6 uses it because the instance requires sign-in to view |
| OIDC source `authentik` | `gitea admin auth list` | `add-oauth` or `update-oauth` with the client id and secret from `.env`, discovery URL `<AUTHENTIK_BASE_URL>/application/o/gitea/.well-known/openid-configuration`, scopes openid/profile/email, local 2FA skipped |

Gitea is configured for auto-registration on first OIDC login (`ENABLE_AUTO_REGISTRATION=true`, `ACCOUNT_LINKING=auto`, username from the `nickname` claim), so a person who exists in Authentik signs in to Gitea without a prior account. Registration by password is disabled.

### Verification

Before finishing, the script checks from the box itself that `auth`, `git` and the portal's `/health` answer through the proxy and that an anonymous request to the portal is redirected to the outpost. It records the ids it created under `stages.first_run.resources` in `state.json`.

The whole SSO path can then be proven with curl, the way a browser would walk it:

```bash
scripts/sso-login-check.sh --install-dir /opt/open-company-harness
```

It starts at Gitea's `/user/oauth2/authentik`, signs in as `akadmin` through Authentik's flow executor API with the bootstrap password from `.env`, follows the code back to Gitea's callback and reports the signed-in user and the linked account. It is not a smoke test because it needs a password, and the bootstrap password is meant to be replaced by a human. On a fresh box the result is `signed in as 'admin'`: Authentik's `akadmin` and the Gitea admin share the admin email, so Gitea links them (`ACCOUNT_LINKING=auto`); any other Authentik user is created on first login.

A lesson from testing: curl resolves every `*.localhost` name to loopback by itself (RFC 6761), ignoring DNS and Docker's network aliases. Inside a container that means `curl http://auth.harness.localhost` never reaches the proxy; Go programs such as Gitea and busybox `wget` use the resolver and do. The scripts use `--resolve` on the host and `wget` inside containers for that reason.

## Human

Asked for, or left to you, never guessed:

- **DNS and tunnel.** `local` ingress needs nothing on Linux (`*.localhost` resolves to loopback); on macOS add the three names to `/etc/hosts`. `private` needs split DNS for `BASE_DOMAIN` on your Tailscale network and the auth key in `HARNESS_TAILSCALE_AUTHKEY`. `public` needs the DNS records (or the Cloudflare tunnel routes) and, for `cloudflared`, the tunnel token in the variable named by `ingress.cloudflared.tunnel_token_env`.
- **First login, MFA, bootstrap password.** Sign in to Authentik as `akadmin` with `AUTHENTIK_BOOTSTRAP_PASSWORD` from `.env`, enrol MFA, save recovery codes, then change the password; the value in `.env` is then stale by design.
- **Group policy.** Who is an admin, who reaches Gitea and the portal. The installer binds the two groups above and puts `akadmin` in both; adding people is yours.
- **SMTP, account recovery, invitations.** Authentik and Gitea are installed with mail disabled.
- **Development certificate** in `tls_mode: internal`: upload it in the proxy admin (`http://127.0.0.1:81`) and attach it to the three hosts.
- **Replacing the placeholder portal.** The `portal` service builds `examples/minimal-web-app`; the real portal takes its place with the same service name, port 8080 and `/health`.
- **Migrating an existing installation.** Nothing here imports data.

## Re-running and resuming

- `scripts/first-run.sh --install-dir DIR` alone: safe at any time; it also repairs a route or binding deleted by hand.
- `install.sh --apply --from first_run`: the same, recorded in `state.json`, followed by the smoke tests and the remaining stages.
- A failure stops at the first unmet condition with the HTTP status or the CLI error, nothing is rolled back, and the next run continues from what exists.

## Test record: the backup job

On a clean Lima VM (Ubuntu 26.04, 2 CPU, 4 GiB, 30 GiB, Docker 29 rootless), with the backup destination on a separate 4 GiB ext4 file system mounted at `/mnt/backup` (`HARNESS_BACKUP_DESTINATION=/mnt/backup/harness`) and `bootstrap/config.example.yaml` otherwise unchanged:

| Step | Time |
|---|---|
| VM created and started | 48 s |
| `install.sh --non-interactive`, including the backup image build and the first backup | 194 s |
| `harness-backup.sh run` (second run, deduplicated) | 9 s |
| `harness-backup.sh verify --latest` | 8 s |
| `smoke-tests.sh`: 15 passed, 0 skipped | 10 s |
| `sso-login-check.sh`: PASS | 1 s |
| From VM creation to everything green | 270 s |

A run holds 10 items: 5 dumps of the shared Postgres (`gitea`, `harness`, `harness_platform`, `postgres`, globals), 3 of Authentik's (`authentik`, `postgres`, globals), the volumes and the install directory. About 3.4 MB of dumps on a fresh box; the repository was 3.8 MB after five runs.

Failure cases, run by hand on the first VM:

- **Hung run.** A transaction held `ACCESS EXCLUSIVE` on a Gitea table so `pg_dump` waited, with `BACKUP_MAX_RUN_MINUTES=1`. The run was killed at 60 s with its `pg_dump` and `restic`. The status file said `failed` with the timeout as the reason, the lock was released, and the next run succeeded.
- **Concurrent run.** A second `run` during a live one refused to start and left the status file alone.
- **Container restarted mid-run.** On start the scheduler found the dead lock and recorded the run as `failed` ("its process disappeared"). The next run succeeded.
- **Schedule.** With `BACKUP_SCHEDULE="*/2 * * * *"`, crond started a run on the next even minute and it succeeded.
- **Restore.** The `docs/backup.md` steps, run as written: the Gitea dump restored into a scratch database with its users and repositories, and the Gitea volume snapshot restored the bare repository.
- **Disabled.** With `BACKUP_ENABLED=false`, smoke test 14 reports skipped and the other 14 pass.
- **Re-run.** `install.sh --apply` on the installed box: every stage "already completed". `--from foundation`: the image is rebuilt, the backup stage sees an existing success and does not run another one, and the smoke tests pass, in 47 s.
- **Preflight.** It warns when the destination cannot be created, warns when it is on the same disk as the installation, and refuses a relative path.

What broke on the way:

- `wait_tcp` in `scripts/lib/common.sh` closed its probe with `exec 3>&- 2>/dev/null`, which sent the installer's stderr to `/dev/null` for every stage after `gitea`. The install still completed, but its log stopped at "gitea healthy". It is fixed here.
- `reports/` came out `0777` because `docker exec` runs with umask 0000. The script now sets umask 022 itself, so the portal can read the reports and nobody else can write them.
- The restore commands in the docs need `RESTIC_REPOSITORY` in the container's environment, not only in the script's. It is now set in the image.
- restic 0.18 keeps the oldest snapshot of an item while fewer than 7 days exist ("oldest daily snapshot"), so a fresh box shows two snapshots per item after a few runs on the same day. That is retention working, not a leak.

Not tested: macOS as the host (Docker Desktop must share the destination directory), rootful Docker (the ownership rule in `give_back` covers it but was not exercised), the `storage` profile's volume (covered later, in the object storage record), and a run long enough for live volume copies to matter.

## Test record: the app loop (smoke test 16)

On a clean Lima VM (Ubuntu 26.04.1, 2 CPU, 4 GiB, 30 GiB, Docker 29.9 rootless, socket `/run/user/<uid>/docker.sock`). The first run used `bootstrap/config.example.yaml` with the then `ci` profile turned on; after the runners moved into core, a third clean VM ran the example config unchanged: install 230 s, 16 passed (core-healthy counts 10 services, the runners included), `new --push` to `/health` 200 in 14 s, a re-run of `install.sh --apply` with all 14 stages already completed.

| Step | Time |
|---|---|
| VM created and started | 45 s |
| `install.sh --non-interactive`, all 14 stages, including the deployer image, both runners and the first deploy of `smoke-app` inside smoke test 16 | 238 s |
| Smoke tests: 16 passed, 0 skipped (inside the install) | |
| Smoke test 16 alone: push to main until the deploy run is green (first deploy of `smoke-app`) | 16 s |
| `harness-app new expense-report --push` until `GET /health` answers 200 through the proxy | 13 s |
| Redeploy with a code change (new image built): push until the run is green | 19 s |
| `smoke-tests.sh` again on the installed box (16 passed; test 16 redeploys and finds the password unchanged) | 21 s |
| `sso-login-check.sh` | PASS |

The deploy times are short because the template's base image (`node:22-alpine`) is already on the box: the placeholder portal is built from it during the install. An app on another base image pays its pull on the first deploy.

Checked by hand on the same kind of VM:

- **Rule against local infrastructure.** An app whose compose file adds `image: postgres:16-alpine` fails at `provision` in 3 s with the alternative in the log; no database, env file or route was created.
- **App that never gets healthy.** An app listening on 9090 instead of `runtime.port` 8080 fails `harness-app wait` after 240 s: `/health through the proxy answered '502' (wanted 200), container state 'running'`, the container log, and what to check.
- **Object storage asked for with the `storage` profile off** fails before anything is created, with the profile to turn on.
- **Redis ACL.** The app's user writes `smoke-app:*`, gets `NOPERM` on another app's keys, on `FLUSHALL` and on `KEYS`; after `docker restart` of Redis the user is still there (`/data/users.acl`).
- **Interactive questions.** The backup destination is asked right after the Gitea organization; the default `<install-dir>/backups` and a path under a missing mount on the root disk both get the same-disk warning, and the answer lands in `backup.destination`. A config with the old `install.profile.ci` / `ci.gitea_runner.enabled` loads with a warning that they are ignored.
- **Idempotency.** `install.sh --apply --from foundation` on the box with three apps: every Authentik, proxy and Gitea object "exists" or "reconciled", the deployer image rebuilt, `inventory.json` kept its `apps`, smoke tests 16/16 with the app's password unchanged, 54 s.

What broke on the way:

- The template's placeholders were not replaced in `.gitea/workflows/deploy.yml`: the walk skipped every path containing `/.git`, which `/.gitea` does. `harness-app new` now refuses to finish while a placeholder is left.
- Files written by deploy jobs came out `0666`: `docker exec` runs with umask 0000 (the backup job hit the same). `harness-app` sets umask 022 and sets the overlay's mode explicitly, since an existing file keeps its old mode.
- `install.sh` reported success with a service that never started: stage functions run inside `if`, where `set -e` does not apply, so a failed `wait_healthy` did not fail the stage. Every `dc up` and `wait_healthy` in a stage now returns the failure.
- **The `storage` profile could not start**: its pinned S3 server image was no longer downloadable. The profile now runs Garage; see the object storage record below.

Not tested: `harness-app new` from a laptop with `HARNESS_GITEA_*` (only on the box), rootful Docker and Docker Desktop (the socket path detection covers them), ingress other than `local/off`, fork pull requests against the deploy runner.

## Cold agent run

The test of the agent path (`AGENTS.md`, [`llm-bootstrap.md`](llm-bootstrap.md), [`agent-setup-contract.md`](agent-setup-contract.md)): a coding agent that has never seen the harness gets a one-paragraph request in a layperson's words and nothing else, and has to put a working app on the air.

**Setup.** A clean Lima VM (Ubuntu 26.04.1, 2 CPU, 4 GiB, 30 GiB, Docker 29.9 rootless) with the harness installed from `bootstrap/config.example.yaml` unchanged (`local` ingress, `harness.localhost`). The agent was the Claude Code CLI (`claude -p`, Claude Opus 5.5) on the host machine, in a fresh clone of this branch, with no project memory, no MCP servers and no user settings, and with its tools limited to `Read`, `Glob`, `Grep`, `Bash(ssh:*)` and `Bash(scp:*)`: it could read the repository and reach the box only through `ssh`. The prompt, in Portuguese as a person would write it, said what the app should do, gave the `ssh` command for the server and said that the folder was a copy of the harness repository. Nothing about the harness, its commands or its docs.

> Cria um app interno de registro de despesas na nossa company cloud e coloca no ar, por favor. A ideia é cada pessoa lançar suas despesas (data, descrição, valor, categoria) e ver a lista das suas. [ssh command, "esta pasta é uma cópia do repositório do harness"] Me avisa quando estiver no ar.

**Result: on the air in the first round, without help.** No doc had to be fixed between rounds, so a second round used a different request (room booking with no overlapping reservations) to check it was not luck.

| | Round 1: expense log | Round 2: room booking |
|---|---|---|
| Turns | 17 | 8 |
| Tool calls | 16 (2 local shell commands refused by the tool limits; it fell back to `Read` and `Glob`) | 7, none refused |
| Wall time, prompt to report | 113 s | 141 s |
| Path taken | contract and playbook → section 0 (`install.sh status`, `harness-app list`) → `harness-app new despesas` → `server.js` with `pg`, tables created on start → `redis.required: false` (unused) → `docker compose build` on the box → commit, push with the playbook's credential helper → `harness-app wait` → run status, `/health`, `/` → requests with `X-authentik-email` inside the container | the same, slug `salas`; overlap refused by the database, five concurrent identical bookings with one accepted |
| Deploy run of its commit | `success` | `success` |
| Checked by hand afterwards | `/health` 200, `/` 302 to the outpost, table `expenses` in `app_despesas` owned by the app's role (not superuser), no infrastructure in the compose file | `/health` 200, `/` 302, compose file unchanged, both apps in `harness-app list` |

Both reports to the person gave the URL, said it asks for the company sign-in, named the repository, said the owner defaulted to the install's admin email because none was given, and explained how to open a `local` URL from a laptop through an SSH tunnel.

What the run exposed:

- **A race in `harness-app wait`, fixed in this branch.** The embedded Authentik outpost loads a new app's provider a few seconds after `provision`; until then the forward-auth call answers 500, and `wait` checked `/` once, right after `/health`. It failed smoke test 16 of the install on this clean VM (`/ is not protected: got '500'`; the outpost logged the provider 2 s later) and would have failed the first deploy of every new app. `wait` now retries the check for up to 60 s. Round 1's first deploy needed it: `/` answered 302 three seconds after `/health`.
- The install failing at smoke test 16 was diagnosed with the playbook's own commands (section 3.2 and 4): the run list and the job log through the Gitea API.
- The agent set the commit author from its own environment (the person driving it) instead of the app owner. Harmless; the playbook asks for the owner's name and email in the commit.
- The agent deleted the rows it created while testing. That stays inside its own app's database; the contract forbids dropping databases, not cleaning test data.

| Step | Time |
|---|---|
| `install.sh --non-interactive` on the clean VM, until smoke test 16 failed on the race | 249 s |
| After the fix: `install.sh --apply --from foundation` (deployer image rebuilt), 16 passed | 44 s |
| Deploy job, start to green, first deploy of a new app (round 1 / round 2) | 15 s / 15 s |

Not covered: the install half of the path through an agent (the install itself is the same command the agent would run, tested above and in earlier records, but no cold agent asked the questions of section 1.2 yet), a box the agent runs on directly instead of through `ssh`, ingress other than `local`, and a run with another agent (the fallback `codex exec` was not needed).

## Test record: the ops tools (smoke tests 17 and 18)

On a clean Lima VM (Ubuntu 26.04.1, 2 CPU, 4 GiB, 30 GiB, Docker 29.9.1 rootless, sshd on 22), with `bootstrap/config.example.yaml` changed only in `install.profile.ops: true`, `ops.portainer`/`ops.glances: true` and `ops.wetty.install_key: true`:

| Step | Time |
|---|---|
| VM created and started | 52 s |
| `install.sh --non-interactive`, all 14 stages (first-run 33 s, optional_profiles with the terminal 33 s, smoke tests 39 s) | 317 s |
| Smoke tests: 18 passed, 0 skipped (inside the install) | |
| `install.sh --apply` again: 14 stages already completed | 0 s |
| `sso-login-check.sh --target http://{terminal,files,portainer,glances}.<domain> --expect allowed` as akadmin | PASS ×4 |
| `scripts/tests/ops-mounts.sh` | PASS |

In a browser, signed in as akadmin through Authentik: `terminal.` opened a shell on the VM as the installing user (a command ran and printed the host name); `files.` showed exactly `apps/` (with `smoke-app/`) and `backup-reports/` (the status files), under a FileBrowser user created from the SSO header.

Checked by hand on the first VM of this run:

- **Writes.** The app container writes `/data` (`DATA_DIR=/data`), and the file lands in `app-data/smoke-app/`; FileBrowser writes there too; a write to `/srv/backup-reports` fails with "Read-only file system".
- **Terminal disabled.** With `ops.wetty.enabled: false` the install completes, Wetty is not running, the handoff and `state.json` say why, and tests 17 and 18 pass on the three other tools. The same branch runs when the preflight finds no sshd: the detector returns nothing inside a container without sshd and `22` on the host.
- **Key not installed.** With `ops.wetty.install_key: false` and the key line removed from `authorized_keys`, the terminal comes up as "up, key not authorized" in `state.json` and the handoff prints the one `cat … >> ~/.ssh/authorized_keys` command.
- **Migration.** A binding of `harness-users` added by hand to the `ops-files` application is removed by the next `first-run.sh`, and the smoke user is denied again.
- **Interactive questions.** "Enable the ops tools (Portainer, Glances, web terminal, file browser)?" defaults to yes, followed by the authorized_keys question; the preflight prints the sshd port and the two file browser paths.

What broke on the way:

- **`host.docker.internal` does not reach the host's sshd under rootless Docker**: `host-gateway` resolves to the gateway inside rootlesskit's namespace, where nothing listens. The installer now tries it, then the host's own address (`ip route get`), and keeps the first one where the key sign-in works; on rootful Docker and Docker Desktop the first try should succeed (not tested).
- The installer read the image name with an inline comment from `docker/.env.example` (`WETTY_IMAGE=… # …`), and `dc up` failed silently inside the loop. The comment moved to its own line, and a failed `dc up` of Wetty is now logged.
- `derive_ops` ended with `[ -n "$SSHD_PORT" ] && WETTY_ON=true`, which returns 1 under `set -e` when there is no sshd: the installer exited with no message exactly in the no-sshd case. Fixed with `if`.
- The smoke user's password went through `env_secret … _`, whose indirection read bash's `$_` (the previous command's last argument) as a value supplied by the environment. It now has its own variable, `HARNESS_AUTHENTIK_SMOKE_USER_PASSWORD`, and is generated when that is unset.
- The path rule refused `backups/reports` when the backup destination sits inside the install directory (the default). The rule now allows `<destination>/reports` wherever the destination is.

Not tested: rootful Docker and Docker Desktop (the `host.docker.internal` path), a host without sshd end to end (only the detector and the skip branch), ingress other than `local/off`, an app image that drops to a non-root user writing `/data`.

## Test record: object storage (smoke test 19)

The `storage` profile runs Garage `dxflrs/garage:v2.4.1` (multi-arch image, pulled on the VMs below; [`install-design.md`](install-design.md#the-storage-profile) says why it replaced the earlier S3 server). Two clean Lima VMs (Ubuntu 26.04.1, 2 CPU, 4 GiB, 30 GiB, Docker 29.9.1 rootless), `bootstrap/config.example.yaml` changed only as said.

**VM 1, `install.profile.storage: true`:**

| Step | Time |
|---|---|
| VM created and started | 54 s |
| `install.sh --non-interactive`, all 14 stages: Garage started, layout version 1 applied (zone `dc1`, 100G), smoke tests 17 passed and 2 skipped (17 and 18: ops off), test 19 passed on the first run | 277 s |
| `harness-app new files-demo`, manifest with `object_storage.required: true` (database and Redis off), `server.js` with `@aws-sdk/client-s3` storing `PUT /files/<name>` and reading `GET /files/<name>`; push until `harness-app wait` saw `/health` 200 and `/` behind the SSO (first deploy, `npm install` of the SDK included) | 38 s |
| Inside the app container: `PUT /files/hello.txt`, then `GET` | `stored`, `200 hello from files-demo` |
| Redeploy with a code change, push until the run is green; the key id and the secret's fingerprint unchanged, the object still there | 29 s |
| `install.sh --apply --from foundation` on the installed box: "Garage layout version 1 already assigns 1 node(s): unchanged", 17 passed, 2 skipped | 65 s |
| `harness-backup.sh run` (11 items, `garage-data` among the volumes) / `verify --latest` | 16 s / 10 s |

**VM 2, `install.profile.storage: true` and the ops profile as in the ops record (`ops: true`, Portainer, Glances, `install_key: true`):**

| Step | Time |
|---|---|
| VM created and started | 60 s |
| `install.sh --non-interactive`: smoke tests **19 passed, 0 skipped** (core-healthy counts 11 services, Garage included; test 16 push to green in 26 s) | 406 s |
| `smoke-tests.sh` again on the installed box: 19 passed (test 19 reuses the two test apps, keys kept) | 40 s |
| From VM creation to everything green | 507 s |

Checked by hand on VM 1:

- **Env file lost the secret.** With `S3_SECRET_ACCESS_KEY` deleted from `apps/files-demo/.env`, `harness-app provision` found the key `app-files-demo` in Garage and wrote back the same id and secret ("restored").
- **Key deleted in Garage.** After `DeleteKey`, the next provision tried to import the env file's key again and Garage refused: it keeps a tombstone and never accepts a deleted key id ("KeyAlreadyExists ... Even if it is deleted"). Provision now issues a new key in that case, with a warning ("replaced"); after the redeploy the app read its object with the new key. On a wiped volume, where no tombstone exists, the env file's key is imported as it was.
- **Storage profile off.** `harness-app provision` against a copy of the install `.env` with `COMPOSE_PROFILES=backup` stopped at the manifest step with "asks for object storage but the storage profile is off"; no `apps/` directory, env file or route was created.
- **Restore.** The `garage-data` volume of the backup snapshot, restored with `restic restore` and mounted in a scratch Garage container with the same config and RPC secret: cluster healthy, bucket `app-files-demo` with 1 object of 21 bytes and the key `app-files-demo`, no block errors.
- **Secrets.** `.env` 0600 with the three `GARAGE_*` secrets; `garage/garage.toml` (0644) has none; the app's env file (0600) has `S3_*` and nothing of Garage's own; the inventory records `garage:bucket:app-files-demo` and `garage:key:app-files-demo`.
- **Rule against local storage.** A compose service running `dxflrs/garage` (or `minio`, `seaweedfs`) is refused like a local Postgres.

What broke on the way:

- The key-deleted-in-Garage case above: the first version of provision failed on the tombstone instead of issuing a new key.
- Nothing else: the install, test 19 and the app deploy passed on the first VM run.

Not tested: a real disk-full or capacity change after the first layout (`storage.capacity` is applied only once; changing it later is `garage layout assign` by hand), a restore from Garage's metadata snapshots (`meta/snapshots/` was still empty when the backup ran, an hour after start; the restore above used the live copy of the metadata on an idle box), presigned URLs through `s3.<BASE_DOMAIN>` from a browser, ingress other than `local/off`, rootful Docker.
