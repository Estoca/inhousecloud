# Security

The cloud is designed around a conservative trust boundary.

## Trust Boundary

- Coding agents may edit files and open pull requests.
- Pull requests run validation on the CI runner, without secrets, the Docker socket or the ihc network.
- Real deploys happen only on a push to `main`: that push is the approval.
- The deploy runner serves the organization's repositories only. Its jobs have the Docker socket and the install directory, so a deploy job is root on the box: write access in the organization is box access ([`gitops-flow.md`](gitops-flow.md)).
- Credentials live on the box: the install `.env` and each app's `apps/<slug>/.env`, mode 0600, never in Git, never printed.
- **Object storage: the root credentials never reach an app.** Garage's RPC secret, admin token and metrics token are in the install `.env` only. Each app gets its own access key, allowed to read and write its bucket `app-<slug>` and nothing else: not owner (no bucket policy or deletion), no bucket creation, 403 on another app's bucket (smoke test 19). The admin API listens on `garage:3903` with a token and is not routed by the proxy; the RPC port answers only to the RPC secret. `s3.<BASE_DOMAIN>` is public to whoever reaches the proxy, like any S3 endpoint: every request must be signed by a key. Provision sends secrets to Garage on stdin, never on a command line.

## Ops tools: admin access to the machine

The `ops` profile (on by default in the interactive installer) adds four tools for `ihc-admins`. Treat membership of that group as root on the box:

- **Web terminal (`terminal.<BASE_DOMAIN>`, Wetty) is a shell on the host** as the user that ran `install.sh`, who is in the `docker` group or runs rootless Docker: equivalent to root on the box. It signs in with a dedicated key, `<install-dir>/local/wetty/id_ed25519`, whose public half sits in that user's `~/.ssh/authorized_keys` (comment `ihc-wetty@<host>`). To revoke it, delete that line; to rotate it, delete the line and the two key files and re-run `install.sh --apply --from optional_profiles`. The key is in the backup (the install directory is backed up), encrypted with the backup key.
- **File browser (`files.<BASE_DOMAIN>`, FileBrowser) sees every app's data**, read and write, and the backup reports, read only. What it does **not** mount, on purpose: the install directory itself, `.env` (every platform secret), `apps/` (each app's `.env` with its database password), `local/` (the terminal key), `runner/`, `state.json`, `config.yaml`, the restic repository, home directories and system directories. App data lives in `<install-dir>/app-data/<slug>`, apart from `apps/<slug>/`, precisely so it can be shown without the secrets next to it. The installer refuses a configured path that breaks this rule, and `scripts/tests/ops-mounts.sh` fails if the compose file ever mounts the install directory or an env file into it.
- **Portainer** has the Docker socket (root on the box) and **Glances** sees every process: both were already admin tools; they now require `ihc-admins` too.
- **No way around the SSO.** The four run on the `ihc-ops` network, which only the proxy joins; apps on the `ihc` network cannot reach them directly. They publish no host port and their routes leave no path public. FileBrowser trusts the `X-authentik-username` header only because nothing but the proxy can reach it.
- **The smoke user.** With `ops`, first-run keeps `ihc-smoke-user` in `ihc-users` (no admin rights; password only in `.env`, 0600) so smoke test 18 can prove the denial with a real sign-in. It can open Gitea and the apps like any user; deactivate it in Authentik if you do not want it, and test 18 will then fail at the sign-in rather than at the denial.

## Private ingress: the tailnet and the CA

`INGRESS=private` ([`install-design.md`](install-design.md#private-ingress-private--internal--tailscale)) puts the box on the company's tailnet. What that exposes and what it trusts:

- **What the tailnet reaches.** Ports 80 and 443 (the proxy, so every route with its SSO), the Gitea SSH port (Gitea's SSH, keys only) and 53 (the split-DNS server, which answers only for `BASE_DOMAIN`). Nothing else: the Tailscale node runs in its own network namespace, so the proxy admin (81), the control ports and every container stay off the tailnet. Smoke test 21 proves the admin port is refused on the tailnet address. Who on the tailnet may reach the node at all is the tailnet's access policy (ACLs or grants): restrict it to the people who should see the apps.
- **What the LAN reaches.** Nothing: in `private` the proxy and Gitea SSH are published on 127.0.0.1 only (smoke test 21 checks the bindings and that the box's other addresses refuse 80 and 443).
- **The auth key** (`IHC_TAILSCALE_AUTHKEY`) is used once, from the installer's environment: it is not in `.env`, not in the compose file and not in the running container. The node's identity is the state in the volume `tailscale-state` (in the backup, encrypted with the backup key); whoever has that volume can impersonate the node, so treat it like a key. To revoke: remove the node in the Tailscale admin console. Prefer a pre-approved, tagged, reusable or one-off key; an ephemeral key's node disappears from the tailnet some time after the box goes offline and a new key is then needed.
- **The CA.** `<install-dir>/local/ca/ca.key` (0600) can sign certificates that every device with the CA installed accepts. Its name constraint limits that to `BASE_DOMAIN` and its subdomains (no other domain, no IP address), so a stolen key cannot impersonate a bank or a public site to those devices. It never leaves the box except in the encrypted backup. `ca.crt` is public. The wildcard key also lives in the proxy's data volume (it serves it).
- **Client addresses.** The proxy sees the Tailscale node as the client of every tailnet request (`X-Forwarded-For` holds the node's container address), not the person's tailnet address: per-person attribution comes from the SSO, not from the network.

## The operator agent: the largest surface of the installation

The `agent` profile (off by default) runs an LLM agent on the box that reads chat messages, logs and web pages, any of which can carry instructions written by someone else. It is therefore built to hold nothing whose loss would be worse than a wrong answer. Its rules are [`operator-contract.md`](operator-contract.md); this is what it can technically reach.

| It sees | How |
|---|---|
| Containers, images, networks, volumes, disk usage, logs, process lists, stats | `agent-docker-proxy`, a read-only filter in front of the Docker socket (`docker/agent/docker-ro-proxy.py`): GET on an allowlist only; logs and stats never stream. **Every `Env` in a container or image inspect comes back as names only**: a plain socket proxy that allows `GET /containers/<id>/json` hands out every service's passwords, the backup key included |
| Every service on the `ihc` network, by name | it joins `ihc` to run HTTP checks the way the proxy does (`http://proxy/` with a `Host` header, health endpoints). It holds no database or admin credential for any of them |
| Gitea, read only | `GITEA_READONLY_TOKEN` (read:misc, read:repository, read:organization, read:user) |
| The backup status | `<BACKUP_DESTINATION>/reports`, mounted read only |
| The map of the box | `<install-dir>/agent/reference/` (read only): the contract, the runbooks, the generated brief (names and places of credentials, never values; the generator refuses to write one that contains a value) |
| Its own LLM key and chat tokens | `AGENT_*` in `.env`, written by a human, passed to its container by name |

| It does not see | Why |
|---|---|
| The Docker socket | only the filter has it; the filter's network (`ihc-agent`) is internal |
| The install directory, `.env`, `apps/` (the apps' env files), `local/` (keys), `state.json`'s directory | not mounted; smoke test 20 checks every mount source |
| Any cloud secret in its environment | only `GITEA_READONLY_TOKEN` and `AGENT_*`; smoke test 20 compares its environment with `.env` |
| The ops tools | not on `ihc-ops` |
| A shell on the host | none; what needs the host, it asks a human to run |
| A port or route | the gateway listens on the container's loopback; people reach it through the chat channel only |

Writes. By default none: every POST, PUT, DELETE through the filter answers 403, and the agent cannot restart even an app. `ops.agent.allow_write: true` adds exactly two: `POST /containers/<id>/restart` for a container of an app's Compose project (never one of the `ihc` project) and `POST /build/prune` (the build cache, never images or volumes). Nothing else is ever on the list: no exec (exec is a shell), no create, no image or volume removal. Re-running a deploy needs a Gitea token that a human creates for it (`AGENT_GITEA_TOKEN`). Each request through the filter is logged (`docker compose logs agent-docker-proxy`).

Who can talk to it. `ops.agent.allow_from` lists chat user ids; empty means pairing, and the admin approves each first DM (`docker compose exec agent node dist/index.js pairing approve <channel> <code>`). Anyone who can talk to it can make it read anything above and repeat it in the chat, logs included: keep the allow list to people who could read the logs anyway. Its LLM provider receives what it reads. In a Telegram group it answers only in the chats listed in `ops.agent.groups`, only when the message mentions the bot, and only to the senders in `ops.agent.group_allow_from` (default `allow_from`): a DM pairing never authorizes anyone in a group, and an empty list means no group at all. Another bot in the group is a sender like any other: list its id only if you want it to be able to ask.

What remains. On the `ihc` network it can open a TCP connection to any service: the shared Redis's default user is still open to every container on that network (apps included; a known gap, to be closed), and a vulnerable service there is reachable from it as from any app. Logs can contain whatever an app chose to log. The OpenClaw image downloads channel plugins at first start, and the LLM and the chat channel are on the internet, so it has egress: asked to, it will `git clone` a public repository into its workspace and read it (it did in the conversation run, [`first-run.md`](first-run.md#operator-conversation-run)). It cannot reach the host or the Docker socket from there, but whoever can talk to it can make it fetch and run code inside its own container.

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

Checked by `ihc-app provision` on every deploy:

- The repository belongs to the organization (the deploy runner serves nothing else) and its name is the app's slug.
- The slug is not one the platform uses and is not registered to another repository.
- The domain is `<slug>.<BASE_DOMAIN>`, and no other route already owns it.
- App manifest is present and valid; compose file present, with the declared service.
- Healthcheck is declared.
- `deploy.port` is `auto`; host ports are dropped.
- No local Postgres, Redis or S3 server; no host networking, privileged mode or Docker socket.

Not checked yet: obvious secret values in tracked files.

