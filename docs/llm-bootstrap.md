# LLM Bootstrap Playbook

This playbook is for a terminal-connected LLM that needs to turn a machine into a single-box company cloud from scratch.

Read `docs/agent-setup-contract.md` first: it defines the intended user experience. This playbook is the execution path for that contract, and the path is short: **run `install.sh` and answer its questions**. The installer is the same program a technical human runs; the agent's only differences are that it writes the answers to a file instead of typing them, and that it asks the human before applying.

## Agent Rules

- Read this file, `docs/install-design.md` and `docs/first-run.md` before running anything.
- Do not invent domains, admin emails or credentials. Ask.
- Never commit generated config or secrets. The installer writes them to the install directory, outside the repository; keep your copy of the config under `local/` (ignored by Git).
- Never print the values in `.env`. Report the key names and where the file lives.
- `--plan` first. `--apply` only after the human confirms the plan.
- Do not delete existing containers, volumes, databases, proxy routes or auth configuration. The installer never does; neither do you.
- If the machine already runs part of the stack, run `install.sh status` and read `state.json` before anything else.

## Prerequisites

The target machine needs:

- Linux or macOS with bash 3.2 or newer, python3 and curl (all present on Ubuntu 24.04 and macOS);
- Docker Engine with the Compose v2 plugin, usable by the current user without sudo;
- 2 CPUs, 4 GiB of memory and 10 GiB of free disk for the `core` profile;
- for `private` or `public` ingress, the tunnel credentials in the environment variables named in the config.

If Docker is missing, stop and report it; do not improvise an installation. On a fresh Ubuntu box the human can run `curl -fsSL https://get.docker.com | sh` and add themselves to the `docker` group.

## Inputs

Everything the installer accepts is in `bootstrap/config.example.yaml`, with defaults. Ask only for what you cannot infer:

- install directory (default `/opt/open-company-harness`; it must be writable by the user, or created once with `sudo install -d -o $USER -g $USER <dir>`);
- ingress mode (`local`, `private`, `public`) and base domain; the TLS mode and tunnel provider follow the matrix in `docs/install-design.md`;
- admin email;
- Gitea organization name;
- which optional profiles to turn on (`storage`, `ci`, `ops`);
- for tunnels, the name of the environment variable holding the token (never the token itself).

Secrets are never inputs: the installer generates every password, key and token into `<install-dir>/.env` with mode 0600. If the human wants to provide one, they export it in the environment variable named in the config (`*_env` keys) before the run.

## Flow

1. Copy and fill the config:

   ```bash
   mkdir -p local
   cp bootstrap/config.example.yaml local/config.yaml
   # edit local/config.yaml with the answers
   ```

2. Plan. Prints the preflight checklist, the services, URLs and files, and changes nothing on the machine beyond the install directory and its `state.json`:

   ```bash
   ./install.sh --plan --config local/config.yaml
   ```

   Preflight refuses an invalid ingress combination, a missing Docker, a used port, too little disk or memory, with a line that says what to fix. Show the plan to the human.

3. Apply, after approval. No prompts; progress goes to the terminal; `--json` sends the human lines to stderr and the final `state.json` to stdout:

   ```bash
   ./install.sh --non-interactive --config local/config.yaml --json
   ```

   The run goes through the 13 stages of `bootstrap/state.example.json`: preflight, plan, secrets, foundation, authentik, shared_data, proxy_ingress, gitea, portal, first_run, smoke_tests, optional_profiles, handoff. Each waits for the healthchecks of what it started. `first_run` creates the Gitea admin and organization, the Authentik OIDC provider and groups, the portal's proxy provider and the proxy hosts with forward auth (`docs/first-run.md`). `smoke_tests` runs `docs/smoke-tests.md` and the installation is not marked completed while one fails.

4. On failure, the output ends with the stage name, the cause and the resume command:

   ```bash
   ./install.sh --apply --install-dir <dir> --from <stage>
   ```

   Fix the cause, resume. Completed stages are skipped; every action in a re-run probes before it creates.

5. Report from the state, not from memory:

   ```bash
   ./install.sh status --install-dir <dir> --json
   ```

   Give the human: the URLs (`inventory.json` in the install directory), the path of `.env` and the names of the credentials in it, the smoke test results, and the human steps that remain (first login, MFA, bootstrap password, SMTP, DNS or tunnel).

## Repository manifest (optional)

`scripts/bootstrap.mjs` clones the company's platform repositories from a manifest (`bootstrap/repos.example.json` to `local/repos.json`) and writes `local/bootstrap-plan.md`. It does not start services; that is `install.sh`. Use it when the company keeps its portal, GitOps and template repositories elsewhere and you need them on the box.

```bash
node scripts/bootstrap.mjs --plan --repos local/repos.json
node scripts/bootstrap.mjs --apply --repos local/repos.json
```

## What The Installer Writes

In the install directory, outside the repository:

```text
config.yaml           the answers (no secrets)
.env                  generated secrets and derived values, mode 0600
compose.yml           the rendered Compose file (a copy of docker/compose.yml)
portal-placeholder/   the placeholder portal (examples/minimal-web-app)
state.json            stage by stage state; the resume command of each stage
inventory.json        URLs, profiles, status command
backup-job/           build context of the backup container (docs/backup.md)
backups/              default backup destination: restic/ repository, reports/ status files
local/                local files, never backed up
```

## Human Checkpoints

Stop for confirmation before:

- applying the plan (starting Docker services);
- creating public DNS records or tunnel routes;
- changing anything in Authentik, the proxy or Gitea by hand instead of through `first-run.sh`;
- rotating, deleting or overwriting anything.
