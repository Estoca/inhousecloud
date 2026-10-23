# Day Zero

The install ends by printing seven steps for a person to do once, in order, with the literal commands for that box. `./install.sh handoff` (or `./ihc handoff` from the install directory) prints them again. They are:

1. **Open the portal** (`http://portal.cloud.localhost` on a default install). The catalog shows each app with its health, SSO and deploys; Platform shows the core services and the backup. It only reads: to change something, use Gitea (a push to `main` deploys) and the operator brief (step 6).
2. **Read the first password** in your own terminal, never in a chat: `python3 scripts/lib/envfile.py get <install-dir>/.env AUTHENTIK_BOOTSTRAP_PASSWORD` (on a Mac, `| pbcopy` copies it instead of showing it).
3. **Sign in to Authentik** at `/if/user/` as `akadmin` and turn on MFA (Settings → MFA Devices → Enroll: an authenticator app, then static tokens kept off the machine), then change the password. In Gitea, use "Sign in with" the company's SSO; Gitea's local admin is break-glass only.
4. **Copy the backup key off the machine**, into a password manager: `envfile.py get <install-dir>/.env BACKUP_ENCRYPTION_KEY`. Without it no backup can be read ([backup](backup.md)). With the backup off, this step says to turn it on first.
5. **Your first app**: `scripts/ihc-app.sh new my-first-app --owner <your email> --push --install-dir <install-dir>`. A folder on the box, a repository in Gitea, deployed by the push, about 30 seconds later behind the same sign-in.
6. **Operate**: `scripts/ihc-operator.sh brief --install-dir <install-dir>` is the map of services, apps, owners and commands; `./install.sh status` the short state; `<install-dir>/ihc doctor` what is broken and what to do ([doctor](doctor.md)).
7. **Only a test?** `./install.sh stop` (data kept) or `./install.sh remove` to get the space back ([stop or remove](cleanup.md)).

Then add the next person: [the first person after you](first-user.md). Mail, password recovery and invitations are off until SMTP is set up.

Before the seven steps the install prints the URLs and what depends on the box's options: with `local` ingress, the SSH tunnel of port 80 that opens the apps from another computer; with `private` ingress, the split DNS to set once in the Tailscale admin console and the CA to install on each device; with the `ops` profile, the web terminal's key if it is not authorized yet; with the `agent` profile, the LLM key and chat channel the operator agent still needs, and how to approve the first chat.

The steps are `day0_handoff` in [`install.sh`](../install.sh); the run that introduced them is the [onboarding run](first-run.md#onboarding-run).
