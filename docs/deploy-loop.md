# The Deploy Loop

The app repository says what should exist; the deploy job makes it exist and logs what it did; the portal reads the result.

## Deployment control loop

```mermaid
flowchart LR
  Human[Human or team] --> Agent[Coding agent]
  Agent --> AppRepo[App repository<br/>company-app.yaml, compose, .env.example]
  Rules[Live cloud rules] --> Agent

  AppRepo -->|push to main = approval| Actions[Gitea Actions<br/>deploy runner on the box]
  Actions --> Build[ihc-app build<br/>release: commit files + images]
  Build --> Apply[ihc-app apply<br/>lock, head of main, journal]
  Apply --> Provision[ihc-app provision]
  Provision --> Services[Shared Postgres, Redis, Garage S3<br/>own database, role, prefix, bucket]
  Provision --> Proxy[Proxy host + forward auth]
  Provision --> Auth[Authentik provider + application]
  Provision --> Inventory[inventory.json]
  Apply --> Docker[start the release's images<br/>on the ihc network]
  Docker --> Health[healthcheck through the proxy]
  Health --> Journal[deploy journal]
  Journal --> Actions

  Actions --> Portal[Portal, read-only:<br/>runs, journal, health, inventory]
  Portal --> Human
  Portal --> Agent
```

The step by step, the runners and the trust they need: [`gitops-flow.md`](gitops-flow.md).

## Core idea

Every deployable app carries its operational contract in the repository:

```yaml
schema_version: 1

app:
  slug: example-app
  name: Example App
  owner_email: owner@example.com

runtime:
  type: docker-compose
  compose_file: docker-compose.yml
  service: app
  healthcheck:
    type: http
    path: /health
    expected_status: 200

deploy:
  enabled: true
  domain: example-app.internal.example.com
  port: auto
  env_file: .env
  env_example: .env.example

auth:
  required: true
  provider: forward-auth
  allowed_domains:
    - example.com
```

`ihc-app provision` validates that contract on every push to `main` and refuses an app that breaks it, before anything changes. The full contract, with the variables an app receives and its MCP section: [`app-contract.md`](app-contract.md).

## Operating model

One path, from the first deploy to the hundredth:

1. `scripts/ihc-app.sh new <slug>` creates the app from `templates/app` and its private repository in the Gitea organization.
2. A developer or a coding agent builds the app inside that contract ([`app-contract.md`](app-contract.md)).
3. A push to `main` is the approval. Who may push to `main` is set in Gitea: organization membership, team permissions, branch protection.
4. The deploy workflow runs on the box, on the deploy runner: it checks out the commit, builds a release with `ihc-app build <slug>` (the commit's files and images, without the cloud's credentials), and `ihc-app apply <slug>` puts it on the air under the app's lock, only when the commit is the head of `main`: it journals what it will change, runs `provision` (database and role on the shared Postgres, Redis ACL user and prefix, optional bucket, the app's env file, the proxy route with forward auth, the Authentik application, the inventory record), starts the release's images on the ihc network, and waits for its healthcheck through the proxy.
5. The run log in Gitea and the deploy journal on the box are the record; the portal reads both. A bad release is undone with `ihc-app rollback <slug>` on the box.

Nobody else acts between the push and the app on the air: the run log is the record and the push is the approval ([`gitops-flow.md`](gitops-flow.md)).

The deploy runner has the Docker socket and the install directory: a job there is root on the box, which is why it serves the organization's repositories only, and why write access in the organization should go to people you would trust with a shell on the box.
