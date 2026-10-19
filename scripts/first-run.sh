#!/usr/bin/env bash
# First access, automated (docs/install-design.md "First Access", docs/first-run.md).
# Stage 14 and 15 of the install sequence; install.sh calls it, and it can be re-run alone:
#
#   scripts/first-run.sh --install-dir DIR [--json]
#
# Repeatable: every action probes before it creates and reconciles what exists.
#   1. Authentik: groups, OIDC provider + application for Gitea, proxy provider +
#      application for the portal, embedded outpost, group policy bindings.
#   2. Proxy: hosts for auth, git and portal (portal with forward auth), plus the
#      optional profiles' hosts.
#   3. Gitea: admin, API tokens, organization, harness-smoke repository, OIDC source.
# Talks to the services on their loopback control ports; tokens travel in curl config
# files and on stdin, never on a command line, and nothing secret is printed.
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
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
INSTALL_DIR="${INSTALL_DIR%/}"
ENV_FILE="$INSTALL_DIR/.env"
STATE_FILE="$INSTALL_DIR/state.json"
load_env
HAVE_STATE=false; [ -f "$STATE_FILE" ] && HAVE_STATE=true
record() { [ "$HAVE_STATE" = true ] && state stage first_run set resources "[\"$1\"]" || true; }
# shellcheck source=lib/sso.sh
. "$HARNESS_ROOT/scripts/lib/sso.sh"

AK="http://127.0.0.1:${AUTHENTIK_LOCAL_PORT}/api/v3"
GT="http://127.0.0.1:${GITEA_LOCAL_PORT}/api/v1"
NPM="http://127.0.0.1:${PROXY_ADMIN_PORT}/api"
GITEA_CALLBACK="${GITEA_BASE_URL}/user/oauth2/${GITEA_OIDC_SOURCE_NAME}/callback"
OIDC_DISCOVERY="${AUTHENTIK_BASE_URL}/application/o/gitea/.well-known/openid-configuration"

# ================================================================ Authentik
step "Authentik"
api_init ak "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}"
t0=$(date +%s)
while :; do
  api GET "$AK/core/users/me/"
  [ "$API_CODE" = 200 ] && break
  [ $(( $(date +%s) - t0 )) -ge 240 ] && die "Authentik API not answering with the bootstrap token (HTTP $API_CODE). Is AUTHENTIK_BOOTSTRAP_TOKEN the value the first start used?"
  sleep 5
done
ok "API reachable as $(printf '%s' "$API_BODY" | jsonq get user.username)"

PORTAL_GROUP_PK="$(ensure_group "$AUTHENTIK_PORTAL_GROUP")"
APP_GROUP_PK="$(ensure_group "$AUTHENTIK_APP_GROUP")"

AUTHZ_FLOW="$(flow_pk default-provider-authorization-implicit-consent)"
INVAL_FLOW="$(flow_pk default-provider-invalidation-flow)"
ok "flows resolved (authorization implicit-consent, invalidation)"

# Signing key for id_tokens: the self-signed pair Authentik generates on first start.
SIGNING_KEY="$(ak_list_find "crypto/certificatekeypairs/?name=$(urlenc "authentik Self-signed Certificate")&has_key=true" name "authentik Self-signed Certificate" pk)"
if [ -z "$SIGNING_KEY" ]; then
  api POST "$AK/crypto/certificatekeypairs/generate/" "$(jsonq build common_name="harness OIDC signing" subject_alt_name="" validity_days:=3650)"
  api_ok || die "generate signing key: HTTP $API_CODE"
  SIGNING_KEY="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "signing key generated"
else ok "signing key: authentik self-signed certificate"; fi

# Scope mappings openid, email, profile (the API gives a provider none by default).
SCOPES="[]"
for m in scope-openid scope-email scope-profile; do
  pk="$(ak_list_find "propertymappings/provider/scope/?managed=$(urlenc "goauthentik.io/providers/oauth2/$m")" managed "goauthentik.io/providers/oauth2/$m" pk)"
  [ -n "$pk" ] || die "scope mapping $m not found"
  SCOPES="$(printf '%s' "$SCOPES" | $PY -c 'import json,sys;l=json.load(sys.stdin);l.append(sys.argv[1]);print(json.dumps(l))' "$pk")"
done

# OAuth2 provider for Gitea: probe by name, then create or reconcile.
PROVIDER_BODY="$(jsonq build name=gitea authorization_flow="$AUTHZ_FLOW" invalidation_flow="$INVAL_FLOW" client_type=confidential grant_types:='["authorization_code","refresh_token"]' client_id="$GITEA_OIDC_CLIENT_ID" client_secret="$GITEA_OIDC_CLIENT_SECRET" signing_key="$SIGNING_KEY" property_mappings:="$SCOPES" redirect_uris:="[{\"matching_mode\":\"strict\",\"url\":\"$GITEA_CALLBACK\"}]" sub_mode=hashed_user_id issuer_mode=per_provider)"
GITEA_PROVIDER_PK="$(ak_list_find "providers/oauth2/?name=gitea" name gitea pk)"
if [ -z "$GITEA_PROVIDER_PK" ]; then
  api POST "$AK/providers/oauth2/" "$PROVIDER_BODY"
  api_ok || die "create OAuth2 provider: HTTP $API_CODE $API_BODY"
  GITEA_PROVIDER_PK="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "OAuth2 provider gitea created (callback $GITEA_CALLBACK)"
else
  api PATCH "$AK/providers/oauth2/$GITEA_PROVIDER_PK/" "$PROVIDER_BODY"
  api_ok || die "reconcile OAuth2 provider: HTTP $API_CODE $API_BODY"
  ok "OAuth2 provider gitea reconciled"
fi
record "authentik:provider:oauth2:$GITEA_PROVIDER_PK"

GITEA_APP_PK="$(ensure_application gitea Gitea "$GITEA_PROVIDER_PK" "$GITEA_BASE_URL")"

# Proxy provider (forward auth, single application) for the portal.
PORTAL_PROVIDER_PK="$(ensure_proxy_provider portal "$PORTAL_BASE_URL" "^/health\$")"
PORTAL_APP_PK="$(ensure_application portal "App Portal" "$PORTAL_PROVIDER_PK" "$PORTAL_BASE_URL")"

# Embedded outpost: add the portal provider, point browsers at the public Authentik URL.
OUTPOST_PK="$(outpost_serve "$PORTAL_PROVIDER_PK")"
ok "embedded outpost serves the portal provider; authentik_host $AUTHENTIK_BASE_URL"
[ "$(env_get AUTHENTIK_OUTPOST_ID)" = "$OUTPOST_PK" ] || env_set AUTHENTIK_OUTPOST_ID "$OUTPOST_PK"
record "authentik:outpost:$OUTPOST_PK"

ensure_binding "$PORTAL_APP_PK" "$PORTAL_GROUP_PK" "portal <- $AUTHENTIK_PORTAL_GROUP"
ensure_binding "$GITEA_APP_PK" "$APP_GROUP_PK" "gitea <- $AUTHENTIK_APP_GROUP"

# The bootstrap admin joins both groups so the first login works out of the box.
ADMIN_PK="$(ak_list_find "core/users/?username=akadmin" username akadmin pk)"
[ -n "$ADMIN_PK" ] || die "akadmin user not found"
for g in "$PORTAL_GROUP_PK:$AUTHENTIK_PORTAL_GROUP" "$APP_GROUP_PK:$AUTHENTIK_APP_GROUP"; do
  gpk="${g%%:*}"; gname="${g#*:}"
  api GET "$AK/core/groups/$gpk/?include_users=true"
  if printf '%s' "$API_BODY" | jsonq has users "$ADMIN_PK"; then ok "akadmin in $gname"; else
    api POST "$AK/core/groups/$gpk/add_user/" "$(jsonq build pk:="$ADMIN_PK")"
    api_ok || die "add akadmin to $gname: HTTP $API_CODE $API_BODY"
    ok "akadmin added to $gname"
  fi
done

# ==================================================================== Proxy
step "Proxy routes"
npm_login
FORWARD_AUTH_CONF="$(forward_auth_conf /health)"

ensure_proxy_host "$AUTHENTIK_HOST" authentik-server 9000 ""
ensure_proxy_host "$GITEA_HOST" gitea 3000 ""
ensure_proxy_host "$PORTAL_HOST" portal 8080 "$FORWARD_AUTH_CONF"
case ",$COMPOSE_PROFILES," in
  *,storage,*) ensure_proxy_host "s3.$BASE_DOMAIN" minio 9000 ""; ensure_proxy_host "s3-console.$BASE_DOMAIN" minio 9001 "" ;;
esac
case ",$COMPOSE_PROFILES," in
  *,ops,*) ensure_proxy_host "portainer.$BASE_DOMAIN" portainer 9000 ""; ensure_proxy_host "glances.$BASE_DOMAIN" glances 61208 "$FORWARD_AUTH_CONF" ;;
esac

# Give nginx a moment to reload, then check the routes from the box itself.
t0=$(date +%s)
while :; do
  c_auth="$(http_code "http://127.0.0.1:${PROXY_HTTP_PORT}/-/health/live/" -H "Host: $AUTHENTIK_HOST")"
  c_git="$(http_code "http://127.0.0.1:${PROXY_HTTP_PORT}/api/healthz" -H "Host: $GITEA_HOST")"
  c_health="$(http_code "http://127.0.0.1:${PROXY_HTTP_PORT}/health" -H "Host: $PORTAL_HOST")"
  [ "$c_auth" = 200 ] && [ "$c_git" = 200 ] && [ "$c_health" = 200 ] && break
  [ $(( $(date +%s) - t0 )) -ge 90 ] && die "routes not answering through the proxy (auth $c_auth, git $c_git, portal health $c_health)"
  sleep 3
done
ok "routes answer through the proxy (auth, git, portal /health)"

# ==================================================================== Gitea
step "Gitea"
GITEA_CID="$(dc ps -q gitea | head -n 1)"
[ -n "$GITEA_CID" ] || die "gitea container not running"
gitea_cli() { docker exec -i -u git "$GITEA_CID" gitea "$@"; }
# gitea_cli_secret VAR -- CMD...: VAR is passed through the environment, never as an argument.
gitea_cli_secret() { local var="$1"; shift; docker exec -i -u git -e "$var" "$GITEA_CID" sh -c "$@"; }

if gitea_cli admin user list --admin 2>/dev/null | awk 'NR>1{print $2}' | grep -qx "$GITEA_ADMIN_USERNAME"; then
  ok "admin user $GITEA_ADMIN_USERNAME exists"
else
  gitea_cli_secret GITEA_ADMIN_PASSWORD 'gitea admin user create --admin --username "$1" --email "$2" --password "$GITEA_ADMIN_PASSWORD" --must-change-password=false >/dev/null' sh "$GITEA_ADMIN_USERNAME" "$GITEA_ADMIN_EMAIL"
  ok "admin user $GITEA_ADMIN_USERNAME created"
fi
record "gitea:user:$GITEA_ADMIN_USERNAME"

gitea_token_valid() { api_init gt "Authorization: token $1"; api GET "$GT/user"; [ "$API_CODE" = 200 ]; }
TOKEN="$(env_get GITEA_ADMIN_TOKEN)"
if [ -z "$TOKEN" ] || ! gitea_token_valid "$TOKEN"; then
  TOKEN="$(gitea_cli admin user generate-access-token --username "$GITEA_ADMIN_USERNAME" --token-name "harness-install-$(date +%s)" --scopes all --raw | tr -d '[:space:]')"
  [ -n "$TOKEN" ] || die "could not generate the admin API token"
  env_set GITEA_ADMIN_TOKEN "$TOKEN"; ok "admin API token generated into .env"
else ok "admin API token valid"; fi
api_init gt "Authorization: token $TOKEN"

api GET "$GT/orgs/$GITEA_ORGANIZATION"
if [ "$API_CODE" = 404 ]; then
  api POST "$GT/orgs" "$(jsonq build username="$GITEA_ORGANIZATION" full_name="$GITEA_ORGANIZATION" visibility=limited repo_admin_change_team_access:=true)"
  api_ok || die "create organization: HTTP $API_CODE $API_BODY"
  ok "organization $GITEA_ORGANIZATION created"
else api_ok || die "probe organization: HTTP $API_CODE"; ok "organization $GITEA_ORGANIZATION exists"; fi
record "gitea:org:$GITEA_ORGANIZATION"

# A small private repository for smoke test 12 (authenticated clone). Deploys need no
# repository of their own: push to main of the app's repository is the approval
# (docs/gitops-flow.md). A deploy-requests repository left by an older install is kept.
REPO=harness-smoke
api GET "$GT/repos/$GITEA_ORGANIZATION/$REPO"
if [ "$API_CODE" = 404 ]; then
  api POST "$GT/orgs/$GITEA_ORGANIZATION/repos" "$(jsonq build name="$REPO" description="Target of the harness smoke tests (authenticated clone)" private:=true auto_init:=true default_branch=main)"
  api_ok || die "create repository: HTTP $API_CODE $API_BODY"
  ok "repository $GITEA_ORGANIZATION/$REPO created"
else api_ok || die "probe repository: HTTP $API_CODE"; ok "repository $GITEA_ORGANIZATION/$REPO exists"; fi
record "gitea:repo:$GITEA_ORGANIZATION/$REPO"
SMOKE="$GITEA_BASE_URL/$GITEA_ORGANIZATION/$REPO.git"
[ "$(env_get GITEA_SMOKE_REPOSITORY)" = "$SMOKE" ] || env_set GITEA_SMOKE_REPOSITORY "$SMOKE"

RO="$(env_get GITEA_READONLY_TOKEN)"
if [ -z "$RO" ] || ! gitea_token_valid "$RO"; then
  RO="$(gitea_cli admin user generate-access-token --username "$GITEA_ADMIN_USERNAME" --token-name "harness-readonly-$(date +%s)" --scopes read:misc,read:repository,read:organization,read:user --raw | tr -d '[:space:]')"
  [ -n "$RO" ] || die "could not generate the read-only token"
  env_set GITEA_READONLY_TOKEN "$RO"; ok "read-only API token generated into .env"
else ok "read-only API token valid"; fi
api_init gt "Authorization: token $TOKEN"

if [ "$GITEA_OIDC_ENABLED" = true ]; then
  # Gitea fetches the discovery document when the source is added, so the auth route
  # must already answer by its public name from inside the container. Probed with
  # busybox wget: curl resolves every *.localhost name to loopback by itself and would
  # never reach the proxy alias.
  disc="$(docker exec -i "$GITEA_CID" wget -qO- -T 20 "$OIDC_DISCOVERY" 2>/dev/null | jsonq get issuer)"
  [ -n "$disc" ] || die "Gitea cannot fetch $OIDC_DISCOVERY from inside its container"
  ok "OIDC discovery reachable from Gitea (issuer $disc)"
  SRC_ID="$(gitea_cli admin auth list 2>/dev/null | awk -F'\t' -v n="$GITEA_OIDC_SOURCE_NAME" 'NR>1 && $2==n {print $1}' | head -n 1)"
  if [ -z "$SRC_ID" ]; then
    gitea_cli_secret GITEA_OIDC_CLIENT_SECRET 'gitea admin auth add-oauth --name "$1" --provider openidConnect --key "$2" --secret "$GITEA_OIDC_CLIENT_SECRET" --auto-discover-url "$3" --scopes openid,profile,email --skip-local-2fa' sh "$GITEA_OIDC_SOURCE_NAME" "$GITEA_OIDC_CLIENT_ID" "$OIDC_DISCOVERY"
    ok "OIDC source $GITEA_OIDC_SOURCE_NAME created"
  else
    gitea_cli_secret GITEA_OIDC_CLIENT_SECRET 'gitea admin auth update-oauth --id "$4" --name "$1" --provider openidConnect --key "$2" --secret "$GITEA_OIDC_CLIENT_SECRET" --auto-discover-url "$3" --scopes openid,profile,email --skip-local-2fa' sh "$GITEA_OIDC_SOURCE_NAME" "$GITEA_OIDC_CLIENT_ID" "$OIDC_DISCOVERY" "$SRC_ID"
    ok "OIDC source $GITEA_OIDC_SOURCE_NAME reconciled (id $SRC_ID)"
  fi
  record "gitea:auth-source:$GITEA_OIDC_SOURCE_NAME"
else
  log "OIDC in Gitea disabled by config"
fi

# ============================================================ Protected route
step "Protected route"
t0=$(date +%s)
while :; do
  loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 -H "Host: $PORTAL_HOST" "http://127.0.0.1:${PROXY_HTTP_PORT}/" 2>/dev/null || echo 000)"
  case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) break ;; esac
  [ $(( $(date +%s) - t0 )) -ge 90 ] && die "portal route is not protected: got '$loc' (wanted 302 to the outpost)"
  sleep 3
done
ok "portal route redirects anonymous requests to the outpost"
[ "$HAVE_STATE" = true ] && state stage first_run set probe "$(jsonq build gitea_oidc_source="$GITEA_OIDC_SOURCE_NAME" callback="$GITEA_CALLBACK" discovery="$OIDC_DISCOVERY" portal_protected:=true first_login=pending)"
ok "first-run complete"
