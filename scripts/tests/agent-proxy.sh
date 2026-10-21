#!/usr/bin/env bash
# The agent's read-only Docker API (docker/agent/docker-ro-proxy.py), checked without Docker:
#
#   scripts/tests/agent-proxy.sh
#
# Starts a fake Docker daemon on a unix socket (it answers every request with a container
# inspect that carries secret values in Env, and records what reached it), then the proxy
# in front of it, read only and then with AGENT_ALLOW_WRITE=true. Checks that GETs on the
# allowlist pass with Env reduced to names, that everything else is refused before it
# reaches the daemon, and that with writes on only a restart of an app container and a
# build cache prune get through. Needs python3 only. Exit 1 on any surprise.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec python3 -I - "$ROOT/docker/agent/docker-ro-proxy.py" <<'PY'
import http.server, json, os, socket, socketserver, subprocess, sys, tempfile, threading, time, urllib.request

proxy_py = sys.argv[1]
work = tempfile.mkdtemp(prefix="ihc-agent-proxy.")
sock = os.path.join(work, "docker.sock")
seen = []

class Fake(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self):
        seen.append("%s %s" % (self.command, self.path.split("?")[0]))
        cid = self.path.split("/")[2] if self.path.startswith("/containers/") else ""
        project = "ihc" if cid == "core" else "demo-app"
        body = json.dumps({"Id": cid, "Config": {"Env": ["PASSWORD=s3cret-value", "PLAIN"],
                           "Labels": {"com.docker.compose.project": project}}}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_GET = do_POST = do_DELETE = reply

class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def get_request(self):
        r, _ = super().get_request(); return r, ("local", 0)

srv = UnixServer(sock, Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = 0
def check(ok, what):
    global fails
    print(("[ok] " if ok else "[xx] ") + what)
    if not ok: fails += 1

def start(port, write):
    env = dict(os.environ, DOCKER_SOCKET_PATH=sock, PORT=str(port), IHC_PROJECT="ihc", AGENT_ALLOW_WRITE=write)
    p = subprocess.Popen([sys.executable, "-I", proxy_py], env=env, stdout=subprocess.DEVNULL)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close(); return p
        except OSError: time.sleep(0.1)
    sys.exit("proxy did not start")

def call(port, method, path):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as r: return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()

ro = start(23751, "false")
try:
    st, body = call(23751, "GET", "/v1.47/containers/app1/json")
    check(st == 200 and json.loads(body)["Config"]["Env"] == ["PASSWORD", "PLAIN"], "GET inspect: 200, Env as names only")
    check("s3cret" not in body, "GET inspect: no secret value in the body")
    check(call(23751, "GET", "/containers/json?all=1")[0] == 200, "GET /containers/json: 200")
    n = len(seen)
    for m, p in [("POST", "/containers/app1/restart"), ("POST", "/containers/create"), ("POST", "/build/prune"),
                 ("POST", "/containers/app1/exec"), ("DELETE", "/containers/app1"), ("GET", "/secrets"),
                 ("GET", "/containers/app1/archive"), ("GET", "/containers/app1/export"), ("GET", "/../containers/json"),
                 ("GET", "/images/a/../../secrets/json"), ("GET", "/images/a%2F..%2Fx/json"), ("GET", "/containers//json")]:
        check(call(23751, m, p)[0] == 403, "read only: %s %s refused" % (m, p))
    check(len(seen) == n, "read only: nothing refused reached the daemon")
finally:
    ro.terminate()

rw = start(23752, "true")
try:
    seen.clear()
    check(call(23752, "POST", "/containers/app1/restart")[0] == 200 and "POST /containers/app1/restart" in seen, "allow_write: restart of an app container passes")
    check(call(23752, "POST", "/containers/core/restart")[0] == 403 and "POST /containers/core/restart" not in seen, "allow_write: restart of a cloud container refused")
    check(call(23752, "POST", "/build/prune")[0] == 200, "allow_write: build cache prune passes")
    for m, p in [("POST", "/containers/create"), ("POST", "/containers/app1/exec"), ("POST", "/containers/app1/stop"),
                 ("POST", "/images/prune"), ("POST", "/volumes/prune"), ("DELETE", "/containers/app1")]:
        check(call(23752, m, p)[0] == 403, "allow_write: %s %s refused" % (m, p))
    check(not [s for s in seen if s.split()[1] not in ("/containers/app1/restart", "/containers/app1/json", "/containers/core/json", "/build/prune")],
          "allow_write: only the allowlisted writes (and their inspect) reached the daemon")
finally:
    rw.terminate()
srv.shutdown()
print("agent proxy: %s" % ("all checks passed" if not fails else "%d failed" % fails))
sys.exit(1 if fails else 0)
PY
