# Smoke Tests

Step 18 of the install sequence, 24 tests, after the runners and the optional profiles start (test 16 needs the runners). Each test is a command and a pass condition. The installer records the result per test in `state.json` (never headers, cookies or tokens) and refuses to mark the installation completed while any of them fails. After the install, `scripts/ihc-doctor.sh` (`<install-dir>/ihc doctor`) re-runs the read-only part of these checks at any time, in seconds, for the core and every app in the inventory, and says what to do about each failure; it never pushes, creates or removes anything (no test 16 or 19).

```sh
# 1. The rendered Compose file is valid
docker compose -f "$IHC_COMPOSE_FILE" config --quiet
# PASS: exit 0

# 2. Every core service is running and healthy
docker compose -f "$IHC_COMPOSE_FILE" ps --format json
# PASS: all core services running/healthy, the two Actions runners included, and garage
#       when the storage profile is on

# 3. The shared Postgres accepts connections
docker compose -f "$IHC_COMPOSE_FILE" exec -T postgres \
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# PASS: accepting connections

# 4. The shared Redis answers
docker compose -f "$IHC_COMPOSE_FILE" exec -T redis redis-cli ping
# PASS: PONG

# 5. Authentik is live and ready
curl -fsS "$AUTHENTIK_BASE_URL/-/health/live/"
curl -fsS "$AUTHENTIK_BASE_URL/-/health/ready/"
# PASS: both HTTP 200

# 6. Gitea answers its API (with the read-only token when sign-in is required to view)
curl -fsS -H "Authorization: token $GITEA_READONLY_TOKEN" "$GITEA_BASE_URL/api/v1/version"
# PASS: HTTP 200 and JSON with a version

# 7. The portal answers its healthcheck
curl -fsS "$PORTAL_BASE_URL/health"
# PASS: HTTP 200 and a healthy status

# 8. The proxy resolves the local route
curl -fsSI -H "Host: $PORTAL_HOST" "http://127.0.0.1:$PROXY_HTTP_PORT/"
# PASS: HTTP 200, 301 or 302

# 9. Forward auth protects the portal
curl -fsSI "$PORTAL_BASE_URL/"
# PASS: HTTP 302 to /outpost.goauthentik.io/ or to the Authentik login

# 10. Authentik publishes OIDC discovery
curl -fsS "$AUTHENTIK_ISSUER/.well-known/openid-configuration"
# PASS: HTTP 200 and issuer equal to the configured one

# 11. OIDC is configured in Gitea
gitea admin auth list
# PASS: the OIDC/Authentik source exists and is enabled

# 12. An authenticated clone against Gitea works
GIT_ASKPASS="$IHC_GIT_ASKPASS" git ls-remote "$GITEA_SMOKE_REPOSITORY"
# PASS: exit 0 and HEAD returned

# 13. The portal's and Gitea's database roles are isolated
docker compose -f "$IHC_COMPOSE_FILE" exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -Atc \
  "SELECT rolname, rolsuper FROM pg_roles WHERE rolname IN ('ihc_platform','gitea');"
# PASS: both roles exist and rolsuper = false

# 14. The newest backup verifies (skipped only when BACKUP_ENABLED=false)
scripts/ihc-backup.sh --install-dir "$IHC_INSTALL_DIR" verify --latest --json
# PASS: ok = true: newest run succeeded and is younger than BACKUP_MAX_AGE_HOURS, its
#       manifest matches the sha256 in the status file, the destination repository
#       opens with the key, every snapshot of the manifest exists, every database dump
#       restores to the sha256 recorded at backup time, and `restic check` is clean

# 15. The final state is consistent
ihc-install status --json
# PASS: status = completed; no stage failed or pending

# 16. An app reaches the air (never skipped: the runners are core)
scripts/ihc-app.sh new smoke-app --install-dir "$IHC_INSTALL_DIR"   # or clone it when it exists
git commit --allow-empty ... && git push origin main                        # a new commit every run
curl -fsS -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "$GITEA_BASE_URL/api/v1/repos/$GITEA_ORGANIZATION/smoke-app/actions/tasks"   # until the run ends
curl -fsS "https://smoke-app.$BASE_DOMAIN/health"
curl -fsSI "https://smoke-app.$BASE_DOMAIN/"
docker compose -f "$IHC_COMPOSE_FILE" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc \
  "SELECT r.rolsuper, r.rolcanlogin, has_database_privilege('public', d.datname, 'CONNECT')
     FROM pg_roles r, pg_database d
    WHERE r.rolname = 'app_smoke_app' AND d.datname = 'app_smoke_app' AND d.datdba = r.oid;"
# PASS: the deploy run of the pushed commit ends `success` within 15 minutes; /health
#       answers 200 with ok = true through the proxy; / answers 302 to the outpost; the
#       query returns f|t|f (owned by its role, not superuser, can log in, no public
#       connect); the role signs in with PGPASSWORD from apps/smoke-app/.env; a second
#       push redeploys it and that password is the same as before
# Then (not a pass condition): smoke-app is marked kind: system-test in inventory.json and
scripts/ihc-app.sh remove smoke-app --yes --install-dir "$IHC_INSTALL_DIR"
#       removes what the test created; if it cannot, the app stays, hidden from ihc-app list

# 17. The ops tools are behind the SSO (skipped only when the ops profile is off)
for h in terminal files portainer glances; do curl -sSI "https://$h.$BASE_DOMAIN/"; done
# PASS: every root answers 302 to /outpost.goauthentik.io/ or to the Authentik login
#       (terminal only when the web terminal is installed; the detail says when it is not)

# 18. The ops tools are for admins only (skipped only when the ops profile is off)
docker compose -f "$IHC_COMPOSE_FILE" ps --format json          # portainer glances filebrowser [wetty]
scripts/sso-login-check.sh --user "$AUTHENTIK_SMOKE_USER" --password-env AUTHENTIK_SMOKE_USER_PASSWORD \
  --target "https://files.$BASE_DOMAIN" --expect denied             # and terminal
docker exec <portal container> wget -T 3 http://filebrowser/health   # an app container
docker compose -f "$IHC_COMPOSE_FILE" config --format json | scripts/lib/opspaths.py compose "$IHC_INSTALL_DIR" "$BACKUP_DESTINATION"
# PASS: the containers are healthy; ihc-smoke-user (ihc-users only) signs in to
#       Authentik and is refused both the terminal and the file browser; the wget from
#       the portal container fails (the ops tools are not on the apps' network); and the
#       file browser mounts only app data and the backup reports (read only), Wetty only
#       its key directory (read only)

# 19. Object storage (skipped only when the storage profile is off)
docker compose -f "$IHC_COMPOSE_FILE" exec garage /garage health
# provision smoke-s3-a twice and smoke-s3-b once (scripts/lib/garage.sh, the code of
# ihc-app provision), from the template manifest with object_storage.required: true
scripts/lib/s3.py put http://127.0.0.1 "s3.$BASE_DOMAIN" app-smoke-s3-a smoke.txt   # key of A
scripts/lib/s3.py get http://127.0.0.1 "s3.$BASE_DOMAIN" app-smoke-s3-a smoke.txt   # key of A
scripts/lib/s3.py put http://127.0.0.1 "s3.$BASE_DOMAIN" app-smoke-s3-b smoke.txt   # key of A
# PASS: garage healthy and the cluster has quorum (a layout is applied); each app gets a
#       bucket app-<slug> and a key; the second provision keeps A's key (same id and
#       secret); A's PUT and GET through the proxy answer 200 and return what was written;
#       A's PUT and GET on B's bucket answer 403

# 20. The operator agent (skipped only when the agent profile is off)
docker compose -f "$IHC_COMPOSE_FILE" ps agent docker-ro
python3 -c '...' "$AGENT_DIR/reference/brief.json"                  # services, access matrix, no secret value
docker exec <agent> node -e 'fetch(DOCKER_API + "/containers/<postgres>/restart", {method: "POST"})'
docker inspect <agent>                                               # mounts, networks, environment
# PASS: both containers healthy; the brief names the core services, has an access matrix
#       and contains no value of .env or of an app's env file; through the agent's Docker
#       API a restart of a core container, a container create and a DELETE answer 403
#       (whatever ops.agent.allow_write says), the container list 200, and an inspect has
#       Env as names only; the agent has no Docker socket, no mount reaching .env, apps/
#       or local/, is not on the ops network, and has no cloud secret in its environment
#       except GITEA_READONLY_TOKEN and its own AGENT_* keys

# 21. The ingress surface (skipped only in public ingress, where the proxy listens everywhere)
docker inspect -f '{{json .HostConfig.PortBindings}}' <proxy>        # 80/tcp and 443/tcp
ss -Hltn                                                             # listeners on 80 and 443
python3 -c 'socket.create_connection((addr, 443), timeout=2)'        # each address of hostname -I
# TLS internal:
openssl s_client -connect 127.0.0.1:443 -servername "portal.$BASE_DOMAIN" | openssl verify -CAfile local/ca/ca.crt
curl --cacert local/ca/ca.crt --resolve "portal.$BASE_DOMAIN:443:127.0.0.1" "https://portal.$BASE_DOMAIN/health"
# private ingress, from inside the Tailscale node's namespace:
nslookup -type=a "portal.$BASE_DOMAIN" 127.0.0.1                     # the split-DNS server
tailscale nc "$TAILSCALE_IP" 80 / 443 / 81                           # the tailnet path
# PASS: 80 and 443 are published on 127.0.0.1 only, nothing listens on them elsewhere and
#       the box's other addresses refuse them; with TLS internal the certificate served
#       for portal.<BASE_DOMAIN> is the cloud wildcard, verifies against the CA (which is
#       name-constrained to BASE_DOMAIN), covers *.<BASE_DOMAIN>, has more than 30 days
#       left, and https://portal.<BASE_DOMAIN>/health answers 200 with the CA as the only
#       trust; in private ingress any *.<BASE_DOMAIN> resolves to TAILSCALE_IP on the
#       node's DNS, the tailnet address answers on 80 and 443 and not on the proxy admin
#       port, and no auth key is left in .env or in the node's container

# 22. The portal reads the cloud (runs inside test 16, while smoke-app is on the air)
docker compose -f "$IHC_COMPOSE_FILE" exec -T portal wget -qO- http://127.0.0.1:8080/health
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: portal.$BASE_DOMAIN" http://127.0.0.1/api/platform/status
docker compose -f "$IHC_COMPOSE_FILE" exec -T gitea curl -H 'X-authentik-email: <admin>' -H 'X-authentik-groups: ihc-admins' http://portal:8080/api/platform/status
docker compose -f "$IHC_COMPOSE_FILE" exec -T proxy curl -H 'X-authentik-email: <admin>' -H 'X-authentik-groups: ihc-admins' http://portal:8080/api/platform/status
docker compose -f "$IHC_COMPOSE_FILE" exec -T proxy curl ... 'http://portal:8080/api/apps-status?refresh=1'
# PASS: /health ok with its migrations applied; anonymous through the proxy is 302 to
#       the outpost; the same headers from another container on the ihc network are
#       anonymous (401: the portal trusts them only from the proxy); from the proxy with
#       the admin group, 200 with the core services; the catalog lists the portal itself
#       (kind core) healthy and smoke-app with health ok, SSO effective (true), its route
#       found and its containers seen

# 23. The portal's status API for agents (docs/portal-api.md); the token goes in a curl
#     config file (-K) or on stdin, never on the command line
curl -K <token.cfg> -H "Host: portal.$BASE_DOMAIN" http://127.0.0.1/api/platform/status
curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Host: portal.$BASE_DOMAIN" http://127.0.0.1/api/platform/status
curl -K <wrong-token.cfg> -H "Host: portal.$BASE_DOMAIN" http://127.0.0.1/api/platform/status
curl -K <token.cfg> -H "Host: portal.$BASE_DOMAIN" http://127.0.0.1/api/apps     # also /api/platform/config, POST .../refresh
printf 'header = "Authorization: Bearer %s"\n' "$IHC_PORTAL_API_TOKEN" | \
  docker compose -f "$IHC_COMPOSE_FILE" exec -T proxy curl -K - http://portal:8080/api/apps   # also /api/me and /
python3 scripts/lib/portalapi.py fetch "$IHC_INSTALL_DIR"
# PASS: with the token, 200 and the contract's required fields (checked_at, overall,
#       summary with total/healthy/unhealthy/unknown, services with name/kind/healthy/
#       detail, at least the 9 core services); without the header, 302 to the outpost or
#       401; a wrong token, 401; the token on another route through the proxy never
#       opens it (302, 401 or 403), and straight to the portal it is 403; the installer's
#       reader (behind `install.sh status --json` and `ihc doctor`) says source portal-api

# 24. The portal by role
scripts/sso-login-check.sh --install-dir "$IHC_INSTALL_DIR" --user ihc-smoke-user \
  --password-env AUTHENTIK_SMOKE_USER_PASSWORD --target "$PORTAL_BASE_URL" --expect allowed \
  --probe /api/apps-status=200 --probe /api/people=403 --probe /api/platform/status=403
docker compose -f "$IHC_COMPOSE_FILE" exec -T proxy curl -H 'X-authentik-email: <admin>' -H 'X-authentik-groups: ihc-admins' 'http://portal:8080/api/people?refresh=1'
docker compose -f "$IHC_COMPOSE_FILE" exec -T proxy curl ... 'http://portal:8080/api/groups?refresh=1'
curl -K <config with AUTHENTIK_PORTAL_TOKEN> http://127.0.0.1:$AUTHENTIK_LOCAL_PORT/api/v3/core/users/?page_size=1
curl -K <same> http://127.0.0.1:$AUTHENTIK_LOCAL_PORT/api/v3/core/groups/?page_size=1
curl -K <same> -X POST -d '{"name":"ihc-smoke-must-not-exist-<pid>"}' http://127.0.0.1:$AUTHENTIK_LOCAL_PORT/api/v3/core/groups/
# PASS: the smoke user (ihc-users only) signs in to the portal through the SSO for real
#       and, with that session, reads the catalog (200) and is refused the people list
#       and the platform status (403); as admin, /api/people lists the smoke user in
#       ihc-users only and ihc-portal in no group, and /api/groups has ihc-admins and
#       ihc-users with the smoke user not in ihc-admins; the portal's token reads users
#       and groups (200) and creating a group answers 403
```

Test 21 checks the tailnet from inside the node. Whether the tailnet's own DNS sends `BASE_DOMAIN` to the node (the split DNS a person sets in the Tailscale admin console) and whether a device that installed the CA opens the portal without a warning are checked by a person, once ([`first-run.md`](first-run.md#private-ingress-run)); the `proxy_ingress` stage reports the first.

Test 20 does not talk to the LLM or the chat channel: the installer never has their keys. A conversation is checked by a human after putting the keys in `.env` ([`operator-contract.md`](operator-contract.md), section 7).

Test 18 signs in for real, with the smoke user's password from `.env`: it proves the binding to `ihc-admins`, not just that a route exists. The positive side (an admin reaches a shell and the file list) needs the admin's password, which a human replaces after the first sign-in, so it is not a smoke test; `scripts/sso-login-check.sh --target https://terminal.<BASE_DOMAIN>` checks it by hand with `--expect allowed`. Without the box, `scripts/tests/ops-mounts.sh` checks the mounts of the compose file in the repository, including that a file browser mounting the install directory, `apps/` or `local/` is refused.

Test 14 restores every dump through `restic dump` to compare checksums; on a box with large databases it takes as long as reading them once. It proves the repository holds what the run wrote, not that a restore into a live service works: that is the monthly restore rehearsal, not built yet ([`backup.md`](backup.md)).

Test 16 is the whole app loop of [`gitops-flow.md`](gitops-flow.md): template, repository, push, the deploy runner, `ihc-app provision` (database, role, Redis ACL user, env file, Authentik provider and application, proxy host, inventory), the build on the box and the healthcheck. It deploys `smoke-app` twice (the second push proves a redeploy keeps the database password), then marks it `kind: system-test` in `inventory.json` and runs `ihc-app remove smoke-app`, so the cloud is handed over without an app nobody asked for. The removal takes only what the deploy recorded for that app: its containers, volumes and image, database and role, Redis user and keys, Authentik application and provider, proxy host (only one that forwards to `smoke-app`), the repository `<organization>/smoke-app`, `apps/smoke-app/`, `app-data/smoke-app/` and its inventory record; `ihc-app remove` refuses any app not marked as a system test. If a step fails, the test still passes (the deploy worked), its detail says what was left, and the app stays hidden from `ihc-app list` (shown with `--all` and in the operator brief) until `ihc-app remove smoke-app` is run. Why remove rather than keep it hidden: every resource the test creates is recorded by the deploy itself, so the removal never has to guess, and a delivered cloud whose first `ihc-app list`, Gitea organization and Authentik applications show a test app confuses the first person who opens them ([`cleanup.md`](cleanup.md#remove-one-app)). The first run pulls the Node base image and builds it, so it takes a few minutes; later runs reuse the cache.

Test 19 provisions with the same function `ihc-app provision` calls, without a deploy: the deploy path is test 16's. The two test apps keep their env files in `<install-dir>/local/smoke-storage/` (0700), and their buckets and keys stay in Garage, so a re-run reuses them. The S3 requests are signed in Python's standard library (`scripts/lib/s3.py`, AWS Signature V4, path-style); no client image is pulled.

Test 23 is what an agent does: it reads the platform with the read-only token and nothing else. Through the proxy only `GET /api/platform/status` with an `Authorization` header skips the forward auth (the rule is in `scripts/lib/portal-api.sh`); every other path with the token still meets Authentik, so the portal's own `403` for the token on another route is checked from the proxy container, straight to `portal:8080`. Without the box, `scripts/tests/portal-api.sh` checks the parser, the fallback to `source: local`, the doctor's check, the nginx rule's text and the real portal behind a stand-in proxy.

Test 24 is the other half of 22 with a real session: the smoke user signs in with its password from `.env`, so it proves the portal's binding to `ihc-users` in Authentik and the portal's own role check on what the outpost sends, not headers we wrote. Its last part proves the service account cannot write with the very token the portal holds; the group name is unique per run, so a broken permission would leave one group named `ihc-smoke-must-not-exist-<pid>` behind, visible in the People page.

Test 22 stands in for a signed-in admin by sending, from the proxy container, the headers the outpost would set: the browser path (forward auth, then the same headers) is test 9 plus the outpost itself. The positive login with a real session needs the admin's password, which a human replaces; `scripts/sso-login-check.sh --target "$PORTAL_BASE_URL"` checks it by hand.

Test 6 is the one most often wrong on a real box: a Gitea configured to require sign-in answers 403 to an anonymous version call, and a probe without the token reports the service down while everything works.
