#!/usr/bin/env bash
# The portal status API on the cloud's side (docs/portal-api.md), without a box:
#
#   scripts/tests/portal-api.sh
#
# 1. scripts/lib/portalapi.py: the parser accepts the contract and names what is wrong
#    with anything else; the reading falls back to source "local" with a reason for every
#    way the portal can fail to answer (no token, no answer, 302, 401, 503, bad body), and
#    `merge` keeps the state's fields. The token never appears in a reading.
# 2. doctor.py's portal-api check: ok, warn on unhealthy services, warn with the right
#    action on each fallback.
# 3. The nginx rule (scripts/lib/portal-api.sh): one exact path, the header condition,
#    an internal location that drops X-authentik-*, the forward auth kept after it.
# 4. End to end with the real portal (portal/src/server.js on a free port) behind a
#    stand-in for the proxy: `portalapi.py fetch` reads it with the token from a .env,
#    and falls back when the token is wrong. Skipped when node or portal/node_modules
#    are missing.
# Fails (exit 1) on any surprise. Needs python3 and curl.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0

python3 -I - "$ROOT/scripts/lib" <<'PY' || FAILS=1
import importlib.util, json, sys
lib = sys.argv[1]
sys.path.insert(0, lib)
spec = importlib.util.spec_from_file_location("portalapi", lib + "/portalapi.py")
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
spec = importlib.util.spec_from_file_location("doctor", lib + "/doctor.py")
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)

bad = 0
def check(name, cond):
    global bad
    print("[%s] %s" % ("ok" if cond else "xx", name))
    bad += not cond

svc = lambda name, healthy: {"name": name, "kind": "x", "healthy": healthy, "detail": "d", "checked_at": "t"}
good = {"checked_at": "2026-10-22T00:00:00Z", "overall": "healthy",
        "summary": {"total": 2, "healthy": 1, "unhealthy": 0, "unknown": 1},
        "services": [svc("Redis", True), svc("Garage", None)], "links": {}, "topology": {},
        "cached": True, "stale": False, "generated_at": "t", "age_seconds": 3}

# --- parser
check("parser: the contract parses", p.parse_status(json.dumps(good))["overall"] == "healthy")
def rejects(name, body, words):
    try:
        p.parse_status(body)
    except p.ParseError as e:
        check("parser rejects %s (%s)" % (name, e), words in str(e))
        return
    check("parser rejects %s" % name, False)
rejects("HTML", "<html>sign in</html>", "not JSON")
rejects("a list", "[]", "not a JSON object")
rejects("no services", json.dumps({k: v for k, v in good.items() if k != "services"}), "services")
rejects("an unknown overall", json.dumps(dict(good, overall="ok")), "overall")
rejects("a summary without unknown", json.dumps(dict(good, summary={"total": 2, "healthy": 1, "unhealthy": 0})), "summary")
rejects("a service without detail", json.dumps(dict(good, services=[svc("Redis", True), {"name": "G", "kind": "s", "healthy": None}])), "service 1")
rejects("healthy as a string", json.dumps(dict(good, services=[svc("Redis", "yes"), svc("G", None)])), "healthy")
rejects("a total that disagrees", json.dumps(dict(good, summary=dict(good["summary"], total=5))), "summary.total")

# --- the reading and its fallbacks
TOKEN = "t0ken-for-the-unit-test-0123456789"
env = {"PORTAL_BASE_URL": "http://portal.cloud.localhost", "PROXY_HTTP_PORT": "8081", "IHC_PORTAL_API_TOKEN": TOKEN}
seen = {}
def fake(code, body=""):
    def http(url, args, headers, timeout):
        seen.update(url=url, args=args, headers=headers)
        return code, body
    return http

r = p.fetch_status(env, "/opt/x", http=fake("200", json.dumps(good)))
check("200 with the contract: source portal-api", r["source"] == "portal-api" and r["platform"]["summary"]["total"] == 2)
check("through the proxy with the Host header", seen["url"] == "http://127.0.0.1:8081/api/platform/status" and seen["args"] == ["-H", "Host: portal.cloud.localhost"])
check("the bearer is the token from .env", "Authorization: Bearer " + TOKEN in seen["headers"])
check("the token is not in the reading", TOKEN not in json.dumps(r))
r = p.fetch_status(dict(env, TLS_MODE="internal", PROXY_HTTPS_PORT="443"), "/opt/x", http=fake("200", json.dumps(good)))
check("TLS internal: https pinned to loopback, verified with the cloud CA",
      seen["url"] == "https://portal.cloud.localhost/api/platform/status" and "--cacert" in seen["args"] and "-k" not in seen["args"]
      and "portal.cloud.localhost:443:127.0.0.1" in seen["args"])

def falls(name, reading, words):
    ok = reading["source"] == "local" and reading["platform"] is None and words in reading["portal_api"].get("reason", "")
    check("fallback %s -> local (%s)" % (name, reading["portal_api"].get("reason")), ok)
    check("fallback %s keeps the token out" % name, TOKEN not in json.dumps(reading))
calls = []
falls("no token in .env", p.fetch_status({k: v for k, v in env.items() if k != "IHC_PORTAL_API_TOKEN"}, "/opt/x",
      http=lambda *a: calls.append(a) or ("200", "")), "is not in .env")
check("no token: nothing is sent", calls == [])
falls("no answer", p.fetch_status(env, "/opt/x", http=fake("000")), "did not answer")
falls("302 to the sign-in", p.fetch_status(env, "/opt/x", http=fake("302")), "no status API rule")
falls("401", p.fetch_status(env, "/opt/x", http=fake("401", '{"error":"unauthorized"}')), "refused the token")
falls("503", p.fetch_status(env, "/opt/x", http=fake("503", '{"error":"portal_api_token_not_configured"}')), "no IHC_PORTAL_API_TOKEN")
falls("500", p.fetch_status(env, "/opt/x", http=fake("500")), "HTTP 500")
falls("502, the portal down", p.fetch_status(env, "/opt/x", http=fake("502")), "container is down")
falls("a 200 that is not the status", p.fetch_status(env, "/opt/x", http=fake("200", "<html></html>")), "not the platform status")
falls("a real curl to a closed port", p.fetch_status(dict(env, PROXY_HTTP_PORT="9"), "/opt/x", timeout=2), "did not answer")

state = {"installation_id": "abc", "status": "completed", "summary": {"failed": [], "pending": []}}
m = p.merge(state, p.fetch_status(env, "/opt/x", http=fake("200", json.dumps(good))))
check("merge keeps state.json and adds source/platform", m["installation_id"] == "abc" and m["summary"]["failed"] == [] and m["source"] == "portal-api" and m["platform"]["overall"] == "healthy")
m = p.merge(state, p.fetch_status(env, "/opt/x", http=fake("000")))
check("merge on fallback: source local, platform null", m["source"] == "local" and m["platform"] is None and m["status"] == "completed")

# --- doctor's portal-api check
class B:  # the part of Box the check reads
    H, I, dc_shown = "/src", "/opt/x", "docker compose -f /opt/x/compose.yml"
    def __init__(self, env): self.env = env
c = d.c_portal_api(B(env), p.fetch_status(env, "/opt/x", http=fake("200", json.dumps(good))))
check("doctor: ok when the portal sees everything healthy (%s)" % c.detail, c.status == "ok" and "1 of 2" in c.detail and "1 not configured" in c.detail)
sick = dict(good, overall="degraded", summary={"total": 2, "healthy": 1, "unhealthy": 1, "unknown": 0}, services=[svc("Redis", True), svc("Backup", False)])
c = d.c_portal_api(B(env), p.fetch_status(env, "/opt/x", http=fake("200", json.dumps(sick))))
check("doctor: warn naming the unhealthy service (%s)" % c.detail, c.status == "warn" and "Backup" in c.detail)
c = d.c_portal_api(B({}), p.fetch_status({}, "/opt/x"))
check("doctor: no token -> warn, update from foundation", c.status == "warn" and "--from foundation" in c.action and "local checks only" in c.detail)
c = d.c_portal_api(B(env), p.fetch_status(env, "/opt/x", http=fake("302")))
check("doctor: 302 -> warn, re-run first-run", c.status == "warn" and "first-run.sh" in c.action)
c = d.c_portal_api(B(env), p.fetch_status(env, "/opt/x", http=fake("401")))
check("doctor: 401 -> warn, recreate the portal", c.status == "warn" and "up -d portal" in c.action)
c = d.c_portal_api(B(env), p.fetch_status(env, "/opt/x", http=fake("502")))
check("doctor: 502 -> warn, start the portal", c.status == "warn" and "up -d portal" in c.action and "logs" in c.action)
sys.exit(1 if bad else 0)
PY

# --- the nginx rule
conf="$(bash -c '. "$1/scripts/lib/common.sh"; . "$1/scripts/lib/sso.sh"; . "$1/scripts/lib/portal-api.sh"; portal_forward_auth_conf' _ "$ROOT")"
rule() { if printf '%s\n' "$conf" | grep -qF -- "$2"; then echo "[ok] nginx: $1"; else echo "[xx] nginx: $1 (missing: $2)"; FAILS=1; fi; }
rule "exact path, header present" 'if ($uri = /api/platform/status) { set $ihc_portal_api "${ihc_portal_api}P"; }'
rule "header condition" 'if ($http_authorization != "") { set $ihc_portal_api "A"; }'
rule "both, or the forward auth" 'if ($ihc_portal_api = "AP") { rewrite ^ /.ihc-portal-api-token last; }'
rule "internal location" 'internal;'
rule "the original URI to the portal" 'proxy_pass $forward_scheme://$server:$port$request_uri;'
rule "forged identity dropped" 'proxy_set_header X-authentik-email "";'
rule "forward auth kept for the rest" 'auth_request        /outpost.goauthentik.io/auth/nginx;'
rule "health still public" 'location = /health {'
n="$(printf '%s\n' "$conf" | grep -c 'rewrite ')"
[ "$n" = 1 ] && echo "[ok] nginx: one rewrite only" || { echo "[xx] nginx: $n rewrites"; FAILS=1; }
for h in username groups entitlements email name uid; do
  printf '%s\n' "$conf" | grep -qF "proxy_set_header X-authentik-$h \"\";" || { echo "[xx] nginx: X-authentik-$h not dropped"; FAILS=1; }
done

# --- end to end: the real portal behind a stand-in proxy
if command -v node >/dev/null 2>&1 && [ -d "$ROOT/portal/node_modules" ]; then
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/ihc-portal-api.XXXXXX")"
  trap '{ kill $(jobs -p); wait; } 2>/dev/null || true; rm -rf "$TMP"' EXIT
  TOKEN="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40)"
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
  PPORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
  (cd "$ROOT/portal" && env -i PATH="$PATH" HOME="$TMP" PORT="$PORT" HOST=127.0.0.1 IHC_PORTAL_API_TOKEN="$TOKEN" \
    INVENTORY_PATH="$TMP/none.json" NPM_HEALTH_URL="http://127.0.0.1:9/" PLATFORM_STATUS_TIMEOUT_MS=500 \
    node src/server.js >"$TMP/portal.log" 2>&1) &
  # The proxy: only what the rule does (path + Authorization -> portal), sign-in otherwise.
  python3 -I - "$PPORT" "$PORT" >"$TMP/proxy.log" 2>&1 <<'PY' &
import http.server, sys, urllib.request
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/api/platform/status" and self.headers.get("Authorization"):
            req = urllib.request.Request("http://127.0.0.1:%s%s" % (sys.argv[2], self.path), headers={"Authorization": self.headers["Authorization"]})
            try:
                r = urllib.request.urlopen(req, timeout=20); code, body = r.status, r.read()
            except urllib.error.HTTPError as e:
                code, body = e.code, e.read()
            self.send_response(code); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(302); self.send_header("Location", "/outpost.goauthentik.io/start"); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
  mkdir -p "$TMP/i"
  printf 'PORTAL_BASE_URL=http://portal.cloud.localhost\nPROXY_HTTP_PORT=%s\nIHC_PORTAL_API_TOKEN=%s\n' "$PPORT" "$TOKEN" >"$TMP/i/.env"
  out="$(python3 -I "$ROOT/scripts/lib/portalapi.py" fetch "$TMP/i" 2>&1 || true)"
  if printf '%s' "$out" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r["source"]=="portal-api" and r["platform"]["services"] else 1)'; then
    echo "[ok] e2e: portalapi.py fetch reads the real portal (source portal-api)"
  else echo "[xx] e2e: expected source portal-api, got: $(printf '%s' "$out" | head -c 300)"; tail -5 "$TMP/portal.log"; FAILS=1; fi
  case "$out" in *"$TOKEN"*) echo "[xx] e2e: the token appears in the output"; FAILS=1 ;; esac
  printf 'PORTAL_BASE_URL=http://portal.cloud.localhost\nPROXY_HTTP_PORT=%s\nIHC_PORTAL_API_TOKEN=wrong-token-0000000000\n' "$PPORT" >"$TMP/i/.env"
  out="$(printf '{"status":"completed"}' | python3 -I "$ROOT/scripts/lib/portalapi.py" merge "$TMP/i")"
  if printf '%s' "$out" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r["source"]=="local" and r["portal_api"]["http_code"]==401 and r["status"]=="completed" else 1)'; then
    echo "[ok] e2e: a wrong token falls back to source local (HTTP 401), state kept"
  else echo "[xx] e2e: wrong token: $(printf '%s' "$out" | head -c 300)"; FAILS=1; fi
  c="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/apps")"
  [ "$c" = 403 ] && echo "[ok] e2e: the token on /api/apps is 403" || { echo "[xx] e2e: /api/apps with the token answered $c"; FAILS=1; }
else
  echo "[--] e2e skipped: node or portal/node_modules missing (cd portal && npm ci)"
fi

[ "$FAILS" = 0 ] && echo "portal-api: all cases pass" || { echo "portal-api: FAILED"; exit 1; }
