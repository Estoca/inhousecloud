# Route and SSO provider

**Purpose.** Read, and when approved change, what puts a name on the air: the proxy host, the Authentik proxy provider and application, its group binding, and the embedded outpost that does forward auth.
**Level.** 1 to read. 3 to create, change, disable or delete any of them: a route or a provider decides who reaches what.
**Preconditions.** In this cloud `ihc-app provision` creates and maintains each app's route and provider on every deploy, so a manual change is the exception: a retirement, a repair, an app made public on purpose.

## What exists, per app

| Object | Name | Made by |
|---|---|---|
| proxy host | `<slug>.<BASE_DOMAIN>`, forward host `<slug>`, the manifest's port | `ihc-app provision` |
| Authentik proxy provider | `app-<slug>`, external host the app URL, the health path left public | `ihc-app provision` |
| Authentik application | `<slug>`, bound to `ihc-users` | `ihc-app provision` |
| embedded outpost | serves every provider | first-run; provision adds the provider to it |

## Read first

```bash
set -a; . "$I/.env"; set +a
# proxy hosts (the admin API on loopback; the token is short-lived)
tok=$(curl -s -X POST "http://127.0.0.1:$PROXY_ADMIN_PORT/api/tokens" -H 'Content-Type: application/json' \
  --data-binary @- <<<"{\"identity\":\"$PROXY_ADMIN_EMAIL\",\"secret\":\"$PROXY_ADMIN_PASSWORD\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -H "Authorization: Bearer $tok" "http://127.0.0.1:$PROXY_ADMIN_PORT/api/nginx/proxy-hosts" \
  | python3 -c 'import json,sys;[print(h["id"],h["domain_names"],h["forward_host"],h["forward_port"],"enabled" if h["enabled"] else "DISABLED") for h in json.load(sys.stdin)]'
# Authentik: the provider, the application, the outpost's providers
curl -s -H "Authorization: Bearer $AUTHENTIK_BOOTSTRAP_TOKEN" "http://127.0.0.1:$AUTHENTIK_LOCAL_PORT/api/v3/providers/proxy/?search=app-<slug>" | python3 -m json.tool | grep -E '"(pk|name|external_host|mode|skip_path_regex)"'
curl -s -H "Authorization: Bearer $AUTHENTIK_BOOTSTRAP_TOKEN" "http://127.0.0.1:$AUTHENTIK_LOCAL_PORT/api/v3/outposts/instances/?managed=goauthentik.io%2Foutposts%2Fembedded" | python3 -c 'import json,sys;[print(o["name"],o["providers"]) for o in json.load(sys.stdin)["results"]]'
```

These commands hold admin credentials in the shell; run them as the admin, not from a shared terminal.

*(agent)* it has neither credential: it reads the behaviour instead, which is usually enough to locate the fault:
`ihc-ro http http://proxy/ <slug>.<BASE_DOMAIN>` (expect `302` to `/outpost.goauthentik.io/`) and `ihc-ro http http://proxy<health path> <slug>.<BASE_DOMAIN>` (expect the manifest's status). Then it asks the admin to run the reads above.

Look for: a proxy host whose forward host is not `<slug>` (another app owns the name: `ihc-app provision` refuses to touch it, and so should you); a provider missing from the outpost's list (forward auth answers 404, the proxy shows 500); an application with no binding (people sign in and are refused).

## Act (level 3, after the ok for this name)

- **Repair an app's route or provider**: re-run its deploy ([redeploy-app](redeploy-app.md)). Provision probes each object and recreates only what is missing; it never deletes.
- **Retire an app**: disable its proxy host in the proxy admin (the UI, or `POST /api/nginx/proxy-hosts/<id>/disable`). Containers, database and data stay; the name then answers 404 from the proxy, which is the expected result. Mark the app retired in whatever catalog the company keeps; deleting is a separate decision.
- **Make an app public**: that is `auth.required: false` in its manifest, merged on `main` by someone who may decide it, not a change on the box.
- **Tighten exposure** (a port to loopback, a network): first prove the real path from the proxy to the container (`docker inspect` the proxy host's forward host). On the first box a port "hardened" to loopback would have cut an app off, because the proxy reached it by the host's LAN address.

## Post-checks

The two requests of "read first", again; for a retirement, `404` from the proxy and nothing else changed (`docker compose -p <slug> ps` unchanged). Record the object, its id, before and after.

## Example

An app on the first box answered 200 on its health endpoint and 500 on its root. The app was fine: the outpost answered 404 to the forward-auth call for that provider, and the proxy reported it as 500. The fix went to the provider and the outpost, not to the app. That pattern is now the first row of [diagnose-app-down](diagnose-app-down.md).
