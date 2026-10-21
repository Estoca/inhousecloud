# Diagnose an app that is down

**Purpose.** Find which link of the chain fails, so that the fix goes to the right place: the app, the proxy, Authentik and its outpost, or the edge (DNS, tunnel).
**Level.** 1: diagnosis needs no permission. The fix found at the end has its own level (a restart of the app is 2, anything on the proxy or Authentik is 3).
**Preconditions.** The slug (`$H/scripts/ihc-app.sh list --install-dir "$I"`) and what the person saw: the URL, the status or page, since when.

The chain, from inside out:

```text
container  ->  app health (inside the network)  ->  proxy route (Host header)  ->  forward auth (Authentik outpost)  ->  edge (DNS, tunnel, TLS)
```

`"$I"/ihc doctor --verbose` walks the first four links for every app at once (its `app:<slug>` line names the first one that fails) *(agent: `ihc-ro doctor`)*. Then walk it here, in this order, and stop at the first link that fails.

## 1. Container

```bash
docker compose -p <slug> ps -a
docker inspect -f '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} policy={{.HostConfig.RestartPolicy.Name}}' <slug>-app-1
docker logs --since 30m --tail 80 <slug>-app-1
```

*(agent)* `ihc-ro ps`, `ihc-ro inspect <slug>-app-1`, `ihc-ro logs <slug>-app-1 80`

- `exited` or restarting: the cause is in the log (a crash on start, a migration against an empty database, a missing variable). Fix in the repository and push; a restart without a fix loops.
- No container at all: the last deploy failed before `up`. Read the run (step 5 below).
- `RestartPolicy` empty or `no`: the app will not come back by itself after the runtime restarts. Note it; it belongs in the app's compose file.

## 2. App health, inside the network

The health path and status are in the app's `company-app.yaml` (`healthcheck`). From any container on the `ihc` network:

```bash
dc exec -T portal wget -S -q -O /dev/null http://<slug>:<port><health path> 2>&1 | head -n 1     # the portal sits on the ihc network
```

*(agent)* `curl -s -o /dev/null -w '%{http_code}\n' http://<slug>:<port><health path>`

Not the expected status here: the app is the problem (step 1's log). Expected status here: the app is fine; continue.

## 3. Proxy route, with the Host header

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: <slug>.$BASE_DOMAIN" "http://127.0.0.1:$PROXY_HTTP_PORT<health path>"
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Host: <slug>.$BASE_DOMAIN" "http://127.0.0.1:$PROXY_HTTP_PORT/"
```

*(agent)* `ihc-ro http http://proxy<health path> <slug>.<BASE_DOMAIN>` and `ihc-ro http http://proxy/ <slug>.<BASE_DOMAIN>`

| Health via proxy | Root via proxy | Where it is |
|---|---|---|
| expected status | `302` to `/outpost.goauthentik.io/...` | the chain is fine up to here: go to step 4 (edge) or to the person's browser |
| `502` / `504` | anything | the proxy cannot reach the upstream: the container is not on `ihc`, or not under the alias `<slug>`, or not listening on the manifest's port. `docker inspect <slug>-app-1` (networks, aliases) and the proxy host's forward host and port |
| expected status | **`500`** | **forward auth**: the outpost does not know this provider, or the provider is missing or misbound. Not the app. Go to [route-and-provider](route-and-provider.md), read mode |
| `404` (the proxy's default page) | `404` | no proxy host for this name: never provisioned, or disabled on purpose (a retired app answers exactly this). Check the inventory before calling it an outage |
| `200` with a page that is not the app | — | another site answers this name: a default page, a wrong route. A `200` is not health |

The rule from the first box: **health 200 locally and root 500 through the proxy is the outpost or the provider.** It happened to an app that was healthy the whole time; the outpost answered 404 to the forward-auth call and the proxy turned it into 500.

Right after a first deploy, forward auth can answer 500 for a few seconds while the outpost loads the new provider; `ihc-app wait` retries for 60 seconds for that reason. Retry before escalating.

## 4. Edge

Only with `private` or `public` ingress: the same two requests through the real name, from outside the box.

```bash
curl -sI https://<slug>.<BASE_DOMAIN>/<health path>
```

- Fails from outside, works with the Host header on the box: DNS, the tunnel or the tailnet. Their configuration lives in the provider's account (level 3, a human).
- A `200` from the edge with nothing behind it is the edge provider's default page, not the app.

## 5. The deploy run, when the container is missing or old

```bash
set -a; . "$I/.env"; set +a
curl -s -H "Authorization: token $GITEA_READONLY_TOKEN" "http://127.0.0.1:$GITEA_LOCAL_PORT/api/v1/repos/$GITEA_ORGANIZATION/<slug>/actions/tasks?limit=5" | python3 -m json.tool | grep -E '"(status|head_sha|display_title|id)"'
```

*(agent)* `ihc-ro gitea /repos/<org>/<slug>/actions/tasks?limit=5`

The job log of a failed run says what to change ([`llm-bootstrap.md`](../llm-bootstrap.md), section 4).

## Post-checks

After the fix (by whoever applies it): the nine checks of the contract that apply, at least 4, 5 and 6. Report which link failed, the evidence, the fix, and what was not checked.

## Never

- Restart a core service to "see if it helps".
- Recreate the proxy host or the provider before reading them: an existing object may belong to another app.
- Call the app healthy on the strength of a `200` from the edge.
