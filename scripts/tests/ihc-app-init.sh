#!/usr/bin/env bash
# ihc-app init (an app that already exists, adopted from a laptop), without a box:
#
#   scripts/tests/ihc-app-init.sh
#
# Serves a fake Gitea on loopback (the API calls init makes, behind a token, and Git's
# smart HTTP for the push) and runs init the way a laptop does, with IHC_GITEA_URL and
# IHC_GITEA_TOKEN only. Checks that it (1) refuses a project with no Dockerfile, or whose
# compose file brings its own Postgres, before writing anything; (2) adds the manifest,
# workflow, compose file and .env.example to a Python project, never touching its code,
# with the port given, the organization found from the token and the data files ignored;
# (3) creates the repository and pushes main with --push; (4) on a project that already
# has a Git repository and an origin elsewhere, commits only what it added and uses the
# remote `cloud`; (5) writes a Dockerfile for a Node project and keeps a compose file's
# own service and port; (6) is idempotent. Fails (exit 1) on any surprise. Needs git, python3.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-app-init.XXXXXX")"
trap 'kill "${SRV:-0}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }
APP="$ROOT/scripts/ihc-app.sh"

mkdir -p "$WORK/srv"
cat > "$WORK/server.py" <<'PY'
import base64, http.server, json, os, subprocess, sys
root, token = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, obj=None):
        body = json.dumps(obj).encode() if obj is not None else b""
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)
    def api(self, method):
        auth = self.headers.get("Authorization", "")
        if auth not in ("token " + token, "token repo-only", "token no-user"):
            return self.reply(401, {"message": "token is required"})
        path = self.path.split("?")[0][len("/api/v1/"):].split("/")
        if auth != "token " + token and path == ["user", "orgs"]:   # Gitea: /user/* needs the user scope
            return self.reply(403, {"message": "token does not have at least one of required scope(s), required=[read:user read:organization]"})
        if auth == "token repo-only" and path[0] == "orgs":
            return self.reply(403, {"message": "token does not have at least one of required scope(s), required=[write:organization]"})
        n = int(self.headers.get("Content-Length") or 0); data = json.loads(self.rfile.read(n) or b"{}")
        if method == "GET" and path == ["user", "orgs"]:
            return self.reply(200, [{"username": "company"}])
        if path[:1] == ["repos"] and len(path) == 3:
            repo = os.path.join(root, path[1], path[2] + ".git")
            if not os.path.isdir(repo):
                return self.reply(404, {"message": "not found"})
            if method == "PATCH":
                return self.reply(200, {"has_actions": data.get("has_actions")})
            empty = subprocess.run(["git", "-C", repo, "rev-parse", "-q", "--verify", "refs/heads/main"], capture_output=True).returncode != 0
            return self.reply(200, {"empty": empty})
        if method == "POST" and path[0] == "orgs" and path[2] == "repos":
            repo = os.path.join(root, path[1], data["name"] + ".git")
            subprocess.run(["git", "init", "-q", "--bare", "-b", "main", repo], check=True)
            subprocess.run(["git", "-C", repo, "config", "http.receivepack", "true"], check=True)
            return self.reply(201, {"name": data["name"], "private": data.get("private")})
        return self.reply(404, {"message": "no route"})
    def git(self, method):
        auth = self.headers.get("Authorization", "")
        if not (auth.startswith("Basic ") and base64.b64decode(auth[6:]).decode().split(":", 1)[1] == token):
            self.send_response(401); self.send_header("WWW-Authenticate", 'Basic realm="x"'); self.end_headers(); return
        path, _, query = self.path.partition("?")
        n = int(self.headers.get("Content-Length") or 0)
        env = dict(os.environ, GIT_PROJECT_ROOT=root, GIT_HTTP_EXPORT_ALL="1", PATH_INFO=path, QUERY_STRING=query,
                   REQUEST_METHOD=method, CONTENT_TYPE=self.headers.get("Content-Type", ""), CONTENT_LENGTH=str(n),
                   REMOTE_USER="ihc")
        out = subprocess.run(["git", "http-backend"], env=env, input=self.rfile.read(n), capture_output=True).stdout
        head, _, body = out.partition(b"\r\n\r\n")
        self.send_response(200)
        for l in head.split(b"\r\n"):
            k, _, v = l.partition(b": ")
            if k.lower() == b"content-type": self.send_header("Content-Type", v.decode())
        self.end_headers(); self.wfile.write(body)
    def route(self, method):
        if self.path.startswith("/api/v1/"): self.api(method)
        else: self.git(method)
    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def do_PATCH(self): self.route("PATCH")
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print(srv.server_port, flush=True); srv.serve_forever()
PY
python3 -I "$WORK/server.py" "$WORK/srv" goodtoken > "$WORK/port" & SRV=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$WORK/port" ] && break; sleep 0.3; done
PORT="$(cat "$WORK/port")"

# The laptop: no install directory, the person's own Git identity and token.
export IHC_GITEA_URL="http://127.0.0.1:$PORT" IHC_GITEA_TOKEN=goodtoken IHC_BASE_DOMAIN=cloud.test
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_NOSYSTEM=1
printf '[user]\n\tname = Ana Example\n\temail = ana@example.com\n' > "$GIT_CONFIG_GLOBAL"
init() { "$APP" init "$@" --install-dir "$WORK/no-install" > "$WORK/out" 2>&1; }
sums() { (cd "$1" && find . -path ./.git -prune -o -type f -print | sort | xargs shasum 2>/dev/null || true); }

# 1. A Python project with no Dockerfile: refused, nothing written.
P="$WORK/rooms"; mkdir -p "$P"
printf 'import os\nprint("rooms")\n' > "$P/app.py"; printf '<html></html>\n' > "$P/index.html"; printf 'sqlite' > "$P/rooms.db"
before="$(sums "$P")"
if init rooms --dir "$P"; then bad "no Dockerfile: init passed"; else
  if [ "$(sums "$P")" = "$before" ] && [ ! -d "$P/.git" ] && grep -q "no Dockerfile" "$WORK/out"; then pass "no Dockerfile: refused, nothing written"; else bad "no Dockerfile: $(cat "$WORK/out")"; fi
fi

# 2 and 3. With a Dockerfile: the files, the commit, the repository and the push.
printf 'FROM python:3.13-slim\nWORKDIR /app\nCOPY . .\nCMD ["python", "app.py"]\n' > "$P/Dockerfile"
code="$(cd "$P" && shasum app.py index.html Dockerfile)"
if init rooms --dir "$P" --port 8000 --push; then
  m="$P/company-app.yaml"
  if [ -f "$m" ] && [ -f "$P/.gitea/workflows/deploy.yml" ] && [ -f "$P/docker-compose.yml" ] && [ -f "$P/.env.example" ]; then pass "files added: manifest, workflow, compose file, .env.example"; else bad "files missing: $(ls -A "$P")"; fi
  [ "$code" = "$(cd "$P" && shasum app.py index.html Dockerfile)" ] && pass "the app's code is untouched" || bad "the app's code changed"
  if grep -q '^  slug: rooms$' "$m" && grep -q '^  port: 8000$' "$m" && grep -q '^  domain: rooms.cloud.test$' "$m" && grep -q '^  owner_email: ana@example.com$' "$m" \
     && ! grep -q '^mcp:' "$m" && ! grep -q '__APP_' "$m" "$P/.gitea/workflows/deploy.yml"; then pass "manifest: slug, port 8000, domain, owner from git, no MCP section"; else bad "manifest: $(cat "$m")"; fi
  python3 "$ROOT/scripts/lib/appmanifest.py" vars "$m" rooms >/dev/null && pass "manifest validates" || bad "manifest does not validate"
  grep -q '"${PORT:-8000}:8000"' "$P/docker-compose.yml" && pass "compose file on port 8000" || bad "compose: $(cat "$P/docker-compose.yml")"
  grep -qxF '*.db' "$P/.gitignore" && ! git -C "$P" ls-files --error-unmatch rooms.db >/dev/null 2>&1 && pass "local data (rooms.db) ignored, not committed" || bad "rooms.db committed or not ignored"
  [ "$(git -C "$P" remote get-url origin)" = "$IHC_GITEA_URL/company/rooms.git" ] && pass "origin is company/rooms (organization found from the token)" || bad "origin: $(git -C "$P" remote -v)"
  [ "$(git -C "$WORK/srv/company/rooms.git" rev-parse main 2>/dev/null)" = "$(git -C "$P" rev-parse HEAD)" ] && pass "--push: main on the server is the local commit" || bad "push: $(cat "$WORK/out")"
  ! grep -q goodtoken "$WORK/out" "$P/.git/config" && pass "the token is in no output and no remote URL" || bad "token leaked"
else bad "Python project with a Dockerfile: $(cat "$WORK/out")"; fi

# 6. Idempotent: a second run adds and commits nothing.
head1="$(git -C "$P" rev-parse HEAD)"
if init rooms --dir "$P" --port 8000 && [ "$(git -C "$P" rev-parse HEAD)" = "$head1" ] && grep -q "nothing to add" "$WORK/out" && grep -q "has commits" "$WORK/out"; then pass "second run: nothing added, no commit"; else bad "second run: $(cat "$WORK/out")"; fi

# A compose file with its own Postgres: refused, nothing written.
Q="$WORK/withdb"; mkdir -p "$Q"
printf 'services:\n  web:\n    build: .\n    ports: ["3000:3000"]\n  db:\n    image: postgres:17\n' > "$Q/docker-compose.yml"; printf 'FROM scratch\n' > "$Q/Dockerfile"
before="$(sums "$Q")"
if init withdb --dir "$Q"; then bad "local Postgres: init passed"; else
  [ "$(sums "$Q")" = "$before" ] && grep -q "shared Postgres" "$WORK/out" && pass "compose file with its own Postgres: refused with the alternative, nothing written" || bad "local Postgres: $(cat "$WORK/out")"
fi

# 4 and 5. A Node project already in Git, origin on another host, compose service `web` on 3000.
N="$WORK/notes"; mkdir -p "$N"
printf '{"name":"notes","scripts":{"start":"node index.js"}}\n' > "$N/package.json"; printf 'console.log(1)\n' > "$N/index.js"
printf 'services:\n  web:\n    build: .\n    ports:\n      - "3000:3000"\n' > "$N/compose.yaml"
git -C "$N" init -q -b main; git -C "$N" add -A; git -C "$N" commit -q -m first; git -C "$N" remote add origin https://example.com/ana/notes.git
printf 'wip\n' > "$N/scratch.txt"
if init notes --dir "$N"; then
  grep -q '^  service: web$' "$N/company-app.yaml" && grep -q '^  port: 3000$' "$N/company-app.yaml" && grep -q '^  compose_file: compose.yaml$' "$N/company-app.yaml" \
    && pass "compose file kept: service web, port 3000, compose.yaml in the manifest" || bad "manifest: $(cat "$N/company-app.yaml")"
  [ ! -e "$N/docker-compose.yml" ] && grep -q 'npm", "start' "$N/Dockerfile" && pass "Node project: Dockerfile written (npm start), no second compose file" || bad "Node files: $(ls -A "$N")"
  [ "$(git -C "$N" remote get-url origin)" = https://example.com/ana/notes.git ] && [ "$(git -C "$N" remote get-url cloud)" = "$IHC_GITEA_URL/company/notes.git" ] \
    && pass "origin kept, the cloud is the remote 'cloud'" || bad "remotes: $(git -C "$N" remote -v)"
  git -C "$N" ls-files --error-unmatch scratch.txt >/dev/null 2>&1 && bad "an unrelated change was committed" || pass "only the added files committed (scratch.txt left alone)"
  grep -q 'git push cloud HEAD:main' "$WORK/out" && pass "says how to push" || bad "next step: $(cat "$WORK/out")"
else bad "Node project: $(cat "$WORK/out")"; fi

# A wrong token: a clear message, before any file is written.
R="$WORK/badtoken"; mkdir -p "$R"; printf 'FROM scratch\n' > "$R/Dockerfile"
if IHC_GITEA_TOKEN=wrong IHC_BASE_DOMAIN=cloud.test "$APP" init badtoken --dir "$R" --install-dir "$WORK/no-install" > "$WORK/out" 2>&1; then bad "wrong token: init passed"; else
  [ "$(ls -A "$R")" = Dockerfile ] && grep -q "does not accept IHC_GITEA_TOKEN" "$WORK/out" && pass "wrong token: refused before writing" || bad "wrong token: $(cat "$WORK/out")"
fi

# A token without the user scope (organization and repository only, what first-user.md asks
# for): the organization falls back to company. Repository only: a message about the token.
S="$WORK/scoped"; mkdir -p "$S"; printf 'FROM scratch\n' > "$S/Dockerfile"
if IHC_GITEA_TOKEN=no-user "$APP" init scoped --dir "$S" --install-dir "$WORK/no-install" > "$WORK/out" 2>&1 \
   && grep -q "using company" "$WORK/out" && [ -d "$WORK/srv/company/scoped.git" ]; then pass "token without user scope: organization company, repository created"; else bad "no user scope: $(cat "$WORK/out")"; fi
S="$WORK/repoonly"; mkdir -p "$S"; printf 'FROM scratch\n' > "$S/Dockerfile"
if IHC_GITEA_TOKEN=repo-only "$APP" init repoonly --dir "$S" --install-dir "$WORK/no-install" > "$WORK/out" 2>&1; then bad "repository-only token: init passed"; else
  grep -q "organization and repository Read and Write" "$WORK/out" && pass "repository-only token: says which token to make" || bad "repository-only token: $(cat "$WORK/out")"
fi

[ "$FAILS" = 0 ] && echo "ihc-app-init: all cases pass" || { echo "ihc-app-init: FAILED"; exit 1; }
