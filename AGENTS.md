# Agent Instructions

This repository installs a company cloud on one machine and puts internal apps on it. You are probably here for one of these requests:

| The human asks | Read | Then run |
|---|---|---|
| "set up this machine as our company cloud" | [`docs/agent-setup-contract.md`](docs/agent-setup-contract.md), [`docs/llm-bootstrap.md`](docs/llm-bootstrap.md) section 1 | `./install.sh --plan`, then `--non-interactive` after a yes |
| "build an app for X and put it on the air" | [`docs/agent-setup-contract.md`](docs/agent-setup-contract.md), [`docs/llm-bootstrap.md`](docs/llm-bootstrap.md) section 2 | `scripts/ihc-app.sh new <slug>`, write the app, `git push origin main` |
| "why is it down", "is the backup ok", "the disk is full", "is it on the air" (an installed box) | [`docs/operator-contract.md`](docs/operator-contract.md), then the runbook in [`docs/runbooks/`](docs/runbooks/) | `scripts/ihc-doctor.sh --install-dir <dir> --json` first (what is wrong and what to do), then `scripts/ihc-operator.sh brief --install-dir <dir>` |

First, always: find out whether the cloud is installed (`llm-bootstrap.md`, section 0). Every command runs from a checkout of this repository **on the box**; on a fresh box, clone it there first (`git clone https://github.com/Estoca/inhousecloud.git ~/inhousecloud`, or `scp -r` this folder):

```bash
cd ~/inhousecloud
./install.sh status --install-dir /opt/inhousecloud --json
```

The loop, in four lines:

```text
install.sh                     the cloud: proxy, SSO (Authentik), Git + Actions (Gitea), shared Postgres and Redis, backup
ihc-app.sh new <slug>      a repository from templates/app in the Gitea organization
git push origin main           the deploy: Gitea Actions on the box gives the app a database, Redis user, route and SSO, and starts it
http://<slug>.<BASE_DOMAIN>    the app, behind the company sign-in
```

Hard rules (the full list is in the contract):

- Commands run on the box, as the user that installed it. From elsewhere, through `ssh`.
- Never ask for or print passwords, tokens or keys: the installer generates them into `<install-dir>/.env`.
- Apps never bring their own Postgres, Redis or object storage, never mount the Docker socket, never use host networking.
- Never delete a database, bucket, route, repository, volume or the install directory.
- Ask before applying an install plan, making an app public, or touching anything outside the box.

Reference: [`docs/gitops-flow.md`](docs/gitops-flow.md) (what the deploy job does), [`docs/app-contract.md`](docs/app-contract.md) (`company-app.yaml` and the variables an app receives), [`docs/install-design.md`](docs/install-design.md) (installer stages and ingress modes).
