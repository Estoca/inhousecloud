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
| `storage` | Garage (S3-compatible object storage): one bucket and one key per app | when an app declares object storage |
| `ops` | admin tools: Portainer, Glances, a web terminal on the host (Wetty), a file browser for app data (FileBrowser); all four behind the SSO for `ihc-admins` only | recommended (the interactive installer defaults to yes), never blocking |
| `agent` | the operator agent (OpenClaw) and its read-only Docker API ([The agent profile](#the-agent-profile)) | opt-in (default no): needs an LLM key and a chat channel from a human |

- **The ops tools are admin access to the machine, not core.** They are what an operator reaches for first (who is eating the disk, what is in that app's data, a shell without an SSH client), so the questionnaire recommends them, but the cloud works without them and they never fail an install. Details in [The ops profile](#the-ops-profile) and [`security.md`](security.md).
- **The runners are core, not a profile.** The base experience is "push to `main`, the app is on the air"; a box without a runner cannot do it. Configs with the old `install.profile.ci` or `ci.gitea_runner.enabled` still load: the value is ignored with a warning.

Rules that came from the first box:

- **Identity does not depend on app data.** Authentik keeps its own Postgres and Redis. Core tools (Gitea, the portal) may also own their databases. The *shared* Postgres, Redis and object storage exist for the apps built inside the cloud, and for nothing else. Gitea and the portal live as separate databases, each with its own role, on the shared Postgres instance; Authentik keeps its own.
- **Apps built inside the cloud do not bring their own database, cache or storage.** `ihc-app provision` refuses a manifest or a Compose file that declares a Postgres, Redis or S3 server, and says what to declare instead. Exceptions (`infrastructure.exception` with `reason`, `owner`, `review_by`, `migration_plan` and an expiry date) are for the portal to review later; the executor refuses them today. This is what makes the box's resource usage visible in one place.
- **The company OS, if adopted, is three ordinary apps** (tracker, MCP server, brain sync) deployed by push to `main` like any other. It has no place in the compose files.

## The storage profile

Object storage for apps is [Garage](https://garagehq.deuxfleurs.fr/) (`dxflrs/garage`, a versioned tag in `GARAGE_IMAGE`), one node:

- `install.sh` renders `<install-dir>/garage/garage.toml` (no secrets in it: `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` and `GARAGE_METRICS_TOKEN` come from `.env`), starts the service in stage `optional_profiles` and, the first time, gives the node a role in the layout (zone `dc1`, capacity `storage.capacity`, 100G by default) and applies it. A re-run sees the role and changes nothing.
- The S3 API is `garage:3900` on the ihc network and `s3.<BASE_DOMAIN>` through the proxy, without forward auth (requests are signed by the app's key). There is no console: Garage has none, and its admin API (`3903`) is not routed.
- Per app, `ihc-app provision` uses the admin API through `garage json-api` inside the container (payloads on stdin): bucket `app-<slug>`, key `app-<slug>` with read and write on that bucket only, `S3_*` in the app's env file ([`app-contract.md`](app-contract.md#what-the-app-receives)).
- Data and metadata live in the volume `garage-data`, backed up with the other volumes; Garage writes a consistent metadata snapshot every 6 hours in `meta/snapshots/` ([`backup.md`](backup.md)).

**Why Garage and not MinIO.** The first designs used MinIO. By October 2026 its images were no longer available: `quay.io/minio/minio` answers 401 for the pinned release and for `latest`, `minio/minio` is gone from Docker Hub, and the last community release on GitHub is from October 2025, so the community distribution ended. Pinning another tag was not an option. Garage is a single binary, maintained, with versioned images, and its admin API (`CreateBucket`, `ImportKey`, `AllowBucketKey`, layout calls) is scriptable without a client in the image. SeaweedFS was the fallback had Garage lacked per-bucket key permissions; it did not.

## The ops profile

Four admin tools, each on its own name, each behind forward auth whose application is bound to `ihc-admins` only (members of `ihc-users` sign in and are refused):

| Name | Service | What it is |
|---|---|---|
| `terminal.<BASE_DOMAIN>` | `wetty` | a shell **on the host** (not in a container) as the user that ran `install.sh` |
| `files.<BASE_DOMAIN>` | `filebrowser` | the apps' data directories (read and write) and the backup reports (read only) |
| `portainer.<BASE_DOMAIN>` | `portainer` | containers, images, volumes, stacks; its own login behind the SSO |
| `glances.<BASE_DOMAIN>` | `glances` | host resource usage |

- **Their own network.** The four services sit on `ihc-ops`, a network only the proxy joins. Apps join `ihc`, so an app container cannot reach `wetty:3000` or `filebrowser:80` around the proxy; smoke test 18 proves it. Nothing publishes a host port.
- **Nothing public.** Their proxy hosts use the forward-auth snippet with no public path (no `/health` exception); the installer checks them through their Docker healthchecks.
- **Web terminal.** Wetty v4 runs `ssh` to the host's sshd with a dedicated ed25519 key, `<install-dir>/local/wetty/id_ed25519` (0600, generated once), the host key pinned in `local/wetty/known_hosts` (`StrictHostKeyChecking=yes`), public key only (no password prompt), and one allowed browser origin (`<scheme>://terminal.<BASE_DOMAIN>`). The preflight looks for sshd on 127.0.0.1 (`ops.wetty.ssh_port`, then the `Port` lines of `sshd_config`, then 22) by its banner. The installer then installs the public key in `~/.ssh/authorized_keys` of the user running it: interactively it asks (default yes); with `--non-interactive` only when `ops.wetty.install_key: true`, otherwise the handoff prints the one command that does it. It reaches the host through `host.docker.internal` (`host-gateway`) and, when that does not answer (rootless Docker keeps the host loopback away from containers), through the host's own address, and proves it with a non-interactive `ssh … true` from inside the container. **No sshd, or no way to reach it: the other three tools come up, the terminal does not, the installer says so, and nothing fails.** `state.json` records the outcome under `stages.optional_profiles.probe.ops`, and `inventory.json` under `ops`.
- **File browser.** FileBrowser sees two host paths and nothing else: `ops.filebrowser.paths.app_data` (default `<install-dir>/app-data`, one directory per app, which `ihc-app provision` creates and mounts at `/data` in the app) and `ops.filebrowser.paths.backup_reports` (default `<BACKUP_DESTINATION>/reports`, read only). The preflight refuses any other path that reaches the install directory, `.env`, `apps/` (the apps' env files), `local/` (keys), the restic repository, a home directory or a system directory (`scripts/lib/opspaths.py`; `scripts/tests/ops-mounts.sh` proves the rule against the rendered compose file). Its own login is off: `auth.method=proxy` takes the user from `X-authentik-username`, which only the proxy sets; each admin gets a non-admin FileBrowser user on first visit; no admin account or default password exists.
- **Portainer and Glances** moved from the `ihc` network to `ihc-ops`, and both now have a provider bound to `ihc-admins` (Portainer had no SSO before, only its own login; Glances had the forward-auth snippet but no provider). Portainer keeps its own login behind the SSO.

## The agent profile

An operator agent on the box, opt-in (`install.profile.agent`, the interactive installer asks "Enable the operator agent (needs an LLM API key and a chat channel)?", default no). It is a layer over the core, not part of it: the core's happy path (provision, start, route) stays deterministic in scripts and Actions and works with no agent at all. The agent handles what needs judgment (diagnosis, disk, a stuck backup, "why did it go down") and asks a human for what needs a yes. The cloud defines the contract ([`operator-contract.md`](operator-contract.md)), the runbooks ([`runbooks/`](runbooks/)) and the map (`scripts/ihc-operator.sh brief`); the tool is replaceable. The reference implementation is [OpenClaw](https://openclaw.ai):

| Service | What |
|---|---|
| `agent` | `openclaw/openclaw:<release>-slim`, gateway bound to the container's loopback, no port and no route. User `0:0` under rootless Docker (that is the installing user), the installing user's uid otherwise; all capabilities dropped |
| `docker-ro` (core) | `docker/agent/docker-ro-proxy.py` on a pinned `python:alpine`: the Docker API as GET on an allowlist, `Env` as names only, read-only root, no capabilities; writes only with `ops.agent.allow_write` and only for the agent's container ([`security.md`](security.md)). Core since the portal reads through it too; the agent reaches it as `agent-docker-proxy` |

- **Workspace, `<install-dir>/agent/`.** `state/` (OpenClaw's config `openclaw.json` and its sessions, 0700), `workspace/` (`AGENTS.md`, which sends the agent to the contract, the brief and the runbooks first; its notes and incident records) and `reference/` (mounted read only inside `workspace/`: `operator-contract.md`, `runbooks/`, `brief.md`, `brief.json`, `bin/ihc-ro`). `scripts/ihc-operator.sh agent-sync` refreshes it; `install.sh` runs it, and `ihc-app provision` regenerates the brief after each deploy.
- **The brief is generated.** From `state.json`, the rendered compose file, `inventory.json` and `docker ps`, plus what the cloud knows of each core service. Never by hand, never a value.
- **Keys and channel come from a human.** `AGENT_ANTHROPIC_API_KEY` or `AGENT_OPENAI_API_KEY`, and `AGENT_SLACK_BOT_TOKEN` + `AGENT_SLACK_APP_TOKEN` (Socket Mode) or `AGENT_TELEGRAM_BOT_TOKEN`, in `.env` or exported as `IHC_AGENT_*` before `install.sh`. The installer never generates them and never fails without them: the agent comes up, reads the box, and cannot answer until they exist; the preflight and the handoff say so. After adding them: `install.sh --apply --from optional_profiles`.
- **Config the installer owns.** In `openclaw.json` it sets `gateway.mode`, the workspace, `skipBootstrap`, the model (`ops.agent.model`) and the channel blocks with tokens by environment reference and the access policy (`ops.agent.allow_from`, else pairing; Telegram groups from `ops.agent.groups`, mention only, senders from `ops.agent.group_allow_from`); everything else in the file is left alone. After `up` it starts each configured channel explicitly: after a few restarts in a row OpenClaw's crash-loop breaker stops starting it on boot, and the bot goes silent while the container is healthy. The container has its own memory limit (`AGENT_MEM_LIMIT`, 3g) and the box needs 6 GiB with the agent on: a turn takes the gateway to about 1.9 GiB.
- **Started** in the `optional_profiles` stage, after the ops tools; the stage checks that the agent reaches the Docker API through the filter. Smoke test 20 checks the isolation.

## Ingress

Five variables, not one. `BASE_DOMAIN` alone cannot say whether TLS terminates at the edge or on the box.

| Variable | Values |
|---|---|
| `INGRESS` | `local` · `private` · `public` |
| `BASE_DOMAIN` | e.g. `cloud.localhost`, `apps.internal`, `cloud.example.com` |
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

### Private ingress (`private` / `internal` / `tailscale`)

Built and tested end to end ([`first-run.md`](first-run.md#private-ingress-run)). Every app is `https://<slug>.<BASE_DOMAIN>`, no port, on the tailnet only, with a certificate browsers accept once the cloud CA is installed.

```text
device on the tailnet --DNS--> <tailnet IP>:53  tailnet-dns (CoreDNS): *.<BASE_DOMAIN> = <tailnet IP>
                      --TLS--> <tailnet IP>:443 tailscale (serve, TCP forward) --> proxy:443 --> app
the box itself: proxy, Gitea SSH and control ports on 127.0.0.1 only
```

| Piece | What the installer does |
|---|---|
| Tailscale node | service `tailscale` (`tailscale/tailscale`, pinned): userspace networking in **its own** network namespace, state in the volume `tailscale-state`, name `ingress.tailscale.hostname`. Its serve config (`<install-dir>/tailscale/serve.json`) forwards tailnet ports 80 and 443 to `proxy` and the Gitea SSH port to `gitea:22` as raw TCP: TLS ends at the proxy |
| Auth key | `IHC_TAILSCALE_AUTHKEY`, read from the installer's environment for the first login only and never written to `.env`: compose gets it from the installer's process, the node logs in, and the container is recreated without it. The node then lives on its state; a re-run with the node logged in needs no key (a value an older install left in `.env` is blanked) |
| TLS | a CA of the installation's own in `<install-dir>/local/ca/` (`ca.key` 0600, `ca.crt` public), **name-constrained to `BASE_DOMAIN`** and to no IP address, 10 years; a wildcard `*.<BASE_DOMAIN>` certificate signed by it (397 days, renewed by any install run when 30 days remain), uploaded to the proxy as a custom certificate and attached to every host with HTTPS forced. Gitea trusts the CA through `SSL_CERT_DIR`, because it calls Authentik's OIDC endpoints by the public name |
| DNS | service `tailnet-dns` (CoreDNS, pinned) in the node's namespace, bound to its loopback, answering every `*.<BASE_DOMAIN>` with the node's tailnet address (empty answers for other types, other zones refused). The tailnet's split DNS, a nameserver set in the Tailscale admin console, points `BASE_DOMAIN` at it; the installer cannot set that, and the handoff says exactly what to enter |
| Checks | the `proxy_ingress` stage fails unless `portal.<BASE_DOMAIN>` resolves to the tailnet address on the node, and says whether the tailnet's own resolver already does (the console step); smoke test 21 checks the surface and the certificate |

Decisions:

- **`tailscale serve` from a separate namespace, not the node inside the proxy's namespace.** Sharing the proxy's namespace is the usual sidecar recipe, but in userspace mode Tailscale forwards *every* tailnet port to the namespace's loopback, which would have put the proxy admin (81) and its API on the tailnet. In its own namespace the node exposes what serve forwards plus the DNS server, nothing else. The cost: the proxy sees the node's address as the client, not the person's tailnet address.
- **Own CA, not `tailscale cert`.** Tailscale certificates cover the node's MagicDNS name only (no wildcard, no private domain): one URL for the box instead of one per app. The name constraint means a device that trusts the CA trusts nothing outside `BASE_DOMAIN`.
- **A DNS server on the node, not public records.** A private domain (`.internal` is reserved for this) has no public DNS; split DNS needs a nameserver on the tailnet, and the node is the one place that knows its own address.
- **Nothing published beyond loopback** (`BIND_ADDRESS=127.0.0.1` in `private`): the LAN does not see the proxy; the installer's checks use the loopback ports and the tailnet path.

What `main` had before: the ingress matrix in preflight; a `tailscale` container in userspace mode on the ihc network, with `TS_AUTHKEY` kept in `.env` and nothing routed through it; `BIND_ADDRESS=0.0.0.0`; proxy hosts created without a certificate in `internal` (the preflight told the person to upload one by hand); no DNS for `BASE_DOMAIN`; every installer check and smoke test speaking plain HTTP to the proxy.

## Execution Model

Preflight → plan → apply → verify → handoff. Copied from how agent frameworks install themselves, because it is the shape a human and an LLM can both follow.

- Every stage writes to `state.json` (status, attempts, timestamps, config hash, probe result, resources created, error code, resume command). Re-running resumes the first incomplete stage.
- Every action probes before it creates: does it exist, is it healthy, does the configuration match. Creation is the exception path.
- `first-run` is a separate, repeatable stage, safe against duplication.
- Modes: `--plan` (print what would happen; a dry run that creates nothing: no install directory, `state.json`, `config.yaml` or backup directory, its record in a temporary file deleted on exit; the plan shown before "Apply this plan now?" is the same dry run), `--apply`, `--non-interactive --config <file>`, `--json`.
- After the install: `handoff` (the seven day-zero steps again), `status` (short: state, URLs, core health, backup age, apps with owners; `--verbose` adds every stage and the operator brief; `--json` is the state file), `doctor` (every check of a running box, read only, with what to do for each failure: `scripts/ihc-doctor.sh`), `stop` / `start` (the cloud and its apps, data kept) and `remove` (a test install, after typing the project name; `--images`, `--dir`): [`cleanup.md`](cleanup.md). The handoff stage also writes `<install-dir>/ihc`, a shortcut to this installation's commands from the checkout that installed it (`ihc doctor`, `ihc status`, `ihc handoff`, `ihc brief`, `ihc app`, `ihc backup`); `inventory.json` names it as `doctor_command`.
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

Per app, the executor is **`scripts/ihc-app.sh provision`**, run by the app's own deploy job on every push to `main` ([`gitops-flow.md`](gitops-flow.md)). After validating the manifest and the Compose file, and before the containers start, it ensures: database and role (`LOGIN NOSUPERUSER`, random password, `REVOKE CONNECT FROM PUBLIC`); `DATABASE_URL` written only to the app's local secret store, `<install-dir>/apps/<slug>/.env` (0600); a Redis ACL user limited to the `<slug>:` prefix; a bucket `app-<slug>` with its own access key, allowed to read and write that bucket only (never Garage's RPC secret or admin token), only when the manifest asks and the `storage` profile is on; the Authentik provider and application and the proxy host with forward auth; and an inventory record with owner and date in `inventory.json`. It is idempotent (a re-run keeps every password) and never deletes a database, bucket, route or namespace. Declared migrations are the app's own job at start for now.

This was designed as the portal's job. It is a script because the portal is read-only by design (below) and because a script in the deploy job runs with the push that approved it and logs where the team already looks. A later portal shows what the executor did; it does not have to do it.

Sequence on a box that already has apps with local services: register and audit allocations; migrate one local Postgres as a canary; refuse local Postgres in new apps (the executor already does); migrate local Redis and object storage; only then refuse every local resource.

## The Portal

The portal is the brain the installer boots in step 13, and it is **read-only**. It reads state from where it lives (the git host's CI runs, Docker, the proxy, the identity provider, the shared services, the backup status file) instead of being written to by workflows, tokens or agents. Deploys are CI on push (`ihc-app` in the deploy job); the portal shows them. It serves two views of the same data: a page for people and `GET /api/platform/status` as JSON for agents, with one entry per core service and the age of the newest backup.

How it is wired (portal/ of this repository, built by the `portal` stage): the service `portal` builds `<install-dir>/portal` (a copy of `portal/`), listens on 8080 and applies its own migrations to `ihc_platform` at boot (`/health` reports them; the stage fails on a failed migration). It reads `inventory.json` from `<install-dir>/catalog/`, mounted read only (the file lives there; `<install-dir>/inventory.json` is a symlink, and every writer goes through `scripts/lib/inventory.py`, which replaces the file next to its real path), the backup status from `<BACKUP_DESTINATION>/reports` read only, Docker through `docker-ro` (never the socket), each app's health and SSO through the proxy with its Host header (as `ihc doctor`), Gitea with the read-only token, and the proxy, Authentik and Garage by their health only (no admin password or token). Who the person is comes from the forward auth headers, trusted only from the proxy; the role from the groups (`ihc-admins` admin, `ihc-users` viewer: the portal's Authentik application is bound to both, and the platform status and the People page answer 403 to a viewer). People and groups come from the Authentik API with the token of a read-only service account, `ihc-portal` (`view_user` and `view_group` only), which first-run creates and keeps ([`security.md`](security.md#the-portal-who-sees-what-and-its-authentik-account)). The inventory's `schema_version` and the contract test on both sides (`scripts/tests/inventory-contract.sh`, `portal/test/inventory-ihc.test.js`) keep the two from drifting apart silently. Not yet: a service token for agents on `GET /api/platform/status`, and the MCP gateway.

The first box learned this the hard way: a write API with per-user tokens let any employee repoint any domain through a forged deploy event. Removing the write surface removed the class of bug.

## Backup

Minimum, part of `core`:

- Daily custom-format dump of every Postgres database plus a global dump of roles, written straight to the backup destination, never staged on the system disk.
- Daily backup of the Gitea, proxy, Authentik and Garage volumes and of the cloud configuration.
- Deduplicated, encrypted repository (restic or equivalent); retention 7 daily, 4 weekly, 12 monthly. With deduplication, a year of retention of a mostly stable dataset costs a few times one snapshot, not twenty-three.
- An encrypted off-site copy of the same repository.
- Checksum and a status file per run; the portal reads the status file and alarms when the newest backup is older than the configured maximum.
- A monthly restore rehearsal into an isolated target, one database per month, everything once a year.
- **A lock and a hard timeout on the job.** On the first box a run hung for two days and silently blocked the next two nightly runs; the only thing that noticed was the portal's backup card. A hung run must be killed, recorded as failed and alarmed, never left to block tomorrow.

What is built ([`backup.md`](backup.md)) and what is next:

| Item | State |
|---|---|
| `pg_dump -Fc` of every database of both Postgres instances plus `pg_dumpall --globals-only`, streamed into the repository | built |
| Gitea, proxy, Authentik and Garage (`storage` profile) volumes, and the install directory | built |
| restic repository encrypted with `BACKUP_ENCRYPTION_KEY`, retention 7/4/12 per item | built |
| Lock, hard timeout `BACKUP_MAX_RUN_MINUTES`, hung or vanished runs recorded as failed | built |
| Manifest with checksums per run and `reports/latest-status.json` for the portal | built |
| `verify --latest` as smoke test 14 | built |
| Scheduling: a sidecar container with crond (`backup` profile) | built |
| Encrypted off-site copy of the repository | next |
| Monthly restore rehearsal into an isolated target | next |
| The portal's backup card and alarm on age | next (portal project; the status file is ready) |

## Renamed twice: Open Company App Harness, Open Company Cloud, InHouseCloud

The project has had three names, none of them announced:

- Until 2026-10-20, **Open Company App Harness** (repository `open-company-app-harness`). It began as a harness around coding agents and became the company's cloud on one machine.
- From 2026-10-20 to 2026-10-21, **Open Company Cloud** (`open-company-cloud`, prefix `occ`), the name of what it is, next to its sibling Open Company OS. A trademark search the next day showed "OpenCompany" already carried three open-source AI-agent projects and "OpenCloud" live marks held by other companies.
- Since 2026-10-21, **InHouseCloud** (`inhousecloud`, prefix `ihc`): the company's own cloud, with no collision in trademark databases, GitHub or package registries. The prose name is InHouseCloud; slugs, directories, images and networks use `inhousecloud`; commands, variables and groups use `ihc`.

Every name changed at once, both times:

| What | Harness (until 2026-10-20) | Open Company Cloud (2026-10-20) | InHouseCloud (now) |
|---|---|---|---|
| Product, repository | Open Company App Harness, `open-company-app-harness` | Open Company Cloud, `open-company-cloud` | InHouseCloud, `inhousecloud` |
| Commands | `scripts/harness-app.sh`, `harness-backup.sh`, `harness-operator.sh`; the agent's `harness-ro` | `scripts/occ-app.sh`, `occ-backup.sh`, `occ-operator.sh`; `occ-ro` | `scripts/ihc-app.sh`, `ihc-backup.sh`, `ihc-operator.sh`; `ihc-ro` |
| Variables | `HARNESS_*` (`HARNESS_INSTALL_DIR`, `HARNESS_TAILSCALE_AUTHKEY`, `HARNESS_AGENT_*`, the `*_env` names in the config) | `OCC_*` | `IHC_*` |
| Compose project, networks | `harness`, `harness-ops`, `harness-agent` | `occ`, `occ-ops`, `occ-agent` | `ihc`, `ihc-ops`, `ihc-agent` |
| Deploy runner label, app overlay | `harness-deploy`, `apps/<slug>/compose.harness.yml` | `occ-deploy`, `compose.occ.yml` | `ihc-deploy`, `apps/<slug>/compose.ihc.yml` |
| Authentik groups | `harness-admins`, `harness-users` | `occ-admins`, `occ-users` | `ihc-admins`, `ihc-users` |
| Probe header | `X-Harness-Probe` | `X-OCC-Probe` | `X-IHC-Probe` |
| Default install directory | `/opt/open-company-harness` | `/opt/open-company-cloud` | `/opt/inhousecloud` |
| Example domains | `harness.localhost`, `harness.internal` | `cloud.localhost`, `cloud.example.internal` | unchanged: `cloud.localhost`, `cloud.example.internal` (a placeholder: use a name you control, e.g. `apps.internal`) |
| Shared Postgres superuser and database, portal database | `harness`, `harness_platform` | `occ`, `occ_platform` | `ihc`, `ihc_platform` |
| Tailnet hostname | `harness` | `occ` | `ihc` |

The commands stay three, each with its own file, rather than one `ihc` with subcommands: the rename changes names, not behavior, and the deploy workflow, the runbooks and the agent's instructions call them by path.

What still reads the previous names: the `OCC_*` variables (in the environment, and as the `*_env` names of a config) and nothing else, for this version only (the next one removes them), each with a warning. Not the `HARNESS_*` variables (their fallback of 2026-10-20 went with this rename, since nothing was published between the two); not the old command names (`occ-app.sh`, `occ-backup.sh`, `occ-operator.sh`, `occ-ro` and their `harness-` forms do not exist any more, and nothing answers to them); not an installation made under a previous name (below).

- **Environment.** Every script that sources `scripts/lib/common.sh` (`install.sh`, `ihc-app`, `ihc-backup`, `ihc-operator`, first-run, the smoke tests) reads `OCC_<X>` as `IHC_<X>` when `IHC_<X>` is unset, and warns once per name: `[!!] OCC_INSTALL_DIR is the old name of IHC_INSTALL_DIR ...`.
- **Config.** A `config.yaml` written for Open Company Cloud loads. Its `*_env` values `OCC_<X>` are read as `IHC_<X>`, and values that carry the old defaults (`/opt/open-company-cloud`, `occ-admins`, `occ-users`, `occ_platform`, the tailnet hostname `occ`) are used as given. `install.sh` says both in two warning lines at the start of the run. A config from the Harness days (`HARNESS_*`, `harness.localhost`) is not read any more.

What does not carry over: an installation made under a previous name. It keeps its `.env`, Compose project, networks, volumes, app overlays, deploy runner and groups under that name, and there is no in-place migration. This checkout does not operate it with the old names either: `install.sh` (`status`, `handoff`, `stop`, `start`, `remove`, `--plan`, `--apply`), `ihc-operator`, `ihc-app`, `ihc-backup` and `ihc doctor` (its `install` check) stop with one message that says which name the installation uses, that it does not migrate, and how to remove it ([`scripts/lib/legacy.py`](../scripts/lib/legacy.py)). It tells by what the installation itself recorded: the foundation's network and volumes in `state.json`, `COMPOSE_PROJECT_NAME` and the `HARNESS_`/`OCC_` network variables in `.env`, the `compose.harness.yml` or `compose.occ.yml` overlays in `apps/`; not by the values an old config carries over on purpose (groups, install directory), so a new installation made from an Open Company Cloud config is not taken for an old one (`scripts/tests/legacy-install.sh`). The way forward is to remove it, with the `install.sh remove` of a checkout of that time for `occ` or by hand ([`cleanup.md`](cleanup.md#an-installation-made-under-a-previous-name)), and install fresh; copy out first what you want to keep, since nothing moves over by itself. App repositories created under a previous name carry a deploy workflow for the `harness-deploy` or `occ-deploy` runner: regenerate it from `templates/app/.gitea/workflows/deploy.yml`.

## What the First Box Taught Us

- The shared services existed and nothing used them; apps kept bringing their own Postgres, Redis and object storage. The rule in the manifest and the executor in the portal are what make the "controlled machine" true, not the compose file.
- The system disk filled up because Docker build cache and superseded images accumulated with every deploy (dozens of GB). Pruning build cache is free; removing tagged images needs a list of what rebuilds from where before deleting.
- On a Mac, Docker's virtual disk does not hand freed space back to the host file system; set a maximum disk image size rather than compacting a running image.
- A bind mount that lives only in an out-of-repo override disappears on the next rebuild. Every mount the portal needs is declared in the compose file with a variable.
- The portal listening on `0.0.0.0` with the proxy forwarding to the LAN IP means "reachable only through the proxy" is not true. Put the portal on the proxy's Docker network and publish its port on `127.0.0.1` only, or not at all.
- Permissions on the host (macOS removable volumes, Full Disk Access) stop an agent before any script does; the installer must say which permission it needs and stop, not fail obscurely.
