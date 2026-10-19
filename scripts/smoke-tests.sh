#!/usr/bin/env bash
# Smoke tests (docs/smoke-tests.md), step 17 of the install sequence.
#
#   scripts/smoke-tests.sh --install-dir DIR [--json]
#
# Runs tests 1 to 16. Test 14 runs `harness-backup.sh verify --latest` and is skipped
# only when BACKUP_ENABLED=false. Test 16 deploys the template app smoke-app by a push to
# main (never skipped: the runners are core); the app stays on the box. Results go to state.json under stages.smoke_tests.probe.tests, one entry
# per test with status and a short detail: never headers, cookies or tokens. Exit 1
# when any test fails. Variable names of the document map to .env as follows:
#   HARNESS_COMPOSE_FILE -> <install-dir>/compose.yml      PORTAL_HOST, PROXY_HTTP_PORT -> same
#   AUTHENTIK_ISSUER     -> AUTHENTIK_BASE_URL/application/o/gitea
#   HARNESS_GIT_ASKPASS  -> a helper written inside the Gitea container for test 12
set -eu
HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$HARNESS_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${HARNESS_INSTALL_DIR:-/opt/open-company-harness}"
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
INSECURE=""; [ "$TLS_MODE" = internal ] && INSECURE="-k"

# 1. compose file valid
if dc config --quiet 2>/dev/null; then result 1 compose-valid pass "compose.yml validates"; else result 1 compose-valid fail "docker compose config failed"; fi

# 2. every core service running and healthy
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
out="$(curl -K "$API_CFG" $INSECURE -H "Host: $GITEA_HOST" -w '\n%{http_code}' "$PROXY/api/v1/version" 2>/dev/null || true)"
code="${out##*$'\n'}"; v="$(printf '%s' "${out%$'\n'*}" | jsonq get version)"
[ "$code" = 200 ] && [ -n "$v" ] && result 6 gitea-api pass "version $v" || result 6 gitea-api fail "HTTP $code"

# 7. portal healthcheck (public path, no forward auth)
out="$(curl -sS $INSECURE -H "Host: $PORTAL_HOST" -w '\n%{http_code}' "$PROXY/health" 2>/dev/null || true)"
code="${out##*$'\n'}"; okv="$(printf '%s' "${out%$'\n'*}" | jsonq get ok)"
[ "$code" = 200 ] && [ "$okv" = true ] && result 7 portal-health pass "200 ok" || result 7 portal-health fail "HTTP $code"

# 8. proxy resolves the local route
code="$(http_code "$PROXY/" -I -H "Host: $PORTAL_HOST")"
case "$code" in 200|301|302) result 8 proxy-route pass "HTTP $code" ;; *) result 8 proxy-route fail "HTTP $code" ;; esac

# 9. forward auth protects the portal
loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 -H "Host: $PORTAL_HOST" "$PROXY/" 2>/dev/null || echo 000)"
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
  ap="$(mktemp "${TMPDIR:-/tmp}/harness-askpass.XXXXXX")"; printf '%s\n' "$ASKPASS_SRC" > "$ap"; chmod 700 "$ap"
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
  vout="$("$HARNESS_ROOT/scripts/harness-backup.sh" --install-dir "$INSTALL_DIR" verify --latest --json 2>/dev/null | tail -n 1 || true)"
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
  work="$(mktemp -d "${TMPDIR:-/tmp}/harness-smoke16.XXXXXX")"
  ap="$work/askpass"; printf '#!/bin/sh\ncase "$1" in *sername*) echo "%s" ;; *) printf "%%s\\n" "$GITEA_ADMIN_TOKEN" ;; esac\n' "$GITEA_ADMIN_USERNAME" > "$ap"; chmod 700 "$ap"
  repo_url="http://127.0.0.1:${GITEA_LOCAL_PORT}/$org/$slug.git"
  app_env="$INSTALL_DIR/apps/$slug/.env"
  fp_before=""; [ -f "$app_env" ] && fp_before="$(sha_fp "$(envfile get "$app_env" PGPASSWORD)")"
  api_init gt16 "Authorization: token ${GITEA_ADMIN_TOKEN}"
  api GET "$GT/repos/$org/$slug"
  if [ "$API_CODE" = 404 ] || [ "$(printf '%s' "$API_BODY" | jsonq get empty)" = true ]; then
    "$HARNESS_ROOT/scripts/harness-app.sh" new "$slug" --dir "$work/$slug" --install-dir "$INSTALL_DIR" --name "Smoke App" --owner "$GITEA_ADMIN_EMAIL" >/dev/null 2>"$work/new.log" \
      || { result 16 app-deploy fail "harness-app new failed: $(tail -n 1 "$work/new.log")"; rm -rf "$work"; return; }
  else
    GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git clone -q "$repo_url" "$work/$slug" 2>/dev/null \
      || { result 16 app-deploy fail "clone of $org/$slug failed"; rm -rf "$work"; return; }
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$work/$slug/.harness-smoke"
  git -C "$work/$slug" add -A
  git -C "$work/$slug" -c user.name=harness-smoke -c user.email="$GITEA_ADMIN_EMAIL" commit -q -m "smoke test 16" 2>/dev/null
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
  body="$(curl -sS --max-time 15 -H "Host: $slug.$BASE_DOMAIN" -w '\n%{http_code}' "$PROXY/health" 2>/dev/null || true)"
  code="${body##*$'\n'}"
  [ "$code" = 200 ] && [ "$(printf '%s' "${body%$'\n'*}" | jsonq get ok)" = true ] || { result 16 app-deploy fail "run green but https://$slug.$BASE_DOMAIN/health answered $code through the proxy"; return; }
  loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 -H "Host: $slug.$BASE_DOMAIN" "$PROXY/" 2>/dev/null || echo 000)"
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

_out ""
_out "smoke tests: $PASS passed, $FAILS failed, $SKIP skipped"
[ "$HAVE_STATE" = true ] && state stage smoke_tests set probe "{\"passed\":$PASS,\"failed\":$FAILS,\"skipped\":$SKIP,\"tests\":{${RESULTS#,}}}"
[ "$FAILS" -eq 0 ]
