#!/usr/bin/env bash
# First access, automated (docs/install-design.md "First Access", docs/first-run.md).
# Stage 14 and 15 of the install sequence; install.sh calls it, and it can be re-run alone:
#
#   scripts/first-run.sh --install-dir DIR [--json]
#
# Repeatable: every action probes before it creates and reconciles what exists.
#   1. Authentik: groups, OIDC provider + application for Gitea, proxy provider +
#      application for the portal (bound to ihc-admins and ihc-users), embedded
#      outpost, group policy bindings; the read-only service account ihc-portal, whose
#      API token goes to AUTHENTIK_PORTAL_TOKEN in .env (the portal's people page);
#      the user AUTHENTIK_SMOKE_USER (ihc-users only, password in .env), so smoke
#      tests 18 and 24 can prove what a non-admin is denied.
#   2. Proxy: hosts for auth, git and portal (portal with forward auth), plus the
#      optional profiles' hosts. The ops tools (Portainer, Glances, the web terminal,
#      the file browser) each get a proxy provider and application bound to the admin
#      group only, and a proxy host with forward auth and no public path.
#   3. Gitea: admin, API tokens, organization, ihc-smoke repository, OIDC source.
#   4. The portal's read-only API token IHC_PORTAL_API_TOKEN (docs/portal-api.md), once.
# Talks to the services on their loopback control ports; tokens travel in curl config
# files and on stdin, never on a command line, and nothing secret is printed.
set -eu
IHC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$IHC_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${IHC_INSTALL_DIR:-/opt/inhousecloud}"
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
. "$IHC_ROOT/scripts/lib/sso.sh"
# shellcheck source=lib/portal-api.sh
. "$IHC_ROOT/scripts/lib/portal-api.sh"

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
  api POST "$AK/crypto/certificatekeypairs/generate/" "$(jsonq build common_name="InHouseCloud OIDC signing" subject_alt_name="" validity_days:=3650)"
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
# ihc-users sign in to the portal too: catalog, health and deploys; the portal itself keeps
# the platform status and the people list for admins (docs/security.md).
ensure_binding "$PORTAL_APP_PK" "$APP_GROUP_PK" "portal <- $AUTHENTIK_APP_GROUP"
ensure_binding "$GITEA_APP_PK" "$APP_GROUP_PK" "gitea <- $AUTHENTIK_APP_GROUP"

# Ops tools: admins only (docs/security.md). Created with the ops profile; the terminal's
# only when the installer found an sshd for it.
OPS=false; case ",$COMPOSE_PROFILES," in *,ops,*) OPS=true ;; esac
OPS_TOOLS=""
if [ "$OPS" = true ]; then
  OPS_TOOLS="ops-portainer:Portainer:portainer:portainer:9000 ops-glances:Glances:glances:glances:61208 ops-files:Files:files:filebrowser:80"
  [ "${OPS_TERMINAL:-false}" = true ] && OPS_TOOLS="$OPS_TOOLS ops-terminal:Terminal:terminal:wetty:3000"
  for t in $OPS_TOOLS; do
    IFS=: read -r slug name sub _ _ <<TOOL
$t
TOOL
    ensure_admin_tool "$slug" "$name" "$sub.$BASE_DOMAIN" "$PORTAL_GROUP_PK"
  done
fi

# The smoke user: ihc-users only, in every install (tests 18 and 24). Its password exists
# only in .env (0600).
# The portal knows a person by the email the outpost sends: the smoke user needs one. The
# .invalid domain (RFC 2606) never receives mail.
SMOKE_EMAIL="$AUTHENTIK_SMOKE_USER@smoke.invalid"
[ -n "${AUTHENTIK_SMOKE_USER_PASSWORD:-}" ] || die "AUTHENTIK_SMOKE_USER_PASSWORD is empty in .env: run install.sh --apply --from secrets"
SMOKE_PK="$(ak_list_find "core/users/?username=$(urlenc "$AUTHENTIK_SMOKE_USER")" username "$AUTHENTIK_SMOKE_USER" pk)"
if [ -z "$SMOKE_PK" ]; then
  api POST "$AK/core/users/" "$(jsonq build username="$AUTHENTIK_SMOKE_USER" name="Smoke test user (not an admin)" email="$SMOKE_EMAIL" is_active:=true path=ihc/smoke)"
  api_ok || die "create user $AUTHENTIK_SMOKE_USER: HTTP $API_CODE $API_BODY"
  SMOKE_PK="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "user $AUTHENTIK_SMOKE_USER created"
else
  api PATCH "$AK/core/users/$SMOKE_PK/" "$(jsonq build email="$SMOKE_EMAIL")"
  api_ok || die "reconcile user $AUTHENTIK_SMOKE_USER: HTTP $API_CODE $API_BODY"
  ok "user $AUTHENTIK_SMOKE_USER exists"
fi
api POST "$AK/core/users/$SMOKE_PK/set_password/" "$(jsonq build password="$AUTHENTIK_SMOKE_USER_PASSWORD")"
api_ok || die "set the password of $AUTHENTIK_SMOKE_USER: HTTP $API_CODE"
api POST "$AK/core/groups/$APP_GROUP_PK/add_user/" "$(jsonq build pk:="$SMOKE_PK")"
api_ok || die "add $AUTHENTIK_SMOKE_USER to $AUTHENTIK_APP_GROUP: HTTP $API_CODE"
api POST "$AK/core/groups/$PORTAL_GROUP_PK/remove_user/" "$(jsonq build pk:="$SMOKE_PK")"
ok "$AUTHENTIK_SMOKE_USER in $AUTHENTIK_APP_GROUP only (password from .env)"
record "authentik:user:$AUTHENTIK_SMOKE_USER"

# The portal's read-only service account (scripts/lib/sso.sh, docs/security.md).
ensure_portal_reader

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
# TLS internal: the wildcard certificate from <install-dir>/local/ca goes up first; every
# host below is created with it and HTTPS forced.
if [ "$TLS_MODE" = internal ]; then
  [ -s "$INSTALL_DIR/local/ca/wildcard.crt" ] || die "tls internal: $INSTALL_DIR/local/ca/wildcard.crt missing; run install.sh --apply --from foundation"
  PROXY_CERTIFICATE_ID="$(ensure_internal_certificate "$INSTALL_DIR/local/ca/wildcard.crt" "$INSTALL_DIR/local/ca/wildcard.key")"
  [ "$(env_get PROXY_CERTIFICATE_ID)" = "$PROXY_CERTIFICATE_ID" ] || env_set PROXY_CERTIFICATE_ID "$PROXY_CERTIFICATE_ID"
fi

ensure_proxy_host "$AUTHENTIK_HOST" authentik-server 9000 ""
ensure_proxy_host "$GITEA_HOST" gitea 3000 ""
# The portal: forward auth, /health public, and the status API rule (lib/portal-api.sh).
ensure_proxy_host "$PORTAL_HOST" portal 8080 "$(portal_forward_auth_conf)"
case ",$COMPOSE_PROFILES," in
  # The S3 API: requests are signed per app key, so no forward auth (it would break every
  # client). Garage has no console; its admin API is never routed.
  *,storage,*) ensure_proxy_host "s3.$BASE_DOMAIN" garage 3900 "" ;;
esac
# Ops tools: forward auth with nothing public; Portainer keeps its own login behind it.
for t in $OPS_TOOLS; do
  IFS=: read -r _ _ sub fhost fport <<TOOL
$t
TOOL
  ensure_proxy_host "$sub.$BASE_DOMAIN" "$fhost" "$fport" "$(forward_auth_conf "")"
done

# Give nginx a moment to reload, then check the routes from the box itself.
t0=$(date +%s)
while :; do
  c_auth="$(http_code "$(proxy_url "$AUTHENTIK_HOST" /-/health/live/)" $(proxy_args "$AUTHENTIK_HOST"))"
  c_git="$(http_code "$(proxy_url "$GITEA_HOST" /api/healthz)" $(proxy_args "$GITEA_HOST"))"
  c_health="$(http_code "$(proxy_url "$PORTAL_HOST" /health)" $(proxy_args "$PORTAL_HOST"))"
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
  TOKEN="$(gitea_cli admin user generate-access-token --username "$GITEA_ADMIN_USERNAME" --token-name "ihc-install-$(date +%s)" --scopes all --raw | tr -d '[:space:]')"
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
REPO=ihc-smoke
api GET "$GT/repos/$GITEA_ORGANIZATION/$REPO"
if [ "$API_CODE" = 404 ]; then
  api POST "$GT/orgs/$GITEA_ORGANIZATION/repos" "$(jsonq build name="$REPO" description="Target of the cloud smoke tests (authenticated clone)" private:=true auto_init:=true default_branch=main)"
  api_ok || die "create repository: HTTP $API_CODE $API_BODY"
  ok "repository $GITEA_ORGANIZATION/$REPO created"
else api_ok || die "probe repository: HTTP $API_CODE"; ok "repository $GITEA_ORGANIZATION/$REPO exists"; fi
record "gitea:repo:$GITEA_ORGANIZATION/$REPO"
SMOKE="$GITEA_BASE_URL/$GITEA_ORGANIZATION/$REPO.git"
[ "$(env_get GITEA_SMOKE_REPOSITORY)" = "$SMOKE" ] || env_set GITEA_SMOKE_REPOSITORY "$SMOKE"

RO="$(env_get GITEA_READONLY_TOKEN)"
if [ -z "$RO" ] || ! gitea_token_valid "$RO"; then
  RO="$(gitea_cli admin user generate-access-token --username "$GITEA_ADMIN_USERNAME" --token-name "ihc-readonly-$(date +%s)" --scopes read:misc,read:repository,read:organization,read:user --raw | tr -d '[:space:]')"
  [ -n "$RO" ] || die "could not generate the read-only token"
  env_set GITEA_READONLY_TOKEN "$RO"; ok "read-only API token generated into .env"
else ok "read-only API token valid"; fi
api_init gt "Authorization: token $TOKEN"

if [ "$GITEA_OIDC_ENABLED" = true ]; then
  # Gitea fetches the discovery document when the source is added, so the auth route
  # must already answer by its public name from inside the container. Probed with
  # busybox wget: curl resolves every *.localhost name to loopback by itself and would
  # never reach the proxy alias. With TLS internal, curl checks the certificate against
  # the cloud CA mounted at /etc/ihc-ca (Gitea itself trusts it through SSL_CERT_DIR).
  if [ "$TLS_MODE" = internal ]; then
    disc="$(docker exec -i "$GITEA_CID" curl -fsS --max-time 20 --cacert /etc/ihc-ca/ca.crt "$OIDC_DISCOVERY" 2>/dev/null | jsonq get issuer)"
  else
    disc="$(docker exec -i "$GITEA_CID" wget -qO- -T 20 "$OIDC_DISCOVERY" 2>/dev/null | jsonq get issuer)"
  fi
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

# ========================================================= Portal API token
# IHC_PORTAL_API_TOKEN: the read-only bearer for GET /api/platform/status (docs/portal-api.md).
# Generated once into .env, never printed; install.sh recreates the portal after this
# script, so the container gets it. Its fingerprint goes to state.json.
step "Portal API token"
if [ -z "$(env_get IHC_PORTAL_API_TOKEN)" ]; then
  env_set IHC_PORTAL_API_TOKEN "$(random_secret 48)"; ok "portal API token generated into .env"
else ok "portal API token present"; fi
PORTAL_API_FP="$(sha_fp "$(env_get IHC_PORTAL_API_TOKEN)")"

# ============================================================ Protected route
step "Protected route"
t0=$(date +%s)
while :; do
  loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 $(proxy_args "$PORTAL_HOST") "$(proxy_url "$PORTAL_HOST" /)" 2>/dev/null || echo 000)"
  case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) break ;; esac
  [ $(( $(date +%s) - t0 )) -ge 90 ] && die "portal route is not protected: got '$loc' (wanted 302 to the outpost)"
  sleep 3
done
ok "portal route redirects anonymous requests to the outpost"
[ "$HAVE_STATE" = true ] && state stage first_run set probe "$(jsonq build gitea_oidc_source="$GITEA_OIDC_SOURCE_NAME" callback="$GITEA_CALLBACK" discovery="$OIDC_DISCOVERY" portal_protected:=true first_login=pending portal_api_token_env=IHC_PORTAL_API_TOKEN portal_api_token_fingerprint="$PORTAL_API_FP")"
ok "first-run complete"
