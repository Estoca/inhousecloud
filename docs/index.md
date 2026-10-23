# InHouseCloud

The company's own cloud on one machine: an agent installs it, and an agent puts apps on the air in it. Open source, MIT.

One box runs what a small company needs around its internal apps: single sign-on, Git with push-to-deploy, shared Postgres and Redis, object storage, backups, ops tools and an optional operator agent. The machine can be a Mac with Docker Desktop, a VM on a laptop or a server in the office; the cloud starts there, on hardware the company already has.

- **New here?** [Try it in 10 minutes](try-it.md), then the [day-zero steps](day-zero.md).
- **An agent?** Start at [AGENTS.md](../AGENTS.md).
- **Why it is built this way?** [One machine, one cloud](single-box.md) and [the deploy loop](deploy-loop.md).

## What the install gives you

`./install.sh` (one command, a few questions, or `--non-interactive` with a config file) brings up the core cloud and checks it with the smoke tests. The core, always on:

| Piece | What it does |
|---|---|
| Reverse proxy (Nginx Proxy Manager) | every app at `<slug>.<BASE_DOMAIN>`, behind the sign-in |
| Authentik | single sign-on for every app and tool; two groups, `ihc-admins` and `ihc-users` ([first person](first-user.md)) |
| Gitea with Actions | the company's Git; a push to `main` deploys, on two runners on the box ([GitOps flow](gitops-flow.md)) |
| Shared Postgres and Redis | each app gets its own database, role, Redis user and key prefix |
| The portal | the catalog, each app's health, SSO and deploys, the platform's status, people and groups (read only) |
| The MCP gateway | the cloud for AI clients at `mcp.<BASE_DOMAIN>`, signed in as the person ([MCP gateway](mcp-gateway.md)) |
| Backup | a nightly encrypted restic backup with a lock, a timeout and a status file ([backup](backup.md)) |
| `ihc doctor` | one command that says what is wrong and what to do ([doctor](doctor.md)) |

Then `ihc-app new <slug> --push` puts an app on the air: a repository from the template, its own database and Redis user, a route behind the sign-in, a health check, a line in the inventory, about 30 seconds after the push ([app contract](app-contract.md)).

## What each profile adds

| Profile | Adds | Default |
|---|---|---|
| `storage` | Garage, S3-compatible object storage: a bucket and key per app | off; on when an app needs files |
| `ops` | Portainer, Glances, a web terminal and a file browser, for `ihc-admins` only | recommended |
| `agent` | an operator agent (OpenClaw) that answers "why is it down" in Slack or Telegram, read only by default, inside a written [contract](operator-contract.md) | off; needs an LLM key and a chat channel |

Details: [install design](install-design.md#layers-as-compose-profiles).

## The portal and the gateway

**The portal** (`portal.<BASE_DOMAIN>`) shows what should exist, what is running and what changed: the catalog from the inventory, each app's health and SSO through the proxy, its deploy runs, the platform's services and the backup's age, and, for admins, Authentik's people and groups. It only reads; to change something, push to Gitea. Its status is also an API for scripts and agents, with a read-only token ([portal API](portal-api.md)).

**The MCP gateway** (`mcp.<BASE_DOMAIN>/mcp`) is one MCP server for the whole cloud. A person connects Claude Code or another MCP client once, signs in with the company account, and gets the platform's read-only tools (apps, status, people and groups, by group) and every app's own tools, named `<slug>__<tool>`. An app gets tools through the `mcp` section of its manifest, which the template already writes ([MCP in an app](app-mcp.md)).

## What is proven, and how

Every claim above has a run on a clean machine behind it, written down with the commands, the times and what broke ([first run and test records](first-run.md)):

- The core install on a clean VM, checked by the [smoke tests](smoke-tests.md) (25 in all; 21 run on the core, the rest need the `ops` or `agent` profile or `private` ingress), and the app loop from `new` to the air by a push ([app loop](first-run.md#test-record-the-app-loop-smoke-test-16)).
- On a Mac with Docker Desktop, no VM ([macOS run](first-run.md#macos-run-docker-desktop)).
- A coding agent that has never seen the cloud installs it from a layperson's request ([cold install run](first-run.md#cold-install-run)) and puts a new app on the air ([cold agent run](first-run.md#cold-agent-run)).
- `private` ingress over Tailscale, with the installation's own CA and split DNS, signed in from another device ([private ingress run](first-run.md#private-ingress-run)).
- The portal, its people and groups, its status API, and the MCP gateway with a real client ([portal run](first-run.md#portal-run), [people run](first-run.md#people-run), [portal API run](first-run.md#portal-api-run), [MCP gateway run](first-run.md#mcp-gateway-run)).
- `ihc doctor` against failures caused on purpose ([doctor run](first-run.md#doctor-run)); the operator agent in a conversation ([operator conversation run](first-run.md#operator-conversation-run)).

## What comes later

The cloud starts on a machine you control and reach directly or over a private network. Putting it on the open internet (`public` ingress, through a Cloudflare tunnel or public DNS) is a later feature: the installer already knows the modes, and it will be documented once it has its own run. Also ahead: write tools and an audit log in the gateway, restoring one app from a snapshot, and an off-site copy of the backup. The list, with what has already shipped: [status and roadmap](roadmap.md).
