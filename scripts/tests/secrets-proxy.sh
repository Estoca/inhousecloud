#!/usr/bin/env bash
# Offline provisioning, manifest parity, revocation and private-file checks.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "$ROOT/.ihc-secrets-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PYTHONDONTWRITEBYTECODE=1 python3 - "$ROOT" "$WORK" <<'PYTEST'
import hashlib, json, os, pathlib, sys
root, work = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / 'scripts/lib'))
import secretsproxy, envfile, config, appmanifest
manifest = work / 'company-app.yaml'
env = work / '.env'
policy = {'github': {'methods': ['GET'], 'path_prefixes': ['/repos/example/project']}}
# Block lists work even without PyYAML.
text = "secrets_proxy:\n  github:\n    methods:\n      - GET\n    path_prefixes:\n      - /repos/example/project\n"
assert config.mini_yaml(text)['secrets_proxy'] == policy
manifest.write_text(text)
env.write_text('UNRELATED="keep"\nIHC_SECRETS_PROXY_TOKEN="untrusted-example"\n')
secretsproxy.provision(str(work), 'demo', str(manifest), str(env))
def token():
    return next(envfile.unquote(s.split('=', 1)[1]) for s in env.read_text().splitlines() if s.startswith('IHC_SECRETS_PROXY_TOKEN='))
first = token()
record_path = work / 'secrets-proxy/callers/demo.json'
record = json.loads(record_path.read_text())
assert record == {'token_hash': hashlib.sha256(first.encode()).hexdigest(), 'policy': policy}
assert first not in record_path.read_text()
credentials = work / 'secrets-proxy/credentials.json'
credentials.write_text('{"github":"machine-only-credential"}')
secretsproxy.provision(str(work), 'demo', str(manifest), str(env))
assert first == token() and 'machine-only-credential' not in env.read_text()
assert 'UNRELATED="keep"' in env.read_text()
manifest.write_text('app:\n  slug: demo\n')
secretsproxy.provision(str(work), 'demo', str(manifest), str(env))
assert json.loads(record_path.read_text())['policy'] == {}
assert first == token()
# A mismatched private env must fail closed, preserving the registry.
before = record_path.read_bytes()
saved_env = env.read_text()
env.write_text(saved_env.replace(first, 'b' * 64))
try:
    secretsproxy.provision(str(work), 'demo', str(manifest), str(env))
    raise AssertionError('mismatched caller accepted')
except ValueError:
    pass
assert record_path.read_bytes() == before
env.write_text(saved_env)
assert credentials.read_text() == '{"github":"machine-only-credential"}'
for file in [env, record_path, credentials]:
    assert file.stat().st_mode & 0o777 == 0o600
for directory in [work / 'secrets-proxy', work / 'secrets-proxy/callers']:
    assert directory.stat().st_mode & 0o777 == 0o700
# Built-in agent starts denied and preserves admin-set policy on installer reruns.
agent_env = work / 'agent.env'
secretsproxy.provision(str(work), 'agent', None, str(agent_env))
agent_record = work / 'secrets-proxy/callers/agent.json'
a = json.loads(agent_record.read_text()); assert a['policy'] == {}
a['policy'] = policy; agent_record.write_text(json.dumps(a))
secretsproxy.provision(str(work), 'agent', None, str(agent_env))
assert json.loads(agent_record.read_text()) == a
for invalid in [None, [], {'unknown': policy['github']}, {'github': {}},
                {'github': {'methods': ['get'], 'path_prefixes': ['/']}},
                {'github': {'methods': ['GET'], 'path_prefixes': ['/repos/../admin']}},
                {'github': {'methods': ['GET'], 'path_prefixes': ['/'], 'url': 'https://evil.test'}}]:
    assert secretsproxy.policy_errors(invalid)
assert appmanifest.slug_problem('secrets-proxy')
print('secrets-proxy: provisioning, isolation, stable tokens, removal, agent policy and validation passed')
PYTEST

# Exercise the actual stage with only the agent profile: no empty `dc up` call,
# and no early return before agent_up. Everything external is stubbed.
sed -n '/^stage_optional_profiles() {/,/^}/p' "$ROOT/install.sh" > "$WORK/stage.sh"
(
  . "$WORK/stage.sh"
  PROFILES=agent
  has_profile_ci() { return 1; }
  has_profile() { [ "$1" = agent ]; }
  agent_up() { printf 'started\n' > "$WORK/started"; }
  dc() { [ "$*" = 'rm -sf wetty filebrowser portainer glances' ]; }
  wait_healthy() { return 1; }
  state() { :; }
  jsonq() { printf '{}'; }
  stage_optional_profiles
  [ "$(cat "$WORK/started")" = started ]
)
# Compose must reuse the portal image with just the private directory mounted.
node --input-type=module - "$ROOT" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const { parse } = await import(`${root}/portal/node_modules/yaml/dist/index.js`);
const service = parse(readFileSync(`${root}/docker/compose.yml`, 'utf8')).services['secrets-proxy'];
assert.deepEqual(service.profiles, ['agent']);
assert.deepEqual(service.command, ['node', 'src/secrets-proxy.js']);
assert.deepEqual(service.networks, ['ihc']);
assert.deepEqual(service.volumes, ['./secrets-proxy:/ihc/secrets-proxy:ro']);
assert.deepEqual(service.cap_drop, ['ALL']);
assert.equal(service.read_only, true);
assert.equal(service.ports, undefined);
assert.equal(service.env_file, undefined);
console.log('secrets-proxy: agent-only installer stage and compose isolation passed');
JS
