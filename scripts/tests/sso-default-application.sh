#!/usr/bin/env bash
# Offline, bash 3.2: run the installer's first_run stage with its real Authentik
# setup through the default brand reconciliation, replacing only the API transport.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = --authentik-stage ]; then
  WORK="$2"
  . "$ROOT/scripts/lib/common.sh"
  . "$ROOT/scripts/lib/sso.sh"
  . "$ROOT/scripts/lib/iht.sh"
  STATE_FILE="$WORK/state.json"
  record() { state stage first_run set resources "[\"$1\"]"; }
  AK=http://offline/api/v3
  AUTHENTIK_PORTAL_GROUP=ihc-admins; AUTHENTIK_APP_GROUP=ihc-users
  AUTHENTIK_BOOTSTRAP_TOKEN=offline-bootstrap-do-not-print
  AUTHENTIK_BASE_URL=https://auth.example.test
  PORTAL_BASE_URL=https://portal.example.test
  GITEA_BASE_URL=https://git.example.test
  GITEA_CALLBACK="$GITEA_BASE_URL/user/oauth2/authentik/callback"
  GITEA_OIDC_CLIENT_ID=gitea; GITEA_OIDC_CLIENT_SECRET=offline-oidc-do-not-print
  IHT_ENABLED=false
  api_init() { :; }
  api() {
    API_CODE=200; API_BODY='{}'
    printf '%s %s\n' "$1" "${2#"$AK"}" >> "$WORK/calls"
    case "$1:${2#"$AK"}" in
      GET:/core/users/me/) API_BODY='{"user":{"username":"akadmin"}}' ;;
      GET:/core/groups/\?name=*) API_BODY="{\"results\":[{\"name\":\"${2##*=}\",\"pk\":\"group-uuid\"}]}" ;;
      GET:/flows/instances/\?slug=*) API_BODY="{\"results\":[{\"slug\":\"${2##*=}\",\"pk\":\"flow-uuid\"}]}" ;;
      GET:/crypto/certificatekeypairs/\?*) API_BODY='{"results":[{"name":"authentik Self-signed Certificate","pk":"key-uuid"}]}' ;;
      GET:/propertymappings/provider/scope/\?*) API_BODY="{\"results\":[{\"managed\":\"goauthentik.io/providers/oauth2/${2##*%2F}\",\"pk\":\"scope-uuid\"}]}" ;;
      GET:/providers/oauth2/\?*) API_BODY='{"results":[{"name":"gitea","pk":10}]}' ;;
      PATCH:/providers/oauth2/10/) : ;;
      GET:/providers/proxy/\?*) API_BODY='{"results":[{"name":"portal","pk":20}]}' ;;
      PATCH:/providers/proxy/20/) : ;;
      GET:/core/applications/gitea/|PATCH:/core/applications/gitea/) API_BODY='{"pk":"22222222-2222-4222-8222-222222222222"}' ;;
      GET:/core/applications/portal/)
        if [ "${FRESH:-false}" = true ] && [ ! -e "$WORK/application-created" ]; then
          API_CODE=404
        else API_BODY="{\"pk\":\"$PORTAL_UUID\"}"; fi ;;
      POST:/core/applications/|PATCH:/core/applications/portal/)
        printf '%s\n' "$3" > "$WORK/application-body"
        touch "$WORK/application-created"
        API_BODY="{\"pk\":\"$PORTAL_UUID\"}" ;;
      GET:/core/brands/\?default=true)
        API_BODY="{\"results\":[{\"default\":false,\"brand_uuid\":\"custom-brand\"},$(cat "$WORK/brand.json")]}"
        case "${FAULT:-}" in
          list) API_CODE=503; API_BODY="$AUTHENTIK_BOOTSTRAP_TOKEN" ;;
          missing) API_BODY='{"results":[]}' ;;
        esac ;;
      PATCH:/core/brands/33333333-3333-4333-8333-333333333333/)
        printf '%s\n' "$3" >> "$WORK/patches"
        if [ "${FAULT:-}" = patch ]; then
          API_CODE=403; API_BODY="$AUTHENTIK_BOOTSTRAP_TOKEN"
        elif [ "${FAULT:-}" != drift ]; then
          $PY - "$WORK/brand.json" "$3" <<'PY'
import json, sys
path, patch = sys.argv[1:]
with open(path) as f:
    brand = json.load(f)
brand.update(json.loads(patch))
with open(path, 'w') as f:
    json.dump(brand, f)
PY
        fi ;;
      GET:/core/brands/33333333-3333-4333-8333-333333333333/)
        API_BODY="$(cat "$WORK/brand.json")"
        if [ "${FAULT:-}" = verify ]; then API_CODE=503; API_BODY="$AUTHENTIK_BOOTSTRAP_TOKEN"; fi ;;
      *) echo "unexpected API call $1 $2" >&2; exit 1 ;;
    esac
  }
  . "$WORK/authentik-stage.sh"
  exit 0
fi

WORK="$ROOT/.ihc-agent/default-application-test-$$"
mkdir -p "$WORK/checkout/scripts"
trap 'rm -rf "$WORK"; rmdir "$ROOT/.ihc-agent" 2>/dev/null || true' EXIT
. "$ROOT/scripts/lib/common.sh"
export PORTAL_UUID=11111111-1111-4111-8111-111111111111
# Keep the real SSO setup and real installer stage/failure recording. Stop before
# the unrelated embedded outpost, proxy and Gitea setup (which need a live box).
awk '/^step "Authentik"$/ { copy=1 } /^# Embedded outpost:/ { exit } copy' \
  "$ROOT/scripts/first-run.sh" > "$WORK/authentik-stage.sh"
awk '/^stage_first_run\(\) \{/,/^}/; /^run_stage\(\) \{/,/^}/' \
  "$ROOT/install.sh" > "$WORK/install-fns.sh"
. "$WORK/install-fns.sh"
cat > "$WORK/checkout/scripts/first-run.sh" <<SH
#!/usr/bin/env bash
exec bash "$ROOT/scripts/tests/sso-default-application.sh" --authentik-stage "$WORK"
SH
chmod 755 "$WORK/checkout/scripts/first-run.sh"
IHC_ROOT="$WORK/checkout"
INSTALL_DIR="$WORK/install"; STATE_FILE="$WORK/state.json"
CONFIG_SHA=offline-config; RESUME_PREFIX='install.sh --apply'; DRY_RUN=false
dc() { printf '%s\n' "$*" >> "$WORK/containers"; }
wait_healthy() { :; }

reset_case() {
  rm -f "$WORK/state.json" "$WORK/patches" "$WORK/calls" "$WORK/containers" "$WORK/application-created"
  state init --install-dir "$INSTALL_DIR" --config-sha "$CONFIG_SHA" >/dev/null
  $PY - "$WORK/brand.json" "$1" <<'PY'
import json, sys
brand = dict(brand_uuid='33333333-3333-4333-8333-333333333333', default=True,
             domain='authentik-default', branding_title='Keep this', flow_authentication='keep-flow')
if sys.argv[2] != 'absent':
    brand['default_application'] = json.loads(sys.argv[2])
with open(sys.argv[1], 'w') as f:
    json.dump(brand, f)
PY
  export FAULT= FRESH=false
}
check_success() {
  rm -f "$WORK/containers"
  (run_stage first_run) > "$WORK/out" 2>&1 || { cat "$WORK/out"; return 1; }
  [ "$(state stage first_run status)" = completed ]
  $PY - "$WORK" "$PORTAL_UUID" <<'PY'
import json, pathlib, sys
work, uuid = pathlib.Path(sys.argv[1]), sys.argv[2]
brand = json.loads((work/'brand.json').read_text())
assert brand['default_application'] == uuid
assert brand['branding_title'] == 'Keep this' and brand['flow_authentication'] == 'keep-flow'
app = json.loads((work/'application-body').read_text())
assert app['meta_launch_url'] == 'https://portal.example.test'
assert app['provider'] == 20
assert 'authentik:brand:33333333-3333-4333-8333-333333333333' in (work/'state.json').read_text()
assert (work/'containers').read_text().strip() == 'up -d portal mcp'
for line in (work/'patches').read_text().splitlines() if (work/'patches').exists() else []:
    assert json.loads(line) == {'default_application': uuid}
PY
}

for initial in null absent '"44444444-4444-4444-8444-444444444444"'; do
  reset_case "$initial"
  check_success
  [ "$(wc -l < "$WORK/patches" | tr -d ' ')" = 1 ]
  # Resume the same stage on the same cloud: the brand is now correct, no PATCH.
  state reset-from first_run
  check_success
  [ "$(wc -l < "$WORK/patches" | tr -d ' ')" = 1 ]
  echo "[ok] default application $initial reconciled once, resume is a no-op"
done
reset_case "\"$PORTAL_UUID\""
check_success
[ ! -e "$WORK/patches" ]
echo '[ok] correct default application is kept without a PATCH'

reset_case null
export FRESH=true
check_success
echo '[ok] fresh portal application is created with PORTAL_BASE_URL before brand setup'

for fault in patch list missing verify drift; do
  reset_case null
  export FAULT="$fault"
  if (run_stage first_run) > "$WORK/out" 2>&1; then
    echo "[xx] $fault accepted"; exit 1
  fi
  [ "$(state stage first_run status)" = failed ]
  [ ! -e "$WORK/containers" ]
  case "$fault" in
    patch) message='set Authentik default brand application to portal: HTTP 403' ;;
    list) message='list Authentik default brand: HTTP 503' ;;
    missing) message='Authentik default brand not found' ;;
    verify) message='verify Authentik default brand application: HTTP 503' ;;
    drift) message='Authentik default brand did not retain default application portal' ;;
  esac
  grep -Fq "$message" "$WORK/out"
  grep -Fq 'stage first_run failed' "$WORK/out"
  grep -Fq -- '--from first_run' "$WORK/out"
  if grep -Eq 'offline-bootstrap-do-not-print|offline-oidc-do-not-print' "$WORK/out" "$WORK/state.json"; then
    echo '[xx] secret printed or recorded'; exit 1
  fi
  echo "[ok] $fault fails first_run with a clear message, resume command and no secret"
done
echo 'sso-default-application: all checks passed'
