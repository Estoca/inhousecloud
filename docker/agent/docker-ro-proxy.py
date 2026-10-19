#!/usr/bin/env python3
"""Read-only Docker API for the operator agent (docs/operator-contract.md, docs/security.md).

Listens on 0.0.0.0:2375 on the agent's internal network and forwards an allowlist of
requests to the Docker socket mounted at /var/run/docker.sock. Standard library only.

Allowed (GET and HEAD; an optional /v1.NN prefix is accepted):
  /_ping /version /info /system/df
  /containers/json  /containers/ID/json  /containers/ID/logs  /containers/ID/top
  /containers/ID/stats  /images/json  /images/NAME/json  /networks  /networks/ID
  /volumes  /volumes/NAME
Every Env list in a container or image inspect comes back as variable NAMES only:
inspect is where the platform's passwords would otherwise leak. Logs and stats never
stream (follow and stream are forced off).

Writes, only when AGENT_ALLOW_WRITE=true (ops.agent.allow_write in the config):
  POST /containers/ID/restart   only for a container of an app's Compose project, never
                                one of the harness project (HARNESS_PROJECT)
  POST /build/prune             the build cache, never images or volumes
Everything else is refused with 403 and logged. Each request is logged to stdout as one
line (method, path, status): `docker compose logs agent-docker-proxy` is the audit trail.
"""
import http.client
import http.server
import json
import os
import re
import socket
import sys
import urllib.parse

SOCKET = os.environ.get("DOCKER_SOCKET_PATH", "/var/run/docker.sock")
HARNESS_PROJECT = os.environ.get("HARNESS_PROJECT", "harness")
ALLOW_WRITE = os.environ.get("AGENT_ALLOW_WRITE", "false").lower() == "true"
PORT = int(os.environ.get("PORT", "2375"))

ID = r"[A-Za-z0-9][A-Za-z0-9_.-]*"
NAME = r"[A-Za-z0-9][A-Za-z0-9_./:@-]*"
READ = [
    r"/_ping", r"/version", r"/info", r"/system/df",
    r"/containers/json", r"/containers/%s/json" % ID, r"/containers/%s/logs" % ID,
    r"/containers/%s/top" % ID, r"/containers/%s/stats" % ID,
    r"/images/json", r"/images/%s/json" % NAME,
    r"/networks", r"/networks/%s" % ID, r"/volumes", r"/volumes/%s" % ID,
]
READ_RE = [re.compile("^%s$" % p) for p in READ]
RESTART_RE = re.compile(r"^/containers/(%s)/restart$" % ID)
PRUNE_RE = re.compile(r"^/build/prune$")
VERSION_RE = re.compile(r"^/v1\.\d+(/.*)$")


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=60):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._path)
        self.sock = s


def docker(method, path, timeout=60):
    c = UnixHTTPConnection(SOCKET, timeout)
    c.request(method, path, headers={"Host": "docker"})
    r = c.getresponse()
    body = r.read()
    ctype = r.getheader("Content-Type", "application/octet-stream")
    c.close()
    return r.status, ctype, body


def names_only(env):
    return [e.split("=", 1)[0] for e in (env or [])]


def redact(path, body):
    """Env values out of container and image inspect output."""
    if not (path.startswith("/containers/") or path.startswith("/images/")) or not path.endswith("/json"):
        return body
    if path in ("/containers/json", "/images/json"):
        return body
    try:
        d = json.loads(body)
    except ValueError:
        return body
    for key in ("Config", "ContainerConfig"):
        if isinstance(d.get(key), dict) and "Env" in d[key]:
            d[key]["Env"] = names_only(d[key]["Env"])
    return json.dumps(d).encode()


def compose_project(cid):
    status, _, body = docker("GET", "/containers/%s/json" % cid)
    if status != 200:
        return None, status
    labels = (json.loads(body).get("Config") or {}).get("Labels") or {}
    return labels.get("com.docker.compose.project"), 200


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "harness-agent-docker-ro"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s\n" % (fmt % args))
        sys.stdout.flush()

    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def refuse(self, status, why):
        self.send(status, json.dumps({"message": "refused by the harness agent proxy: %s" % why}).encode())

    def split(self):
        u = urllib.parse.urlsplit(self.path)
        path = u.path
        m = VERSION_RE.match(path)
        if m:
            path = m.group(1)
        return path, urllib.parse.parse_qs(u.query, keep_blank_values=True)

    def forward(self, method, path, query):
        qs = urllib.parse.urlencode(query, doseq=True)
        try:
            status, ctype, body = docker(method, path + ("?" + qs if qs else ""))
        except OSError as e:
            return self.refuse(502, "docker socket: %s" % e)
        if method == "GET" and status == 200:
            body = redact(path, body)
        self.send(status, body, ctype)

    def unsafe(self, path):
        # No dot segments, escapes or empty segments: the daemon must see the path we matched.
        return "%" in path or "//" in path or any(seg in (".", "..") for seg in path.split("/"))

    def do_GET(self):
        path, query = self.split()
        if self.unsafe(path):
            return self.refuse(403, "path not allowed")
        if not any(r.match(path) for r in READ_RE):
            return self.refuse(403, "GET %s is not on the read allowlist" % path)
        if path.endswith("/logs"):
            query["follow"] = ["0"]
            if "stdout" not in query and "stderr" not in query:
                query["stdout"] = ["1"]; query["stderr"] = ["1"]
            query.setdefault("tail", ["200"])
        if path.endswith("/stats"):
            query["stream"] = ["0"]
        self.forward("GET", path, query)

    do_HEAD = do_GET

    def do_POST(self):
        path, query = self.split()
        if self.unsafe(path):
            return self.refuse(403, "path not allowed")
        if not ALLOW_WRITE:
            return self.refuse(403, "read only (ops.agent.allow_write is false); a human runs this")
        m = RESTART_RE.match(path)
        if m:
            project, status = compose_project(m.group(1))
            if status != 200:
                return self.refuse(404, "no such container")
            if not project or project == HARNESS_PROJECT:
                return self.refuse(403, "restart is allowed for app containers only, not %s" % (project or "a container outside Compose"))
            return self.forward("POST", path, {"t": query.get("t", ["10"])})
        if PRUNE_RE.match(path):
            return self.forward("POST", path, {})
        self.refuse(403, "POST %s is not on the write allowlist" % path)

    def _deny(self):
        self.refuse(403, "%s is never allowed" % self.command)

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _deny


def main():
    if not os.path.exists(SOCKET):
        sys.exit("no Docker socket at %s" % SOCKET)
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("read-only Docker API on :%d (writes: %s)" % (PORT, "restart of app containers, build cache prune" if ALLOW_WRITE else "none"), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
