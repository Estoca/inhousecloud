# Smoke Tests

Step 18 of the install sequence, after the optional profiles (test 16 needs the runners). Each test is a command and a pass condition. The installer records the result per test in `state.json` (never headers, cookies or tokens) and refuses to mark the installation completed while any of them fails.

```sh
# 1. The rendered Compose file is valid
docker compose -f "$HARNESS_COMPOSE_FILE" config --quiet
# PASS: exit 0

# 2. Every core service is running and healthy
docker compose -f "$HARNESS_COMPOSE_FILE" ps --format json
# PASS: all core services running/healthy

# 3. The shared Postgres accepts connections
docker compose -f "$HARNESS_COMPOSE_FILE" exec -T postgres \
  pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# PASS: accepting connections

# 4. The shared Redis answers
docker compose -f "$HARNESS_COMPOSE_FILE" exec -T redis redis-cli ping
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
GIT_ASKPASS="$HARNESS_GIT_ASKPASS" git ls-remote "$GITEA_SMOKE_REPOSITORY"
# PASS: exit 0 and HEAD returned

# 13. The portal's and Gitea's database roles are isolated
docker compose -f "$HARNESS_COMPOSE_FILE" exec -T postgres \
  psql -U "$POSTGRES_USER" -d postgres -Atc \
  "SELECT rolname, rolsuper FROM pg_roles WHERE rolname IN ('harness_platform','gitea');"
# PASS: both roles exist and rolsuper = false

# 14. The newest backup verifies (skipped only when BACKUP_ENABLED=false)
scripts/harness-backup.sh --install-dir "$HARNESS_INSTALL_DIR" verify --latest --json
# PASS: ok = true: newest run succeeded and is younger than BACKUP_MAX_AGE_HOURS, its
#       manifest matches the sha256 in the status file, the destination repository
#       opens with the key, every snapshot of the manifest exists, every database dump
#       restores to the sha256 recorded at backup time, and `restic check` is clean

# 15. The final state is consistent
harness-install status --json
# PASS: status = completed; no stage failed or pending

# 16. An app reaches the air (skipped only when the ci profile is off)
scripts/harness-app.sh new smoke-app --install-dir "$HARNESS_INSTALL_DIR"   # or clone it when it exists
git commit --allow-empty ... && git push origin main                        # a new commit every run
curl -fsS -H "Authorization: token $GITEA_ADMIN_TOKEN" \
  "$GITEA_BASE_URL/api/v1/repos/$GITEA_ORGANIZATION/smoke-app/actions/tasks"   # until the run ends
curl -fsS "https://smoke-app.$BASE_DOMAIN/health"
curl -fsSI "https://smoke-app.$BASE_DOMAIN/"
docker compose -f "$HARNESS_COMPOSE_FILE" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc \
  "SELECT r.rolsuper, r.rolcanlogin, has_database_privilege('public', d.datname, 'CONNECT')
     FROM pg_roles r, pg_database d
    WHERE r.rolname = 'app_smoke_app' AND d.datname = 'app_smoke_app' AND d.datdba = r.oid;"
# PASS: the deploy run of the pushed commit ends `success` within 15 minutes; /health
#       answers 200 with ok = true through the proxy; / answers 302 to the outpost; the
#       query returns f|t|f (owned by its role, not superuser, can log in, no public
#       connect); the role signs in with PGPASSWORD from apps/smoke-app/.env; and on a
#       second run that password is the same as before the push
```

Test 14 restores every dump through `restic dump` to compare checksums; on a box with large databases it takes as long as reading them once. It proves the repository holds what the run wrote, not that a restore into a live service works: that is the monthly restore rehearsal, not built yet ([`backup.md`](backup.md)).

Test 16 is the whole app loop of [`gitops-flow.md`](gitops-flow.md): template, repository, push, the deploy runner, `harness-app provision` (database, role, Redis ACL user, env file, Authentik provider and application, proxy host, inventory), the build on the box and the healthcheck. It leaves `smoke-app` running, listed in `inventory.json` and reachable by the users group; every run adds one commit to its repository. The harness never deletes it; remove it by hand if it bothers you. The first run pulls the Node base image and builds it, so it takes a few minutes; later runs reuse the cache.

Test 6 is the one most often wrong on a real box: a Gitea configured to require sign-in answers 403 to an anonymous version call, and a probe without the token reports the service down while everything works.
