#!/usr/bin/env bash
# Exercise the real redemption/persistence helper with a stubbed HTTP transport.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/.ihc-agent/iht-claim-offline-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
python3 -I - "$ROOT" "$WORK" <<'PYTEST'
import contextlib, importlib.util, io, json, os, stat, subprocess, sys, urllib.error
from pathlib import Path
from unittest.mock import patch
root, work = map(Path, sys.argv[1:])
path = root/'scripts/lib/iht-claim.py'
spec = importlib.util.spec_from_file_location('claim', path)
claim = importlib.util.module_from_spec(spec); spec.loader.exec_module(claim)
config, env = work/'config.yaml', work/'.env'
config.write_text('install:\n  directory: /opt/inhousecloud\nauthentik:\n  iht:\n    issuer: https://iht.test\n')
issuer = 'https://iht.test'
response = dict(client_id='same-client', client_secret='fresh-private-secret', issuer=issuer)
requests = []
class Reply:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return json.dumps(response).encode()
class Transport:
    def open(self, request, timeout):
        requests.append(request)
        assert request.data == b'code=one-use-claim'
        assert timeout == 10
        return Reply()
def invoke(transport=Transport(), endpoint=issuer+'/oidc/clients/claim'):
    output = io.StringIO()
    with patch.object(sys, 'argv', [str(path),str(config),str(env),issuer,endpoint]), patch.object(sys, 'stdin', io.StringIO('one-use-claim')), patch('urllib.request.build_opener', return_value=transport), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        claim.main()
    assert not output.getvalue()
invoke()
assert stat.S_IMODE(env.stat().st_mode) == 0o600
assert 'IHC_IHT_CLIENT_SECRET="fresh-private-secret"' in env.read_text()
assert 'IHT_CLIENT_SECRET="fresh-private-secret"' in env.read_text()
assert 'IHT_ENABLED="true"' in env.read_text()
assert json.loads(config.read_text())['install']['directory'] == '/opt/inhousecloud'
assert json.loads(config.read_text())['authentik']['iht']['client_id'] == 'same-client'
assert 'fresh-private-secret' not in config.read_text()
response['client_secret'] = 'rotated-private-secret'
invoke()
assert 'fresh-private-secret' not in env.read_text()
assert 'IHT_CLIENT_SECRET="rotated-private-secret"' in env.read_text()
previous = config.read_bytes(), env.read_bytes()
class Broken:
    def __init__(self, error): self.error = error
    def open(self, *args, **kwargs): raise self.error
for error in (urllib.error.HTTPError(issuer,410,'Gone',{},None), urllib.error.URLError('private-transport-detail')):
    try: invoke(Broken(error))
    except (urllib.error.HTTPError, urllib.error.URLError): pass
    else: raise AssertionError('failure accepted')
    assert previous == (config.read_bytes(), env.read_bytes())
for changed in ({'issuer':'https://wrong.test'}, {'client_id':'different-client'}, {'client_secret':'unsafe$value'}):
    original = response.copy(); response.update(changed)
    try: invoke()
    except ValueError: pass
    else: raise AssertionError('invalid response accepted')
    response.clear(); response.update(original)
    assert previous == (config.read_bytes(), env.read_bytes())
before = len(requests)
try: invoke(endpoint='https://other-origin.test/claim')
except ValueError: pass
else: raise AssertionError('cross-origin endpoint accepted')
assert len(requests) == before
# Run the actual shell handoff with only urllib's transport replaced in a child.
# This covers config reload and prevents stage_secrets copying the original YAML
# over the newly claimed client metadata on fresh installs.
reply = work/'reply.json'; reply.write_text(json.dumps(response))
shim = work/'python-transport.py'
shim.write_text("""
import io, json, os, runpy, sys, urllib.request
if sys.argv[1].endswith('/iht-claim.py'):
    class Response(io.BytesIO):
        status = 200
    class Transport:
        def open(self, *args, **kwargs):
            return Response(open(os.environ['TEST_REPLY'], 'rb').read())
    urllib.request.build_opener = lambda *args: Transport()
    sys.argv = sys.argv[1:]
    runpy.run_path(sys.argv[0], run_name='__main__')
else:
    os.execvp('python3', ['python3', '-I'] + sys.argv[1:])
""")
script = r"""
set -eu
. "$IHC_ROOT/scripts/lib/common.sh"
. "$IHC_ROOT/scripts/lib/iht.sh"
PY="python3 -I $TEST_SHIM"
SOURCE_CONFIG=/original/config.yaml
iht_claim
test "$SOURCE_CONFIG" = "$CONFIG_FILE"
test "$CFG_authentik__iht__client_id" = same-client
test "$CFG_authentik__iht__issuer" = https://iht.test
test -n "$CONFIG_SHA"
test -z "${IHT_CLAIM:-}"
"""
result = subprocess.run(['bash', '-c', script], text=True, capture_output=True,
    env=dict(os.environ, IHC_ROOT=str(root), CONFIG_FILE=str(config), ENV_FILE=str(env),
             IHT_CLAIM='shell-claim', IHT_CLAIM_ISSUER=issuer, TEST_SHIM=str(shim), TEST_REPLY=str(reply)))
assert result.returncode == 0, result.stderr
assert response['client_secret'] not in result.stdout + result.stderr
assert 'shell-claim' not in result.stdout + result.stderr
print('iht-claim-offline: success, rotation, private persistence, 410, network and response validation passed')
PYTEST
