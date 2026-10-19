#!/usr/bin/env bash
# Smoke tests (docs/smoke-tests.md), step 16 of the install sequence.
#
#   scripts/smoke-tests.sh --install-dir DIR [--json]
#
# Runs tests 1 to 13 and 15; test 14 (backup) is reported as skipped until the backup
# job exists. Results go to state.json under stages.smoke_tests.probe.tests, one entry
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
CORE="proxy authentik-postgres authentik-server authentik-worker postgres redis gitea portal"
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

# 12. authenticated clone (ls-remote) against Gitea, from inside the container so the
#     public name resolves; the token goes in through the environment.
head_ref="$(docker exec -i -e GITEA_READONLY_TOKEN -e GITEA_ADMIN_USERNAME -e GITEA_SMOKE_REPOSITORY "$GITEA_CID" sh -c '
printf "#!/bin/sh\ncase \"\$1\" in *sername*) printf \"%%s\\\\n\" \"\$GITEA_ADMIN_USERNAME\";; *) printf \"%%s\\\\n\" \"\$GITEA_READONLY_TOKEN\";; esac\n" > /tmp/askpass && chmod 700 /tmp/askpass
GIT_ASKPASS=/tmp/askpass GIT_TERMINAL_PROMPT=0 git ls-remote "$GITEA_SMOKE_REPOSITORY" HEAD 2>/dev/null; rm -f /tmp/askpass' | awk '{print $2}' | head -n 1)"
[ "$head_ref" = HEAD ] && result 12 git-ls-remote pass "HEAD returned for ${GITEA_SMOKE_REPOSITORY#*://}" || result 12 git-ls-remote fail "ls-remote returned nothing"

# 13. the portal's database role is isolated
row="$(dc exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc "SELECT rolname, rolsuper FROM pg_roles WHERE rolname='$PORTAL_DB_ROLE';" 2>/dev/null | tr -d '[:space:]')"
[ "$row" = "$PORTAL_DB_ROLE|f" ] && result 13 portal-db-role pass "$PORTAL_DB_ROLE exists, rolsuper=false" || result 13 portal-db-role fail "got '$row'"

# 14. backup verification: not available until the backup job exists
result 14 backup-verify skip "backup job not installed yet"

# 15. the state is consistent: nothing failed, every stage before this one completed
if [ "$HAVE_STATE" = true ]; then
  detail="$(state status --json 2>/dev/null | $PY -c '
import json,sys
d=json.load(sys.stdin); st=d["stages"]
order=["preflight","plan","secrets","foundation","authentik","shared_data","proxy_ingress","gitea","portal","first_run"]
failed=[s for s in st if st[s].get("status")=="failed"]
missing=[s for s in order if st.get(s,{}).get("status")!="completed"]
print("ok" if not failed and not missing else "failed=%s pending=%s"%(failed,missing))')"
  [ "$detail" = ok ] && result 15 state-consistent pass "no failed stage; stages up to first_run completed" || result 15 state-consistent fail "$detail"
else
  result 15 state-consistent skip "no state.json (run outside install.sh)"
fi

_out ""
_out "smoke tests: $PASS passed, $FAILS failed, $SKIP skipped"
[ "$HAVE_STATE" = true ] && state stage smoke_tests set probe "{\"passed\":$PASS,\"failed\":$FAILS,\"skipped\":$SKIP,\"tests\":{${RESULTS#,}}}"
[ "$FAILS" -eq 0 ]
