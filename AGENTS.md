# Agent Instructions

This repository installs a company cloud on one machine and puts internal apps on it. You are probably here for one of these requests:

| The human asks | Read | Then run |
|---|---|---|
| "set up this machine as our company cloud" | [`docs/agent-setup-contract.md`](docs/agent-setup-contract.md), [`docs/llm-bootstrap.md`](docs/llm-bootstrap.md) section 1 | `./install.sh --plan`, then `--non-interactive` after a yes |
| "build an app for X and put it on the air" | [`docs/agent-setup-contract.md`](docs/agent-setup-contract.md), [`docs/llm-bootstrap.md`](docs/llm-bootstrap.md) section 2 | `scripts/ihc-app.sh new <slug>`, write the app, `git push origin main` |
| "put this app on our cloud" (the code already exists, outside the box: on the person's laptop) | [`docs/gitops-flow.md`](docs/gitops-flow.md#from-a-laptop), [`docs/llm-bootstrap.md`](docs/llm-bootstrap.md) section 5 | `scripts/ihc-app.sh init <slug> --push` in the app's folder, with `IHC_GITEA_URL` and the person's `IHC_GITEA_TOKEN`; no `ssh` to the box |
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

- Commands run on the box, as the user that installed it. From elsewhere, through `ssh`. The exception is an app that already exists on a laptop: it reaches the box by `git push` with the person's own token.
- Never ask for or print passwords, tokens or keys: the installer generates them into `<install-dir>/.env`.
- Apps never bring their own Postgres, Redis or object storage, never mount the Docker socket, never use host networking.
- Never delete a database, bucket, route, repository, volume or the install directory.
- Ask before applying an install plan, making an app public, or touching anything outside the box.

To read the health of the cloud's services without a browser (a script, a monitor, an agent off the box), use the portal's read-only API: `GET <portal>/api/platform/status` with `Authorization: Bearer <IHC_PORTAL_API_TOKEN>` from `<install-dir>/.env`. The contract is [`docs/portal-api.md`](docs/portal-api.md); `install.sh status --json` and `ihc doctor --json` already read it and say `"source": "portal-api"` (or `"local"` when the portal does not answer).

To use the cloud from an AI client (Claude Code, claude.ai) instead of reading it: the MCP gateway at `https://mcp.<BASE_DOMAIN>/mcp` signs the person in through Authentik (OAuth client id `ihc-mcp`) and serves the platform's read-only tools and every app's tools named `<slug>__<tool>`. An app gets tools through the `mcp` section of its `company-app.yaml`, which `ihc-app new` already writes with a `ping` tool. Contracts: [`docs/mcp-gateway.md`](docs/mcp-gateway.md) (the gateway, sign-in, connecting a client) and [`docs/app-contract.md`](docs/app-contract.md#mcp) (what an app exposes and must check).

Reference: [`docs/gitops-flow.md`](docs/gitops-flow.md) (what the deploy job does), [`docs/app-contract.md`](docs/app-contract.md) (`company-app.yaml` and the variables an app receives), [`docs/install-design.md`](docs/install-design.md) (installer stages and ingress modes).
