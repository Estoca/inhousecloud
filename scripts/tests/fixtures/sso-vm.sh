#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$TASK_ROOT"
export TMPDIR="$PWD/tmp"
mkdir -p "$TMPDIR" logs
umask 077
echo 'Preparing isolated OIDC fixtures and browser dependencies...'
if [ ! -e dependencies.ready ]; then
  sudo apt-get update -qq >logs/apt.log 2>&1
  sudo apt-get install -y python3-venv libnss3-tools >>logs/apt.log 2>&1
  python3 -m venv venv
  venv/bin/pip install ./iht playwright PyYAML >logs/pip.log 2>&1
  venv/bin/playwright install --with-deps chromium >logs/playwright.log 2>&1
  touch dependencies.ready
fi
BRIDGE="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
export BRIDGE
if [ ! -e test.env ]; then
  venv/bin/python ihc/scripts/tests/fixtures/sso-seed.py
fi
set -a
. ./test.env
set +a
if [ ! -e tls.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -days 2 \
    -subj /CN=ihc-sso-test -addext "subjectAltName=IP:$BRIDGE" -addext basicConstraints=critical,CA:TRUE >logs/tls.log 2>&1
  sudo cp tls.crt /usr/local/share/ca-certificates/ihc-sso-test.crt
  sudo update-ca-certificates >>logs/tls.log 2>&1
fi
# requests in Authentik uses this bundle; this changes only the disposable copy.
venv/bin/python - <<'PY'
from pathlib import Path
p = Path("ihc/docker/compose.yml")
s = p.read_text()
# These anchors occur only in the two Authentik services.
s = s.replace("      IHT_CLIENT_ID:", "      REQUESTS_CA_BUNDLE: /etc/ssl/certs/ca-certificates.crt\n      SSL_CERT_FILE: /etc/ssl/certs/ca-certificates.crt\n      IHT_CLIENT_ID:")
s = s.replace("      - ./authentik/blueprints:/blueprints/custom:ro", "      - /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro\n      - ./authentik/blueprints:/blueprints/custom:ro")
p.write_text(s)
PY
# Restart only fixture PIDs recorded by this harness, including on --reuse.
stop_fixture() {
  local name="$1" module="$2" pid args
  [ -f "$name.pid" ] || return 0
  pid="$(cat "$name.pid")"
  case "$pid" in ''|*[!0-9]*) echo "Invalid fixture PID" >&2; exit 1 ;; esac
  if kill -0 "$pid" 2>/dev/null; then
    args="$(ps -p "$pid" -o args=)"
    case "$args" in *"uvicorn $module:app"*) kill "$pid" ;; *) echo "Fixture PID was reused; refusing to kill it" >&2; exit 1 ;; esac
    for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || return 0; sleep 1; done
    echo "Fixture did not stop" >&2; exit 1
  fi
}
stop_fixture mock mock_upstream
stop_fixture iht serve_iht
nohup venv/bin/uvicorn mock_upstream:app --app-dir "$PWD/ihc/scripts/tests/fixtures" --host 0.0.0.0 --port 9081 >logs/mock.log 2>&1 &
echo $! > mock.pid
# Load iht through a tiny settings factory, without changing its source.
cat > serve_iht.py <<'PY'
from iht.app import create_app
from iht.config import Settings
app = create_app(Settings())
PY
nohup venv/bin/uvicorn serve_iht:app --host 0.0.0.0 --port 9443 --ssl-keyfile tls.key --ssl-certfile tls.crt >logs/iht.log 2>&1 &
echo $! > iht.pid
for url in "$MOCK_ISSUER/.well-known/openid-configuration" "$IHT_PUBLIC_URL/.well-known/openid-configuration"; do
  ready=false
  for i in $(seq 1 60); do
    if curl -fsS "$url" > /dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  $ready || { echo "Fixture not ready: $url (logs in ~/sso-e2e/logs)"; exit 1; }
done
cd ihc
./install.sh status --install-dir "$TASK_ROOT/cloud" --json >../logs/before-status.json 2>&1 || true
echo 'Installing ihc (details: ~/sso-e2e/logs/install.log)...'
if ! ./install.sh --non-interactive --config ../config.yaml >../logs/install.log 2>&1; then
  tail -70 ../logs/install.log
  exit 1
fi
cd ..
echo 'Running real browser journeys...'
venv/bin/python ihc/scripts/tests/fixtures/sso-browser.py
