# Runbooks

One file per operation, for the operator of a harness box ([`../operator-contract.md`](../operator-contract.md)). Each says its purpose, its level of autonomy, the preconditions, the commands (read mode first), the post-checks, and an example from a real box.

| Runbook | When | Level |
|---|---|---|
| [diagnose-app-down.md](diagnose-app-down.md) | "the app is down", a 5xx, a login loop | 1 (diagnosis); the fix has its own level |
| [redeploy-app.md](redeploy-app.md) | put a merged change on the air again, or roll back | 2 |
| [restart-service.md](restart-service.md) | a restart is the hypothesis | 2 for an app, 3 for core |
| [disk-pressure.md](disk-pressure.md) | free disk low, a build or dump failing on space | 1 to read, 2 for build cache, 3 for anything else |
| [backup-stuck.md](backup-stuck.md) | the backup is late, failed, or "running" for too long | 1 to read, 3 to intervene |
| [database-migration.md](database-migration.md) | an app's release changes its schema or data | 3 unless purely additive |
| [route-and-provider.md](route-and-provider.md) | a name, a route, the SSO in front of an app | 1 to read, 3 to change |
| [incident-record.md](incident-record.md) | after any incident | 1 |

## Conventions

Commands run **on the box, as the user that installed it**, unless marked *(agent)*.

```bash
I=/opt/open-company-harness          # the install directory (state.json, .env, compose.yml)
H=~/open-company-app-harness         # the harness checkout install.sh ran from
dc() { docker compose --project-directory "$I" -f "$I/compose.yml" "$@"; }
set -a; . "$I/.env"; set +a          # only for the commands that say so: it puts secrets in your shell
```

- A core service is a service of the Compose project `harness` (`dc ps`). An app is the Compose project named by its slug (`docker compose -p <slug> ps`); its container is `<slug>-app-1`.
- `scripts/harness-operator.sh brief --install-dir "$I"` prints the map of the box: read it before anything else.
- *(agent)* lines are for the agent profile's container, where `harness-ro` replaces `docker` and `curl` reaches the services by name on the `harness` network (`http://proxy/` with a `Host` header is a request through the proxy). What the container cannot run, the agent asks a human to run, quoting the line.
- Never print a value from `.env` or an app's env file. `python3 "$H/scripts/lib/envfile.py" keys FILE` lists names.
