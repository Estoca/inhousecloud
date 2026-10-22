# The First Person After You

The install leaves one person: `akadmin`, in both groups. This is how a second person gets in, what each group opens, and what does not work yet because mail is off.

`cloud.localhost` below is the example base domain; use yours.

## The two groups

| Group | Opens | For |
|---|---|---|
| `ihc-users` | Gitea (sign-in with Authentik), every app deployed on the cloud, and the portal's catalog: each app with its health, SSO and deploys | everyone who uses or builds apps |
| `ihc-admins` | the whole portal (also Platform, Dockers and People: the box's services, its containers, and who is in which group) and the ops tools (web terminal, file browser, Portainer, Glances) when the `ops` profile is on | the few who operate the box |

They do not include each other: an admin who also uses the apps is in both, like `akadmin`. The ops tools are a shell and the files of the box, so `ihc-admins` is root on it in practice ([`security.md`](security.md)). The names come from `authentik.app_group` and `authentik.portal_group` in the config.

## Add a person

In Authentik's admin interface, <http://auth.cloud.localhost/if/admin/>, signed in as `akadmin`:

1. **Directory > Users > Create.** Username, name, email; type `Internal`. The email is required for the portal: it knows a person by the email Authentik sends, and without one sends them to its sign-in page.
2. Open the new user: **Set password**. Pick a temporary one and send it to the person over a channel other than the one where you send the URL.
3. **Directory > Groups > `ihc-users` > Users > Add existing user**: the person. Also `ihc-admins`, only if they operate the box.

The person then opens <http://portal.cloud.localhost>, an app, or <http://git.cloud.localhost> with "Sign in with authentik", and at <http://auth.cloud.localhost/if/user/> changes the password and enrolls MFA (Settings > MFA Devices).

**Gitea.** The first "Sign in with authentik" creates their Gitea account. To let them push to an app's repository (a push to `main` is a deploy), add them, after that first sign-in, to a team of the organization with write access: Gitea > `company` > Teams. Without it they see nothing: every app repository is private.

**Check it.** Portal > People (admins) lists every user with email, active or not, and groups, and every group with its members, as Authentik has them now (up to a minute old; Refresh reads again). It only reads: adding, removing and changing groups stays in Authentik.

**Remove a person.** Authentik > Directory > Users > the person > Deactivate. It closes every app and Gitea at once (they all sign in through Authentik); their Gitea account stays, without access.

## Off until mail is set up

The cloud is installed with no mail server: Authentik has no SMTP settings and Gitea runs with `GITEA__mailer__ENABLED: "false"`. So:

- **No password recovery.** A person who forgets the password asks an admin, who sets a new one (step 2 above). The same goes for `akadmin`: keep its MFA recovery codes (static tokens) and password in a password manager.
- **No invitations or self sign-up.** Every person is created by an admin, as above. Gitea registration is closed (`DISABLE_REGISTRATION`); the accounts come from Authentik.
- **No notification mail** from Gitea or Authentik.

**Turning it on is not in the installer yet.** It needs an SMTP account and, on the box:

- Authentik (`authentik-server` and `authentik-worker`): `AUTHENTIK_EMAIL__HOST`, `AUTHENTIK_EMAIL__PORT`, `AUTHENTIK_EMAIL__USERNAME`, `AUTHENTIK_EMAIL__PASSWORD`, `AUTHENTIK_EMAIL__USE_TLS` (or `__USE_SSL`), `AUTHENTIK_EMAIL__FROM`. Then a recovery flow (Flows > Import, Authentik's example "recovery with email verification") set as the brand's recovery flow, and an enrollment flow for invitations.
- Gitea: `GITEA__mailer__ENABLED: "true"`, `GITEA__mailer__PROTOCOL`, `GITEA__mailer__SMTP_ADDR`, `GITEA__mailer__SMTP_PORT`, `GITEA__mailer__USER`, `GITEA__mailer__PASSWD`, `GITEA__mailer__FROM`.

Those go in the services' environment in `compose.yml`, which `install.sh` renders again on every run, so an edit there by hand does not last. Carrying an `smtp:` section of the config into `.env` and the compose file is the planned change; until it lands, the admin sets passwords.
