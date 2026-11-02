# Status and Roadmap

Status as of 2026-11-02.

## Status

Usable on one box, with `local` or `private` ingress and managed Cloudflare edge ingress. Local/private runs on clean VMs and on a Mac with Docker Desktop are recorded in [`first-run.md`](first-run.md); the managed public run is recorded in the iht history (#38, LAB-101):

- `install.sh` brings up the core cloud and passes its [smoke tests](smoke-tests.md) (22 of 26 on the core; the others need the `ops` or `agent` profile or `private` ingress).
- `ihc-app` takes an app from `new` to the air behind the sign-in by a push to `main`; every deploy is journaled before it changes anything, and `ihc-app rollback` goes back to the previous release ([`gitops-flow.md`](gitops-flow.md#rollback)).
- A coding agent that has never seen the cloud installs it from a layperson's request (about 8 minutes, no password in the conversation) and puts a new app on the air (about 2 minutes).
- `private` ingress (Tailscale) is tested end to end, with a sign-in from another device on the tailnet.
- The portal shows the catalog, health, SSO, deploys, the platform's status and, for admins, Authentik's people and groups; its status API answers agents with a read-only token ([`portal-api.md`](portal-api.md)).
- The MCP gateway serves the platform's read-only tools and every app's tools to a person's AI client. App writes require `confirmed_by`, checked in the company directory, and a gateway-owned audit record; grants can narrow access per tool (LAB-64). Every new app is born with an MCP tool ([`mcp-gateway.md`](mcp-gateway.md), [MCP in an app](app-mcp.md)).
- `ihc doctor` says what is wrong and what to do, for a person or an agent ([doctor](doctor.md)).
- The `agent` profile includes a credential proxy for external API calls (LAB-66); app trust-boundary lint (LAB-67) and public `/llms.txt` guides on the portal and gateway (LAB-68) are implemented.
- The installer configures “Sign in with inhouse.technology” (LAB-84) and redeems a one-time iht login claim (LAB-91). Edge ingress uses local-CA HTTPS inside the box and Cloudflare TLS at the edge (#52, LAB-101); the iht's [public hosting run](https://github.com/Estoca/inhouse-technology/commit/1ddaa3e) passed install, smoke and public HTTPS checks for a test company.
- Direct sign-in to inhouse.technology is implemented (LAB-108, #53). Live verification of that automatic redirect and return journey remains pending.

Still ahead: deploy jobs without the Docker socket, restoring one app on its own, the off-site backup copy, the monthly restore rehearsal, and the remaining sign-in/public-ingress validation below.

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
- PR 41 (LAB-64): app write tools require a directory-checked `confirmed_by`; per-tool grants and the gateway-owned, append-only audit log are implemented. Writes are refused if the audit cannot be recorded; admins read it through MCP or the portal API ([`mcp-gateway.md`](mcp-gateway.md#writes)).
- PR 42 (LAB-65): deploys as transactions. The template's deploy is `ihc-app build` (a release from the commit's files: images tagged per release, no cloud credentials, no build secrets or contexts outside the repository) then `ihc-app apply` (the reconciler: a per-app lock, only the head of `main`, a write-ahead journal of what it will change, provision, the release's images, the healthcheck). `ihc-app rollback <slug>` undoes the newest deploy in reverse order, journaled and health-checked, and refuses when there is nothing to go back to; the portal shows the journal to admins. Smoke test 26.
- PR 43 (LAB-68): public `/llms.txt` on the portal and gateway, with a test that keeps their guides aligned with the tool and route registries.
- PR 44 (LAB-67): `ihc-app lint` checks the app trust boundary before build; `install.sh doctor` checks active releases and running mounts ([`security.md`](security.md#app-trust-boundary-lint)).
- PR 45 and PR 46 (LAB-84): the iht OIDC source in Authentik, identity linked by `sub`, admin/member group mapping, and iht instance-token access through the MCP gateway. The isolated browser SSO harness passed; this does not establish live acceptance of the later direct sign-in change.
- PR 47 and PR 49 (LAB-91): `--iht-claim` redeems a single-use code for the login secret on the server; the claim request works behind Cloudflare. See [installation](install.md#sign-in-with-inhousetechnology).
- PR 48 and PR 50 (LAB-66): the credential proxy in the `agent` profile, with app/agent tokens, fixed upstreams and method/path allowlists; isolated-Python imports fixed ([`app-contract.md`](app-contract.md#external-apis-through-the-credential-proxy)).
- PR 52 (LAB-101): edge ingress with local-CA HTTPS and container trust inside, Cloudflare at the public edge, and HTTPS sign-in redirects. The managed public test-company run is recorded in iht #38.
- PR 53 (LAB-108): opening the portal redirects straight to inhouse.technology when configured as the login source. Local `akadmin` recovery keeps its separate flow; live verification remains pending.

Next:

- **Deploy jobs without the Docker socket.** Today `build` and `apply` are two steps of one job that has the socket, so a repository's own workflow can still skip `apply`. Next: the reconciler (lock, merged-commit check, journal) runs outside Gitea Actions and fetches the commit itself, the build runs as an unprivileged user (rootless BuildKit, the image pushed to Gitea's registry), and no job on the box gets the socket; with that, no code from an unmerged branch runs on the machine.
- **Restoring one app** from a snapshot (`ihc-app restore <slug>`), without restoring the whole box. The dumps are already per database, and the deploy journal says which release ran when, so a restore can put back the data and the release together.
- **The off-site backup copy** and the monthly restore rehearsal ([`backup.md`](backup.md#next)).
- **Direct sign-in live verification (LAB-108, #53).** Record the automatic portal → inhouse.technology → portal journey on the managed instance.
- **Remaining public-ingress validation.** The managed Cloudflare edge path has a recorded test-company run; standalone public DNS with Let's Encrypt still needs its own run. A live authenticated journey through the MCP door remains pending.

## Name

Renamed from **Open Company App Harness** (repository `open-company-app-harness`, until 2026-10-20) and **Open Company Cloud** (`open-company-cloud`, prefix `occ`, 2026-10-20 to 2026-10-21). The first name said where it came from, a harness around coding agents; the second said what it is, but a trademark search found "OpenCompany" and "OpenCloud" already taken by other open-source projects and live marks. InHouseCloud is the company's own cloud, in-house, and clashes with nothing. Commands, variables and defaults changed with each rename (`harness-app` → `occ-app` → `ihc-app`, `HARNESS_*` → `OCC_*` → `IHC_*`); only the `OCC_*` variables still load, with a warning, for one version; the old command names and installations made under the old names do not. Details in [`install-design.md`](install-design.md#renamed-twice-open-company-app-harness-open-company-cloud-inhousecloud).
