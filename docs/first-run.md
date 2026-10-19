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
- with the `storage` profile: `s3.<BASE_DOMAIN>` and `s3-console.<BASE_DOMAIN>` to MinIO
- with the `ops` profile: `portainer.<BASE_DOMAIN>` (its own login) and `glances.<BASE_DOMAIN>` (forward auth)

The forward-auth snippet is the one Authentik documents for nginx, in the host's advanced configuration: `auth_request` against `/outpost.goauthentik.io/auth/nginx`, the `X-authentik-*` headers passed to the app, anonymous requests redirected to `/outpost.goauthentik.io/start`. `GET /health` is left public so the installer and monitors can probe the app.

TLS per mode: `off` and `edge` create plain HTTP hosts (the Cloudflare edge terminates TLS in `edge`); `acme` requests a Let's Encrypt certificate for each host and forces HTTPS; `internal` creates the hosts without a certificate and leaves the development certificate to you (see below).

Containers resolve the public names to the proxy through network aliases, so Gitea fetches Authentik's discovery document by its public URL and the issuer in the tokens is the same one browsers see.

### Gitea

| Resource | Probe | Create or reconcile |
|---|---|---|
| Admin user | `gitea admin user list --admin` | created with `GITEA_ADMIN_PASSWORD`, no forced password change |
| Admin API token (`GITEA_ADMIN_TOKEN`) | the token answers `/api/v1/user` | generated with scope `all`, written to `.env` |
| Organization (`GITEA_ORGANIZATION`) | `GET /api/v1/orgs/<org>` | visibility limited (members and signed-in users) |
| Repository `<org>/deploy-requests` | `GET /api/v1/repos/...` | private, initialised with a README on `main`; the GitOps repository of [`gitops-flow.md`](gitops-flow.md) and the target of smoke test 12 (`GITEA_SMOKE_REPOSITORY`) |
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

Not tested: macOS as the host (Docker Desktop must share the destination directory), rootful Docker (the ownership rule in `give_back` covers it but was not exercised), the `storage` profile's MinIO volume, and a run long enough for live volume copies to matter.
