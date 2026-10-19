# Agent Setup Contract

This document describes the target experience for installing Open Company App Harness with a terminal-connected LLM.

The ideal user prompt is intentionally simple:

```text
Clone this repository and set up this machine as an internal company cloud.
Explain what you will install before changing anything.
```

The agent should be able to read the repository, understand the stack, ask for missing decisions, generate a plan, apply approved steps, and leave the machine ready to deploy its first internal app.

## Target Experience

1. The user sends the public repository URL to an LLM with terminal access.
2. The LLM clones the repository.
3. The LLM reads the README, architecture, quickstart, bootstrap playbook, compose files, schemas, and templates.
4. The LLM explains the whole stack before making changes.
5. The LLM asks for required local choices and credentials.
6. The LLM generates an inspectable setup plan.
7. The user approves the plan.
8. The LLM installs and configures the approved services.
9. The LLM verifies the stack and reports URLs, credentials handling, health, and next steps.
10. The machine is ready for a new app deploy flow.

## What The Agent Must Explain

Before applying changes, the agent should explain:

- which services will be installed;
- why each service exists;
- which ports, domains, and local paths will be used;
- which data will persist on disk;
- which generated files may contain secrets;
- which actions require human approval;
- how to stop, inspect, update, and back up the stack;
- how the first app deploy will work after bootstrap.

## Reference Services

The default single-box cloud includes:

- `cloudflared` or another tunnel for public ingress;
- Nginx Proxy Manager, Traefik, Caddy, or nginx for reverse proxying;
- Authentik, Authelia, OAuth2 Proxy, or another auth gateway for SSO;
- Gitea, GitHub Enterprise, GitLab, or GitHub for source control and automation;
- Docker Compose as the runtime;
- Portainer for container and stack inspection;
- Glances for host observability;
- Postgres and Redis as common shared services;
- an app portal / orchestrator for inventory, deploys, health, and drift;
- one GitOps repository for first-deploy requests;
- one repository per internal app.

The reference ingress path is:

```text
user -> tunnel -> reverse proxy -> auth gateway -> app
```

## Questions The Agent Should Ask

The agent should ask only for values it cannot infer safely:

- install directory;
- internal base domain;
- tunnel provider and token setup method;
- reverse proxy choice;
- auth provider choice;
- Git provider choice;
- initial admin email;
- initial admin username, when needed;
- initial admin password or permission to generate one locally;
- default database/cache/storage choices;
- whether Docker services may be started now;
- whether public routes or DNS records may be created now.

The agent must never ask the user to paste long-lived secrets into committed files.

## Required Safety Behavior

The agent must:

- run plan mode before apply mode;
- keep generated config under `local/` or another ignored path;
- avoid committing secrets;
- avoid deleting existing data;
- avoid overwriting existing repositories, volumes, databases, or proxy routes;
- request explicit approval before starting services or changing external routing;
- verify generated files and service health after each major phase;
- produce a final report with what changed and what still needs manual setup.

## Bootstrap Phases

The installer (`install.sh`, built from `docs/install-design.md`) is the whole path: the agent runs it and answers its questions, through a config file. The phases below map to its modes.

### 1. Inspect

Read the repository and inspect the host:

```bash
git status --short
docker --version
docker compose version
./install.sh status --install-dir /opt/open-company-harness   # fails cleanly on a fresh box
```

If Docker or Compose v2 is missing, stop and report prerequisites instead of improvising an installation.

### 2. Plan

Write the answers to a local, ignored config file and ask the installer for its plan:

```bash
mkdir -p local && cp bootstrap/config.example.yaml local/config.yaml
./install.sh --plan --config local/config.yaml
```

Preflight validates Docker, disk, memory, ports and the ingress matrix and refuses what it cannot install. Review the plan with the user.

### 3. Apply

After approval, one command does everything: secrets, images, networks and volumes, every service in order with its healthcheck, the first access, the smoke tests, the handoff:

```bash
./install.sh --non-interactive --config local/config.yaml --json
```

Starting services is part of this step; the separate approval the contract asks for is the approval of the plan. Public routes and DNS records are never created by the installer.

### 4. Resume

A failed stage prints its cause and the resume command; nothing is rolled back and completed stages are skipped:

```bash
./install.sh --apply --install-dir <dir> --from <stage>
```

### 5. Verify

`./install.sh status --install-dir <dir> --json` is the source of the report. The smoke tests (`docs/smoke-tests.md`) have already checked:

- every core container is running and healthy;
- the shared Postgres and Redis answer;
- Authentik is live and ready and publishes OIDC discovery with the expected issuer;
- Gitea answers its API, has the OIDC source, and an authenticated `ls-remote` works;
- the proxy routes the local names, and the portal route redirects anonymous requests to the outpost;
- the portal answers `/health`;
- the portal's database role is not a superuser.

## Expected Final State

At the end, the user should have:

- a running single-box internal cloud;
- local admin credentials stored outside Git;
- Git hosting for the harness and apps;
- SSO protecting internal routes;
- container and host visibility;
- a sample app template;
- a deploy request repository;
- a documented path for creating the next app with an LLM.

The agent should finish with a short report:

- installed services and profiles;
- local URLs (`inventory.json` in the install directory);
- public URLs, if any;
- generated files, and the names of the credentials in `.env` (never their values);
- smoke test results;
- manual steps still required (`docs/first-run.md`: first login, MFA, bootstrap password, SMTP, DNS or tunnel);
- how to create the first real app.
