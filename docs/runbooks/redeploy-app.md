# Redeploy an app

**Purpose.** Put an app's merged code on the air again (a failed run, a dependency that was down during the deploy), or roll it back to an earlier commit.
**Level.** 2: under an explicit instruction naming the app, for a change already merged on `main`. A rollback that needs a database rollback is level 3 ([database-migration](database-migration.md)).
**Preconditions.** The slug; the commit that should run; the change is on `main` (a push to `main` is the approval in this harness: the operator never deploys code that is not there).

## Read first

```bash
$H/scripts/harness-app.sh list --install-dir "$I"                       # repository, last deployed commit
docker inspect -f '{{.Config.Image}} {{.Image}} {{.State.StartedAt}}' <slug>-app-1
docker image ls <slug>-app                                              # the image kept for rollback, if any
```

*(agent)* `harness-ro ps`, `harness-ro inspect <slug>-app-1`, `harness-ro gitea /repos/<org>/<slug>/actions/tasks?limit=5`, `harness-ro gitea /repos/<org>/<slug>/commits?sha=main&limit=5`

Answer before acting:

1. Which commit is `main`, and which commit did the last green run deploy? If they are equal and the app is down, a redeploy will not help: [diagnose-app-down](diagnose-app-down.md).
2. Does the release carry a migration? Then [database-migration](database-migration.md) first.
3. Is there local, uncommitted work in the box's checkout of this app? Never deploy from a working directory; the deploy job checks out the pushed commit itself.

## Act

Keep the running image for rollback:

```bash
docker tag "$(docker inspect -f '{{.Image}}' <slug>-app-1)" "<slug>-app:rollback-$(date -u +%Y%m%dT%H%M%S)"
```

Then one of:

- **Re-run the last run** in Gitea Actions (the web UI, "Re-run all jobs"), as a person with write access to the repository. *(agent)* only with `AGENT_GITEA_TOKEN`, which a human created for it; otherwise it asks.
- **An empty commit on `main`**, by the person who asked: `git commit --allow-empty -m "redeploy" && git push origin main`.
- **Rollback**: `git revert` of the bad commits on `main` and push. The harness has no out-of-band deploy, on purpose: the history of `main` is the history of what ran.

Never `docker compose up` an app by hand from another directory: the Compose project name comes from the directory unless named, and a second project with the same containers is how a rollout misses the running stack. If a manual start is unavoidable, the deploy job's command is the only form:

```bash
cd <checkout of the commit> && COMPANY_ENV_FILE="$I/apps/<slug>/.env" docker compose -p <slug> -f docker-compose.yml -f "$I/apps/<slug>/compose.harness.yml" up -d --build
```

## Post-checks

```bash
$H/scripts/harness-app.sh wait <slug> --install-dir "$I"     # from the app's checkout: health through the proxy, then / to the SSO
```

Then checks 1 (the run's `head_sha` is the commit asked for), 4, 5, 6 and 7 of the contract. Keep the rollback tag until the next green deploy; remove it then ([disk-pressure](disk-pressure.md)).

## Example

A rollout on the first box was started from a second checkout of the repository. The Compose project name was derived from that directory, so `up` created a new project next to the running one and the release seemed to do nothing. Since then: the project is always named (`-p <slug>`), and `docker compose -p <slug> ps` is read before and after.
