# Install and Deploy

The reference for the install, the backup it sets up and the first deploy. For the guided ten-minute path, see [try it](try-it.md); for what happens right after, [day zero](day-zero.md).

## Getting started

**Asking a coding agent to install it.** Give the agent this repository and `ssh` access to the box, and ask in your own words ("set up our company cloud on this server"). It reads [`AGENTS.md`](../AGENTS.md), copies the repository to the box, asks you a handful of plain questions (your email, the company name, who reaches the apps, backups), shows the plan and installs after your yes. What the box must have before that, none of which the agent installs:

- Linux (tested: Ubuntu 26.04), 2 CPUs, 4 GiB of memory (6 GiB with the operator agent), 10 GiB free disk;
- Docker Engine usable by the `ssh` user without `sudo` (rootless, or the user in the `docker` group) and Docker Compose v2;
- `git`, `curl`, `python3`; `sshd` for the web terminal of the admin tools;
- `sudo` for one command if the install directory is under `/opt` (or answer with a folder the user owns).

**Trying it yourself.** [`try-it.md`](try-it.md): on a Mac with Docker Desktop or in a VM on your laptop, one install command, a first app on the air, about 8 minutes. Adding the next person: [`first-user.md`](first-user.md). Stopping or removing it: [`cleanup.md`](cleanup.md).

Start with the docs:

- [`try-it.md`](try-it.md)
- [`architecture.md`](architecture.md)
- [`quickstart.md`](quickstart.md)
- [`app-rules-example.md`](app-rules-example.md)
- [`agent-setup-contract.md`](agent-setup-contract.md)
- [`llm-bootstrap.md`](llm-bootstrap.md)
- [`app-contract.md`](app-contract.md)
- [`gitops-flow.md`](gitops-flow.md)
- [`security.md`](security.md)

Then inspect:

- [`templates/app/`](../templates/app)
- [`examples/minimal-web-app/`](../examples/minimal-web-app)

## Install

One command, a few questions, the core cloud up and verified:

```bash
./install.sh
```

Same path for an agent or CI, with the answers in a file:

```bash
./install.sh --non-interactive --config bootstrap/config.example.yaml
```

`--plan` prints what would happen and creates nothing (no directory, no `state.json`); `--apply --from <stage>` resumes. After the install (the same commands, without paths, from the install directory: `cd /opt/inhousecloud && ./ihc doctor`, `./ihc status`):

```bash
./install.sh handoff     # the seven day-zero steps again
./install.sh status      # short: state, URLs, service health, backup age, apps and owners
./install.sh doctor      # every check, and what to do about each one that fails (--json for agents)
./install.sh status --verbose   # every stage and the full operator brief (scripts/ihc-operator.sh brief)
./install.sh stop        # stop the cloud and its apps, data kept (start: ./install.sh start)
./install.sh remove      # remove a test install; asks for the project name (docs/cleanup.md)
```

Re-running on an installed box changes nothing. Every stage, the generated `.env` (0600) and the smoke tests are described in [`install-design.md`](install-design.md), [`first-run.md`](first-run.md) and [`smoke-tests.md`](smoke-tests.md); the agent path is in [`llm-bootstrap.md`](llm-bootstrap.md).

### Backup

Part of the install, on by default. A small `backup` container runs `scripts/ihc-backup.sh` on `backup.schedule` (02:00 UTC by default): every Postgres database of the shared instance and of Authentik's, streamed by `pg_dump` into an encrypted restic repository, plus the Gitea, proxy, Authentik and Garage (storage profile) volumes and the install directory. Retention is 7 daily, 4 weekly, 12 monthly. A lock and a hard timeout keep a hung run from blocking the next night; it is killed and recorded as failed. Each run writes `reports/latest-status.json`, which the portal reads.

```bash
export IHC_BACKUP_DESTINATION=/mnt/backup-disk/ihc   # or answer the installer's question, or backup.destination in the config
scripts/ihc-backup.sh --install-dir /opt/inhousecloud run
scripts/ihc-backup.sh --install-dir /opt/inhousecloud verify --latest
scripts/ihc-backup.sh --install-dir /opt/inhousecloud status
```

Keep a copy of `BACKUP_ENCRYPTION_KEY` from `.env` off the box: the repository cannot be read without it. The off-site copy and the monthly restore rehearsal are not built yet. Details and restore steps: [`backup.md`](backup.md). App databases live on the shared Postgres, so they are in the nightly dump with everything else.

## Deploy an app

On the box (the Actions runners are part of every install):

```bash
scripts/ihc-app.sh new expense-report --owner maria@example.com --install-dir /opt/inhousecloud
cd expense-report
git push -u origin main
```

The push runs `.gitea/workflows/deploy.yml` on the box: the app gets its own database and role on the shared Postgres, a Redis user limited to its key prefix, an env file at `<install-dir>/apps/expense-report/.env` (0600), the route `expense-report.<BASE_DOMAIN>` behind the SSO and a line in `inventory.json`; then it is built, started on the ihc network and checked at `/health`. Every later push redeploys it, keeping its passwords. The flow, the runners and the trust they need: [`gitops-flow.md`](gitops-flow.md). The contract the app keeps: [`app-contract.md`](app-contract.md).

`scripts/bootstrap.mjs` remains for cloning the platform repositories of a manifest (`bootstrap/repos.example.json`); it no longer starts services.
