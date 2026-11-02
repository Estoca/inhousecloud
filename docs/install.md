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

### Sign in with inhouse.technology

This also enables iht instance tokens at the MCP gateway (`IHT_ISSUER` in the `mcp`
service). In iht, open Products (`/empresas/{id}/products`) and set InHouseCloud MCP
to `https://mcp.<BASE_DOMAIN>` without a trailing slash or `/mcp`; local ingress uses
`http://mcp.cloud.localhost`.
Email access defaults to the portal super-admin emails and their domains; explicit
`IHT_ALLOWED_DOMAINS` / `IHT_ALLOWED_PEOPLE` in the installation `.env` restrict or
extend it. See [MCP gateway](mcp-gateway.md#via-inhousetechnology).

The iht blueprint owns both enrollment and repeat-login authentication flows. This avoids a first-boot race with Authentik’s asynchronously installed default source flow. The authentication flow permits only source SSO; local recovery remains separate.

This optional connection applies to a company that uses inhouse.technology (iht) as
its identity provider. A self-installed cloud with no `authentik.iht.client_id`
keeps its existing login. An issuer alone, or a secret alone, does not enable it.
A client id without a supplied or previously saved secret fails before enabling it.

For the agent flow, add the `https://inhouse.technology/mcp` connector in Claude,
ask Claude to connect the instance (`iht_connect_instance`, product `ihc`, gateway URL)
and create its login client with the callback below. Approve the changes, then run
one of the commands it gives **on the server** within 15 minutes:

```bash
./install.sh --iht-issuer https://inhouse.technology --iht-claim <code>
# Existing install / rotation (add --install-dir if using a custom directory):
./install.sh --apply --from foundation --iht-issuer https://inhouse.technology --iht-claim <code>
```

For unattended fresh installs, add `--non-interactive --config local/config.yaml`.
`--plan` never redeems a claim. Apply redeems it after approval, before the
Authentik stages. The installer POSTs the code to `authentik.iht.claim_url`
(default `<issuer>/oidc/clients/claim`); overrides must share the issuer's origin.
HTTPS is required except local HTTP for testing. Redirects are refused.
The response issuer must match the configured issuer (`--iht-issuer` overrides it).
The secret is saved only to the installation's `.env` (0600), as
`IHC_IHT_CLIENT_SECRET` and the existing Compose key `IHT_CLIENT_SECRET`;
client ID and issuer are persisted in `config.yaml`. The config is rewritten as
JSON (valid YAML), preserving its values. No secret is printed or put in config/state.
Successful claims reset the stages from foundation so an existing install updates
Authentik and its blueprint. A rotation must keep the same client ID and issuer.

A claim is a temporary bearer credential: run it promptly, and keep it out of logs.
Redeeming it generates a new secret and invalidates the previous one. On expiry,
replay or network failure, the installer stops before changing login services;
local login/recovery remains available. Request a new claim and rerun the command.
If the response was lost, the consumed claim cannot be retried: request a new one.

The manual path remains available:

An iht company admin creates or rotates this ihc's OIDC client in Login
(`/empresas/{id}/login`). Register this exact Authentik source callback, including its
trailing slash, substituting the ihc's Authentik host (usually `auth.<base_domain>`):

```text
https://<authentik host>/source/oauth/callback/inhouse-technology/
```

This is Authentik's OAuth **source** callback, with slug `inhouse-technology`,
including the trailing slash. The client's scopes must include `openid email profile`;
the provider supplies `sub`, `email`, `email_verified`, `name`, `company` and
`groups` as ID token claims. Verify that the pinned source exposes these to its
claim mapping, including when userinfo omits them. Use HTTPS ingress and a
certificate trusted by the browser.
Authentik's containers must reach the issuer, its discovery, token, JWKS and userinfo
endpoints. The issuer defaults to `https://inhouse.technology`; discovery is
`<issuer>/.well-known/openid-configuration`.

Add to the installer config:

```yaml
authentik:
  iht:
    issuer: https://inhouse.technology
    client_id: your-ihc-client-id
    client_secret_env: IHC_IHT_CLIENT_SECRET
```

The admin obtains the secret from the private, no-store response after creating or
rotating the client in Login (`/empresas/{id}/login`). It is shown only in that response;
there is no separate secret-retrieval link. In the terminal that will run the installer,
read the **secret value** without echo:

```bash
IFS= read -r -s -p 'iht client secret: ' IHC_IHT_CLIENT_SECRET; printf '\n'
export IHC_IHT_CLIENT_SECRET
./install.sh --non-interactive --config local/config.yaml
unset IHC_IHT_CLIENT_SECRET
```

Never paste the secret into an agent conversation, command argument, YAML file or
repository. Alternatively, an interactive install with that config asks
for the missing secret with hidden input after approval. The installer uses its
existing secret mechanism to save `IHT_CLIENT_SECRET` in `.env` (0600); it never
generates a replacement for an external client secret. The current shared `.env`
format cannot represent quotes, backslashes, dollar signs, backticks or control
characters safely in externally supplied secrets: these are rejected without
printing the value. Re-runs keep the saved secret. For a deliberate credential
rotation, the installing human updates `IHT_CLIENT_SECRET` in the private `.env`
and recreates both Authentik containers, then verifies blueprint application.

`docker/authentik/iht.yaml` is copied to `<install-dir>/authentik/blueprints/` and
mounted read-only at `/blueprints/custom/` in both Authentik containers. It declares
the OpenID Connect source, claim mapping, automatic enrollment and an independent
local recovery flow. Credentials and group names come from container environment;
the YAML contains no secret. Authentik's worker discovers and reapplies the blueprint.
The blueprint also configures `default-authentication-identification` with
`user_fields: []` and exactly one source, `inhouse-technology`. In the pinned
Authentik **2026.8.4**, this makes the identification stage **redirect straight to
iht**: people see iht's sign-in page (including its Google option), without an
Authentik username/password form or a source-link click. This is the supported
[identification-stage behavior](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/identification/)
implemented in the [pinned stage](https://github.com/goauthentik/authentik/blob/version/2026.8.4/authentik/stages/identification/stage.py).
Its password stage, enrollment link and recovery link are unset.
First-run waits for the source, recovery flow and built-in default flow, checks
identifier matching, then reconciles and reads back those identification settings.
The blueprint carries the same settings so worker reimports preserve the redirect;
the API step also updates existing installations after asynchronous blueprint import.
Without an enabled iht connection, this blueprint is not installed and first-run
does not change authentication.

Accounts are linked by the source's provider identifier (`sub`), **never email**:
`user_matching_mode: identifier`. A same-email local account must remain a different
identity, even when the upstream claims `email_verified: true`. Username is
`iht-<sub>`; email and display name come from their respective claims. The source
uses its own user path. Do not change an installed source's issuer or client id
in place: those values define the identity namespace. The installer refuses those
changes, and refuses silently removing an enabled configuration. Moving to another
provider or restoring password login needs a planned operator migration with
account ownership verified independently of email.

The `admin` claim maps to `authentik.portal_group` (`ihc-admins` by default).
Both `admin` and `member` receive `authentik.app_group` (`ihc-users` by default),
so admins can also use ordinary apps, Git and the MCP gateway. Unknown role names
grant no group. These are application admin rights; the mapping never sets
Authentik's superuser flag. `company` is not used to choose a tenant or grant
access: the iht client must already be scoped to the company by its owner.
The mapping clears the OpenID source's base group list before returning ihc
groups: Authentik merges lists, so otherwise raw `admin`/`member` groups would
also be created. On each source login, the pinned Authentik version reconciles
membership in groups connected to this source; promotion adds `ihc-admins` and
demotion removes it while retaining `ihc-users`.

**Recovery:** bookmark `https://<authentik host>/if/flow/ihc-local-recovery/`.
This separate emergency path is never linked from the default login page; open the
bookmark directly if iht is unavailable.
It authenticates a local password but only `akadmin` can finish and receive a
session; an ordinary local account cannot use it to bypass iht. Keep the current
`akadmin` password offline (the original is `AUTHENTIK_BOOTSTRAP_PASSWORD` in
`.env`, unless a person has since changed it). Test recovery before depending on
iht. Do not use email matching to repair access. On an existing installation,
after an approved plan, enable with `--apply --from foundation` so the new env,
mount, blueprint and first-run reconciliation all run.

#### Automated Lima SSO verification

On a Mac with Lima and network access, run the opt-in integration test (it is not
part of CI). It copies this checkout and a local iht source tree into a dedicated
`ihc-sso-e2e` VM using `docker-rootful`, 4 CPUs, 6 GiB RAM and a 40 GiB disk:

```bash
scripts/tests/sso-iht-e2e.sh --iht-source /path/to/inhouse-technology
```

The source defaults to a sibling `inhouse-technology` directory. The harness uses
throwaway credentials, seeds Acme and Other through iht's store, and starts a
Google-shaped mock OIDC provider. It never calls a real identity provider or the
production iht. It installs ihc with local ingress and drives Chromium inside the
VM through the portal, Authentik, iht and mock provider. iht uses HTTPS on the VM's
Docker bridge address with a temporary certificate trusted inside the VM and
Authentik containers; Authentik's callback uses `auth.cloud.localhost`, which iht
allows over HTTP for development. Production issuer validation remains HTTPS-only.
Installation and operator smoke checks run as root inside this disposable VM,
matching the rootful deploy runner's ownership of app artifacts. No host Docker
context is selected or used.

The final table checks owner/member groups, company isolation, distinct subjects
sharing an email, role changes on later logins, administrator-only local recovery,
and direct login after restarting Authentik and reapplying the mounted blueprint.
The restart check deliberately restores a username field while the worker is
stopped, then verifies the blueprint removes it again without first-run. Any
failed check exits nonzero. The VM is deleted on success or failure. For diagnosis,
`--keep-vm` keeps it and its `~/sso-e2e/logs`; `--reuse --keep-vm` reruns in a VM
previously created by this harness. Delete it afterwards with
`limactl delete --force ihc-sso-e2e`. Never use these options with valuable data.
The account-recycling check first verifies iht refuses the lost membership, then
explicitly admits the new identity as a fresh domain member through the store API
and verifies Authentik creates a separate user for its distinct subject. A denied
source login can auto-retry in Authentik's source-only flow; the test observes the
real `access_denied` callback response and closes that page before asserting no
session. A local non-admin's recovery policy skips the login stage and returns
to normal login without a session. With `--keep-vm`, logs may require `sudo` to read.

#### Additional release verification (requires a real iht)

The offline test `scripts/tests/iht-sso.sh` checks config, secret handling,
expressions, mounts and stubbed reconciliation. It does not import a blueprint
into Authentik or prove OIDC protocol behavior. Before release, on a clean Lima VM:

1. Install with no iht configuration; verify the existing local login and all
   existing smoke tests. Then repeat on a second clean install with real client
   credentials and HTTPS ingress. Confirm blueprint status is successful on the
   pinned Authentik image (2026.8.4), including model/field names and discovery.
2. Open a protected app in a fresh browser session and confirm Authentik redirects
   straight to inhouse.technology, with no username/password form, source chooser
   or recovery link. Complete a real
   authorization-code login with the exact callback above; verify first login
   needs no local password or manual enrollment and maps username, email and name.
3. Log in twice as the same `sub`, then change its email upstream and log in again:
   one ihc user and source connection must remain. Pre-create a local user with the
   same email, including an admin email; a different `sub` must never inherit it,
   its groups or its session. Test two distinct `sub` values sharing an email.
4. Test `member`, `admin`, empty and unknown groups: inspect actual membership and
   portal/Gitea/MCP/ops authorization. Change admin to member and remove all groups;
   check that the source mapping removes former grants on the next login, rather
   than retaining or accumulating them. Verify custom installer group names too.
5. Sign out and test recovery while iht is unavailable: `akadmin` succeeds, another
   local user with a valid password cannot obtain a session, and a wrong password
   fails. Verify normal login cannot authenticate a local user by direct POST.
6. Repeat first-run, restart/recreate both Authentik containers and restart the VM:
   no duplicate sources/users/flows, secret retained, blueprint reapplied, login
   still redirects directly and recovery still works. Exercise worker import delay and
   failed blueprint import; first-run must not hide local login on failure.
7. Verify invalid issuer, audience, signature, expired token, missing `sub`, and
   unapproved company/client access are rejected by the OIDC source/provider.
   Inspect installer output/logs and generated YAML for credential leakage.
8. On a pre-feature install, exercise the approved `--from foundation` upgrade.
   With iht enabled, automated smoke checks that need a local ordinary-user login
   cannot prove access: test 25 is explicitly skipped; tests 18 and 24 retain
   infrastructure/API checks and warn about missing real-member verification.
   Complete those browser/PKCE and role checks with real iht users as above.

## Deploy an app

On the box (the Actions runners are part of every install):

```bash
scripts/ihc-app.sh new expense-report --owner maria@example.com --install-dir /opt/inhousecloud
cd expense-report
git push -u origin main
```

The push runs `.gitea/workflows/deploy.yml` on the box: the app gets its own database and role on the shared Postgres, a Redis user limited to its key prefix, an env file at `<install-dir>/apps/expense-report/.env` (0600), the route `expense-report.<BASE_DOMAIN>` behind the SSO and a line in `inventory.json`; then it is built, started on the ihc network and checked at `/health`. Every later push redeploys it, keeping its passwords. The flow, the runners and the trust they need: [`gitops-flow.md`](gitops-flow.md). The contract the app keeps: [`app-contract.md`](app-contract.md).

`scripts/bootstrap.mjs` remains for cloning the platform repositories of a manifest (`bootstrap/repos.example.json`); it no longer starts services.
