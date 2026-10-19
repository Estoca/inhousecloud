# Security

The harness is designed around a conservative trust boundary.

## Trust Boundary

- Coding agents may edit files and open pull requests.
- Pull requests run validation on the CI runner, without secrets, the Docker socket or the harness network.
- Real deploys happen only on a push to `main`: that push is the approval.
- The deploy runner serves the organization's repositories only. Its jobs have the Docker socket and the install directory, so a deploy job is root on the box: write access in the organization is box access ([`gitops-flow.md`](gitops-flow.md)).
- Credentials live on the box: the install `.env` and each app's `apps/<slug>/.env`, mode 0600, never in Git, never printed.

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

