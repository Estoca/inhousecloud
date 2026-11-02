#!/usr/bin/env bash
# Offline, bash 3.2: config/env handling, blueprint contract and stubbed API.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/.ihc-agent/iht-test-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
. "$ROOT/scripts/lib/common.sh"
. "$ROOT/scripts/lib/sso.sh"
. "$ROOT/scripts/lib/iht.sh"
awk '/^env_default\(\) \{/,/^}/; /^env_secret\(\) \{/,/^}/; /^detect_docker_socket_gid\(\)/,/^}/' "$ROOT/install.sh" > "$WORK/env-fns.sh"
. "$WORK/env-fns.sh"
INSTALL_DIR="$WORK/install"; mkdir -p "$INSTALL_DIR"
ENV_FILE="$INSTALL_DIR/.env"; NON_INTERACTIVE=true
check() { if "$@"; then echo "[ok] $*"; else echo "[xx] $*"; exit 1; fi; }

# No configuration: no secret, source or change to existing .env.
printf 'EXISTING="kept"\n' > "$ENV_FILE"
cp "$ENV_FILE" "$WORK/before"
IHC_IHT_CLIENT_SECRET=unused
iht_configure
check cmp -s "$ENV_FILE" "$WORK/before"
render_iht_blueprint
check test ! -e "$INSTALL_DIR/authentik/blueprints/iht.yaml"
api() { echo "unexpected API call" >&2; return 1; }
ensure_iht_login
# An issuer alone must not enable or alter login either.
(CFG_authentik__iht__issuer=https://inhouse.technology; iht_configure; render_iht_blueprint; ensure_iht_login)
check cmp -s "$ENV_FILE" "$WORK/before"
check test ! -e "$INSTALL_DIR/authentik/blueprints/iht.yaml"

# The real config parser, including a custom *_env name.
cat > "$WORK/config.yaml" <<'YAML'
authentik:
  iht:
    client_id: company-client
    client_secret_env: TEST_IHT_SECRET
YAML
eval "$($PY "$ROOT/scripts/lib/config.py" "$WORK/config.yaml" flatten)"
check test "$CFG_authentik__iht__client_id" = company-client
if (unset TEST_IHT_SECRET; iht_configure) >"$WORK/out" 2>&1; then
  echo '[xx] missing external secret accepted'; exit 1
fi
check cmp -s "$ENV_FILE" "$WORK/before"
TEST_IHT_SECRET='offline-test-private-value'
iht_configure >"$WORK/out" 2>&1
check test "$(env_get IHT_ENABLED)" = true
check test "$(env_get IHT_DISCOVERY_URL)" = https://inhouse.technology/.well-known/openid-configuration
test "$(env_get IHT_CLIENT_SECRET)" = "$TEST_IHT_SECRET"
echo "[ok] external secret saved without printing it"
if grep -Fq "$TEST_IHT_SECRET" "$WORK/out"; then echo '[xx] secret printed'; exit 1; fi
$PY - "$ENV_FILE" <<'PY'
import os, stat, sys
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY
unset TEST_IHT_SECRET
cp "$ENV_FILE" "$WORK/enabled"
iht_configure
check cmp -s "$ENV_FILE" "$WORK/enabled"
render_iht_blueprint
check cmp -s "$ROOT/docker/authentik/iht.yaml" "$INSTALL_DIR/authentik/blueprints/iht.yaml"
if grep -Fq offline-test-private-value "$INSTALL_DIR/authentik/blueprints/iht.yaml"; then exit 1; fi
if (CFG_authentik__iht__client_id=other; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
if (CFG_authentik__iht__issuer=https://other.example; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
if (CFG_authentik__iht__client_id=; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
check cmp -s "$ENV_FILE" "$WORK/enabled"
if (CFG_authentik__iht__client_secret_env='BAD;exit'; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
if (CFG_authentik__iht__issuer=http://inhouse.technology; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
if (ENV_FILE="$WORK/unsafe.env"; TEST_IHT_SECRET='unsafe$value'; iht_configure) >"$WORK/out" 2>&1; then exit 1; fi
check test ! -e "$WORK/unsafe.env"
if grep -Fq 'unsafe$value' "$WORK/out"; then echo '[xx] rejected secret printed'; exit 1; fi

# Expressions are Python inside YAML. Exercise them with real claim dictionaries,
# and inspect the model/flow references without requiring a YAML package.
$PY - "$ROOT" <<'PY'
from pathlib import Path
import os, re, sys
root = Path(sys.argv[1])
s = (root/'docker/authentik/iht.yaml').read_text()
assert 'user_matching_mode: identifier' in s
assert 'email_link' not in s
for key in ('IHT_DISCOVERY_URL', 'IHT_CLIENT_ID', 'IHT_CLIENT_SECRET'):
    assert '!Env ' + key in s
assert 'provider_type: openidconnect' in s
assert 'user_creation_mode: always_create' in s
assert 'authentication_flow: !KeyOf authentication' in s
assert 'default-source-authentication' not in s
assert 'slug: ihc-iht-authentication' in s
assert 'enrollment_flow: !KeyOf enrollment' in s
# Inspect each stage separately: a stray user_fields: [] elsewhere cannot make
# the default stage redirect. The blueprint must preserve first-run's settings.
entries = s.split('  - model: ')[1:]
def named(name):
    found = [e for e in entries if re.search(r'^      name: '+re.escape(name)+r'$', e, re.M)]
    assert len(found) == 1, name
    return found[0]
direct = named('default-authentication-identification')
assert direct.startswith('authentik_stages_identification.identificationstage\n')
assert re.search(r'^      user_fields: \[\]$', direct, re.M)
assert re.search(r'^      sources:\n        - !KeyOf iht\n(?=      \w)', direct, re.M)
for field in ('password_stage', 'enrollment_flow', 'recovery_flow'):
    assert re.search(r'^      '+field+r': null$', direct, re.M)
local = named('ihc-local-recovery-identification')
assert 'user_fields: [username]' in local and 'sources: []' in local
assert 'password_stage: !Find [authentik_stages_password.passwordstage, [name, default-authentication-password]]' in local
assert 'slug: ihc-local-recovery' in s
assert 'AUTHENTIK_IMAGE=ghcr.io/goauthentik/server:2026.8.4' in (root/'docker/.env.example').read_text()
ids = set(re.findall(r'^    id: (.+)$', s, re.M))
assert set(re.findall(r'!KeyOf ([\w-]+)', s)) <= ids
expressions = re.findall(r'      expression: \|\n((?:        .*\n|\n)+)', s)
assert len(expressions) == 3
def expression(text, **env):
    properties = env.setdefault('properties', {'groups': ['admin', 'member', 'unknown']})
    code = 'def evaluate():\n' + '\n'.join('    '+l[8:] for l in text.splitlines())
    exec(code, env)
    value = env['evaluate']()
    if isinstance(value, dict):
        # Authentik merges list values with the base properties, rather than
        # replacing them. Raw upstream roles must have been cleared first.
        assert properties['groups'] == []
    return value
os.environ.update(IHT_ADMIN_GROUP='custom-admins', IHT_USER_GROUP='custom-users')
info = dict(sub='person-123', email='same@example.com', name='Person', groups=['member'])
mapped = expression(expressions[0], info=info)
assert mapped == dict(username='iht-person-123', email=info['email'], name='Person', groups=['custom-users'])
assert expression(expressions[0], info=dict(info, groups=['admin']))['groups'] == ['custom-admins','custom-users']
assert expression(expressions[0], info=dict(info, groups=['custom-admins']))['groups'] == []
assert expression(expressions[0], info=dict(info, groups=[]))['groups'] == []
assert expression(expressions[0], info=dict(info, email='changed@example.com'))['username'] == mapped['username']
assert expression(expressions[0], info=dict(info, sub='other'))['username'] != mapped['username']
for bad in (dict(info, sub=''), dict(info, groups='admin')):
    try: expression(expressions[0], info=bad)
    except ValueError: pass
    else: raise AssertionError('invalid claims accepted')
assert expression(expressions[1], ak_is_sso_flow=True) is True
assert expression(expressions[1], ak_is_sso_flow=False) is False
from types import SimpleNamespace as NS
for user, allowed in ((None, False), (NS(username='akadmin',is_active=True), True),
                      (NS(username='iht-admin',is_active=True), False),
                      (NS(username='akadmin',is_active=False), False)):
    assert expression(expressions[2], request=NS(context={'pending_user': user})) is allowed
assert 'evaluate_on_plan: false' in s and 're_evaluate_policies: true' in s
compose = (root/'docker/compose.yml').read_text()
for service in ('authentik-server', 'authentik-worker'):
    block = re.search(r'^  '+service+r':\n(.*?)(?=^  [a-z]|\Z)',compose,re.M|re.S)[1]
    assert './authentik/blueprints:/blueprints/custom:ro' in block
    assert 'IHT_CLIENT_SECRET: ${IHT_CLIENT_SECRET:-}' in block
print('[ok] blueprint claims, identifier matching, flows, recovery policy, container mounts/env')
PY

# Stub only the transport; the real ak_list_find/jsonq and reconciliation run.
AK=http://offline/api/v3
IHT_ENABLED=true; IHT_CLIENT_ID=company-client; IHT_CLIENT_SECRET=not-printed
MATCHING=identifier; PATCH_CODE=200; VERIFY_CODE=200; BAD_STAGE=
api() {
  API_CODE=200
  case "$1:$2" in
    GET:*sources/oauth/\?*)
      if [ ! -e "$WORK/ready" ]; then API_BODY='{"results":[]}'; touch "$WORK/ready"; else API_BODY='{"results":[{"slug":"inhouse-technology","pk":"source-pk"}]}'; fi ;;
    GET:*flows/instances/\?slug=ihc-local-recovery) API_BODY='{"results":[{"slug":"ihc-local-recovery","pk":"recovery-pk"}]}' ;;
    GET:*flows/instances/\?slug=default-authentication-flow)
      if [ ! -e "$WORK/default-ready" ]; then API_BODY='{"results":[]}'; touch "$WORK/default-ready"; else API_BODY='{"results":[{"slug":"default-authentication-flow","pk":"default-pk"}]}'; fi ;;
    GET:*sources/oauth/inhouse-technology/) API_BODY="{\"user_matching_mode\":\"$MATCHING\"}" ;;
    GET:*stages/identification/\?*) API_BODY='{"results":[{"name":"default-authentication-identification","pk":"stage-pk"}]}' ;;
    PATCH:*stages/identification/stage-pk/) printf '%s\n' "$3" >> "$WORK/patches"; API_CODE="$PATCH_CODE"; API_BODY=not-printed ;;
    GET:*stages/identification/stage-pk/)
      API_CODE="$VERIFY_CODE"
      API_BODY="$(tail -n 1 "$WORK/patches")"
      if [ -n "$BAD_STAGE" ]; then API_BODY="$BAD_STAGE"; fi ;;
    *) echo "unexpected API call $1 $2" >&2; return 1 ;;
  esac
}
sleep() { :; }
ensure_iht_login >"$WORK/out" 2>&1
ensure_iht_login >>"$WORK/out" 2>&1
$PY - "$WORK/patches" <<'PY'
import json,sys
patches=[json.loads(l) for l in open(sys.argv[1])]
assert len(patches)==2 and patches[0]==patches[1]
assert patches[0] == dict(user_fields=[], sources=['source-pk'], show_source_labels=True,
                        password_stage=None, enrollment_flow=None, recovery_flow=None)
assert ( __import__('pathlib').Path(sys.argv[1]).parent / 'default-ready').exists()
print('[ok] repeatable source-only login patch after asynchronous import')
PY
if (MATCHING=email_link; ensure_iht_login) >"$WORK/out" 2>&1; then exit 1; fi
if (PATCH_CODE=400; ensure_iht_login) >"$WORK/out" 2>&1; then exit 1; fi
if (VERIFY_CODE=503; ensure_iht_login) >"$WORK/out" 2>&1; then exit 1; fi
# A successful PATCH alone is insufficient: reject a retained local form, a
# source chooser, or any password/enrollment/recovery link in the readback.
for drift in user_fields sources password_stage enrollment_flow recovery_flow; do
  BAD_STAGE="$($PY - "$WORK/patches" "$drift" <<'PY'
import json, sys
s = json.loads(open(sys.argv[1]).readlines()[-1])
s[sys.argv[2]] = {'user_fields': ['username'], 'sources': ['source-pk', 'other-source']}.get(sys.argv[2], 'local-pk')
print(json.dumps(s))
PY
)"
  if (ensure_iht_login) >"$WORK/out" 2>&1; then echo "[xx] retained $drift accepted"; exit 1; fi
done
BAD_STAGE=
if grep -q not-printed "$WORK/out"; then echo '[xx] API body leaked'; exit 1; fi
# A failed/missing worker import must time out without touching the login stage.
before="$(wc -l < "$WORK/patches")"
if (
  ak_list_find() { :; }
  date() {
    if [ -e "$WORK/clock" ]; then echo 121; else touch "$WORK/clock"; echo 0; fi
  }
  ensure_iht_login
) >"$WORK/out" 2>&1; then echo '[xx] absent blueprint accepted'; exit 1; fi
check test "$(wc -l < "$WORK/patches")" = "$before"
# Recovery and the default flow must both exist before reconciliation, even if
# the source is already ready (worker import order on a fresh installation).
for missing in ihc-local-recovery default-authentication-flow; do
  rm -f "$WORK/clock"
  if (
    ak_list_find() { [ "$3" = "$missing" ] || printf existing-pk; }
    date() {
      if [ -e "$WORK/clock" ]; then echo 121; else touch "$WORK/clock"; echo 0; fi
    }
    ensure_iht_login
  ) >"$WORK/out" 2>&1; then echo "[xx] absent $missing accepted"; exit 1; fi
  check test "$(wc -l < "$WORK/patches")" = "$before"
done
if (IHT_CLIENT_SECRET=; ensure_iht_login) >"$WORK/out" 2>&1; then exit 1; fi

# An iht skip covers the entire MCP smoke journey, including revocation and
# aggregation. It must produce one skip, never a later revoked:no-token failure.
awk '/^t25_granted\(\)/,/^}/; /^t25_revoked\(\)/,/^}/; /^t25_result\(\)/,/^}/' \
  "$ROOT/scripts/smoke-tests.sh" > "$WORK/mcp-fns.sh"
. "$WORK/mcp-fns.sh"
T25_BAD=; T25_DONE=false
result() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$WORK/results"; }
t25_granted unused
t25_revoked unused
t25_result
check test -z "$T25_BAD"
check test "$(cat "$WORK/results")" = '25 mcp-gateway skip'

# Rootful docker-ro needs the host socket group with capabilities dropped.
# Exercise the real common.sh Python command (which includes -I) on any OS.
touch "$WORK/docker.sock"
env_set DOCKER_SOCKET "$WORK/docker.sock"
gid="$(uname() { printf Linux; }; docker() { printf '[]'; }; detect_docker_socket_gid)"
check test "$gid" = "$($PY -c 'import os,sys;print(os.stat(sys.argv[1]).st_gid)' "$WORK/docker.sock")"
check test "$(uname() { printf Darwin; }; detect_docker_socket_gid)" = 0
check test "$(uname() { printf Linux; }; docker() { printf '[name=rootless]'; }; detect_docker_socket_gid)" = 0
if (uname() { printf Linux; }; docker() { printf '[]'; }; env_set DOCKER_SOCKET "$WORK/missing.sock"; detect_docker_socket_gid) >"$WORK/out" 2>&1; then
  echo '[xx] missing Docker socket accepted'; exit 1
fi
echo 'iht-sso: all checks passed'
