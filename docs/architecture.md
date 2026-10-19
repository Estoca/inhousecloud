# Architecture

Open Company App Harness describes a single-box internal cloud: one machine that runs the core services a small company needs to build, protect, deploy, observe, and operate internal apps.

The deployment harness is only one layer of the system. The full architecture includes ingress, SSO, Git, runtime, shared services, observability, and an agent-friendly control loop.

## Topology

```text
users
  |
cloudflared
  |
reverse proxy
  |
auth gateway
  |
internal apps
  |
shared services
```

The support plane runs beside the app path:

```text
Git server + Actions
Portainer
Glances
App portal (read-only)
Backups and local config
```

Coding agents and developers prepare code, manifests, Docker Compose files and tests. A push to `main` is the approval; the deploy job on the box validates those artifacts and deploys only when they keep the contract.

## Components

### Ingress

The ingress layer exposes internal apps without requiring every app to manage TLS, public ports, or edge configuration.

The reference path is:

- Cloudflare Tunnel or another tunnel provider;
- Nginx Proxy Manager, Traefik, Caddy, or nginx;
- one route per app domain.

### Auth Gateway

The auth gateway provides SSO and default access control for internal apps.

The reference implementation uses Authentik with forward-auth headers. Apps can trust the gateway for identity headers and avoid implementing login from scratch unless they need app-specific permissions.

### Git Server

The Git server hosts the harness, app repositories, and the workflows that deploy them.

The reference implementation uses Gitea because it is small, self-hosted, and enough for internal app workflows.

### App Repository

Each app repository contains:

- `company-app.yaml`: operational manifest;
- `docker-compose.yml`: runtime definition;
- `.env.example`: documented environment variables without secrets;
- `README.md`: local development and deployment notes;
- `/health`: HTTP health endpoint.

### Deploy Runner and Executor

The core runs two Gitea Actions runners. `gitea-runner` serves CI for any repository, with no Docker socket in its jobs. `gitea-deployer` serves the organization's repositories only (label `harness-deploy`) and gives its jobs the Docker socket, the harness network and the install directory.

An app's deploy workflow runs there on every push to `main`. Its executor is `scripts/harness-app.sh provision`: it validates the manifest and the compose file, then ensures the app's database and role on the shared Postgres, its Redis ACL user, its optional bucket, its env file in the install directory, the proxy route with forward auth, the Authentik application and the inventory record. Then the job builds the app, starts it on the harness network and waits for its healthcheck through the proxy. The executor is idempotent and never deletes. Details: [`gitops-flow.md`](gitops-flow.md).

The first box ran this loop through a deploy-request repository and an operator agent on the box; both were retired once the operator's steps became the executor.

### Portal

The portal shows:

- app inventory (`inventory.json`, written by the executor);
- deploy runs (Gitea Actions);
- runtime state;
- health status;
- backup status.

It is read-only: it compares Git intent with real infrastructure state instead of becoming the source of truth, and nothing writes to it.

### Coding Agents on the Box

A terminal-connected agent on the runtime host is still useful for what the executor does not do: diagnosing a failed deploy from its log and the live host, migrating an existing app off its local database, or removing an app by hand. It reads live state before changing anything and never deletes or overwrites repositories, databases, volumes, proxy routes, auth config, or secrets without an explicit request.

### Runtime Host

The runtime host is the same single box. It runs Docker Compose apps and local infrastructure integrations, such as:

- reverse proxy;
- auth gateway;
- app containers;
- shared services like Postgres, Redis, or object storage when appropriate.

### Support Plane

The support plane keeps the single box understandable:

- Portainer shows containers, images, volumes, networks, and stacks.
- Glances exposes host resource usage.
- The portal shows inventory, deploy runs, health, ownership, and drift.
- Backups and local generated config are explicit operational concerns.

### Coding Agent Rules

Coding agents should read the live rules before preparing a repo. They edit app code and push; the deploy job creates routes, databases and SSO. They should not create proxy routes by hand, assign fixed ports, or bring their own Postgres, Redis or object storage.

## App Deployment Flow

1. A user asks an agent or developer to create an internal app.
2. `harness-app new <slug>` creates the repository from the template in the Gitea organization.
3. `company-app.yaml` declares owner, runtime, health, auth, and the shared services it needs.
4. Local checks validate the app and its health behavior.
5. A push to `main` approves the deploy.
6. The deploy workflow runs on the box: checkout, `harness-app provision`, `docker compose up`, healthcheck through the proxy.
7. The run log is the record; the portal reads it with health and inventory.
8. Every later push to `main` redeploys the same way.

## Why Single Box First

The single-box model works because it optimizes for operational coherence:

- the agent can inspect the same environment it helps operate;
- Git, SSO, proxy, runtime, and observability share one failure domain and one mental model;
- internal apps get real production behavior without needing a full platform team;
- small teams can defer Kubernetes and managed cloud complexity until they actually need it;
- the platform remains portable because the contracts are explicit.
