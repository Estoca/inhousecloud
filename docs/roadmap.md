# Status and Roadmap

## Status

Usable on one box, with `local` or `private` ingress. Proven on clean VMs and on a Mac with Docker Desktop, and recorded in [`first-run.md`](first-run.md):

- `install.sh` brings up the core cloud and passes its [smoke tests](smoke-tests.md) (21 of 25 on the core; the others need the `ops` or `agent` profile or `private` ingress).
- `ihc-app` takes an app from `new` to the air behind the sign-in by a push to `main`.
- A coding agent that has never seen the cloud installs it from a layperson's request (about 8 minutes, no password in the conversation) and puts a new app on the air (about 2 minutes).
- `private` ingress (Tailscale) is tested end to end, with a sign-in from another device on the tailnet.
- The portal shows the catalog, health, SSO, deploys, the platform's status and, for admins, Authentik's people and groups; its status API answers agents with a read-only token ([`portal-api.md`](portal-api.md)).
- The MCP gateway serves the platform's read-only tools and every app's tools to a person's AI client, and every new app is born with an MCP tool ([`mcp-gateway.md`](mcp-gateway.md), [MCP in an app](app-mcp.md)).
- `ihc doctor` says what is wrong and what to do, for a person or an agent ([doctor](doctor.md)).

Still ahead: `public` ingress (the cloud on the open internet, a later step once the local and private paths are settled), write tools and an audit log in the gateway, restoring one app on its own, the off-site backup copy and the monthly restore rehearsal.

## Roadmap

Done:

- PR 1: install design (profiles, ingress matrix, stage model, first-run, backup minimum).
- PR 2: `install.sh`, the core cloud on one box (proxy, Authentik, Gitea on the shared Postgres, shared Postgres and Redis), first-run automation, smoke tests.
- PR 3: backup job (restic sidecar, lock, hard timeout, status file).
- PR 4: the app loop: `ihc-app new`, deploy by push to `main` on Gitea Actions, the Actions runners in core.
- PR 5: the agent path ([`AGENTS.md`](../AGENTS.md), [`llm-bootstrap.md`](llm-bootstrap.md), [`agent-setup-contract.md`](agent-setup-contract.md)) rewritten for the loop above and tested with a cold agent run.
- PR 6: the `ops` profile: Portainer, Glances, a web terminal and a file browser, for admins only behind the SSO.
- PR 7: the cold install run: an agent installs the cloud from zero on a clean box from a layperson's request.
- PR 8: the `storage` profile on Garage (the earlier S3 server's images were no longer downloadable), a bucket and key per app.
- PR 9: the `agent` profile: the operator contract ([`operator-contract.md`](operator-contract.md)), runbooks ([`runbooks/`](runbooks/README.md)), the generated brief (`scripts/ihc-operator.sh brief`) and OpenClaw as the reference agent, read only by default.
- PR 10: try it in 10 minutes ([`try-it.md`](try-it.md)), the demo recordings and the announcement drafts.
- PR 11: `private` ingress: Tailscale serve, the installation's own name-constrained CA, split DNS.
- PR 12 and PR 17: the renames, to Open Company Cloud and then to InHouseCloud (`ihc-*` commands, `IHC_*` variables). Only the `OCC_*` variables still load, with a warning, for one version; the old command names do not, and an installation made under an old name is detected and not operated: remove it and install fresh ([`cleanup.md`](cleanup.md#an-installation-made-under-a-previous-name)).
- PR 13: onboarding after the install: the day-zero handoff ([day zero](day-zero.md)), `--plan` as a dry run, stop, start and remove.
- PR 14: the operator agent in conversation (Telegram), with a memory limit and the writes it can use.
- PR 15 and PR 16: the roadmap of that time: the ported portal, `ihc doctor`, per-app restore later, and the MCP layer, in apps and in the cloud.
- PR 18: `ihc doctor`: one command that checks the box the way the smoke tests do (containers, disk and memory, routes, DNS and TLS for the ingress, the sign-in, Gitea and its runners, Postgres, Redis, the backup, every app's health path, the agent) in about 3 seconds, and says what is wrong and what to do: plain text for a person, `--json` for an agent; `ihc-ro doctor` for the operator agent inside its container ([doctor](doctor.md)).
- PR 19: installations made under a previous name detected and not operated; the Mac try-it path with its own commands.
- PR 20 and PR 22: the real portal, from the internal portal of the reference installation, in `portal/` (one commit, no history), then wired into the installer: built by the `portal` stage, migrations at boot, the inventory read through a read-only mount with a `schema_version` and a contract test on both sides, each app's health and SSO through the proxy, Docker through the read-only API (now core, `docker-ro`), the backup status files, admin by the `ihc-admins` group, smoke test 22 and CI on GitHub Actions.
- PR 21: smoke test 16 waits for Gitea to accept the push (a bounded readiness probe); the doctor's disk check decides by free space.
- PR 23 and PR 27: the announcement drafts, updated for the real portal and then for people, the status API and the MCP gateway.
- PR 24: the portal's People page: Authentik's people and groups for admins, through a read-only service account; the portal opened to `ihc-users` (smoke test 24).
- PR 25: the portal's read-only status API for agents: `GET /api/platform/status` with a service token, `IHC_PORTAL_API_TOKEN` ([`portal-api.md`](portal-api.md)); `install.sh status --json` and `ihc doctor --json` read it.
- PR 26: the MCP layer. **The cloud's own MCP**: one gateway per company at `mcp.<BASE_DOMAIN>`, behind the SSO, that knows which person is calling, with the platform's tools read only (apps, status, people, groups) and a route to each app's provider by audience and scope ([`mcp-gateway.md`](mcp-gateway.md)). Apps never expose MCP on their own; the gateway does. This is the endpoint [InHouseOS](https://github.com/Estoca/inhouseos) assumes exists. **Every app is born agent-ready**: an `mcp` section in `company-app.yaml` (audience, paths, scopes granted to groups), a `ping` tool in the app template behind the actor JWT check, and the deploy recording the provider in the inventory ([MCP in an app](app-mcp.md)). Smoke test 25.
- PR 28: the installer normalizes the file modes of the copied portal tree, so the image's `node` user can read it whatever the checkout's umask.

Next:

- **Write tools and an audit log in the MCP gateway.** Tools that change something, each call recorded with the person, the tool and the arguments; today every tool reads.
- **Restoring one app** from a snapshot (`ihc-app restore <slug>`), without restoring the whole box. The dumps are already per database.
- **The off-site backup copy** and the monthly restore rehearsal ([`backup.md`](backup.md#next)).
- **`public` ingress**, for a cloud reachable from the internet (a Cloudflare tunnel or public DNS with Let's Encrypt): the installer already has the modes; they get their own run and documentation when the local and private paths are settled. claude.ai as an MCP client needs it.

## Name

Renamed from **Open Company App Harness** (repository `open-company-app-harness`, until 2026-10-20) and **Open Company Cloud** (`open-company-cloud`, prefix `occ`, 2026-10-20 to 2026-10-21). The first name said where it came from, a harness around coding agents; the second said what it is, but a trademark search found "OpenCompany" and "OpenCloud" already taken by other open-source projects and live marks. InHouseCloud is the company's own cloud, in-house, and clashes with nothing. Commands, variables and defaults changed with each rename (`harness-app` → `occ-app` → `ihc-app`, `HARNESS_*` → `OCC_*` → `IHC_*`); only the `OCC_*` variables still load, with a warning, for one version; the old command names and installations made under the old names do not. Details in [`install-design.md`](install-design.md#renamed-twice-open-company-app-harness-open-company-cloud-inhousecloud).
