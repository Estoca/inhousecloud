# Security Policy

## Reporting a vulnerability

Report it privately, through GitHub: on this repository, **Security > Report a vulnerability** (a private security advisory). Only the maintainers see it, and the discussion, the fix and the credit stay in that advisory until it is published.

Please do not open a public issue, pull request or discussion for a vulnerability, and do not test against an installation that is not yours.

What helps: the version (`git rev-parse --short HEAD` of the checkout that installed it), the ingress mode and profiles (`install.sh status --json`), the steps to reproduce on a clean box, and what an attacker gains. Strip passwords, tokens, keys, real domains and IP addresses from anything you attach.

## What to expect

This is a small project maintained by a small team, not a company with a security response desk. Honestly:

- an acknowledgement within **5 working days**;
- a first assessment (in scope or not, how severe) within **15 working days**;
- a fix or a mitigation in the docs as soon as we have one, usually within 90 days for anything serious; we will tell you in the advisory if it will take longer, and why;
- credit in the advisory and in the fix, if you want it.

There is no bug bounty.

## Scope

In scope, in this repository:

- **The installer**: `install.sh`, `scripts/` (`first-run.sh`, `ihc-app`, `ihc-backup`, `ihc-operator`, `ihc doctor`, `scripts/lib/`), the rendered `docker/compose.yml` and the configuration it writes. For example: a secret printed, logged or written with a loose mode; a path or name from a config or a manifest that reaches a shell; a route that skips the sign-in; a check of `ihc-app provision` that an app can get around.
- **The portal** (`portal/`): its role checks, the status API and its token, what it reads from Docker and Authentik.
- **The MCP gateway**: sign-in, the token checks, the actor JWT, the routing to apps.
- **The images built here**: `docker/deployer`, `docker/backup`, `docker/agent` (the read-only Docker filter) and the portal image, and the app template in `templates/app`.

Out of scope: vulnerabilities in the upstream projects the cloud runs (Authentik, Gitea, Nginx Proxy Manager, Postgres, Redis, Garage, restic, Tailscale, OpenClaw and the ops tools): report those to them, and tell us if our configuration makes one worse. Also out of scope: an installation whose admin turned a protection off, social engineering, and anything that needs root on the box already.

## The security model, in short

The full model is [`docs/security.md`](docs/security.md). The parts a report usually turns on:

- **Credentials live on the box.** The installer generates every password, token and key into `<install-dir>/.env` (mode 0600), never prints one and never puts one in Git; each app gets its own `apps/<slug>/.env`.
- **Everything is behind the company sign-in** (Authentik forward auth on the proxy), except what an admin makes public on purpose and the one status API path that takes a read-only token.
- **The push to `main` is the deploy.** Pull requests run validation without secrets, the Docker socket or the cloud's network. The deploy runner serves the organization's repositories only, and its jobs are root on the box: write access in the Gitea organization is box access.
- **Apps share the platform and cannot bring their own.** No own Postgres, Redis or object storage, no Docker socket, no host networking, no privileged mode; `ihc-app provision` checks it on every deploy.
- **Admin tools are root.** The `ops` profile (web terminal, file browser, Portainer) is for `ihc-admins` only; membership of that group is root on the box.
- **The operator agent holds nothing worth stealing.** The `agent` profile reads Docker through a read-only filter, sees no `.env` and no socket, and writes nothing unless an admin allows two named actions.
