# Security

The harness is designed around a conservative trust boundary.

## Trust Boundary

- Coding agents may edit files and open pull requests.
- Pull requests run validation on the CI runner, without secrets, the Docker socket or the harness network.
- Real deploys happen only on a push to `main`: that push is the approval.
- The deploy runner serves the organization's repositories only. Its jobs have the Docker socket and the install directory, so a deploy job is root on the box: write access in the organization is box access ([`gitops-flow.md`](gitops-flow.md)).
- Credentials live on the box: the install `.env` and each app's `apps/<slug>/.env`, mode 0600, never in Git, never printed.

## Ops tools: admin access to the machine

The `ops` profile (on by default in the interactive installer) adds four tools for `harness-admins`. Treat membership of that group as root on the box:

- **Web terminal (`terminal.<BASE_DOMAIN>`, Wetty) is a shell on the host** as the user that ran `install.sh`, who is in the `docker` group or runs rootless Docker: equivalent to root on the box. It signs in with a dedicated key, `<install-dir>/local/wetty/id_ed25519`, whose public half sits in that user's `~/.ssh/authorized_keys` (comment `harness-wetty@<host>`). To revoke it, delete that line; to rotate it, delete the line and the two key files and re-run `install.sh --apply --from optional_profiles`. The key is in the backup (the install directory is backed up), encrypted with the backup key.
- **File browser (`files.<BASE_DOMAIN>`, FileBrowser) sees every app's data**, read and write, and the backup reports, read only. What it does **not** mount, on purpose: the install directory itself, `.env` (every platform secret), `apps/` (each app's `.env` with its database password), `local/` (the terminal key), `runner/`, `state.json`, `config.yaml`, the restic repository, home directories and system directories. App data lives in `<install-dir>/app-data/<slug>`, apart from `apps/<slug>/`, precisely so it can be shown without the secrets next to it. The installer refuses a configured path that breaks this rule, and `scripts/tests/ops-mounts.sh` fails if the compose file ever mounts the install directory or an env file into it.
- **Portainer** has the Docker socket (root on the box) and **Glances** sees every process: both were already admin tools; they now require `harness-admins` too.
- **No way around the SSO.** The four run on the `harness-ops` network, which only the proxy joins; apps on the `harness` network cannot reach them directly. They publish no host port and their routes leave no path public. FileBrowser trusts the `X-authentik-username` header only because nothing but the proxy can reach it.
- **The smoke user.** With `ops`, first-run keeps `harness-smoke-user` in `harness-users` (no admin rights; password only in `.env`, 0600) so smoke test 18 can prove the denial with a real sign-in. It can open Gitea and the apps like any user; deactivate it in Authentik if you do not want it, and test 18 will then fail at the sign-in rather than at the denial.

## Rules

- Never store secrets in app manifests, compose files or `.env.example`.
- Never deploy production on pull request events.
- Never run untrusted pull request code with deploy credentials.
- Never delete databases, volumes, repositories, stacks, or proxy routes automatically.
- Never overwrite an existing domain or app without an explicit policy.
- Prefer authentication for internal apps by default.
- Prefer automatic port allocation for new apps.
- Keep local `.env` files out of Git.

## Required Validations

Checked by `harness-app provision` on every deploy:

- The repository belongs to the organization (the deploy runner serves nothing else) and its name is the app's slug.
- The slug is not one the platform uses and is not registered to another repository.
- The domain is `<slug>.<BASE_DOMAIN>`, and no other route already owns it.
- App manifest is present and valid; compose file present, with the declared service.
- Healthcheck is declared.
- `deploy.port` is `auto`; host ports are dropped.
- No local Postgres, Redis or MinIO; no host networking, privileged mode or Docker socket.

Not checked yet: obvious secret values in tracked files.

