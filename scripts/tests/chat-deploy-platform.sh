#!/usr/bin/env bash
# LAB-169 install/image wiring, offline: real staging and lint, parsed Compose,
# first-run with fake Gitea API/CLI, and the completed-install upgrade path.
set -Eeu
# A failed assertion names its line in CI logs instead of exiting silently.
trap 'echo "chat-deploy-platform: failed at line $LINENO: $BASH_COMMAND" >&2' ERR
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Keep every scratch artifact in one ignored folder in the checkout, never /tmp.
mkdir -p "$ROOT/local"
WORK="$(mktemp -d "$ROOT/local/chat-platform.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export PYTHONDONTWRITEBYTECODE=1
. "$ROOT/scripts/lib/common.sh"
pass() { printf '[ok] %s\n' "$*"; }

eval "$(sed -n '/^copy_portal() {/,/^}/p' "$ROOT/install.sh")"
INSTALL_DIR="$WORK/install"; mkdir -p "$INSTALL_DIR"
copy_portal
RUNTIME="$INSTALL_DIR/portal/.ihc-runtime"
python3 -I - "$ROOT" "$RUNTIME" <<'PY'
import pathlib, sys
root, staged = map(pathlib.Path, sys.argv[1:])
expected = {'applint.py', 'appmanifest.py', 'config.py', 'secretsproxy.py', 'envfile.py'}
assert {p.name for p in (staged/'scripts/lib').iterdir()} == expected
for name in expected:
    assert (staged/'scripts/lib'/name).read_bytes() == (root/'scripts/lib'/name).read_bytes()
def tree(path):
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob('*') if p.is_file()}
assert tree(staged/'templates/app') == tree(root/'templates/app')
PY
pass 'staging copies exactly the five lint modules and the canonical starter tree'

# Model COPY .ihc-runtime/ ./ and the image's /app/applint symlink. Force the
# existing Node yaml fallback, including on CI machines that happen to have PyYAML.
ln -s scripts/lib "$RUNTIME/applint"
mkdir -p "$RUNTIME/portal" "$WORK/no-pyyaml"
ln -s "$ROOT/portal/node_modules" "$RUNTIME/portal/node_modules"
printf 'raise ImportError("exercise Node yaml fallback")\n' > "$WORK/no-pyyaml/yaml.py"
PYTHONPATH="$WORK/no-pyyaml" python3 "$RUNTIME/applint/applint.py" "$RUNTIME/templates/app" "$INSTALL_DIR"
pass 'python3 applint/applint.py templates/app works in the staged image layout (Node yaml fallback)'

# A stale/developer-staged copy must never be trusted when restaging an update.
mkdir -p "$INSTALL_DIR/portal/.ihc-runtime/stale"
copy_portal
[ ! -e "$INSTALL_DIR/portal/.ihc-runtime/stale" ]
pass 'restaging removes stale build inputs'

node --input-type=module - "$ROOT" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = process.argv[2];
const {parse} = await import(`${root}/portal/node_modules/yaml/dist/index.js`);
const compose = parse(fs.readFileSync(`${root}/docker/compose.yml`, 'utf8'));
const mcp = compose.services.mcp, env = mcp.environment;
assert.deepEqual(mcp.networks, ['ihc']);
assert.ok(compose.services.gitea.networks.includes('ihc'));
const expected = {
  IHC_CHAT_GITEA_TOKEN: '${IHC_CHAT_GITEA_TOKEN:-}',
  IHC_CHAT_GITEA_USER: '${IHC_CHAT_GITEA_USER:-ihc-chat}',
  GITEA_URL: 'http://gitea:3000', GITEA_ORG: '${GITEA_ORGANIZATION}',
  BASE_DOMAIN: '${BASE_DOMAIN}', MCP_PUBLIC_URL: '${MCP_BASE_URL:-}',
  IHC_CHAT_NEW_APP_GROUP: '${IHC_CHAT_NEW_APP_GROUP:-ihc-admins}',
  IHC_CHAT_CHECKS_PER_HOUR: '${IHC_CHAT_CHECKS_PER_HOUR:-30}',
  IHC_INSTALL_DIR: '${IHC_INSTALL_DIR}', IHC_CHAT_DIR: '/ihc/chat',
  IHC_APPLINT: '/app/applint/applint.py', IHC_TEMPLATE_DIR: '/app/templates/app',
};
for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, key);
assert.ok(mcp.volumes.includes('mcp-chat:/ihc/chat'));
assert.ok(Object.hasOwn(compose.volumes, 'mcp-chat'));
assert.equal(mcp.user, '1000:1000');
assert.deepEqual(mcp.cap_drop, ['ALL']);
assert.ok(!mcp.ports && !mcp.volumes.some(v => /docker.sock|:\/opt\/inhousecloud/.test(v)));
assert.ok(!compose.services.portal.environment.IHC_CHAT_GITEA_TOKEN);
const dockerfile = fs.readFileSync(`${root}/portal/Dockerfile`, 'utf8');
assert.match(dockerfile, /apk add --no-cache python3 py3-yaml git/);
assert.match(dockerfile, /COPY \.ihc-runtime\/ \.\//);
assert.match(dockerfile, /ln -s scripts\/lib \/app\/applint/);
assert.match(dockerfile, /chown node:node \/ihc\/mcp-keys \/ihc\/chat/);
assert.match(dockerfile, /chmod 700 \/ihc\/mcp-keys \/ihc\/chat/);
assert.match(dockerfile, /^USER node$/m);
const ignore = fs.readFileSync(`${root}/portal/.dockerignore`, 'utf8');
assert.match(ignore, /^!\.ihc-runtime\/templates\/app\/\.env.example$/m);
assert.equal(fs.readFileSync(`${root}/.env.example`, 'utf8'), fs.readFileSync(`${root}/docker/.env.example`, 'utf8'));
JS
pass 'parsed compose has every chat variable, persistent volume, Gitea network and existing isolation; image owns the volume as node'

# Extract only the first-run function: no real services, no network, no real tokens.
eval "$(sed -n '/^ensure_chat_deployer() {/,/^}/p' "$ROOT/scripts/first-run.sh")"
eval "$(sed -n '/^gitea_token_valid() /p' "$ROOT/scripts/first-run.sh")"
ENV_FILE="$INSTALL_DIR/.env"; : > "$ENV_FILE"
GT=http://gitea.invalid/api/v1; TOKEN=fixture-admin
GITEA_ORGANIZATION=company; BASE_DOMAIN=example.invalid
record() { :; }
api_init() { AUTH="${2#Authorization: token }"; }
api() {
  printf '%s %s\n' "$1" "${2#"$GT"}" >> "$WORK/api-calls"
  API_CODE=200; API_BODY='{}'
  case "$1 ${2#"$GT"}" in
    'GET /users/ihc-chat') [ -e "$WORK/user" ] || API_CODE=404 ;;
    'POST /admin/users')
      printf '%s' "$3" | python3 -I -c 'import json,sys
b=json.load(sys.stdin)
assert b["username"] == "ihc-chat" and b["email"] == "ihc-chat@noreply.example.invalid"
assert len(b["password"]) == 48 and b["must_change_password"] is False and b["send_notify"] is False'
      touch "$WORK/user" ;;
    'PATCH /admin/users/ihc-chat')
      printf '%s' "$3" | python3 -I -c 'import json,sys
assert json.load(sys.stdin) == dict(email="ihc-chat@noreply.example.invalid", visibility="private", must_change_password=False)'
      ;;
    'GET /orgs/company/teams?limit=50') API_BODY='[{"name":"Owners","id":7}]' ;;
    'PUT /teams/7/members/ihc-chat') [ "${OWNER_FAILURE:-false}" != true ] || API_CODE=403 ;;
    'GET /user')
      API_BODY='{"login":"ihc-chat"}'
      case "$AUTH" in
        revoked) API_CODE=401 ;;
        unavailable) API_CODE=503 ;;
        wrong-account) API_BODY='{"login":"someone-else"}' ;;
        fixture-token-*) [ "${BAD_NEW_TOKEN:-false}" != true ] || API_CODE=401 ;;
        *) echo 'unexpected fake token' >&2; exit 1 ;;
      esac ;;
    *) echo 'unexpected Gitea API call' >&2; exit 1 ;;
  esac
}
gitea_cli() {
  [ "$*" = "admin user generate-access-token --username ihc-chat --token-name ${7} --scopes write:repository,read:organization,read:user --raw" ] || return 1
  local n=0; [ ! -f "$WORK/generated" ] || n="$(cat "$WORK/generated")"
  n=$((n+1)); printf '%s' "$n" > "$WORK/generated"
  printf 'fixture-token-%s\n' "$n"
}
run_deployer() { (set -eu; ensure_chat_deployer) > "$WORK/out" 2>&1; }
run_deployer
[ "$(cat "$WORK/generated")" = 1 ]
[ "$(env_get IHC_CHAT_GITEA_TOKEN)" = fixture-token-1 ]
[ "$(wc -l < "$WORK/out" | tr -d ' ')" = 1 ]
! grep -q 'fixture-token\|password' "$WORK/out"
pass 'fresh first-run creates a private user, reconciles owner membership and writes a probed scoped token; one secret-free ok line'
run_deployer
[ "$(cat "$WORK/generated")" = 1 ]
[ "$(grep -c '^POST /admin/users$' "$WORK/api-calls")" = 1 ]
[ "$(grep -c '^PATCH /admin/users/ihc-chat$' "$WORK/api-calls")" = 2 ]
[ "$(grep -c '^PUT /teams/7/members/ihc-chat$' "$WORK/api-calls")" = 2 ]
pass 'second run repairs account settings/membership and keeps the current token and user'
for old in revoked wrong-account; do
  env_set IHC_CHAT_GITEA_TOKEN "$old"
  run_deployer
done
[ "$(cat "$WORK/generated")" = 3 ]
pass 'revoked token and token for another account are each replaced after probing'
env_set IHC_CHAT_GITEA_TOKEN ''
run_deployer
[ "$(cat "$WORK/generated")" = 4 ]
pass 'missing token is repaired for an existing user'
env_set IHC_CHAT_GITEA_TOKEN unavailable
if run_deployer; then echo '[xx] transient API failure accepted'; exit 1; fi
[ "$(env_get IHC_CHAT_GITEA_TOKEN)" = unavailable ]
[ "$(cat "$WORK/generated")" = 4 ]
pass 'transient API failure stops first-run and keeps the current token'
env_set IHC_CHAT_GITEA_TOKEN ''
export OWNER_FAILURE=true
if run_deployer; then echo '[xx] ownership failure accepted'; exit 1; fi
[ "$(cat "$WORK/generated")" = 4 ]
unset OWNER_FAILURE
pass 'ownership failure stops before issuing a token'
export BAD_NEW_TOKEN=true
if run_deployer; then echo '[xx] invalid new token accepted'; exit 1; fi
[ -z "$(env_get IHC_CHAT_GITEA_TOKEN)" ]
unset BAD_NEW_TOKEN
pass 'a newly issued token that fails probing is never persisted'

# Completed installs must enter foundation once on plain --apply, and leave secrets
# alone. Marker is written in main only after first_run (and container refresh) succeeds.
STATE_FILE="$WORK/state.json"
eval "$(sed -n '/^ensure_chat_deploy_upgrade() {/,/^}/p' "$ROOT/install.sh")"
state init --install-dir "$INSTALL_DIR" --config-sha fixture >/dev/null
for stage in preflight plan secrets foundation authentik shared_data proxy_ingress gitea portal first_run backup optional_profiles smoke_tests handoff; do
  state stage "$stage" complete
done
ensure_chat_deploy_upgrade
[ "$(state stage secrets status)" = completed ]
[ "$(state stage foundation status)" = pending ]
[ "$(state stage first_run status)" = pending ]
pass 'old completed install resets from foundation on --apply, preserving secrets'
state set chat_deploy_version 1
state stage foundation complete
ensure_chat_deploy_upgrade
[ "$(state stage foundation status)" = completed ]
pass 'upgrade marker prevents repeated rebuilds on unchanged installs'
python3 -I - "$ROOT/install.sh" <<'PY'
from pathlib import Path
import sys
s = Path(sys.argv[1]).read_text()
assert s.index('if [ "$MODE" = plan ]; then', s.index('# -------------------------------------------------------------------- main')) < s.index('\nensure_chat_deploy_upgrade\n')
assert 'run_stage "$s"\n  [ "$s" != first_run ] || state set chat_deploy_version 1' in s
assert 'env_set IHC_INSTALL_DIR "$INSTALL_DIR"' in s
PY
pass 'plan exits before upgrade mutation; foundation persists the install path and first-run gates the marker'
echo 'chat-deploy-platform: 14 checks passed'
