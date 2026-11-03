# Status and Roadmap

Status as of 2026-11-03.

## Available today

The cloud runs on one machine with `local` ingress, `private` ingress over
Tailscale, or managed Cloudflare edge ingress. Local and private test records
are in [first run](first-run.md).

- **Install and operate:** `install.sh` brings up the core services and runs the
  [smoke tests](smoke-tests.md). The optional profiles add object storage, admin
  tools and an operator agent. [Day zero](day-zero.md) covers the handoff.
- **Publish apps:** a push to `main` in Gitea builds and deploys the app with its
  own database, Redis user, address and company sign-in. Deploys have a journal;
  rollback restores the previous release when available. See
  [Publish your first app](first-app.md) and [GitOps flow](gitops-flow.md).
- **See the cloud:** the portal shows apps, health, deploys, services, backup age
  and, for admins, people and groups. Agents can read the
  [status API](portal-api.md); [ihc doctor](doctor.md) reports problems and actions.
- **Use AI clients:** the [MCP gateway](mcp-gateway.md) serves platform read tools
  and each app's tools. App writes require a directory-checked `confirmed_by`
  and a gateway-owned audit record. Access can be narrowed per tool.
- **Connect sign-in:** the installer connects Authentik to inhouse.technology
  and redeems a single-use login claim on the server. With this connection,
  opening the portal redirects to inhouse.technology. Local administrator
  recovery has a separate flow. See [connection steps](install.md#connect-ihc-to-inhousetechnology).
- **Constrain app access:** app lint checks the trust boundary before build.
  The `agent` profile includes a credential proxy for allowed external API calls.
  Public `/llms.txt` guides describe the portal and gateway for agents.

## Managed hosting

Managed clouds have run since 2026-11-02. Cava Industries has run managed since
that date. Hosting uses AWS us-east-1, one machine per company, an encrypted disk,
daily backups to S3 and a Cloudflare tunnel in front. inhouse.technology itself
has run on AWS since 2026-11-03.

A managed dry run on 2026-11-03 completed new company creation, domain proof,
hosting and setup-os in claude.ai through the downloadable skill. Sign-in uses
Google Workspace; Microsoft is experimental, and personal Gmail cannot get in.
The skills are Portuguese first; replies follow the user's language.

## What still needs verification

The managed run establishes the setup journey above. The repository also has an
isolated browser SSO harness using a mock provider. It does not record the full
live-provider matrix of role changes, identity isolation, recovery and invalid
tokens described in [verification coverage](install.md#verification-coverage).
Standalone public DNS with Let's Encrypt also has no recorded live run.

## Next

- **Deploy jobs without the Docker socket.** Today build and apply share a job
  with the socket; an app's workflow can bypass the reconciler. Move apply
  outside Actions and run builds without privileged access.
- **Restore one app** from a snapshot without restoring the whole box. Database
  dumps are already separate; a restore should recover the data and release together.
- **Self-hosted off-site backup copy** and automated monthly restore rehearsals.
  The self-hosted backup script does not implement these yet. This is separate
  from managed hosting's daily S3 backups. See [backup](backup.md#next).
