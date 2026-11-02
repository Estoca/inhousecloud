#!/usr/bin/env bash
# Offline edge DNS and proxy contract; no running Docker daemon required.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${IHC_TEST_WORK_ROOT:-$HOME/.ihc-agent}/edge-ingress-$$"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
. "$ROOT/scripts/lib/common.sh"
. "$ROOT/scripts/lib/sso.sh"
. "$ROOT/scripts/lib/portal-api.sh"
ENV_FILE="$WORK/.env"
PORTAL_HOST=portal.example.test; AUTHENTIK_HOST=auth.example.test; GITEA_HOST=git.example.test
# The documented env template contains annotated empty paths. Supply fake paths
# just as foundation does before Compose validates optional service mounts.
$PY - "$ROOT/docker/.env.example" "$ENV_FILE" "$WORK" <<'FIXTURE'
import re, sys
from pathlib import Path
lines = []
for line in Path(sys.argv[1]).read_text().splitlines():
    if not line or line.startswith('#'):
        continue
    key, value = line.split('=', 1)
    value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
    if not value and (key.endswith('_DIR') or key == 'BACKUP_DESTINATION'):
        value = sys.argv[3]
    lines.append(key + '=' + value)
Path(sys.argv[2]).write_text('\n'.join(lines) + '\n')
FIXTURE
for TLS_MODE in off internal acme edge internal edge; do
  configure_proxy_aliases
  resolved="$(curl_resolve "https://$AUTHENTIK_HOST")"
  if [ "$TLS_MODE" = edge ]; then
    [ -z "$resolved" ]
  else
    [ "$resolved" = "$(printf -- '--resolve\n%s:443:127.0.0.1' "$AUTHENTIK_HOST")" ]
  fi
  for service in PORTAL AUTHENTIK GITEA; do
    value="$(env_get "PROXY_${service}_ALIAS")"
    if [ "$TLS_MODE" = edge ]; then
      [ "$value" = "proxy-$(printf '%s' "$service" | tr 'A-Z' 'a-z')" ]
    else
      eval 'expected="$'"${service}"'_HOST"'
      [ "$value" = "$expected" ]
    fi
  done
  echo "[ok] $TLS_MODE aliases (including mode transitions)"
done
# Verify Compose's actual nested interpolation, rather than duplicating it.
if command -v docker >/dev/null 2>&1; then
  docker compose --env-file "$ENV_FILE" -f "$ROOT/docker/compose.yml" config --format json > "$WORK/compose.json"
  $PY - "$WORK/compose.json" <<'CHECK'
import json, sys
config = json.load(open(sys.argv[1]))
assert config['services']['proxy']['networks']['ihc']['aliases'] == ['proxy-portal', 'proxy-authentik', 'proxy-gitea']
CHECK
  echo '[ok] edge Compose has no public hostname aliases'
fi
# Stub only the proxy API; exercise the production route renderer and JSON payload.
PROXY_HOSTS='[]'; NPM=http://proxy.invalid/api; PROXY_ADMIN_EMAIL=test@example.test
api_ok() { return 0; }
api() { API_BODY='{"id":1}'; printf '%s' "$3" > "$WORK/route.json"; }
for TLS_MODE in off acme edge; do
  for kind in plain portal protected; do
    case "$kind" in
      plain) conf="" ;;
      portal) conf="$(portal_forward_auth_conf)" ;;
      protected) conf="$(forward_auth_conf /health)" ;;
    esac
    ensure_proxy_host "$AUTHENTIK_HOST" authentik-server 9000 "$conf"
    $PY - "$WORK/route.json" "$TLS_MODE" "$kind" <<'CHECK'
import json, sys
route = json.load(open(sys.argv[1]))
conf = route['advanced_config']
assert route['forward_scheme'] == 'http'
if sys.argv[2] == 'edge':
    assert route['certificate_id'] == 0 and not route['ssl_forced']
    assert 'proxy_set_header Host $host;' in conf
    assert 'proxy_set_header X-Forwarded-Proto https;' in conf
    assert 'proxy_set_header X-Forwarded-Scheme https;' in conf
    assert '$scheme' not in conf and '$http_x_forwarded_proto' not in conf
    if sys.argv[3] != 'plain':
        assert 'X-Original-URL https://$http_host$request_uri' in conf
        assert 'rd=https://$http_host$request_uri' in conf
        assert 'auth_request ' in conf
    else:
        assert 'proxy_set_header Upgrade $http_upgrade;' in conf
        assert 'location / {' in conf
elif sys.argv[3] == 'plain':
    assert conf == ''
else:
    assert 'X-Forwarded-Proto $scheme' in conf
CHECK
  done
  echo "[ok] $TLS_MODE route headers and forward-auth return URLs"
done

# The operator's issuer check must agree with the browser-facing TLS mode too.
$PY - "$ROOT/scripts/lib" <<'DOCTOR'
import json, sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
from doctor import c_login
for mode in ('off', 'internal', 'acme', 'edge'):
    expected = ('http' if mode == 'off' else 'https') + '://auth.example.test/application/o/gitea/'
    advertised = expected
    def proxy(host, path):
        if path == '/':
            return '302', 'https://auth.example.test/if/flow/default-authentication-flow/', ''
        if path.endswith('openid-configuration'):
            return '200', '', json.dumps({'issuer': advertised})
        return '200', '', ''
    box = SimpleNamespace(tls=mode, auth_host='auth.example.test', portal_host='portal.example.test',
                          proxy=proxy, H='/checkout', I='/install')
    assert c_login(box).status == 'ok', mode
    advertised = 'https://wrong.example.test/'
    assert c_login(box).status == 'warn', mode
print('[ok] doctor validates the public issuer in every TLS mode')
DOCTOR

# First boot must request a provider refresh and propagate a delivery failure.
dc() { printf '%s\n' "$*" > "$WORK/signal"; return "${SIGNAL_RESULT:-0}"; }
refresh_embedded_outpost
[ "$(cat "$WORK/signal")" = 'kill -s USR1 authentik-server' ]
SIGNAL_RESULT=1
if refresh_embedded_outpost; then echo '[xx] outpost refresh failure ignored'; exit 1; fi
echo '[ok] embedded outpost provider refresh signal and failure propagation'
