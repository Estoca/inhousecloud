# InHouseCloud

The company's own cloud on one machine: an agent installs it, and an agent puts apps on the air in it.

One box runs what a small company needs around its internal apps: single sign-on (Authentik), Git with push-to-deploy (Gitea and Actions), shared Postgres and Redis, a portal, an MCP gateway for AI clients and a nightly backup, all behind one sign-in and under one contract an agent can read. The box can be a Mac with Docker Desktop, a VM on a laptop or a server in the office. Open source, MIT.

**Documentation: <https://inhousecloud.estoca.com.br/>** (built from [`docs/`](docs/)).

> **Sibling project:** [Open Company OS](https://github.com/Estoca/open-company-os) is the people-and-work half (a personal LLM agent per person, a second brain, a shared tracker, a company compass). It runs on top of this cloud as ordinary apps and is adopted separately.

## Try it in 10 minutes

On a Mac with Docker Desktop, directly (15 to 20 GiB free; no `sudo`):

```bash
git clone https://github.com/Estoca/inhousecloud.git ~/src/inhousecloud && cd ~/src/inhousecloud
./install.sh --non-interactive --config bootstrap/config.example.yaml --install-dir ~/inhousecloud
```

Or in a throwaway VM, on a Mac with [Homebrew](https://brew.sh) and no Docker (or skip the VM on any Ubuntu box with Docker):

```bash
brew install lima
limactl start --tty=false --name ihc --cpus 2 --memory 4 --disk 30 template:docker
limactl shell ihc
# inside the VM:
cd ~ && git clone https://github.com/Estoca/inhousecloud.git && cd inhousecloud
sudo install -d -o $(id -un) -g $(id -gn) /opt/inhousecloud
./install.sh --non-interactive --config bootstrap/config.example.yaml
```

About a minute for the VM and five for the install. The install ends with seven [day-zero steps](docs/day-zero.md), with the literal commands: open <http://portal.cloud.localhost> and sign in, turn on MFA, copy the backup key off the machine, put a first app on the air with `scripts/ihc-app.sh new <name> --owner <email> --push` (about 30 seconds later behind the same sign-in), and stop or remove a test install ([`docs/cleanup.md`](docs/cleanup.md)). Both paths, with the times measured: [`docs/try-it.md`](docs/try-it.md).

Or ask a coding agent. Below, Claude Code gets one sentence in Portuguese ("create an internal expense log app on our company cloud and put it on the air") and `ssh` to a box it has never seen; recordings and how they were made are in [`docs/demo/`](docs/demo/).

![A coding agent turns a one-sentence request into an app behind the company sign-in](docs/demo/agent-first-app.gif)

## Proven by record

Each of these ran on a clean machine and is written down with the commands, the times and what broke, in [`docs/first-run.md`](docs/first-run.md):

- the core install and its [smoke tests](docs/smoke-tests.md), and an app from `new` to the air by a push to `main` ([app loop](docs/first-run.md#test-record-the-app-loop-smoke-test-16));
- on a Mac with Docker Desktop, no VM ([macOS run](docs/first-run.md#macos-run-docker-desktop));
- a coding agent that has never seen the cloud installs it from a layperson's request, about 8 minutes, no password in the conversation ([cold install run](docs/first-run.md#cold-install-run)), and puts a new app on the air, about 2 minutes ([cold agent run](docs/first-run.md#cold-agent-run));
- `private` ingress over Tailscale with the installation's own CA ([private ingress run](docs/first-run.md#private-ingress-run));
- the portal with people and groups, its status API for agents, and the MCP gateway with a real client ([portal](docs/first-run.md#portal-run), [people](docs/first-run.md#people-run), [portal API](docs/first-run.md#portal-api-run), [MCP gateway](docs/first-run.md#mcp-gateway-run));
- `ihc doctor` against failures caused on purpose ([doctor run](docs/first-run.md#doctor-run)), and the operator agent in a conversation ([operator run](docs/first-run.md#operator-conversation-run)).

## Profiles

The core (proxy, Authentik, Gitea with its runners, shared Postgres and Redis, the portal, the MCP gateway, the backup) is always on. Each profile adds:

| Profile | Adds |
|---|---|
| `storage` | Garage, S3-compatible object storage: a bucket and key per app |
| `ops` | Portainer, Glances, a web terminal and a file browser, for admins only behind the SSO |
| `agent` | an operator agent that answers "why is it down" in Slack or Telegram, read only by default, inside a written [contract](docs/operator-contract.md) |

## For agents

Start at [`AGENTS.md`](AGENTS.md): it routes an install, a new app or "why is it down" to the contract and the playbook ([`docs/llm-bootstrap.md`](docs/llm-bootstrap.md), [`docs/agent-setup-contract.md`](docs/agent-setup-contract.md), [`docs/operator-contract.md`](docs/operator-contract.md)). Off the box, an agent reads the cloud's health through the [portal API](docs/portal-api.md), and a person's AI client uses it through the [MCP gateway](docs/mcp-gateway.md).

## Status

Usable on one box, with `local` ingress (on the machine itself) or `private` ingress (Tailscale, tested end to end). The portal has people and groups and a read-only status API for agents; the MCP gateway serves read-only tools, and every new app is born with one. Next: write tools and an audit log in the gateway, restoring one app on its own, and the off-site backup copy. `public` ingress, for a cloud on the open internet, comes after that: the installer has the modes, and they get their own run first. Everything done and ahead: [status and roadmap](docs/roadmap.md).

## Documentation

The site, <https://inhousecloud.estoca.com.br/>, has six parts, all from [`docs/`](docs/):

- **Start**: [try it](docs/try-it.md), [day zero](docs/day-zero.md), [the first person after you](docs/first-user.md), [install and deploy](docs/install.md), [quickstart](docs/quickstart.md).
- **Concepts**: [one machine, one cloud](docs/single-box.md), [the deploy loop](docs/deploy-loop.md), [why it exists](docs/why.md).
- **Operate**: [doctor](docs/doctor.md), [backup](docs/backup.md), [stop or remove](docs/cleanup.md), [runbooks](docs/runbooks/), [security](docs/security.md), [install design](docs/install-design.md).
- **Build apps**: [app contract](docs/app-contract.md), [MCP in an app](docs/app-mcp.md), [app rules example](docs/app-rules-example.md), [GitOps flow](docs/gitops-flow.md).
- **For agents**: [AGENTS.md](AGENTS.md), [LLM bootstrap](docs/llm-bootstrap.md), [operator contract](docs/operator-contract.md), [portal API](docs/portal-api.md), [MCP gateway](docs/mcp-gateway.md).
- **Reference**: [architecture](docs/architecture.md), [smoke tests](docs/smoke-tests.md), [first run](docs/first-run.md), [repository layout](docs/repository-layout.md), [roadmap](docs/roadmap.md).

Preview it locally: `pip install -r docs/requirements.txt && mkdocs serve`.

## License

MIT, see [`LICENSE`](LICENSE).
