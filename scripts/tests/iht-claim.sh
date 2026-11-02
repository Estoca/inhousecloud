#!/usr/bin/env bash
# Real loopback HTTP, no Docker/VM/network services. Run outside restricted sandboxes.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/.ihc-agent/iht-claim-test-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
python3 - "$ROOT" "$WORK" <<'PYTEST'
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json, os, stat, subprocess, sys, threading
from urllib.parse import parse_qs
root, work = map(Path, sys.argv[1:])
secret = 'claim-test-private-value'
requests = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        code = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())['code'][0]
        requests.append(code)
        self.send_response(410 if code == 'expired' else 200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(dict(client_id='test-client', client_secret=secret, issuer=issuer)).encode())
try:
    server = HTTPServer(('127.0.0.1', 0), Handler)
except PermissionError:
    sys.exit('iht-claim: EPERM binding loopback; run scripts/tests/iht-claim.sh outside the sandbox')
issuer = 'http://127.0.0.1:%s' % server.server_port
threading.Thread(target=server.serve_forever, daemon=True).start()
config = work/'config.yaml'; envfile = work/'.env'
config.write_text('authentik:\n  iht:\n    issuer: ' + issuer + '\n')
script = r"""
set -eu
. "$IHC_ROOT/scripts/lib/common.sh"
. "$IHC_ROOT/scripts/lib/iht.sh"
SOURCE_CONFIG=/original/input/config.yaml
iht_claim
test "$SOURCE_CONFIG" = "$CONFIG_FILE"
test -z "${IHT_CLAIM:-}"
"""
def run(code, endpoint=None):
    env = dict(os.environ, IHC_ROOT=str(root), CONFIG_FILE=str(config), ENV_FILE=str(envfile),
               IHT_CLAIM=code, CFG_authentik__iht__issuer=issuer)
    if endpoint: env['CFG_authentik__iht__claim_url'] = endpoint
    result = subprocess.run(['bash', '-c', script], env=env, text=True, capture_output=True)
    assert secret not in result.stdout + result.stderr
    assert code not in result.stdout + result.stderr
    return result
try:
    # Fresh install and repeat/rotation: no environment credential supplied.
    result = run('fresh-claim'); assert result.returncode == 0, result.stderr
    assert stat.S_IMODE(envfile.stat().st_mode) == 0o600
    assert 'IHC_IHT_CLIENT_SECRET="' + secret + '"' in envfile.read_text()
    assert 'IHT_CLIENT_SECRET="' + secret + '"' in envfile.read_text()
    saved = json.loads(config.read_text())
    assert saved['authentik']['iht']['client_id'] == 'test-client'
    assert saved['authentik']['iht']['issuer'] == issuer
    assert secret not in config.read_text()
    secret = 'rotated-private-value'
    assert run('rotate-claim').returncode == 0
    assert secret in envfile.read_text()
    previous = envfile.read_bytes(), config.read_bytes()
    result = run('expired'); assert result.returncode != 0 and 'HTTP 410' in result.stderr
    assert previous == (envfile.read_bytes(), config.read_bytes())
    # A same-origin path failure; endpoint below intentionally closes the socket.
    original = Handler.do_POST
    def close(self): self.connection.close()
    Handler.do_POST = close
    result = run('network-error'); assert result.returncode != 0 and 'network' in result.stderr
    assert previous == (envfile.read_bytes(), config.read_bytes())
    Handler.do_POST = original
    # Endpoint overrides cannot send the bearer claim to another origin.
    before = list(requests)
    assert run('wrong-origin', 'http://localhost:%s/claim' % server.server_port).returncode != 0
    assert requests == before
    print('iht-claim: fresh install, rotation, 410, network failure, same-origin and no secret output passed')
finally:
    server.shutdown(); server.server_close()
PYTEST
