# ihc doctor

Is the cloud on the air, and if not, what to do. The doctor checks the installation and its apps, reports each finding as `ok`, `warn` or `fail`, and offers a literal next command. Its [version 2 contract](doctor-contract.md) preserves the fields read by the operator agent and adds supported repairs.

```bash
cd /opt/inhousecloud && ./ihc doctor
./install.sh doctor --lint --json
scripts/ihc-doctor.sh --install-dir /opt/inhousecloud --fix --yes --json
```

All three entry points accept `--verbose`, `--json`, `--lint`, `--fix` and `--yes`. `--verbose` adds evidence. Human output goes to stderr and ends with **Fix now**, **Recommended**, **Repaired**, in that order, listing check names and details; the first two groups include actions. With `--json`, stdout contains only the JSON document.

## Modes and exit codes

| Mode | Writes and confirmation |
|---|---|
| No mode flag (`report`) | Reads the box; writes only its report to `agent/reference/doctor.json` when that directory exists and is writable. Does not repair anything. |
| `--lint` (`lint`) | Writes nothing, including no report, temporary credentials or manifests. |
| `--fix` (`fix`) | Runs only `safe: true` repairs in check order, after backups, and reruns each attempted check. Asks before each repair on a terminal. Without a terminal, or with `--json`, requires `--yes`; otherwise applies nothing and says so on stderr. |

Exit 0 means no check remains `fail`; exit 1 means at least one does. Warnings alone exit 0. A usage error, including `--fix --lint`, exits 2. `--yes` never enables an unsafe repair.

Which installation it checks: `--install-dir`, else `$IHC_INSTALL_DIR`, else the current directory when it contains an installation, else `/opt/inhousecloud`, else the directory the running Compose project was started from. Repair commands run from the install directory; their checkout paths are absolute.

## What it checks

Every applicable check is listed below. Checks without a finding are `ok`. TLS, backup and agent checks are listed in `not_applicable` when their feature is off. If Docker fails, the local install, stage, caller, test-app, version and app-lint checks still run; checks requiring Docker are skipped. Unexpected exceptions in concurrent checks become warnings with an action to report them.

| Check name | Reads and warning/failure criteria |
|---|---|
| `install` | `.env`, `state.json`, `compose.yml`, `config.yaml`. Fails for no readable installation, a legacy installation, missing state or required files, or a failed stage. Warns for a state belonging to another install directory or an incomplete install. |
| `install-stages` | Stage status and `resume_command` in `state.json`, plus the host process list. Fails naming every failed stage, and every `running` or `started` stage when no installer is running. A running installer suppresses interrupted-stage findings and disables resume; an unreadable process list also disables resume. A malformed recorded command is report-only. |
| `secrets-proxy-callers` | `secrets-proxy/callers/*.json` filenames against inventory app slugs. Warns naming orphan callers; `agent` is always retained. A missing or unreadable inventory warns and prevents removal. Invalid caller slugs require manual review. |
| `system-test-apps` | Inventory apps with `kind: system-test`. Warns naming any left behind, even if their containers are gone. Normal apps never receive this repair. |
| `docker` | Daemon version, Compose v2 and `compose config --quiet`. Fails if any cannot be read or validated. |
| `containers` | Expected core/profile services from Docker inspect. Fails for missing, stopped or unhealthy services. Warns for health `starting` or a restart within the last hour. |
| `disk` | Free space in the install directory, Docker data and enabled backup destination, once per filesystem. Fails below 2 GiB free; warns below 10 GiB, or at least 85% used with less than 15 GiB free. High usage with at least 15 GiB free is an informational note. Unreadable disk usage warns. |
| `memory` | Host memory and Docker OOM flags. Fails when available memory is below the larger of 200 MiB and 3% of total. Warns below 3500 MiB total, below 10% available, for an OOM kill, or when memory cannot be read. |
| `routes` | Proxy admin API and expected core/profile/app hosts. Fails if the API cannot be read, a route is absent/disabled, its upstream is wrong, or its internal/edge certificate differs from the cloud's recorded certificate. |
| `dns` | Portal, Authentik, Gitea and non-test app names. Local ingress warns when a name does not resolve to loopback. Public ingress fails for an unresolved portal and warns for other unresolved names. Private ingress fails if Tailscale is not running or split DNS does not return its recorded address for the core names and wildcard probe. |
| `tls` | Served certificate, expiry, and internal CA/wildcard files. Warns without openssl. Internal TLS fails for no certificate, failed CA verification, expiry/unreadable expiry or missing wildcard coverage; warns for an older served certificate, at most 30 days of leaf validity or at most 90 days of CA validity. Edge/public TLS fails for no certificate or expired/unreadable expiry, warns at at most 14 days. Public trust verification is evidence. |
| `login` | Authentik live/ready endpoints, anonymous portal redirect and Gitea OIDC discovery. Fails unless both health endpoints return 200 and the portal redirects to SSO. Warns if a returned discovery issuer differs from the expected issuer. |
| `gitea` | Version endpoint through the proxy with the read-only token. Fails unless HTTP 200 returns a version. |
| `runners` | Gitea's runner records through Postgres. Warns if records cannot be read; fails if either CI/deploy runner is unregistered or last online more than 120 seconds ago. |
| `postgres` | Shared Postgres `pg_isready`. Fails on a nonzero result. |
| `redis` | Shared Redis `redis-cli ping`. Fails unless it returns `PONG`. |
| `backup` | Backup container and `latest-status.json`/`latest-success.json`. Fails if the container is down, no success exists or its age exceeds `BACKUP_MAX_AGE_HOURS` (26 by default). The latest run's error is evidence. Then a quick verification (`ihc-backup verify --latest --quick`: the repository opens, the newest run's snapshots exist, `restic check` passes). `--lint` skips it, because it writes restic's cache and locks. |
| `app:<slug>` | Inventory runtime (or fetched manifest/template defaults), container, route, health path and SSO. Fails for a missing/stopped container, missing route, unreachable proxy/upstream, wrong health status or absent required SSO redirect. Warns for an unhealthy container despite a successful HTTP probe, or an otherwise healthy leftover system-test app. |
| `app-lint:<slug>` | Active release/repository manifest and running bind mounts. Warns for any trust boundary finding, inaccessible source or failed lint. Mounts must stay within the app's owned paths. |
| `agent` | Agent and read-only Docker proxy containers, then Docker API probes from the agent. Fails for missing/stopped/unhealthy containers or probes other than `200 200`. |
| `version` | Checkout HEAD, `state.json`'s `installed_commit`, and a best-effort comparison with `origin/main` (no fetch). Warns when the installed commit is an ancestor of a different checkout HEAD; offers the unsafe `apply-checkout` repair. Remote differences and unreachable origins remain informational. Older installs without an installed commit explicitly say the running version cannot be compared. Completing the foundation stage now records `installed_commit`; a skipped stage never advances it. |
| `portal-api` | Portal's read-only platform status API. Warns if it cannot be read, or if any returned service is unhealthy. |

When the portal answers, the report says `source: "portal-api"` and `platform` carries its [status response](portal-api.md). Otherwise `source` is `local`, `platform` is null and `portal_api.reason` explains why.

## Repairs and backups

| Repair id | Safe? | Scope and reason |
|---|---|---|
| `remove-orphan-callers` | Yes, with a readable inventory and valid caller slugs | Copies every orphan record first, then calls `python3 scripts/lib/secretsproxy.py remove <install-dir> <slug>`. Removes no app or credential; keeps the operator's `agent` record. Repeating it leaves the same result. |
| `remove-system-test-app` | Yes, only for test-owned resources | Runs `scripts/ihc-app.sh remove <slug> --install-dir <dir> --yes`. Backs up inventory, app files/env, app data, deploy history and caller records first. The remover checks `kind: system-test` and repository ownership, and removes the test's containers, volumes, network, images, database/role, Redis keys/user, empty bucket/key, SSO/provider, route, repository, local files and inventory entry. It keeps the record if removal is incomplete; it does not archive these itself. No company app is removed. Invalid/reserved slugs, a different repository or resources outside the test's naming scheme make the repair unsafe and explain why in its description/evidence. |
| `resume-install` | Yes, when no installer is running | Backs up existing installation files, excluding `doctor-backups`, `backups` and the configured backup destination. Uses the first failed/interrupted stage's recorded resume command, adding `--yes --non-interactive`; falls back to the checkout's `install.sh --apply --install-dir <dir> --from <stage>` when absent. Installer stages probe before acting. No shell evaluates the recorded command. An unreadable process list prevents automatic resume. |
| `apply-checkout` | **No** | `install.sh --apply --from foundation --install-dir <dir> --yes --non-interactive`. Updates from this checkout and restarts core services: operator-contract level 3. Always report-only; a human must authorize that update. |

Safe repairs first copy files into `<install-dir>/doctor-backups/<UTC timestamp>/<relative path>`, with directories mode 0700. `repaired.backup` records the backup directory (or null when nothing existed). A backup failure prevents the repair. These are file backups, not database snapshots; removed test data belongs only to a smoke test. An incomplete repair reports `repaired.ok: false` with its error and the check's current status. Later safe checks can still run.

Other findings keep their `action` and runbook without an automatic repair. Core restarts, changes to company routes, DNS, tunnels, Authentik, secrets and volumes remain manual under the [operator contract](operator-contract.md).

## Report and secrets

JSON preserves `checkout`, `generated_at`, `install_dir`, `duration_seconds`, `ingress`, `profiles`, `checks`, `summary`, `not_applicable`, `source`, `platform` and `portal_api`. It adds `doctor_version: 2`, `product: "ihc"`, `mode` and `commit` (checkout HEAD, empty outside Git). Checks may carry `repair`; only attempted repairs in fix mode carry `repaired`. The final check status is the state after repair. `summary.fix_now` counts remaining failures, `recommended` counts remaining warnings, and `repaired` counts successful repaired checks.

Every value of at least eight characters in the installation `.env` and app env files is replaced by `[redacted]` throughout reports and human output. JWT/token prefixes and long hex/base64 token runs are also redacted. Known public checkout commit metadata stays visible; a matching env value still takes precedence and is redacted. Credentials used for HTTP probes travel in memory/stdin, never in command arguments or temporary credential files.

## Inside the operator agent

The operator agent has no Docker socket or host shell. `ihc-ro doctor` runs its permitted live checks and adds the host's last `agent/reference/doctor.json` with its age. It refuses `--fix` with a message directing the person to the host command, including when `--fix` follows other arguments. Ask for a fresh host report when host-only checks matter or that report is old.

## Tests

`scripts/tests/doctor-fix.sh` covers fixtures, backups, rechecks, stage resume, test-only app cleanup, refusal without confirmation, redaction, JSON compatibility, unsafe update refusal and CLI forwarding without Docker or network. `scripts/tests/doctor-disk.sh` covers disk thresholds. Both run in CI. Earlier VM checks are recorded in [the doctor run](first-run.md#doctor-run).
