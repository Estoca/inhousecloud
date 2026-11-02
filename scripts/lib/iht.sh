# Optional inhouse.technology source. bash 3.2; common.sh must be sourced first.
# Called by secrets AND foundation (upgrades can start at foundation).
iht_configure() {
  local client issuer secret_var supplied saved
  client="${CFG_authentik__iht__client_id:-}"
  if [ -z "$client" ]; then
    [ "$(env_get IHT_ENABLED)" != true ] || die "iht already enabled: keep authentik.iht configured; see docs/install.md for migration"
    return 0
  fi
  issuer="${CFG_authentik__iht__issuer:-https://inhouse.technology}"
  issuer="${issuer%/}"
  printf '%s\n%s' "$client" "$issuer" | $PY -c 'import sys
v=sys.stdin.read()
sys.exit(0 if v.count("\n")==1 and all(c=="\n" or (32 <= ord(c) < 127 and c not in "\"\\$`") for c in v) else 1)' || die "iht client id or issuer contains characters unsupported by the shared .env format"
  printf '%s' "$issuer" | $PY -c 'import sys,urllib.parse
u=urllib.parse.urlsplit(sys.stdin.read())
local=u.hostname in ("localhost", "127.0.0.1", "::1") or (u.hostname or "").endswith(".localhost")
sys.exit(0 if (u.scheme=="https" or (u.scheme=="http" and local)) and u.hostname and u.username is None and u.password is None and not u.query and not u.fragment else 1)' || die "authentik.iht.issuer must be HTTPS (HTTP only on localhost), without credentials, query or fragment"
  secret_var="${CFG_authentik__iht__client_secret_env:-IHC_IHT_CLIENT_SECRET}"
  printf '%s' "$secret_var" | $PY -c 'import re,sys;sys.exit(0 if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",sys.stdin.read()) else 1)' || die "authentik.iht.client_secret_env must name an environment variable"
  eval "supplied=\${$secret_var:-}"
  saved="$(env_get IHT_CLIENT_SECRET)"
  if [ -z "$saved" ] && [ -z "$supplied" ]; then
    if [ "${NON_INTERACTIVE:-false}" != true ] && [ -t 0 ]; then
      printf 'iht client secret (hidden, from the single-use link): ' >&2
      IFS= read -r -s supplied; printf '\n' >&2
    fi
    [ -n "$supplied" ] || die "iht client id requires a secret: set the variable named by authentik.iht.client_secret_env"
  fi
  # envfile is also sourced by bash; refuse interpolation in an external secret.
  printf '%s' "${saved:-$supplied}" | $PY -c 'import sys
v=sys.stdin.read()
sys.exit(0 if v and all(32 <= ord(c) < 127 and c not in "\"\\$`" for c in v) else 1)' || die "iht secret contains characters unsupported by the shared .env format"
  if [ -n "$(env_get IHT_CLIENT_ID)" ] && [ "$(env_get IHT_CLIENT_ID)" != "$client" ]; then
    die "iht client id changed: migrate the source explicitly before changing identity configuration"
  fi
  if [ -n "$(env_get IHT_ISSUER)" ] && [ "$(env_get IHT_ISSUER)" != "$issuer" ]; then
    die "iht issuer changed: migrate the source explicitly before changing identity configuration"
  fi
  # Use the normal secret mechanism, but never its random-generation branch.
  IHC_IHT_SUPPLIED_SECRET="$supplied"
  env_secret IHT_CLIENT_SECRET IHC_IHT_SUPPLIED_SECRET 0
  unset IHC_IHT_SUPPLIED_SECRET
  env_set IHT_CLIENT_ID "$client"
  env_set IHT_ISSUER "$issuer"
  env_set IHT_DISCOVERY_URL "$issuer/.well-known/openid-configuration"
  env_set IHT_ENABLED true
}

render_iht_blueprint() {
  mkdir -p "$INSTALL_DIR/authentik/blueprints"
  chmod 755 "$INSTALL_DIR/authentik" "$INSTALL_DIR/authentik/blueprints"
  [ "$(env_get IHT_ENABLED)" = true ] || return 0
  cp "$IHC_ROOT/docker/authentik/iht.yaml" "$INSTALL_DIR/authentik/blueprints/iht.yaml"
  chmod 644 "$INSTALL_DIR/authentik/blueprints/iht.yaml"
}

# The worker imports asynchronously. Keep local login until the source, recovery
# and built-in default flow exist. Reconcile here too for existing installations;
# the mounted blueprint keeps the same settings on subsequent worker imports.
# Never echo API bodies, which may contain the source's credentials.
ensure_iht_login() {
  [ "${IHT_ENABLED:-false}" = true ] || return 0
  [ -n "${IHT_CLIENT_ID:-}" ] && [ -n "${IHT_CLIENT_SECRET:-}" ] || die "iht enabled without client credentials"
  local source recovery default_flow stage started
  started=$(date +%s)
  while :; do
    source="$(ak_list_find 'sources/oauth/?slug=inhouse-technology' slug inhouse-technology pk)"
    recovery="$(ak_list_find 'flows/instances/?slug=ihc-local-recovery' slug ihc-local-recovery pk)"
    default_flow="$(ak_list_find 'flows/instances/?slug=default-authentication-flow' slug default-authentication-flow pk)"
    [ -n "$source" ] && [ -n "$recovery" ] && [ -n "$default_flow" ] && break
    [ $(( $(date +%s) - started )) -ge 120 ] && die "iht blueprint not ready in 120s: check authentik-worker blueprint status; local login was kept"
    sleep 2
  done
  api GET "$AK/sources/oauth/inhouse-technology/"
  api_ok || die "read iht source: HTTP $API_CODE"
  [ "$(printf '%s' "$API_BODY" | jsonq get user_matching_mode)" = identifier ] || die "iht source must use identifier matching; local login was kept"
  stage="$(ak_list_find 'stages/identification/?name=default-authentication-identification' name default-authentication-identification pk)"
  [ -n "$stage" ] || die "default authentication identification stage not found; local login was kept"
  api PATCH "$AK/stages/identification/$stage/" "$(jsonq build user_fields:='[]' sources:="[\"$source\"]" show_source_labels:=true password_stage:=null enrollment_flow:=null recovery_flow:=null)"
  api_ok || die "reconcile iht login stage: HTTP $API_CODE"
  api GET "$AK/stages/identification/$stage/"
  api_ok || die "verify iht login stage: HTTP $API_CODE"
  printf '%s' "$API_BODY" | $PY -c 'import json,sys
s=json.load(sys.stdin)
sys.exit(0 if s.get("user_fields") == [] and s.get("sources") == [sys.argv[1]]
         and all(s.get(k, "missing") is None for k in ("password_stage", "enrollment_flow", "recovery_flow")) else 1)' "$source" \
    || die "iht login must redirect to its sole source without local fields or recovery links"
  ok "login redirects straight to inhouse.technology; akadmin recovery: /if/flow/ihc-local-recovery/"
}

# Runs only after apply approval and before any Authentik stage, including resumes.
iht_claim() {
  [ -n "${IHT_CLAIM:-}" ] || return 0
  local issuer endpoint
  issuer="${IHT_CLAIM_ISSUER:-${CFG_authentik__iht__issuer:-https://inhouse.technology}}"
  issuer="${issuer%/}"
  endpoint="${CFG_authentik__iht__claim_url:-$issuer/oidc/clients/claim}"
  if ! printf '%s' "$IHT_CLAIM" | $PY "$IHC_LIB/iht-claim.py" "$CONFIG_FILE" "$ENV_FILE" "$issuer" "$endpoint"; then
    unset IHT_CLAIM
    return 1
  fi
  unset IHT_CLAIM
  eval "$($PY "$IHC_LIB/config.py" "$CONFIG_FILE" flatten)"
  CONFIG_SHA="$($PY "$IHC_LIB/config.py" "$CONFIG_FILE" sha)"
  SOURCE_CONFIG="$CONFIG_FILE"
  ok "iht credentials claimed and saved privately; local recovery remains available"
}
