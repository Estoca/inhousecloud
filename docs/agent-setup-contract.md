# Agent Setup Contract

What a terminal-connected coding agent may ask, must do and must never do on a company cloud built with this harness. The commands are in [`llm-bootstrap.md`](llm-bootstrap.md).

## The two requests this contract covers

```text
"Set up this machine as our company cloud."              -> install (llm-bootstrap.md, section 1)
"Build an internal app for X and put it on the air."      -> create an app (llm-bootstrap.md, section 2)
```

Before either, run section 0 of the playbook to learn whether the cloud is already installed. A box with `status: completed` is never reinstalled.

## How it works today

```text
install.sh                     one command: secrets, services, SSO, Git, runners, smoke tests
harness-app.sh new <slug>      app repository from templates/app, created in the Gitea organization
git push origin main           the deploy: Gitea Actions on the box provisions and starts the app
http://<slug>.<BASE_DOMAIN>    the app, behind the company sign-in; /health public
```

A push to `main` of the app's repository is the only approval a deploy needs. The deploy job ([`gitops-flow.md`](gitops-flow.md)) gives the app its own database and role on the shared Postgres, a Redis user limited to its key prefix, an env file on the box, the route and the SSO application, builds it, starts it and waits for its healthcheck. Nobody else has to act for the app to go live.

## Install: what to ask the human

Ask once, all together, offering the defaults from [`bootstrap/config.example.yaml`](../bootstrap/config.example.yaml):

1. install directory;
2. ingress mode (`local`, `private`, `public`) and base domain;
3. admin email;
4. Gitea organization name;
5. backup destination, ideally another disk;
6. optional profiles: object storage (`storage`), Portainer and Glances (`ops`);
7. for `private` or `public`: the name of the environment variable that holds the tunnel token (they export it; you never see it).

Then show `./install.sh --plan` and ask: "apply this plan?". That yes covers starting the services.

## Install: what never to ask

- Passwords, API tokens, keys, bootstrap credentials. The installer generates all of them into `<install-dir>/.env` (0600).
- Anything already in the config with a sensible default (ports, image versions, group names, backup schedule).
- To paste a secret into the chat or into a file in a repository.

## App: what to ask the human

Only what changes the app, and only if the request does not say it:

- what the app must do (fields, screens, who uses it), in a few lines;
- who owns it (an email); if nobody says, the install's admin email, stated in the report.

Pick the slug yourself from the request (`despesas`, `expense-report`) and say it. Do not ask about databases, ports, domains, auth or deploys: the harness decides them.

## The agent must

- Run commands on the box, as the user that installed it, from a checkout of this repository on the box (clone or copy it there first). From another machine, through `ssh`.
- Use `install.sh` to install and `scripts/harness-app.sh new` to create an app. Never assemble containers, routes or SSO by hand.
- Keep the app inside [`app-contract.md`](app-contract.md): listen on `PORT`, answer `/health`, read `DATABASE_URL` and `REDIS_URL`, create its tables on start, take the user from the `X-authentik-*` headers.
- Push to `main` to deploy, then confirm three things before saying it is live:
  1. the deploy run of the pushed commit is `success`;
  2. `GET http://<slug>.<BASE_DOMAIN>/health` answers 200;
  3. `GET http://<slug>.<BASE_DOMAIN>/` answers 302 to the sign-in.
- On a failed run, read the job log, fix the cause in the app repository and push again. The harness's errors say what to change.
- Report: the URL, the repository, the owner, what the human must do (sign in; for a non-local ingress, open the URL from the company network).

## The agent never

- adds `postgres`, `redis`, `minio` (or `valkey`, `keydb`, `postgis`...) services to an app's `docker-compose.yml`: the app uses the shared ones through `DATABASE_URL`, `REDIS_URL`, `S3_*`;
- mounts the Docker socket, uses `network_mode: host`, `privileged: true` or publishes host ports for an app;
- reads or edits another app's `<install-dir>/apps/<other>/.env`, or edits its own by hand (`provision` writes it);
- prints a secret: the values in `<install-dir>/.env` or any app env file. Key names only (`python3 scripts/lib/envfile.py keys <file>`);
- drops a database or role, deletes a bucket, a Redis user, a proxy route, an Authentik object, a repository, a volume or the install directory. Removing an app is a human's job;
- edits `.gitea/workflows/deploy.yml` of an app, or writes a workflow with `runs-on: harness-deploy` anywhere else;
- changes Authentik, the proxy or Gitea settings by hand; `install.sh` and `harness-app` own them;
- turns `auth.required` off, unless the human asked for a public app in those words;
- runs on a box the human did not name, creates DNS records or tunnel routes, or applies an install plan without a yes.

## Human checkpoints

Stop and ask before:

- applying the install plan;
- resuming an install with `--from` on a box that already serves apps;
- anything that removes or overwrites data;
- making an app public (`auth.required: false`);
- creating DNS records, tunnels or anything outside the box.

Creating an app and pushing it to `main` is not a checkpoint when the human asked for the app: the push is the deploy they asked for.

## Done means

For an install: `./install.sh status --json` says `completed`, the smoke tests passed, and the human has the URLs, how to open them from their own computer (for `local` ingress on a box they reach by `ssh`: the port-80 tunnel), the command that shows the first password on their screen, the path of `.env` and the list of steps left to them.

For an app: the three checks above pass, and the human has the URL and knows it asks for the company sign-in.
