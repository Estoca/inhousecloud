#!/usr/bin/env bash
# The authenticated Git probe (git_auth_probe in scripts/lib/common.sh), without a box:
#
#   scripts/tests/git-probe.sh
#
# Serves a bare repository over Git's smart HTTP protocol on loopback, behind a token, and
# checks that the probe (1) passes at once with the right token, (2) keeps trying while the
# server still answers 401 and passes once it stops (the readiness race), and (3) fails,
# bounded, with a wrong token. Fails (exit 1) on any surprise. Needs git and python3.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-git-probe.XXXXXX")"
trap 'kill "${SRV:-0}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }

git init -q --bare "$WORK/srv/app.git"
cat > "$WORK/server.py" <<'PY'
import base64, http.server, os, subprocess, sys
root, token, refuse = sys.argv[1], sys.argv[2], int(sys.argv[3])
seen = {"n": 0}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        path, _, query = self.path.partition("?")
        auth = self.headers.get("Authorization", "")
        ok = auth.startswith("Basic ") and base64.b64decode(auth[6:]).decode().split(":", 1)[1] == token
        if ok:
            seen["n"] += 1
        if not ok or seen["n"] <= refuse:   # the first `refuse` good requests meet a service not ready
            self.send_response(401); self.send_header("WWW-Authenticate", 'Basic realm="x"'); self.end_headers(); return
        env = dict(os.environ, GIT_PROJECT_ROOT=root, GIT_HTTP_EXPORT_ALL="1", PATH_INFO=path, QUERY_STRING=query, REQUEST_METHOD="GET")
        out = subprocess.run(["git", "http-backend"], env=env, capture_output=True).stdout
        head, _, body = out.partition(b"\r\n\r\n")
        self.send_response(200)
        for l in head.split(b"\r\n"):
            k, _, v = l.partition(b": ")
            if k.lower() == b"content-type": self.send_header("Content-Type", v.decode())
        self.end_headers(); self.wfile.write(body)
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True); srv.serve_forever()
PY
start() { # REFUSE: starts the server, sets PORT
  if [ -n "${SRV:-}" ]; then kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; fi
  python3 -I "$WORK/server.py" "$WORK/srv" goodtoken "$1" > "$WORK/port" & SRV=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port" ] && break; sleep 0.3; done
  PORT="$(cat "$WORK/port")"; : > "$WORK/port"
}
askpass() { # TOKEN
  printf '#!/bin/sh\ncase "$1" in *sername*) echo ihc ;; *) echo "%s" ;; esac\n' "$1" > "$WORK/ap"; chmod 700 "$WORK/ap"
}
. "$ROOT/scripts/lib/common.sh" 2>/dev/null
have git || { echo "git missing"; exit 1; }

start 0; askpass goodtoken
if git_auth_probe "http://127.0.0.1:$PORT/app.git" "$WORK/ap" 10 1 && [ "$GIT_PROBE_TRIES" = 1 ]; then pass "right token: answers on the first try"; else bad "right token: tries=$GIT_PROBE_TRIES err=$GIT_PROBE_ERR"; fi

start 2; askpass goodtoken
if git_auth_probe "http://127.0.0.1:$PORT/app.git" "$WORK/ap" 20 1 && [ "$GIT_PROBE_TRIES" -ge 3 ]; then pass "service not ready for 2 requests: passes after $GIT_PROBE_TRIES tries"; else bad "race: tries=$GIT_PROBE_TRIES err=$GIT_PROBE_ERR"; fi

start 0; askpass wrongtoken
t0=$(date +%s)
if git_auth_probe "http://127.0.0.1:$PORT/app.git" "$WORK/ap" 3 1; then bad "wrong token: the probe passed"; else
  el=$(( $(date +%s) - t0 ))
  if [ "$el" -le 8 ] && [ "$GIT_PROBE_TRIES" -ge 2 ]; then pass "wrong token: fails after $GIT_PROBE_TRIES tries in ${el}s ($GIT_PROBE_ERR)"; else bad "wrong token: tries=$GIT_PROBE_TRIES in ${el}s"; fi
fi
[ "$FAILS" = 0 ] && echo "git-probe: all cases pass" || { echo "git-probe: FAILED"; exit 1; }
