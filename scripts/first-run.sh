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
#   3. Gitea: admin, API tokens, organization, deploy-requests repository, OIDC source.
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

ak_list_find() { # PATH?filter FIELD VALUE OUT -> prints OUT of the matching element
  api GET "$AK/$1"
  api_ok || die "GET $1 failed: HTTP $API_CODE"
  printf '%s' "$API_BODY" | jsonq find results "$2" "$3" "$4"
}

ensure_group() { # NAME -> pk
  local pk
  pk="$(ak_list_find "core/groups/?name=$(urlenc "$1")" name "$1" pk)"
  if [ -z "$pk" ]; then
    api POST "$AK/core/groups/" "$(jsonq build name="$1" is_superuser:=false)"
    api_ok || die "create group $1: HTTP $API_CODE $API_BODY"
    pk="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "group $1 created"
  else ok "group $1 exists"; fi
  record "authentik:group:$1"
  printf '%s' "$pk"
}
PORTAL_GROUP_PK="$(ensure_group "$AUTHENTIK_PORTAL_GROUP")"
APP_GROUP_PK="$(ensure_group "$AUTHENTIK_APP_GROUP")"

flow_pk() { # SLUG
  local pk; pk="$(ak_list_find "flows/instances/?slug=$(urlenc "$1")" slug "$1" pk)"
  [ -n "$pk" ] || die "Authentik flow not found: $1"
  printf '%s' "$pk"
}
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

ensure_application() { # SLUG NAME PROVIDER_PK LAUNCH_URL -> pk
  local body pk
  body="$(jsonq build name="$2" slug="$1" provider:="$3" meta_launch_url="$4" open_in_new_tab:=false policy_engine_mode=any)"
  api GET "$AK/core/applications/$1/"
  if [ "$API_CODE" = 404 ]; then
    api POST "$AK/core/applications/" "$body"
    api_ok || die "create application $1: HTTP $API_CODE $API_BODY"
    ok "application $1 created"
  else
    api_ok || die "probe application $1: HTTP $API_CODE"
    api PATCH "$AK/core/applications/$1/" "$body"
    api_ok || die "reconcile application $1: HTTP $API_CODE $API_BODY"
    ok "application $1 reconciled"
  fi
  record "authentik:application:$1"
  printf '%s' "$API_BODY" | jsonq get pk
}
GITEA_APP_PK="$(ensure_application gitea Gitea "$GITEA_PROVIDER_PK" "$GITEA_BASE_URL")"

# Proxy provider (forward auth, single application) for the portal.
PROXY_BODY="$(jsonq build name=portal authorization_flow="$AUTHZ_FLOW" invalidation_flow="$INVAL_FLOW" mode=forward_single external_host="$PORTAL_BASE_URL" skip_path_regex="^/health\$" internal_host_ssl_validation:=false)"
PORTAL_PROVIDER_PK="$(ak_list_find "providers/proxy/?name=portal" name portal pk)"
if [ -z "$PORTAL_PROVIDER_PK" ]; then
  api POST "$AK/providers/proxy/" "$PROXY_BODY"
  api_ok || die "create proxy provider: HTTP $API_CODE $API_BODY"
  PORTAL_PROVIDER_PK="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "proxy provider portal created ($PORTAL_BASE_URL)"
else
  api PATCH "$AK/providers/proxy/$PORTAL_PROVIDER_PK/" "$PROXY_BODY"
  api_ok || die "reconcile proxy provider: HTTP $API_CODE $API_BODY"
  ok "proxy provider portal reconciled"
fi
record "authentik:provider:proxy:$PORTAL_PROVIDER_PK"
PORTAL_APP_PK="$(ensure_application portal "App Portal" "$PORTAL_PROVIDER_PK" "$PORTAL_BASE_URL")"

# Embedded outpost: add the portal provider, point browsers at the public Authentik URL.
api GET "$AK/outposts/instances/?managed__iexact=$(urlenc goauthentik.io/outposts/embedded)"
api_ok || die "list outposts: HTTP $API_CODE"
OUTPOST_PK="$(printf '%s' "$API_BODY" | jsonq get results.0.pk)"
[ -n "$OUTPOST_PK" ] || die "embedded outpost not found"
OUTPOST_PATCH="$(printf '%s' "$API_BODY" | $PY -c '
import json,sys
o=json.load(sys.stdin)["results"][0]
prov=o.get("providers") or []
pk=int(sys.argv[1])
if pk not in prov: prov.append(pk)
cfg=o.get("config") or {}
cfg["authentik_host"]=sys.argv[2]
cfg["authentik_host_insecure"]=sys.argv[2].startswith("http://")
print(json.dumps({"providers":prov,"config":cfg}))' "$PORTAL_PROVIDER_PK" "$AUTHENTIK_BASE_URL")"
api PATCH "$AK/outposts/instances/$OUTPOST_PK/" "$OUTPOST_PATCH"
api_ok || die "update embedded outpost: HTTP $API_CODE $API_BODY"
ok "embedded outpost serves the portal provider; authentik_host $AUTHENTIK_BASE_URL"
[ "$(env_get AUTHENTIK_OUTPOST_ID)" = "$OUTPOST_PK" ] || env_set AUTHENTIK_OUTPOST_ID "$OUTPOST_PK"
record "authentik:outpost:$OUTPOST_PK"

ensure_binding() { # APP_PK GROUP_PK LABEL
  api GET "$AK/policies/bindings/?target=$1"
  api_ok || die "list bindings: HTTP $API_CODE"
  if [ -n "$(printf '%s' "$API_BODY" | jsonq find results group "$2" pk)" ]; then ok "binding $3 exists"; return; fi
  api POST "$AK/policies/bindings/" "$(jsonq build target="$1" group="$2" order:=0 enabled:=true)"
  api_ok || die "create binding $3: HTTP $API_CODE $API_BODY"
  ok "binding $3 created"
}
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
api_init npm-login ""
api POST "$NPM/tokens" "$(jsonq build identity="$PROXY_ADMIN_EMAIL" secret="$PROXY_ADMIN_PASSWORD")"
api_ok || die "proxy admin login failed (HTTP $API_CODE). PROXY_ADMIN_EMAIL/PROXY_ADMIN_PASSWORD in .env must match the admin created on the proxy's first start."
NPM_TOKEN="$(printf '%s' "$API_BODY" | jsonq get token)"
api_init npm "Authorization: Bearer $NPM_TOKEN"
api GET "$NPM/nginx/proxy-hosts"
api_ok || die "list proxy hosts: HTTP $API_CODE"
PROXY_HOSTS="$API_BODY"

FORWARD_AUTH_CONF='# Open Company App Harness: forward auth through the Authentik embedded outpost.
proxy_buffers 8 16k;
proxy_buffer_size 32k;
set $authentik_upstream http://authentik-server:9000;

# Health stays public so the installer and monitors can probe it.
location = /health {
    proxy_pass $forward_scheme://$server:$port$request_uri;
    proxy_set_header Host $host;
}

location / {
    proxy_pass $forward_scheme://$server:$port$request_uri;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;

    auth_request        /outpost.goauthentik.io/auth/nginx;
    error_page          401 = @goauthentik_proxy_signin;
    auth_request_set    $auth_cookie $upstream_http_set_cookie;
    add_header          Set-Cookie $auth_cookie;

    auth_request_set $authentik_username $upstream_http_x_authentik_username;
    auth_request_set $authentik_groups $upstream_http_x_authentik_groups;
    auth_request_set $authentik_entitlements $upstream_http_x_authentik_entitlements;
    auth_request_set $authentik_email $upstream_http_x_authentik_email;
    auth_request_set $authentik_name $upstream_http_x_authentik_name;
    auth_request_set $authentik_uid $upstream_http_x_authentik_uid;
    proxy_set_header X-authentik-username $authentik_username;
    proxy_set_header X-authentik-groups $authentik_groups;
    proxy_set_header X-authentik-entitlements $authentik_entitlements;
    proxy_set_header X-authentik-email $authentik_email;
    proxy_set_header X-authentik-name $authentik_name;
    proxy_set_header X-authentik-uid $authentik_uid;
}

location /outpost.goauthentik.io {
    proxy_pass              $authentik_upstream$uri$is_args$args;
    proxy_set_header        Host $host;
    proxy_set_header        X-Original-URL $scheme://$http_host$request_uri;
    proxy_set_header        X-Forwarded-Proto $scheme;
    add_header              Set-Cookie $auth_cookie;
    auth_request_set        $auth_cookie $upstream_http_set_cookie;
    proxy_pass_request_body off;
    proxy_set_header        Content-Length "";
}

location @goauthentik_proxy_signin {
    internal;
    add_header Set-Cookie $auth_cookie;
    return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}'

ensure_proxy_host() { # HOST FORWARD_HOST FORWARD_PORT ADVANCED_CONFIG
  local host="$1" fhost="$2" fport="$3" adv="$4" id cert="0" ssl=false http2=false meta body
  id="$(printf '%s' "$PROXY_HOSTS" | $PY -c '
import json,sys
for h in json.load(sys.stdin):
    if sys.argv[1] in (h.get("domain_names") or []): print(h["id"]); break' "$host")"
  meta='{"letsencrypt_agree":false,"dns_challenge":false}'
  case "$TLS_MODE" in
    acme)
      ssl=true; http2=true; cert='"new"'
      meta="$(jsonq build letsencrypt_email="$PROXY_ADMIN_EMAIL" letsencrypt_agree:=true dns_challenge:=false)"
      if [ -n "$id" ]; then
        local existing; existing="$(printf '%s' "$PROXY_HOSTS" | jsonq find . id "$id" certificate_id)"
        [ -n "$existing" ] && [ "$existing" != 0 ] && cert="$existing"
      fi ;;
  esac
  body="$(jsonq build domain_names:="[\"$host\"]" forward_scheme=http forward_host="$fhost" forward_port:="$fport" access_list_id:=0 certificate_id:="$cert" ssl_forced:="$ssl" http2_support:="$http2" caching_enabled:=false block_exploits:=false allow_websocket_upgrade:=true hsts_enabled:=false hsts_subdomains:=false meta:="$meta" advanced_config="$adv" locations:='[]')"
  if [ -z "$id" ]; then
    api POST "$NPM/nginx/proxy-hosts" "$body"
    api_ok || die "create proxy host $host: HTTP $API_CODE $API_BODY"
    ok "route $host -> $fhost:$fport created"
  else
    api PUT "$NPM/nginx/proxy-hosts/$id" "$body"
    api_ok || die "reconcile proxy host $host: HTTP $API_CODE $API_BODY"
    ok "route $host -> $fhost:$fport reconciled"
  fi
  record "proxy:host:$host"
}
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

REPO=deploy-requests
api GET "$GT/repos/$GITEA_ORGANIZATION/$REPO"
if [ "$API_CODE" = 404 ]; then
  api POST "$GT/orgs/$GITEA_ORGANIZATION/repos" "$(jsonq build name="$REPO" description="GitOps deploy requests (templates/gitops-request)" private:=true auto_init:=true default_branch=main)"
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
