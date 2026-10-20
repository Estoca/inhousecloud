#!/usr/bin/env bash
# Smoke tests (docs/smoke-tests.md), step 17 of the install sequence.
#
#   scripts/smoke-tests.sh --install-dir DIR [--json]
#
# Runs tests 1 to 21. Test 14 runs `occ-backup.sh verify --latest` and is skipped
# only when BACKUP_ENABLED=false. Test 16 deploys the template app smoke-app by a push to
# main (never skipped: the runners are core); the app stays on the box. Tests 17 and 18
# cover the ops tools and are skipped only when the ops profile is off; test 19 covers object
# storage and is skipped only when the storage profile is off; test 20 covers the operator
# agent and is skipped when the agent profile is off. Results go to state.json under stages.smoke_tests.probe.tests, one entry
# per test with status and a short detail: never headers, cookies or tokens. Exit 1
# when any test fails. Variable names of the document map to .env as follows:
#   OCC_COMPOSE_FILE -> <install-dir>/compose.yml      PORTAL_HOST, PROXY_HTTP_PORT -> same
#   AUTHENTIK_ISSUER     -> AUTHENTIK_BASE_URL/application/o/gitea
#   OCC_GIT_ASKPASS  -> a helper written inside the Gitea container for test 12
set -eu
OCC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$OCC_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/garage.sh
. "$OCC_ROOT/scripts/lib/garage.sh"

INSTALL_DIR="${OCC_INSTALL_DIR:-/opt/open-company-cloud}"
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --json) JSON_OUTPUT=true ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
INSTALL_DIR="${INSTALL_DIR%/}"
ENV_FILE="$INSTALL_DIR/.env"
STATE_FILE="$INSTALL_DIR/state.json"
load_env
HAVE_STATE=false; [ -f "$STATE_FILE" ] && HAVE_STATE=true

PASS=0; FAILS=0; SKIP=0; RESULTS=""
result() { # NUMBER NAME STATUS DETAIL
  local json
  json="$(jsonq build status="$3" detail="$4" name="$2")"
  RESULTS="$RESULTS,\"$1\":$json"
  case "$3" in
    pass) PASS=$((PASS+1)); ok "$1. $2: $4" ;;
    skip) SKIP=$((SKIP+1)); log "$1. $2: skipped ($4)" ;;
    *) FAILS=$((FAILS+1)); fail "$1. $2: $4" ;;
  esac
}
PROXY="http://127.0.0.1:${PROXY_HTTP_PORT}"
CORE="proxy authentik-postgres authentik-server authentik-worker postgres redis gitea portal gitea-runner gitea-deployer"
STORAGE=false; case ",$COMPOSE_PROFILES," in *,storage,*) STORAGE=true; CORE="$CORE garage" ;; esac
# TLS internal: every HTTPS check verifies the certificate against the cloud CA
# (<install-dir>/local/ca/ca.crt), as a device that installed it would; never -k.
INSECURE="$(ca_args)"
SCHEME_URL=https; [ "$TLS_MODE" = off ] && SCHEME_URL=http

# 1. compose file valid
if dc config --quiet 2>/dev/null; then result 1 compose-valid pass "compose.yml validates"; else result 1 compose-valid fail "docker compose config failed"; fi

# 2. every core service running and healthy (and Garage with the storage profile)
bad=""
for s in $CORE; do h="$(container_health "$s")"; case "$h" in healthy|none) ;; *) bad="$bad $s=$h" ;; esac; done
[ -z "$bad" ] && result 2 core-healthy pass "$(echo $CORE | wc -w | tr -d ' ') services healthy" || result 2 core-healthy fail "not healthy:$bad"

# 3. shared Postgres accepts connections
if dc exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then result 3 postgres-ready pass "accepting connections"; else result 3 postgres-ready fail "pg_isready failed"; fi

# 4. shared Redis answers
if [ "$(dc exec -T redis redis-cli ping 2>/dev/null | tr -d '[:space:]')" = PONG ]; then result 4 redis-ping pass "PONG"; else result 4 redis-ping fail "no PONG"; fi

# 5. Authentik live and ready (through the proxy, by its public name)
c1="$(http_code "$AUTHENTIK_BASE_URL/-/health/live/" $INSECURE $(curl_resolve "$AUTHENTIK_BASE_URL"))"
c2="$(http_code "$AUTHENTIK_BASE_URL/-/health/ready/" $INSECURE $(curl_resolve "$AUTHENTIK_BASE_URL"))"
[ "$c1" = 200 ] && [ "$c2" = 200 ] && result 5 authentik-health pass "live 200, ready 200" || result 5 authentik-health fail "live $c1, ready $c2"

# 6. Gitea API version with the read-only token (sign-in is required to view)
api_init gitea-ro "Authorization: token ${GITEA_READONLY_TOKEN}"
# api() has no --resolve; go through the proxy on loopback with the Host header instead
out="$(curl -K "$API_CFG" $(proxy_args "$GITEA_HOST") -w '\n%{http_code}' "$(proxy_url "$GITEA_HOST" /api/v1/version)" 2>/dev/null || true)"
code="${out##*$'\n'}"; v="$(printf '%s' "${out%$'\n'*}" | jsonq get version)"
[ "$code" = 200 ] && [ -n "$v" ] && result 6 gitea-api pass "version $v" || result 6 gitea-api fail "HTTP $code"

# 7. portal healthcheck (public path, no forward auth)
out="$(curl -sS $(proxy_args "$PORTAL_HOST") -w '\n%{http_code}' "$(proxy_url "$PORTAL_HOST" /health)" 2>/dev/null || true)"
code="${out##*$'\n'}"; okv="$(printf '%s' "${out%$'\n'*}" | jsonq get ok)"
[ "$code" = 200 ] && [ "$okv" = true ] && result 7 portal-health pass "200 ok" || result 7 portal-health fail "HTTP $code"

# 8. proxy resolves the local route
code="$(http_code "$(proxy_url "$PORTAL_HOST" /)" -I $(proxy_args "$PORTAL_HOST"))"
case "$code" in 200|301|302) result 8 proxy-route pass "HTTP $code" ;; *) result 8 proxy-route fail "HTTP $code" ;; esac

# 9. forward auth protects the portal
loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 $(proxy_args "$PORTAL_HOST") "$(proxy_url "$PORTAL_HOST" /)" 2>/dev/null || echo 000)"
case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) result 9 forward-auth pass "302 to the outpost" ;; *) result 9 forward-auth fail "got ${loc%% *}" ;; esac

# 10. OIDC discovery with the expected issuer
ISSUER="$AUTHENTIK_BASE_URL/application/o/gitea/"
iss="$(curl -sS $INSECURE $(curl_resolve "$AUTHENTIK_BASE_URL") "$ISSUER.well-known/openid-configuration" 2>/dev/null | jsonq get issuer)"
[ "$iss" = "$ISSUER" ] && result 10 oidc-discovery pass "issuer matches" || result 10 oidc-discovery fail "issuer '$iss' != '$ISSUER'"

# 11. OIDC source configured in Gitea
GITEA_CID="$(dc ps -q gitea | head -n 1)"
row="$(docker exec -i -u git "$GITEA_CID" gitea admin auth list 2>/dev/null | awk -F'\t' -v n="$GITEA_OIDC_SOURCE_NAME" 'NR>1 && $2==n' | head -n 1)"
if [ -z "$row" ]; then result 11 gitea-oidc-source fail "source $GITEA_OIDC_SOURCE_NAME not found"
elif printf '%s' "$row" | grep -qi 'false'; then result 11 gitea-oidc-source fail "source exists but is disabled"
else result 11 gitea-oidc-source pass "source $GITEA_OIDC_SOURCE_NAME enabled"; fi

# 12. authenticated clone (ls-remote) against Gitea with the read-only token. From the
#     host by the public URL when the name resolves here (Linux resolves *.localhost to
#     loopback, where the proxy listens); otherwise from inside the Gitea container by
#     the internal URL, since curl (and so git) resolves *.localhost itself and skips
#     the network alias. The token reaches git through GIT_ASKPASS, never an argument.
GITEA_CID="$(dc ps -q gitea | head -n 1)"
ASKPASS_SRC='#!/bin/sh
case "$1" in *sername*) printf "%s\n" "$GITEA_ADMIN_USERNAME" ;; *) printf "%s\n" "$GITEA_READONLY_TOKEN" ;; esac'
head_ref=""; where=""
if have git && $PY -c 'import socket,sys;socket.gethostbyname(sys.argv[1])' "$GITEA_HOST" 2>/dev/null; then
  ap="$(mktemp "${TMPDIR:-/tmp}/occ-askpass.XXXXXX")"; printf '%s\n' "$ASKPASS_SRC" > "$ap"; chmod 700 "$ap"
  [ "$TLS_MODE" = internal ] && export GIT_SSL_CAINFO="$INSTALL_DIR/local/ca/ca.crt"
  head_ref="$(GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git ls-remote "$GITEA_SMOKE_REPOSITORY" HEAD 2>/dev/null | awk '{print $2}' | head -n 1)"
  rm -f "$ap"; where="from the host, ${GITEA_SMOKE_REPOSITORY#*://}"
else
  internal="http://127.0.0.1:3000/${GITEA_SMOKE_REPOSITORY#"$GITEA_BASE_URL"/}"
  head_ref="$(printf '%s\n' "$ASKPASS_SRC" | docker exec -i -e GITEA_READONLY_TOKEN -e GITEA_ADMIN_USERNAME -e REPO="$internal" "$GITEA_CID" sh -c 'cat > /tmp/askpass && chmod 700 /tmp/askpass && GIT_ASKPASS=/tmp/askpass GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO" HEAD 2>/dev/null; rm -f /tmp/askpass' | awk '{print $2}' | head -n 1)"
  where="inside the container, ${internal#*://}"
fi
[ "$head_ref" = HEAD ] && result 12 git-ls-remote pass "HEAD returned $where" || result 12 git-ls-remote fail "ls-remote returned nothing ($where)"

# 13. the portal's and Gitea's database roles are isolated (not superusers)
bad=""
for pair in "$PORTAL_DB_ROLE" "$GITEA_DB_USER"; do
  row="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc "SELECT rolname, rolsuper FROM pg_roles WHERE rolname='$pair';" 2>/dev/null | tr -d '[:space:]')"
  [ "$row" = "$pair|f" ] || bad="$bad $pair='$row'"
done
[ -z "$bad" ] && result 13 db-roles-isolated pass "$PORTAL_DB_ROLE and $GITEA_DB_USER exist, rolsuper=false" || result 13 db-roles-isolated fail "unexpected:$bad"

# 14. backup verification: newest run succeeded, manifest checksum, every snapshot in
#     the repository and every dump restoring to its recorded sha256, restic check
if [ "${BACKUP_ENABLED:-true}" != true ]; then
  result 14 backup-verify skip "BACKUP_ENABLED=false"
else
  vout="$("$OCC_ROOT/scripts/occ-backup.sh" --install-dir "$INSTALL_DIR" verify --latest --json 2>/dev/null | tail -n 1 || true)"
  vok="$(printf '%s' "$vout" | jsonq get ok)"
  if [ "$vok" = true ]; then
    result 14 backup-verify pass "run $(printf '%s' "$vout" | jsonq get run_id): $(printf '%s' "$vout" | jsonq len checks) checks passed"
  else
    bad="$(printf '%s' "$vout" | $PY -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("no verify output"); sys.exit()
print("; ".join("%s: %s"%(c["name"],c["detail"]) for c in d["checks"] if c["status"]!="pass")[:300])')"
    result 14 backup-verify fail "${bad:-verify failed}"
  fi
fi

# 15. the state is consistent: nothing failed, every stage before this one completed
if [ "$HAVE_STATE" = true ]; then
  detail="$(state status --json 2>/dev/null | $PY -c '
import json,sys
d=json.load(sys.stdin); st=d["stages"]
order=["preflight","plan","secrets","foundation","authentik","shared_data","proxy_ingress","gitea","portal","first_run","backup","optional_profiles"]
failed=[s for s in st if st[s].get("status")=="failed"]
missing=[s for s in order if st.get(s,{}).get("status")!="completed"]
print("ok" if not failed and not missing else "failed=%s pending=%s"%(failed,missing))')"
  [ "$detail" = ok ] && result 15 state-consistent pass "no failed stage; stages up to optional_profiles completed" || result 15 state-consistent fail "$detail"
else
  result 15 state-consistent skip "no state.json (run outside install.sh)"
fi

# 16. an app reaches the air: the template app smoke-app is created in the organization
#     (or cloned when it exists), a commit is pushed to main, the deploy run must succeed,
#     /health answers 200 through the proxy, / redirects to Authentik, the app's database
#     and role exist (LOGIN NOSUPERUSER, no public connect) and the role signs in with
#     the password of the app's env file, which a redeploy does not change.
t16() {
  local slug=smoke-app org="$GITEA_ORGANIZATION" work ap repo_url sha t0 run st code body loc row fp_before fp_after app_env db
  local GT="http://127.0.0.1:${GITEA_LOCAL_PORT}/api/v1"
  have git || { result 16 app-deploy fail "git not found on the box"; return; }
  work="$(mktemp -d "${TMPDIR:-/tmp}/occ-smoke16.XXXXXX")"
  ap="$work/askpass"; printf '#!/bin/sh\ncase "$1" in *sername*) echo "%s" ;; *) printf "%%s\\n" "$GITEA_ADMIN_TOKEN" ;; esac\n' "$GITEA_ADMIN_USERNAME" > "$ap"; chmod 700 "$ap"
  repo_url="http://127.0.0.1:${GITEA_LOCAL_PORT}/$org/$slug.git"
  app_env="$INSTALL_DIR/apps/$slug/.env"
  fp_before=""; [ -f "$app_env" ] && fp_before="$(sha_fp "$(envfile get "$app_env" PGPASSWORD)")"
  api_init gt16 "Authorization: token ${GITEA_ADMIN_TOKEN}"
  api GET "$GT/repos/$org/$slug"
  if [ "$API_CODE" = 404 ] || [ "$(printf '%s' "$API_BODY" | jsonq get empty)" = true ]; then
    "$OCC_ROOT/scripts/occ-app.sh" new "$slug" --dir "$work/$slug" --install-dir "$INSTALL_DIR" --name "Smoke App" --owner "$GITEA_ADMIN_EMAIL" >/dev/null 2>"$work/new.log" \
      || { result 16 app-deploy fail "occ-app new failed: $(tail -n 1 "$work/new.log")"; rm -rf "$work"; return; }
  else
    GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git clone -q "$repo_url" "$work/$slug" 2>/dev/null \
      || { result 16 app-deploy fail "clone of $org/$slug failed"; rm -rf "$work"; return; }
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$work/$slug/.occ-smoke"
  git -C "$work/$slug" add -A
  git -C "$work/$slug" -c user.name=occ-smoke -c user.email="$GITEA_ADMIN_EMAIL" commit -q -m "smoke test 16" 2>/dev/null
  sha="$(git -C "$work/$slug" rev-parse HEAD)"
  t0=$(date +%s)
  GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git -C "$work/$slug" push -q "$repo_url" HEAD:main 2>"$work/push.log" \
    || { result 16 app-deploy fail "push to $org/$slug failed: $(tail -n 1 "$work/push.log")"; rm -rf "$work"; return; }
  rm -rf "$work"
  # The run for this commit: Gitea lists jobs as tasks with their head_sha.
  st=""
  while :; do
    api GET "$GT/repos/$org/$slug/actions/tasks?limit=20"
    st="$(printf '%s' "$API_BODY" | $PY -c 'import json,sys
try: runs=json.load(sys.stdin).get("workflow_runs") or []
except Exception: runs=[]
m=[r for r in runs if r.get("head_sha")==sys.argv[1]]
print(m[0].get("status","") if m else "")' "$sha")"
    case "$st" in success|failure|cancelled|skipped) break ;; esac
    [ $(( $(date +%s) - t0 )) -ge 900 ] && break
    sleep 5
  done
  run=$(( $(date +%s) - t0 ))
  if [ "$st" != success ]; then
    result 16 app-deploy fail "deploy run for $(printf '%s' "$sha" | cut -c1-8) ended '${st:-not started after ${run}s}': $GITEA_BASE_URL/$org/$slug/actions"
    return
  fi
  body="$(curl -sS --max-time 15 $(proxy_args "$slug.$BASE_DOMAIN") -w '\n%{http_code}' "$(proxy_url "$slug.$BASE_DOMAIN" /health)" 2>/dev/null || true)"
  code="${body##*$'\n'}"
  [ "$code" = 200 ] && [ "$(printf '%s' "${body%$'\n'*}" | jsonq get ok)" = true ] || { result 16 app-deploy fail "run green but https://$slug.$BASE_DOMAIN/health answered $code through the proxy"; return; }
  loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 $(proxy_args "$slug.$BASE_DOMAIN") "$(proxy_url "$slug.$BASE_DOMAIN" /)" 2>/dev/null || echo 000)"
  case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) ;; *) result 16 app-deploy fail "/ of $slug is not behind the SSO: got ${loc%% *}"; return ;; esac
  db=app_smoke_app
  row="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc "SELECT r.rolsuper, r.rolcanlogin, has_database_privilege('public', d.datname, 'CONNECT') FROM pg_roles r, pg_database d WHERE r.rolname='$db' AND d.datname='$db' AND d.datdba=r.oid;" 2>/dev/null | tr -d '[:space:]')"
  [ "$row" = "f|t|f" ] || { result 16 app-deploy fail "database/role $db: got '$row' (wanted owner role nosuperuser, login, no public connect)"; return; }
  PGPASSWORD="$(envfile get "$app_env" PGPASSWORD)" dc exec -T -e PGPASSWORD postgres psql -h 127.0.0.1 -U "$db" -d "$db" -Atc 'SELECT current_user' >/dev/null 2>&1 \
    || { result 16 app-deploy fail "role $db cannot sign in with the password in $app_env"; return; }
  fp_after="$(sha_fp "$(envfile get "$app_env" PGPASSWORD)")"
  if [ -n "$fp_before" ] && [ "$fp_before" != "$fp_after" ]; then result 16 app-deploy fail "the redeploy changed the database password"; return; fi
  result 16 app-deploy pass "push to green run in ${run}s; /health 200, / to the SSO, $db owned by its role$( [ -n "$fp_before" ] && echo ', password kept on redeploy')"
}
t16

# 17. the ops tools are behind the SSO: an anonymous request to the root of
#     terminal.<BASE_DOMAIN> (when the web terminal is installed), files.<BASE_DOMAIN>,
#     portainer.<BASE_DOMAIN> and glances.<BASE_DOMAIN> is sent to Authentik.
OPS=false; case ",$COMPOSE_PROFILES," in *,ops,*) OPS=true ;; esac
wetty_running() { [ "$(docker inspect -f '{{.State.Running}}' "$(dc ps -q wetty 2>/dev/null | head -n 1)" 2>/dev/null)" = true ]; }
OPS_HOSTS="files portainer glances"; wetty_running && OPS_HOSTS="terminal $OPS_HOSTS"
if [ "$OPS" != true ]; then
  result 17 ops-routes-protected skip "ops profile off"
else
  bad=""; good=""
  for sub in $OPS_HOSTS; do
    loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 $(proxy_args "$sub.$BASE_DOMAIN") "$(proxy_url "$sub.$BASE_DOMAIN" /)" 2>/dev/null || echo 000)"
    case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) good="$good $sub" ;; *) bad="$bad $sub=${loc%% *}" ;; esac
  done
  wetty_running || good="$good (terminal not installed: see stages.optional_profiles.probe.ops)"
  [ -z "$bad" ] && result 17 ops-routes-protected pass "anonymous / to Authentik:$good" || result 17 ops-routes-protected fail "not protected:$bad"
fi

# 18. the ops tools are for admins only: their containers are healthy; the smoke user
#     (AUTHENTIK_SMOKE_USER, occ-users only) signs in and is denied the terminal and
#     the file browser; an app container on the occ network cannot reach them; the
#     file browser mounts only app data and the backup reports (read only), never the
#     install directory or an env file.
if [ "$OPS" != true ]; then
  result 18 ops-admins-only skip "ops profile off"
else
  bad=""
  svcs="portainer glances filebrowser"; wetty_running && svcs="$svcs wetty"
  for s in $svcs; do h="$(container_health "$s")"; [ "$h" = healthy ] || bad="$bad $s=$h"; done
  for sub in $OPS_HOSTS; do
    case "$sub" in terminal|files) ;; *) continue ;; esac
    out="$("$OCC_ROOT/scripts/sso-login-check.sh" --install-dir "$INSTALL_DIR" --user "$AUTHENTIK_SMOKE_USER" --password-env AUTHENTIK_SMOKE_USER_PASSWORD --target "$SCHEME_URL://$sub.$BASE_DOMAIN" --expect denied 2>/dev/null | tail -n 1 || true)"
    case "$out" in *PASS*) ;; *) bad="$bad $sub:smoke-user-not-denied(${out:-no output})" ;; esac
  done
  PORTAL_CID="$(dc ps -q portal | head -n 1)"
  if docker exec "$PORTAL_CID" sh -c 'wget -q -T 3 -O /dev/null http://filebrowser/health || wget -q -T 3 -O /dev/null http://wetty:3000/' >/dev/null 2>&1; then
    bad="$bad reachable-from-an-app-container"
  fi
  dc config --format json 2>/dev/null | $PY "$OCC_LIB/opspaths.py" compose "$INSTALL_DIR" "$BACKUP_DESTINATION" "${WETTY_KEY_DIR:-$INSTALL_DIR/local/wetty}" 2>"${TMPDIR:-/tmp}/occ-opspaths.$$" \
    || bad="$bad mounts:$(head -n 2 "${TMPDIR:-/tmp}/occ-opspaths.$$" | tr '\n' ' ')"
  rm -f "${TMPDIR:-/tmp}/occ-opspaths.$$"
  [ -z "$bad" ] && result 18 ops-admins-only pass "$(echo $svcs | wc -w | tr -d ' ') containers healthy; $AUTHENTIK_SMOKE_USER denied$(wetty_running && echo ' terminal and') files; unreachable from apps; mounts: app data + reports (ro)" \
    || result 18 ops-admins-only fail "${bad# }"
fi

# 19. object storage: Garage is healthy with a layout; two apps (smoke-s3-a, smoke-s3-b)
#     declaring object_storage.required: true each get a bucket and a key through the
#     same code as occ-app provision; a second provision keeps the key; app A writes
#     and reads an object in its bucket through s3.<BASE_DOMAIN> and is denied on B's.
#     Their env files stay in <install-dir>/local/smoke-storage/ (0700), so re-runs reuse them.
t19() {
  local dir="$INSTALL_DIR/local/smoke-storage" work m a b id1 id2 code got want bad="" host="s3.$BASE_DOMAIN"
  [ "$(container_health garage)" = healthy ] || { result 19 object-storage fail "garage is $(container_health garage)"; return; }
  garage_need 2>/dev/null && garage_healthy || { result 19 object-storage fail "garage health: cluster unavailable (no layout?): install.sh --apply --from optional_profiles"; return; }
  (umask 077; mkdir -p "$dir"); chmod 700 "$dir"
  work="$(mktemp -d "${TMPDIR:-/tmp}/occ-smoke19.XXXXXX")"
  cp "$OCC_ROOT/templates/app/company-app.yaml" "$work/company-app.yaml"
  $PY - "$work/company-app.yaml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace("object_storage:\n  required: false", "object_storage:\n  required: true")
s = s.replace("__APP_SLUG__", "smoke-s3-a").replace("__APP_NAME__", "Smoke S3").replace("__OWNER_EMAIL__", "smoke@example.com").replace("__APP_DOMAIN__", "smoke-s3-a.example.com")
open(p, "w").write(s)
PY
  m="$($PY "$OCC_LIB/appmanifest.py" vars "$work/company-app.yaml" smoke-s3-a 2>/dev/null | grep '^M_BUCKET=' || true)"
  rm -rf "$work"
  case "$m" in *true*) ;; *) result 19 object-storage fail "the template manifest with object_storage.required: true did not ask for a bucket ($m)"; return ;; esac
  a="$dir/smoke-s3-a.env"; b="$dir/smoke-s3-b.env"
  for f in "$a" "$b"; do [ -f "$f" ] || (umask 077; : > "$f"); done
  garage_app_bucket smoke-s3-a "$a" "$SCHEME_URL://$host" 2>/dev/null || { result 19 object-storage fail "provision of smoke-s3-a failed (run: occ-app provision with object storage)"; return; }
  id1="$(envfile get "$a" S3_ACCESS_KEY_ID)"
  garage_app_bucket smoke-s3-a "$a" "$SCHEME_URL://$host" 2>/dev/null; id2="$(envfile get "$a" S3_ACCESS_KEY_ID)"
  [ -n "$id1" ] && [ "$id1" = "$id2" ] && [ "$GARAGE_RESULT" = kept ] || bad="$bad second-provision:$GARAGE_RESULT"
  garage_app_bucket smoke-s3-b "$b" "$SCHEME_URL://$host" 2>/dev/null || { result 19 object-storage fail "provision of smoke-s3-b failed"; return; }
  s3() { ( set -a; . "$a"; set +a; OCC_CA_FILE="$( [ "$TLS_MODE" = internal ] && echo "$INSTALL_DIR/local/ca/ca.crt")" $PY "$OCC_LIB/s3.py" "$@" ); }
  local S3URL="$PROXY"; [ "$TLS_MODE" = internal ] && S3URL="https://127.0.0.1:${PROXY_HTTPS_PORT}"
  want="smoke 19 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  code="$(printf '%s' "$want" | s3 put "$S3URL" "$host" app-smoke-s3-a smoke.txt)"
  [ "$code" = 200 ] || bad="$bad put-own=$code"
  got="$(s3 get "$S3URL" "$host" app-smoke-s3-a smoke.txt 3>&1 >/dev/null)"
  [ "$got" = "$want" ] || bad="$bad get-own=mismatch"
  code="$(printf x | s3 put "$S3URL" "$host" app-smoke-s3-b smoke.txt)"
  [ "$code" = 403 ] || bad="$bad put-other=$code"
  code="$(s3 get "$S3URL" "$host" app-smoke-s3-b smoke.txt 3>/dev/null)"
  [ "$code" = 403 ] || bad="$bad get-other=$code"
  [ -z "$bad" ] && result 19 object-storage pass "garage healthy; buckets and keys for smoke-s3-a/b, key kept on re-provision; PUT+GET 200 on its bucket through $host, 403 on the other's" \
    || result 19 object-storage fail "${bad# }"
}
if [ "$STORAGE" = true ]; then t19; else result 19 object-storage skip "storage profile off"; fi
# 20. the operator agent (agent profile): its two containers are healthy; the brief is
#     generated, names every core service and holds no value of .env or of an app's env
#     file; the Docker API it sees refuses writes (a restart of a core container and a
#     container create, whatever ops.agent.allow_write says) and returns Env as names
#     only; the agent has no Docker socket, no mount that reaches the install directory's
#     .env, apps/ or local/, no place on the ops network, and no cloud secret in its
#     environment except the read-only Gitea token and its own AGENT_* keys.
AGENT=false; case ",$COMPOSE_PROFILES," in *,agent,*) AGENT=true ;; esac
t20() {
  local bad="" h acid pgid out insp
  for s in agent-docker-proxy agent; do h="$(container_health "$s")"; [ "$h" = healthy ] || bad="$bad $s=$h"; done
  [ -z "$bad" ] || { result 20 operator-agent fail "not healthy:$bad"; return; }
  acid="$(dc ps -q agent | head -n 1)"; pgid="$(dc ps -q postgres | head -n 1)"
  out="$($PY - "$AGENT_DIR/reference" "$ENV_FILE" "$INSTALL_DIR" <<'PY'
import json, os, re, sys
ref, envf, inst = sys.argv[1:4]
sec = re.compile(r"(PASSWORD|SECRET|TOKEN|_KEY$|AUTHKEY|DATABASE_URL|REDIS_URL)")
def env(p):
    d = {}
    for l in open(p).read().splitlines():
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', l)
        if m: d[m.group(1)] = m.group(2).strip().strip('"')
    return d
try:
    b = json.load(open(os.path.join(ref, "brief.json"))); md = open(os.path.join(ref, "brief.md")).read()
except (OSError, ValueError) as e:
    print("brief missing or invalid: %s" % e); sys.exit()
vals = [v for k, v in env(envf).items() if sec.search(k) and len(v) >= 8]
appd = os.path.join(inst, "apps")
for s in (os.listdir(appd) if os.path.isdir(appd) else []):
    f = os.path.join(appd, s, ".env")
    if os.path.isfile(f): vals += [v for k, v in env(f).items() if sec.search(k) and len(v) >= 8]
text = json.dumps(b) + md
svcs = {s["service"] for s in b.get("services", [])}
miss = {"proxy", "authentik-server", "postgres", "redis", "gitea", "portal"} - svcs
if any(v in text for v in vals): print("brief contains a secret value")
elif miss: print("brief misses services: %s" % ",".join(sorted(miss)))
elif not b.get("access_matrix"): print("brief has no access matrix")
else: print("ok %d services, %d apps, %d credentials" % (len(svcs), len(b.get("apps", [])), len(b["access_matrix"])))
PY
)"
  case "$out" in ok*) ;; *) bad="$bad brief:$out" ;; esac
  # The Docker API as the agent sees it.
  out="$(docker exec -i "$acid" node - "$pgid" <<'JS' 2>&1
const api = process.env.OCC_DOCKER_API, pg = process.argv[2];
const r = async (m, p) => (await fetch(api + p, { method: m })).status;
(async () => {
  const restart = await r("POST", `/containers/${pg}/restart`);
  const create = await r("POST", "/containers/create");
  const del = await r("DELETE", `/containers/${pg}`);
  const list = await r("GET", "/containers/json");
  const env = (await (await fetch(`${api}/containers/${pg}/json`)).json()).Config.Env;
  console.log(`restart=${restart} create=${create} delete=${del} list=${list} envvalues=${env.filter((e) => e.includes("=")).length}`);
})().catch((e) => console.log("error " + e.message));
JS
)"
  [ "$out" = "restart=403 create=403 delete=403 list=200 envvalues=0" ] || bad="$bad docker-api:$out"
  # What the agent container can reach on the box.
  insp="$(mktemp "${TMPDIR:-/tmp}/occ-smoke20.XXXXXX")"; docker inspect "$acid" > "$insp" 2>/dev/null || true
  out="$($PY - "$INSTALL_DIR" "$ENV_FILE" "${OCC_OPS_NETWORK:-occ-ops}" "$insp" <<'PY'
import json, os, re, sys
inst, envf, opsnet, insp = sys.argv[1:5]
try:
    c = json.load(open(insp))[0]
except (OSError, ValueError, IndexError):
    print("cannot inspect the agent container"); sys.exit()
bad = []
guard = [os.path.realpath(p) for p in (envf, os.path.join(inst, "apps"), os.path.join(inst, "local"))]
for m in c.get("Mounts", []):
    src = os.path.realpath(m.get("Source", ""))
    if m.get("Destination") == "/var/run/docker.sock" or src.endswith("docker.sock"): bad.append("docker socket mounted")
    for g in guard:
        if g == src or g.startswith(src.rstrip("/") + "/"): bad.append("mount %s reaches %s" % (src, g))
if opsnet in (c.get("NetworkSettings", {}).get("Networks") or {}): bad.append("on the ops network")
sec = re.compile(r"(PASSWORD|SECRET|TOKEN|_KEY$|AUTHKEY)")
allowed = re.compile(r"^(GITEA_READONLY_TOKEN|AGENT_[A-Z_]+)$")
vals = {}
for l in open(envf).read().splitlines():
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$', l)
    if m and sec.search(m.group(1)) and not allowed.match(m.group(1)):
        v = m.group(2).strip().strip('"')
        if len(v) >= 8: vals[v] = m.group(1)
leak = sorted({vals[e.split("=", 1)[1]] for e in c["Config"]["Env"] if "=" in e and e.split("=", 1)[1] in vals})
if leak: bad.append("cloud secrets in its environment: " + ",".join(leak))
print("; ".join(bad) or "ok")
PY
)"
  rm -f "$insp"
  [ "$out" = ok ] || bad="$bad isolation:$out"
  docker exec "$acid" sh -c 'test -e /var/run/docker.sock' 2>/dev/null && bad="$bad socket-visible-in-container"
  [ -z "$bad" ] && result 20 operator-agent pass "agent and its Docker API healthy; brief generated; POST/DELETE refused, Env as names; no socket, no .env, apps/ or local/, no ops network, no cloud secret in its env" \
    || result 20 operator-agent fail "${bad# }"
}
if [ "$AGENT" = true ]; then t20; else result 20 operator-agent skip "agent profile off"; fi

# 21. ingress surface: the proxy's ports 80/443 are published on loopback only and nothing
#     on the box's other addresses answers on them (the tailnet reaches the proxy only
#     through the Tailscale node's serve config). With TLS internal, the certificate the
#     proxy presents for portal.<BASE_DOMAIN> is the cloud wildcard, verifies against the
#     cloud CA (name-constrained to BASE_DOMAIN), covers *.<BASE_DOMAIN> and has more than
#     30 days left. In private ingress, the split-DNS server answers *.<BASE_DOMAIN> with the
#     node's tailnet address, the tailnet path node -> proxy answers on 80 and 443 and refuses
#     the proxy admin port, and no auth key is left in .env or in the node's container.
#     Skipped in public ingress, where the proxy listens on every interface by design.
t21() {
  local bad="" good="" cid binds addrs a p ca="$INSTALL_DIR/local/ca/ca.crt" served want ip tsid out
  cid="$(dc ps -q proxy | head -n 1)"
  binds="$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$cid" 2>/dev/null | $PY -c 'import json,sys
b=json.load(sys.stdin) or {}
print(" ".join(sorted({x.get("HostIp") or "0.0.0.0" for k in ("80/tcp","443/tcp") for x in (b.get(k) or [])})))' 2>/dev/null)"
  [ "$binds" = 127.0.0.1 ] && good="published on 127.0.0.1 only" || bad="$bad published-on:${binds:-unknown}"
  if have ss; then
    out="$(ss -Hltn 2>/dev/null | awk '{print $4}' | grep -E ":($PROXY_HTTP_PORT|$PROXY_HTTPS_PORT)\$" | grep -vE '^(127\.0\.0\.1|\[::1\]|\[::ffff:127\.0\.0\.1\]):' | tr '\n' ' ')"
    [ -z "$out" ] || bad="$bad listening-on:${out% }"
  fi
  addrs="$(hostname -I 2>/dev/null || true)"
  for a in $addrs; do
    for p in "$PROXY_HTTP_PORT" "$PROXY_HTTPS_PORT"; do
      if $PY -c 'import socket,sys;socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=2)' "$a" "$p" 2>/dev/null; then bad="$bad answers-on:$a:$p"; fi
    done
  done
  [ -n "$addrs" ] && good="$good; refused on $(echo $addrs | wc -w | tr -d ' ') other address(es)"
  if [ "$TLS_MODE" = internal ]; then
    served="$(openssl s_client -connect "127.0.0.1:$PROXY_HTTPS_PORT" -servername "$PORTAL_HOST" </dev/null 2>/dev/null | openssl x509 -outform PEM 2>/dev/null)"
    want="$(openssl x509 -in "$INSTALL_DIR/local/ca/wildcard.crt" -outform PEM 2>/dev/null)"
    if [ -z "$served" ]; then bad="$bad no-certificate-on-443"
    else
      [ "$served" = "$want" ] || bad="$bad served-certificate-is-not-the-occ-wildcard"
      printf '%s\n' "$served" | openssl verify -CAfile "$ca" >/dev/null 2>&1 || bad="$bad does-not-verify-against-the-CA"
      printf '%s\n' "$served" | openssl x509 -noout -checkend 2592000 >/dev/null 2>&1 || bad="$bad expires-within-30-days"
      printf '%s\n' "$served" | openssl x509 -noout -ext subjectAltName 2>/dev/null | grep -qF "DNS:*.$BASE_DOMAIN" || bad="$bad SAN-misses-*.$BASE_DOMAIN"
      openssl x509 -in "$ca" -noout -ext nameConstraints 2>/dev/null | grep -qF "DNS:$BASE_DOMAIN" || bad="$bad CA-not-name-constrained"
    fi
    code="$(http_code "https://$PORTAL_HOST/health" --resolve "$PORTAL_HOST:$PROXY_HTTPS_PORT:127.0.0.1" --cacert "$ca")"
    [ "$code" = 200 ] || bad="$bad https-portal-health=$code"
    good="$good; https://$PORTAL_HOST verifies against the cloud CA (until $(printf '%s\n' "$served" | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//'))"
  fi
  if [ "$INGRESS" = private ]; then
    ip="${TAILSCALE_IP:-}"
    for n in "portal.$BASE_DOMAIN" "smoke-check-$$.$BASE_DOMAIN"; do
      a="$(dc exec -T tailscale nslookup -type=a "$n" 127.0.0.1 2>/dev/null | awk '/^Address/ && $NF !~ /#53$|:53$/ {print $NF}' | tail -n 1)"
      [ -n "$ip" ] && [ "$a" = "$ip" ] || bad="$bad dns:$n=${a:-none}"
    done
    # The tailnet path, from the node itself: tailnet address -> serve -> proxy.
    # stdin stays open a few seconds: tailscale nc closes the connection when it ends.
    out="$(dc exec -T tailscale sh -c '(printf "HEAD /health HTTP/1.0\r\nHost: $1\r\n\r\n"; sleep 4) | timeout 8 tailscale nc "$2" 80 2>/dev/null | head -n 1' sh "$PORTAL_HOST" "$ip" 2>/dev/null | tr -d '\r')"
    case "$out" in HTTP/*) ;; *) bad="$bad tailnet-80:'${out:-no answer}'" ;; esac
    out="$(dc exec -T tailscale sh -c 'timeout 10 tailscale nc "$1" 443 </dev/null >/dev/null 2>&1 && echo open || echo closed' sh "$ip" 2>/dev/null)"
    [ "$out" = open ] || bad="$bad tailnet-443:${out:-?}"
    out="$(dc exec -T tailscale sh -c '(printf "GET / HTTP/1.0\r\n\r\n"; sleep 4) | timeout 8 tailscale nc "$1" "$2" 2>/dev/null | head -c 12' sh "$ip" "$PROXY_ADMIN_PORT" 2>/dev/null)"
    [ -z "$out" ] || bad="$bad tailnet-admin-port-answers"
    [ -z "$(envfile get "$ENV_FILE" TAILSCALE_AUTHKEY)" ] || bad="$bad authkey-in-.env"
    tsid="$(dc ps -q tailscale | head -n 1)"
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$tsid" 2>/dev/null | grep -q '^TS_AUTHKEY=.' && bad="$bad authkey-in-container"
    good="$good; *.$BASE_DOMAIN -> $ip on the node's DNS; tailnet 80/443 reach the proxy, ${PROXY_ADMIN_PORT} does not; no auth key kept"
  fi
  [ -z "$bad" ] && result 21 ingress-surface pass "${good#; }" || result 21 ingress-surface fail "${bad# }"
}
if [ "$INGRESS" = public ]; then result 21 ingress-surface skip "public ingress: the proxy listens on every interface"; else t21; fi

_out ""
_out "smoke tests: $PASS passed, $FAILS failed, $SKIP skipped"
[ "$HAVE_STATE" = true ] && state stage smoke_tests set probe "{\"passed\":$PASS,\"failed\":$FAILS,\"skipped\":$SKIP,\"tests\":{${RESULTS#,}}}"
[ "$FAILS" -eq 0 ]
