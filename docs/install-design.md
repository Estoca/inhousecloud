# Install Design

How a single box becomes a company cloud in one command, re-runnable, driven by a technical human or by a terminal-connected LLM. This document is the design; the code (`install.sh`, `first-run`, the compose profiles) is built from it. It was written from a box that has run this stack in production for months, together with the LLM agent that operates that box, and it records what that box taught us.

Companion files:

- [`bootstrap/config.example.yaml`](../bootstrap/config.example.yaml): every input the installer accepts, with defaults.
- [`bootstrap/state.example.json`](../bootstrap/state.example.json): the state file the installer keeps, stage by stage.
- [`docs/smoke-tests.md`](smoke-tests.md): the checks that decide "installed".

## Goals

- One command: `install.sh` asks a handful of questions (or reads a config file), generates secrets, brings the stack up, waits for health, runs the first-access setup, runs the smoke tests and prints the URLs.
- Idempotent: running it again on an installed box changes nothing; running it after a failure resumes at the failed stage.
- Same path for humans and agents: `--plan`, `--apply`, `--non-interactive --config <file>`, `--json`. Output is a checklist with actionable errors and a resume command. Secrets never appear in output.
- Separable: the core cloud is useful alone; everything else is a Compose profile you turn on.

## Layers as Compose Profiles

| Profile | Services | When |
|---|---|---|
| `core` (always) | reverse proxy, Authentik (with its **own** Postgres and Redis), Gitea, the Gitea Actions runners (`gitea-runner` for CI, `gitea-deployer` for deploys by push to `main`, [`gitops-flow.md`](gitops-flow.md)), the app portal, shared Postgres, shared Redis, internal network, named volumes, minimal backup (the `backup` Compose profile, on unless `backup.enabled: false`) | first boot |
| `storage` | MinIO (S3-compatible object storage) | when an app declares object storage |
| `ops` | admin tools: Portainer, Glances, a web terminal on the host (Wetty), a file browser for app data (FileBrowser); all four behind the SSO for `harness-admins` only | recommended (the interactive installer defaults to yes), never blocking |

- **The ops tools are admin access to the machine, not core.** They are what an operator reaches for first (who is eating the disk, what is in that app's data, a shell without an SSH client), so the questionnaire recommends them, but the cloud works without them and they never fail an install. Details in [The ops profile](#the-ops-profile) and [`security.md`](security.md).
- **The runners are core, not a profile.** The base experience is "push to `main`, the app is on the air"; a box without a runner cannot do it. Configs with the old `install.profile.ci` or `ci.gitea_runner.enabled` still load: the value is ignored with a warning.

Rules that came from the first box:

- **Identity does not depend on app data.** Authentik keeps its own Postgres and Redis. Core tools (Gitea, the portal) may also own their databases. The *shared* Postgres, Redis and MinIO exist for the apps built inside the cloud, and for nothing else. Gitea and the portal live as separate databases, each with its own role, on the shared Postgres instance; Authentik keeps its own.
- **Apps built inside the cloud do not bring their own database, cache or storage.** `harness-app provision` refuses a manifest or a Compose file that declares a Postgres, Redis or MinIO service, and says what to declare instead. Exceptions (`infrastructure.exception` with `reason`, `owner`, `review_by`, `migration_plan` and an expiry date) are for the portal to review later; the executor refuses them today. This is what makes the box's resource usage visible in one place.
- **The company OS, if adopted, is three ordinary apps** (tracker, MCP server, brain sync) deployed by push to `main` like any other. It has no place in the compose files.

## The ops profile

Four admin tools, each on its own name, each behind forward auth whose application is bound to `harness-admins` only (members of `harness-users` sign in and are refused):

| Name | Service | What it is |
|---|---|---|
| `terminal.<BASE_DOMAIN>` | `wetty` | a shell **on the host** (not in a container) as the user that ran `install.sh` |
| `files.<BASE_DOMAIN>` | `filebrowser` | the apps' data directories (read and write) and the backup reports (read only) |
| `portainer.<BASE_DOMAIN>` | `portainer` | containers, images, volumes, stacks; its own login behind the SSO |
| `glances.<BASE_DOMAIN>` | `glances` | host resource usage |

- **Their own network.** The four services sit on `harness-ops`, a network only the proxy joins. Apps join `harness`, so an app container cannot reach `wetty:3000` or `filebrowser:80` around the proxy; smoke test 18 proves it. Nothing publishes a host port.
- **Nothing public.** Their proxy hosts use the forward-auth snippet with no public path (no `/health` exception); the installer checks them through their Docker healthchecks.
- **Web terminal.** Wetty v4 runs `ssh` to the host's sshd with a dedicated ed25519 key, `<install-dir>/local/wetty/id_ed25519` (0600, generated once), the host key pinned in `local/wetty/known_hosts` (`StrictHostKeyChecking=yes`), public key only (no password prompt), and one allowed browser origin (`<scheme>://terminal.<BASE_DOMAIN>`). The preflight looks for sshd on 127.0.0.1 (`ops.wetty.ssh_port`, then the `Port` lines of `sshd_config`, then 22) by its banner. The installer then installs the public key in `~/.ssh/authorized_keys` of the user running it: interactively it asks (default yes); with `--non-interactive` only when `ops.wetty.install_key: true`, otherwise the handoff prints the one command that does it. It reaches the host through `host.docker.internal` (`host-gateway`) and, when that does not answer (rootless Docker keeps the host loopback away from containers), through the host's own address, and proves it with a non-interactive `ssh … true` from inside the container. **No sshd, or no way to reach it: the other three tools come up, the terminal does not, the installer says so, and nothing fails.** `state.json` records the outcome under `stages.optional_profiles.probe.ops`, and `inventory.json` under `ops`.
- **File browser.** FileBrowser sees two host paths and nothing else: `ops.filebrowser.paths.app_data` (default `<install-dir>/app-data`, one directory per app, which `harness-app provision` creates and mounts at `/data` in the app) and `ops.filebrowser.paths.backup_reports` (default `<BACKUP_DESTINATION>/reports`, read only). The preflight refuses any other path that reaches the install directory, `.env`, `apps/` (the apps' env files), `local/` (keys), the restic repository, a home directory or a system directory (`scripts/lib/opspaths.py`; `scripts/tests/ops-mounts.sh` proves the rule against the rendered compose file). Its own login is off: `auth.method=proxy` takes the user from `X-authentik-username`, which only the proxy sets; each admin gets a non-admin FileBrowser user on first visit; no admin account or default password exists.
- **Portainer and Glances** moved from the `harness` network to `harness-ops`, and both now have a provider bound to `harness-admins` (Portainer had no SSO before, only its own login; Glances had the forward-auth snippet but no provider). Portainer keeps its own login behind the SSO.

## Ingress

Five variables, not one. `BASE_DOMAIN` alone cannot say whether TLS terminates at the edge or on the box.

| Variable | Values |
|---|---|
| `INGRESS` | `local` · `private` · `public` |
| `BASE_DOMAIN` | e.g. `harness.localhost`, `apps.internal`, `cloud.example.com` |
| `PUBLIC_BASE_URL` | the portal URL users type |
| `TLS_MODE` | `off` · `internal` · `edge` · `acme` |
| `TUNNEL_PROVIDER` | `none` · `tailscale` · `cloudflared` |

Valid combinations; the installer refuses everything else in preflight:

| `INGRESS` | `TLS_MODE` | `TUNNEL_PROVIDER` | Meaning |
|---|---|---|---|
| `local` | `off` | `none` | default for a first try: ports on `127.0.0.1`, `*.localhost` names, HTTP |
| `local` | `internal` | `none` | same, with a development certificate |
| `private` | `internal` | `tailscale` | default private cloud: reachable on the tailnet only |
| `public` | `edge` | `cloudflared` | TLS at the Cloudflare edge, tunnel to the box |
| `public` | `acme` | `none` | public DNS straight to the proxy, Let's Encrypt |
| `public` | `acme` | `cloudflared` | end-to-end TLS through the tunnel |

Refused: `local` with any tunnel; `private` without Tailscale; `public` with `TLS_MODE=off`; `edge` without cloudflared; `acme` in `local`; `private` with cloudflared; `public` with Tailscale (a future `funnel` mode could allow it).

For a company of about thirty people the recommended mode is `private`: a private domain with split DNS over Tailscale, not MagicDNS as the app URL. MagicDNS is fine for administering the machine; a private domain keeps `BASE_DOMAIN`, wildcard routing, stable per-app URLs and a single proxy.

## Execution Model

Preflight → plan → apply → verify → handoff. Copied from how agent frameworks install themselves, because it is the shape a human and an LLM can both follow.

- Every stage writes to `state.json` (status, attempts, timestamps, config hash, probe result, resources created, error code, resume command). Re-running resumes the first incomplete stage.
- Every action probes before it creates: does it exist, is it healthy, does the configuration match. Creation is the exception path.
- `first-run` is a separate, repeatable stage, safe against duplication.
- Modes: `--plan` (print what would happen), `--apply`, `--non-interactive --config <file>`, `--json`.
- Output: paths, ids, status, URLs. Never secrets.

## The Sequence

1. Preflight: OS, Docker, Compose v2, disk, memory, free ports, permissions, ingress matrix.
2. Read configuration, interactive or from file.
3. Validate `INGRESS`, domain or URL, profiles, tunnel token when applicable.
4. Create the install directory, `state.json`, `.env` with mode `0600`, local backup folders.
5. Generate random secrets without displaying them.
6. Render the Compose file and derived configs for the chosen profiles.
7. Create networks and persistent volumes.
8. Start Authentik's Postgres and Redis; wait for health.
9. Start Authentik server and worker; wait for the API.
10. Start the shared Postgres and Redis; wait for health.
11. Start the proxy and ingress; validate a local route.
12. Start Gitea; wait for API and SSH.
13. Start the portal, apply its migrations, wait for `/health`.
14. `first-run`: Gitea admin and organization; Authentik bootstrap; OIDC between Authentik and Gitea; minimum groups; portal access.
15. Protected route for the portal on the proxy with forward auth.
16. Backup job: start the backup container, run and verify the first backup ([`backup.md`](backup.md)).
17. The Gitea Actions runners (core, started once Gitea can issue their registration tokens) and the optional profiles: `storage`, `ops` (the web terminal last, and only when it can sign in to the host's sshd).
18. Smoke tests ([`docs/smoke-tests.md`](smoke-tests.md)); test 16 deploys an app by push to `main`.
19. Write the final inventory, URLs, completed state and the status command.

## First Access: Automated Versus Human

Automated by the installer:

- `.env` with `0600`, random keys and passwords.
- Start and wait for every healthcheck.
- Gitea admin and organization via CLI or API.
- Authentik OIDC provider, Gitea registered as its client with the callback derived from the final URL, OIDC source created in Gitea.
- Authentik Application, Proxy Provider and Embedded Outpost for the portal and later for every app.
- Proxy host, TLS and forward auth.

Decided by a human, asked for by the installer, never guessed:

- Public domain, tunnel account and DNS, Cloudflare or Tailscale credentials.
- Group policy: who is admin, which groups reach Gitea and the portal.
- First MFA enrollment, recovery codes, replacing the bootstrap password.
- SMTP, account recovery, invitation policy.
- Any migration or import of an existing installation.

## Provisioning: Installer Versus Executor

`install.sh` creates platform resources only: networks, volumes, the portal's and Gitea's databases and roles, Authentik's database, the initial Gitea organization and admin, the runners. It creates nothing for future apps.

Per app, the executor is **`scripts/harness-app.sh provision`**, run by the app's own deploy job on every push to `main` ([`gitops-flow.md`](gitops-flow.md)). After validating the manifest and the Compose file, and before the containers start, it ensures: database and role (`LOGIN NOSUPERUSER`, random password, `REVOKE CONNECT FROM PUBLIC`); `DATABASE_URL` written only to the app's local secret store, `<install-dir>/apps/<slug>/.env` (0600); a Redis ACL user limited to the `<slug>:` prefix; a bucket per slug with its own credential and policy (never the root credential), only when the manifest asks and the `storage` profile is on; the Authentik provider and application and the proxy host with forward auth; and an inventory record with owner and date in `inventory.json`. It is idempotent (a re-run keeps every password) and never deletes a database, bucket, route or namespace. Declared migrations are the app's own job at start for now.

This was designed as the portal's job. It is a script because the portal is read-only by design (below) and because a script in the deploy job runs with the push that approved it and logs where the team already looks. A later portal shows what the executor did; it does not have to do it.

Sequence on a box that already has apps with local services: register and audit allocations; migrate one local Postgres as a canary; refuse local Postgres in new apps (the executor already does); migrate local Redis and MinIO; only then refuse every local resource.

## The Portal

The portal is the brain the installer boots in step 13, and it is **read-only**. It reads state from where it lives (the git host's CI runs, Docker, the proxy, the identity provider, the shared services, the backup status file) instead of being written to by workflows, tokens or agents. Deploys are CI on push (`harness-app` in the deploy job); the portal shows them. It serves two views of the same data: a page for people and `GET /api/platform/status` as JSON for agents, with one entry per core service and the age of the newest backup.

The first box learned this the hard way: a write API with per-user tokens let any employee repoint any domain through a forged deploy event. Removing the write surface removed the class of bug.

## Backup

Minimum, part of `core`:

- Daily custom-format dump of every Postgres database plus a global dump of roles, written straight to the backup destination, never staged on the system disk.
- Daily backup of the Gitea, proxy, Authentik and MinIO volumes and of the harness configuration.
- Deduplicated, encrypted repository (restic or equivalent); retention 7 daily, 4 weekly, 12 monthly. With deduplication, a year of retention of a mostly stable dataset costs a few times one snapshot, not twenty-three.
- An encrypted off-site copy of the same repository.
- Checksum and a status file per run; the portal reads the status file and alarms when the newest backup is older than the configured maximum.
- A monthly restore rehearsal into an isolated target, one database per month, everything once a year.
- **A lock and a hard timeout on the job.** On the first box a run hung for two days and silently blocked the next two nightly runs; the only thing that noticed was the portal's backup card. A hung run must be killed, recorded as failed and alarmed, never left to block tomorrow.

What is built ([`backup.md`](backup.md)) and what is next:

| Item | State |
|---|---|
| `pg_dump -Fc` of every database of both Postgres instances plus `pg_dumpall --globals-only`, streamed into the repository | built |
| Gitea, proxy, Authentik and MinIO volumes, and the install directory | built |
| restic repository encrypted with `BACKUP_ENCRYPTION_KEY`, retention 7/4/12 per item | built |
| Lock, hard timeout `BACKUP_MAX_RUN_MINUTES`, hung or vanished runs recorded as failed | built |
| Manifest with checksums per run and `reports/latest-status.json` for the portal | built |
| `verify --latest` as smoke test 14 | built |
| Scheduling: a sidecar container with crond (`backup` profile) | built |
| Encrypted off-site copy of the repository | next |
| Monthly restore rehearsal into an isolated target | next |
| The portal's backup card and alarm on age | next (portal project; the status file is ready) |

## What the First Box Taught Us

- The shared services existed and nothing used them; apps kept bringing their own Postgres, Redis and MinIO. The rule in the manifest and the executor in the portal are what make the "controlled machine" true, not the compose file.
- The system disk filled up because Docker build cache and superseded images accumulated with every deploy (dozens of GB). Pruning build cache is free; removing tagged images needs a list of what rebuilds from where before deleting.
- On a Mac, Docker's virtual disk does not hand freed space back to the host file system; set a maximum disk image size rather than compacting a running image.
- A bind mount that lives only in an out-of-repo override disappears on the next rebuild. Every mount the portal needs is declared in the compose file with a variable.
- The portal listening on `0.0.0.0` with the proxy forwarding to the LAN IP means "reachable only through the proxy" is not true. Put the portal on the proxy's Docker network and publish its port on `127.0.0.1` only, or not at all.
- Permissions on the host (macOS removable volumes, Full Disk Access) stop an agent before any script does; the installer must say which permission it needs and stop, not fail obscurely.
