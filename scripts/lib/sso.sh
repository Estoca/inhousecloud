# Authentik and proxy helpers shared by first-run.sh (platform routes) and
# ihc-app.sh (one route per app). bash 3.2 compatible. Sourced, never executed.
#
# The caller sources common.sh first, sets AK (Authentik API base) and NPM (proxy
# admin API base), and may define record() to collect the resources it touches.
# Authentik calls use the curl config of the last `api_init`, so call `api_init ak ...`
# before an Authentik block and `npm_login` before a proxy block.

type record >/dev/null 2>&1 || record() { :; }

# ---------------------------------------------------------------- Authentik
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

flow_pk() { # SLUG
  local pk; pk="$(ak_list_find "flows/instances/?slug=$(urlenc "$1")" slug "$1" pk)"
  [ -n "$pk" ] || die "Authentik flow not found: $1"
  printf '%s' "$pk"
}

# ensure_proxy_provider NAME EXTERNAL_URL SKIP_PATH_REGEX -> pk
# Proxy provider in forward auth (single application) mode: probe by name, then create
# or reconcile. The two default flows are resolved on the first call.
ensure_proxy_provider() {
  local name="$1" url="$2" skip="$3" body pk
  [ -n "${AUTHZ_FLOW:-}" ] || AUTHZ_FLOW="$(flow_pk default-provider-authorization-implicit-consent)"
  [ -n "${INVAL_FLOW:-}" ] || INVAL_FLOW="$(flow_pk default-provider-invalidation-flow)"
  body="$(jsonq build name="$name" authorization_flow="$AUTHZ_FLOW" invalidation_flow="$INVAL_FLOW" mode=forward_single external_host="$url" skip_path_regex="$skip" internal_host_ssl_validation:=false)"
  pk="$(ak_list_find "providers/proxy/?name=$(urlenc "$name")" name "$name" pk)"
  if [ -z "$pk" ]; then
    api POST "$AK/providers/proxy/" "$body"
    api_ok || die "create proxy provider $name: HTTP $API_CODE $API_BODY"
    pk="$(printf '%s' "$API_BODY" | jsonq get pk)"; ok "proxy provider $name created ($url)"
  else
    api PATCH "$AK/providers/proxy/$pk/" "$body"
    api_ok || die "reconcile proxy provider $name: HTTP $API_CODE $API_BODY"
    ok "proxy provider $name reconciled"
  fi
  record "authentik:provider:proxy:$pk"
  printf '%s' "$pk"
}

ensure_application() { # SLUG NAME PROVIDER_PK LAUNCH_URL -> pk
  local body
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

# outpost_serve PROVIDER_PK -> outpost pk. Adds the provider to the embedded outpost and
# points browsers at the public Authentik URL. Never removes a provider.
outpost_serve() {
  local patch pk
  api GET "$AK/outposts/instances/?managed__iexact=$(urlenc goauthentik.io/outposts/embedded)"
  api_ok || die "list outposts: HTTP $API_CODE"
  pk="$(printf '%s' "$API_BODY" | jsonq get results.0.pk)"
  [ -n "$pk" ] || die "embedded outpost not found"
  patch="$(printf '%s' "$API_BODY" | $PY -c '
import json,sys
o=json.load(sys.stdin)["results"][0]
prov=o.get("providers") or []
pk=int(sys.argv[1])
if pk not in prov: prov.append(pk)
cfg=o.get("config") or {}
cfg["authentik_host"]=sys.argv[2]
cfg["authentik_host_insecure"]=sys.argv[2].startswith("http://")
print(json.dumps({"providers":prov,"config":cfg}))' "$1" "$AUTHENTIK_BASE_URL")"
  api PATCH "$AK/outposts/instances/$pk/" "$patch"
  api_ok || die "update embedded outpost: HTTP $API_CODE $API_BODY"
  record "authentik:outpost:$pk"
  printf '%s' "$pk"
}

ensure_binding() { # APP_PK GROUP_PK LABEL
  api GET "$AK/policies/bindings/?target=$1"
  api_ok || die "list bindings: HTTP $API_CODE"
  if [ -n "$(printf '%s' "$API_BODY" | jsonq find results group "$2" pk)" ]; then ok "binding $3 exists"; return; fi
  api POST "$AK/policies/bindings/" "$(jsonq build target="$1" group="$2" order:=0 enabled:=true)"
  api_ok || die "create binding $3: HTTP $API_CODE $API_BODY"
  ok "binding $3 created"
}

# -------------------------------------------------------------------- Proxy
# npm_login: signs in to the proxy admin API and loads the current hosts into PROXY_HOSTS.
npm_login() {
  local tok
  api_init npm-login ""
  api POST "$NPM/tokens" "$(jsonq build identity="$PROXY_ADMIN_EMAIL" secret="$PROXY_ADMIN_PASSWORD")"
  api_ok || die "proxy admin login failed (HTTP $API_CODE). PROXY_ADMIN_EMAIL/PROXY_ADMIN_PASSWORD in .env must match the admin created on the proxy's first start."
  tok="$(printf '%s' "$API_BODY" | jsonq get token)"
  api_init npm "Authorization: Bearer $tok"
  # The same header without the JSON content type, for the certificate upload.
  NPM_UPLOAD_CFG="$API_TMPDIR/npm-upload.cfg"
  (umask 077; grep -v 'Content-Type' "$API_CFG" > "$NPM_UPLOAD_CFG")
  api GET "$NPM/nginx/proxy-hosts"
  api_ok || die "list proxy hosts: HTTP $API_CODE"
  PROXY_HOSTS="$API_BODY"
}

# ensure_internal_certificate CERT KEY: the cloud wildcard certificate (scripts/lib/tls.sh)
# as a custom certificate on the proxy, nice name "ihc internal wildcard". Uploaded on
# every run, so a renewed file reaches nginx; the hosts are reconciled after it. Prints the
# certificate id. The key goes up as a multipart file, never on a command line.
ensure_internal_certificate() {
  local name="ihc internal wildcard" id out code
  api GET "$NPM/nginx/certificates"
  api_ok || die "list proxy certificates: HTTP $API_CODE"
  id="$(printf '%s' "$API_BODY" | jsonq find . nice_name "$name" id)"
  if [ -z "$id" ]; then
    api POST "$NPM/nginx/certificates" "$(jsonq build provider=other nice_name="$name")"
    api_ok || die "create proxy certificate: HTTP $API_CODE $API_BODY"
    id="$(printf '%s' "$API_BODY" | jsonq get id)"; ok "proxy certificate '$name' created (id $id)"
  fi
  out="$(curl -K "$NPM_UPLOAD_CFG" -X POST -F "certificate=@$1" -F "certificate_key=@$2" -w '\n%{http_code}' "$NPM/nginx/certificates/$id/upload" 2>/dev/null || true)"
  code="${out##*$'\n'}"
  case "$code" in 2*) ok "wildcard certificate uploaded to the proxy (certificate $id)" ;; *) die "upload of the wildcard certificate: HTTP $code $(printf '%s' "${out%$'\n'*}" | head -c 300)" ;; esac
  record "proxy:certificate:$id"
  printf '%s' "$id"
}

# proxy_host_field HOST FIELD: a field of the existing proxy host for HOST, empty if none.
proxy_host_field() {
  printf '%s' "$PROXY_HOSTS" | $PY -c '
import json,sys
for h in json.load(sys.stdin):
    if sys.argv[1] in (h.get("domain_names") or []):
        v=h.get(sys.argv[2]); print("" if v is None else v); break' "$1" "$2"
}

FORWARD_AUTH_TEMPLATE='# InHouseCloud: forward auth through the Authentik embedded outpost.
proxy_buffers 8 16k;
proxy_buffer_size 32k;
set $authentik_upstream http://authentik-server:9000;

# Health stays public so the installer and monitors can probe it.
location = @HEALTH_PATH@ {
    proxy_pass $forward_scheme://$server:$port$request_uri;
    proxy_set_header Host $host;
}
@END_HEALTH@
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

# forward_auth_conf HEALTH_PATH: the advanced config of a protected host, with
# HEALTH_PATH (one exact path, e.g. /health) left public. An empty HEALTH_PATH leaves
# nothing public (the ops tools).
forward_auth_conf() {
  local tpl="$FORWARD_AUTH_TEMPLATE"
  if [ -z "$1" ]; then
    printf '%s' "$tpl" | awk '/^# Health stays public/{skip=1} !skip{print} /^@END_HEALTH@/{skip=0}'
  else
    tpl="${tpl/@HEALTH_PATH@/$1}"
    printf '%s' "${tpl/@END_HEALTH@
/}"
  fi
}

# ensure_admin_tool SLUG NAME HOST GROUP_PK: the Authentik side of an ops tool. Proxy
# provider (forward auth, nothing public), application bound to GROUP_PK only, and the
# embedded outpost serving it. The caller adds the proxy host with forward_auth_conf "".
ensure_admin_tool() {
  local slug="$1" name="$2" host="$3" gpk="$4" url prov app
  url="https://$host"; [ "${TLS_MODE:-off}" = off ] && url="http://$host"
  prov="$(ensure_proxy_provider "$slug" "$url" "")"
  app="$(ensure_application "$slug" "$name" "$prov" "$url")"
  outpost_serve "$prov" >/dev/null
  ensure_admin_binding "$app" "$gpk" "$slug"
}

# ensure_admin_binding APP_PK GROUP_PK LABEL: the application's only binding is GROUP_PK;
# bindings to any other group (e.g. ihc-users from an older install) are removed.
ensure_admin_binding() {
  local pk
  api GET "$AK/policies/bindings/?target=$1"
  api_ok || die "list bindings: HTTP $API_CODE"
  for pk in $(printf '%s' "$API_BODY" | $PY -c 'import json,sys
for b in json.load(sys.stdin).get("results",[]):
    if b.get("group") and b["group"]!=sys.argv[1]: print(b["pk"])' "$2"); do
    api DELETE "$AK/policies/bindings/$pk/"
    api_ok || die "remove binding $pk from $3: HTTP $API_CODE"
    ok "binding of $3 to another group removed"
  done
  ensure_binding "$1" "$2" "$3 <- admins only"
}

ensure_proxy_host() { # HOST FORWARD_HOST FORWARD_PORT ADVANCED_CONFIG
  local host="$1" fhost="$2" fport="$3" adv="$4" id cert="0" ssl=false http2=false meta body existing
  id="$(proxy_host_field "$host" id)"
  meta='{"letsencrypt_agree":false,"dns_challenge":false}'
  case "$TLS_MODE" in
    internal)
      # The cloud wildcard certificate (ensure_internal_certificate), HTTPS forced.
      case "${PROXY_CERTIFICATE_ID:-0}" in ""|0) die "tls internal: no certificate on the proxy yet (PROXY_CERTIFICATE_ID in .env); run scripts/first-run.sh" ;; esac
      ssl=true; http2=true; cert="$PROXY_CERTIFICATE_ID" ;;
    acme)
      ssl=true; http2=true; cert='"new"'
      meta="$(jsonq build letsencrypt_email="$PROXY_ADMIN_EMAIL" letsencrypt_agree:=true dns_challenge:=false)"
      if [ -n "$id" ]; then
        existing="$(proxy_host_field "$host" certificate_id)"
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
