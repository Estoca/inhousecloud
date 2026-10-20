# Restart a service

**Purpose.** Restart the smallest unit that tests a hypothesis, and only then.
**Level.** 2 for **one app's** container, under an explicit instruction naming it. 3 for a core service (proxy, Authentik, Gitea, Postgres, Redis, the runners, the portal, backup, the tunnel), for the Docker daemon and for the host.
**Preconditions.** A hypothesis written in one sentence ("the app holds a dead connection to Postgres after the database restarted") and the evidence for it. "It might help" is not one.

## Read first

```bash
docker compose -p <slug> ps -a                 # an app
dc ps -a                                       # the core
docker inspect -f '{{.Config.Image}} {{.Image}} {{.State.StartedAt}} restarts={{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' <container>
docker logs --since 15m --tail 60 <container>
docker inspect -f '{{json .HostConfig.PortBindings}} {{json .Mounts}}' <container>
```

*(agent)* `occ-ro ps`, `occ-ro inspect <container>`, `occ-ro logs <container> 60`

Write down before acting: image id, ports, mounts, health, the last log lines, and what depends on it (the brief's `depends_on`; for Postgres or Redis: every app). That record is the way back and the comparison after.

## Act

- **One app**: `docker compose -p <slug> restart app`. *(agent)* with `ops.agent.allow_write`: `POST /containers/<id>/restart` through its Docker API, which refuses any container of the `occ` project.
- **A core service** (level 3, after the human's ok for that service): `dc restart <service>`, or `dc up -d <service>` when the configuration changed and the container must be recreated. Never `dc down`, never `dc up -d` without a service name: both touch everything.
- **Not a restart**: a container `unhealthy` while it serves correctly is often a wrong healthcheck, not a sick service. Read the healthcheck (`docker inspect -f '{{json .Config.Healthcheck}}'`) and run it by hand inside the container first.

If it fails again after one restart, stop and go back to diagnosis. Restarting in a loop hides the cause and multiplies the outage.

## Post-checks

Health back to `healthy`; the log of the new start clean; the dependants checked (for a core service: `$H/scripts/smoke-tests.sh --install-dir "$I"` covers the core; for an app: `occ-app wait`). Report: what was restarted, why, how long it took, any side effect.

## Examples

- After the container runtime itself restarted, one app stayed down while the others came back: its stack had no restart policy. The fix was the policy, in the app's compose file; the rule is that a missing `restart:` is noted when an app enters the box.
- A file tool showed `unhealthy` for days while answering 200: its healthcheck script read a settings path as a file, and on that box it was a directory, so the probe called an empty port. With the admin's ok, the probe was replaced by a plain HTTP check and only that service was recreated, in about 13 minutes from report to `healthy`.
