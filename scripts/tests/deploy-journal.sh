#!/usr/bin/env bash
# The deploy journal, rollback's refusals and apply's merged-commit gate, without a box:
#
#   scripts/tests/deploy-journal.sh
#
# Checks that (1) deployjournal.py groups a journal into transactions and picks what rollback
# undoes in reverse order: the newest applied deploy not undone yet, never one that changed
# nothing, refusing the app's first deploy and a stack already undone; (2) envdiff names the
# keys added, removed and changed and never prints a value; (3) the pin overlay resets every
# build and prune keeps the newest releases plus the ones asked for; (4) appmanifest.py
# build-check refuses build secrets, ssh, a host network and contexts outside the repository,
# and accepts a plain build; (5) `ihc-app rollback` refuses, writing nothing, with no journal,
# with nothing to go back to, with the target release gone, and while another apply holds the
# app's lock; (6) `ihc-app apply` against a fake Gitea refuses a run that is not for main and a
# commit that is not on main, skips an older commit of main as superseded, and journals nothing
# in those cases. Fails (exit 1) on any surprise. Needs python3 and git; not Docker.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-journal.XXXXXX")"
SRV=""; HOLD=""
# shellcheck disable=SC2086
trap 'for p in $SRV $HOLD; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }
DJ="python3 -I $ROOT/scripts/lib/deployjournal.py"
APP="$ROOT/scripts/ihc-app.sh"

# ------------------------------------------------------------- (1) undo order
J="$WORK/j.jsonl"
add() { printf '%s\n' "$1" | $DJ append "$J"; }
tx() { # TX OP BEFORE AFTER APPLIED RESULT [REVERTS]
  add "{\"tx\":\"$1\",\"phase\":\"begin\",\"op\":\"$2\",\"reverts\":\"${7:-}\",\"before\":{\"release\":\"$3\",\"commit\":\"c-$3\"},\"after\":{\"release\":\"$4\",\"commit\":\"c-$4\"}}"
  [ "$5" = yes ] && add "{\"tx\":\"$1\",\"phase\":\"step\",\"step\":\"applied\"}"
  [ "$6" = none ] || add "{\"tx\":\"$1\",\"phase\":\"end\",\"result\":\"$6\"}"
}
undo() { $DJ undo-target "$J" 2>"$WORK/why"; }
target_of() { undo | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["reverts"],d["to_release"])'; }

if out="$(undo)"; then bad "an empty journal has an undo target: $out"; else grep -q 'no deploy' "$WORK/why" && pass "empty journal: nothing to roll back to" || bad "empty journal: $(cat "$WORK/why")"; fi
tx t1 deploy "" r1 yes ok
if out="$(undo)"; then bad "the first deploy has an undo target: $out"; else grep -q 'first deploy' "$WORK/why" && pass "first deploy: refused, it replaced nothing the journal has" || bad "first deploy: $(cat "$WORK/why")"; fi
tx t2 deploy r1 r2 yes ok
tx t3 deploy r2 r3 no failed            # provision failed: the containers never changed
tx t4 deploy r2 r3 no none              # interrupted before up
[ "$(target_of)" = "t2 r1" ] && pass "undo skips deploys that changed nothing: t2 back to r1" || bad "undo target: $(target_of)"
tx t5 deploy r2 r4 yes unhealthy
[ "$(target_of)" = "t5 r2" ] && pass "an unhealthy deploy that ran is undone first: t5 back to r2" || bad "undo target: $(target_of)"
tx t6 rollback r4 r2 yes ok t5
[ "$(target_of)" = "t2 r1" ] && pass "after rolling t5 back, the next undo is t2 (reverse order)" || bad "undo target after a rollback: $(target_of)"
tx t7 deploy r2 r5 yes ok
[ "$(target_of)" = "t7 r2" ] && pass "a deploy after a rollback goes on top" || bad "undo target: $(target_of)"
tx t8 rollback r5 r2 no failed t7        # a rollback that failed before up undoes nothing
[ "$(target_of)" = "t7 r2" ] && pass "a rollback that changed nothing does not count" || bad "undo target: $(target_of)"
tx t9 rollback r5 r2 yes ok t7; tx t10 rollback r2 r1 yes ok t2
if out="$(undo)"; then bad "an undone stack still has a target: $out"; else grep -q 'first deploy' "$WORK/why" && pass "back at the first deploy: refused" || bad "undone stack: $(cat "$WORK/why")"; fi
n="$($DJ show "$J" --json --limit 50 | python3 -c 'import json,sys;t=json.load(sys.stdin);print(len(t),t[0]["tx"],[x["result"] for x in t if x["tx"]=="t4"][0])')"
[ "$n" = "10 t10 interrupted" ] && pass "show: 10 transactions, newest first, t4 interrupted" || bad "show: $n"
$DJ show "$J" | grep -q 'undoes t2' && pass "show (text) says what a rollback undid" || bad "show text: $($DJ show "$J" | head -n 3)"

# ------------------------------------------------------------- (2) envdiff
printf 'A="1"\nB="secret-old-value"\nC="x"\n' > "$WORK/e1"; printf 'A="1"\nB="secret-new-value"\nD="y"\n' > "$WORK/e2"
d="$($DJ envdiff "$WORK/e1" "$WORK/e2")"
[ "$d" = '{"env_keys_added": ["D"], "env_keys_changed": ["B"], "env_keys_removed": ["C"]}' ] && pass "envdiff: D added, B changed, C removed" || bad "envdiff: $d"
case "$d" in *secret*) bad "envdiff printed a value" ;; *) pass "envdiff prints names only" ;; esac

# ------------------------------------------------------------- (3) pin, prune
p="$(printf '{"app":"ihc-release/x/app:r1"}' | $DJ pin x)"
case "$p" in *'build: !reset null'*'image: "ihc-release/x/app:r1"'*'pull_policy: never'*) pass "pin: build reset, release image, never pulled" ;; *) bad "pin: $p" ;; esac
mkdir -p "$WORK/rel"; for r in 20261101T100000Z-aaaaaaa 20261101T110000Z-bbbbbbb 20261101T120000Z-ccccccc 20261101T130000Z-ddddddd; do mkdir "$WORK/rel/$r"; done
pr="$($DJ prune "$WORK/rel" 2 20261101T100000Z-aaaaaaa | tr '\n' ' ')"
[ "$pr" = "20261101T110000Z-bbbbbbb " ] && pass "prune: keeps the 2 newest and the protected one" || bad "prune: $pr"

# ------------------------------------------------------------- (4) build-check
mkdir -p "$WORK/repo/sub"
bc() { printf '%s' "$1" | python3 -I "$ROOT/scripts/lib/appmanifest.py" build-check "$WORK/repo" 2>"$WORK/bc.err"; }
if bc "{\"services\":{\"app\":{\"build\":{\"context\":\"$WORK/repo\",\"dockerfile\":\"Dockerfile\"}},\"w\":{\"build\":{\"context\":\"$WORK/repo/sub\"}},\"db\":{\"image\":\"nginx\"}}}"; then pass "build-check accepts builds inside the repository"; else bad "build-check refused a plain build: $(cat "$WORK/bc.err")"; fi
for case in \
  "secrets|{\"context\":\"$WORK/repo\",\"secrets\":[{\"source\":\"env\"}]}" \
  "ssh|{\"context\":\"$WORK/repo\",\"ssh\":[\"default\"]}" \
  "network|{\"context\":\"$WORK/repo\",\"network\":\"host\"}" \
  "outside|{\"context\":\"$WORK\"}" \
  "dockerfile|{\"context\":\"$WORK/repo\",\"dockerfile\":\"../Dockerfile\"}" \
  "additional_contexts|{\"context\":\"$WORK/repo\",\"additional_contexts\":{\"up\":\"$WORK\"}}"; do
  what="${case%%|*}"
  if bc "{\"services\":{\"app\":{\"build\":${case#*|}}}}"; then bad "build-check accepted build $what"; else pass "build-check refuses build $what: $(head -n 1 "$WORK/bc.err" | cut -c1-90)"; fi
done

# ------------------------------------------------------------- fake box and Gitea
I="$WORK/install"; mkdir -p "$I/catalog" "$I/apps"; chmod 755 "$I/catalog"
HEAD_SHA=1111111111111111111111111111111111111111
OLD_SHA=2222222222222222222222222222222222222222
cat > "$WORK/gitea.py" <<'PY'
import http.server, json, sys
head, old = sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.headers.get("Authorization") != "token test-admin-token":
            self.send_response(401); self.end_headers(); return
        p = self.path.split("?")[0]
        if p == "/api/v1/repos/company/demo/branches/main":
            body = {"name": "main", "commit": {"id": head}}
        elif p == "/api/v1/repos/company/demo/commits":
            body = [{"sha": head}, {"sha": old}]
        else:
            self.send_response(404); self.end_headers(); return
        b = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(b)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(s.server_port))
s.serve_forever()
PY
python3 "$WORK/gitea.py" "$WORK/port" "$HEAD_SHA" "$OLD_SHA" & SRV=$!
for _ in $(seq 1 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
cat > "$I/.env" <<EOF
COMPOSE_PROJECT_NAME="ihc"
BASE_DOMAIN="cloud.localhost"
PORTAL_BASE_URL="http://portal.cloud.localhost"
GITEA_BASE_URL="http://git.cloud.localhost"
GITEA_ORGANIZATION="company"
GITEA_ADMIN_TOKEN="test-admin-token"
GITEA_LOCAL_PORT="$(cat "$WORK/port")"
AUTHENTIK_LOCAL_PORT="1"
PROXY_ADMIN_PORT="1"
PROXY_HTTP_PORT="1"
EOF
chmod 600 "$I/.env"
run() { env -u GITHUB_SHA -u GITHUB_REF -u GITHUB_REPOSITORY -u GITHUB_ACTOR IHC_ENDPOINTS=loopback "$@" 2>&1; }
JF="$I/catalog/deploys/demo.jsonl"
release() { # RID COMMIT
  mkdir -p "$I/deploys/demo/releases/$1/src"
  printf '{"slug":"demo","release":"%s","commit":"%s","repository":"company/demo","project_dir":"","manifest":"company-app.yaml","images":{"app":{"tag":"ihc-release/demo/app:%s","id":"sha256:none"}}}' "$1" "$2" "$1" > "$I/deploys/demo/releases/$1/release.json"
  printf 'services: {}\n' > "$I/deploys/demo/releases/$1/pin.yml"
}

# ------------------------------------------------------------- (5) rollback refusals
rc=0; out="$(run "$APP" rollback demo --yes --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'no deploy journal' && pass "rollback without a journal: refused" || bad "rollback without a journal: rc=$rc $out"
J="$JF"; mkdir -p "$I/catalog/deploys"
tx t1 deploy "" 20261101T100000Z-aaaaaaa yes ok
sum0="$(cksum < "$JF")"
rc=0; out="$(run "$APP" rollback demo --yes --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'nothing to roll back to' && pass "rollback after the first deploy: refused" || bad "rollback after the first deploy: rc=$rc $out"
[ "$(cksum < "$JF")" = "$sum0" ] && pass "a refused rollback writes nothing to the journal" || bad "a refused rollback changed the journal"
tx t2 deploy 20261101T100000Z-aaaaaaa 20261101T110000Z-bbbbbbb yes ok
rc=0; out="$(run "$APP" rollback demo --yes --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'no longer on the box' && pass "rollback to a pruned release: refused" || bad "rollback to a pruned release: rc=$rc $out"
release 20261101T100000Z-aaaaaaa "$OLD_SHA"
rc=0; out="$(run "$APP" rollback demo --yes --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'cannot be started again' && pass "rollback to a release whose image is gone: refused" || bad "rollback with the image gone: rc=$rc $out"
mkdir -p "$I/deploys/demo"; : > "$I/deploys/demo/lock"
python3 -c 'import fcntl,sys,time
f=open(sys.argv[1],"a"); fcntl.flock(f, fcntl.LOCK_EX); open(sys.argv[2],"w").write("held"); time.sleep(60)' "$I/deploys/demo/lock" "$WORK/held" & HOLD=$!
for _ in $(seq 1 50); do [ -s "$WORK/held" ] && break; sleep 0.1; done
printf 'deploy of 1111 by test, pid 1, since now\n' > "$I/deploys/demo/lock.holder"
rc=0; out="$(run "$APP" rollback demo --yes --lock-timeout 1 --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'another apply or rollback of demo is running (deploy of 1111' && pass "rollback while the lock is held: refused, says who holds it" || bad "rollback under the lock: rc=$rc $out"
kill "$HOLD" 2>/dev/null || true; wait "$HOLD" 2>/dev/null || true; HOLD=""
[ "$(wc -l < "$JF" | tr -d ' ')" = 6 ] && pass "the journal still has only the two deploys" || bad "journal lines: $(wc -l < "$JF")"

# ------------------------------------------------------------- (6) apply's gate
release 20261101T120000Z-111111111111 "$HEAD_SHA"; release 20261101T090000Z-222222222222 "$OLD_SHA"
lines0="$(wc -l < "$JF" | tr -d ' ')"
rc=0; out="$(run env GITHUB_REF=refs/heads/feature GITHUB_REPOSITORY=company/demo "$APP" apply demo --release 20261101T120000Z-111111111111 --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'only commits merged into main' && pass "apply of a run for another branch: refused" || bad "apply for a branch: rc=$rc $out"
release 20261101T130000Z-333333333333 3333333333333333333333333333333333333333
rc=0; out="$(run env GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=company/demo "$APP" apply demo --release 20261101T130000Z-333333333333 --install-dir "$I")" || rc=$?
[ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'is not on main of company/demo' && pass "apply of a commit not on main: refused" || bad "apply of a commit not on main: rc=$rc $out"
rc=0; out="$(run env GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=company/demo "$APP" apply demo --release 20261101T090000Z-222222222222 --install-dir "$I")" || rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'moved on to 111111111111' && pass "apply of an older commit of main: skipped as superseded (exit 0)" || bad "apply superseded: rc=$rc $out"
rc=0; out="$(run env GITHUB_REF=refs/heads/main GITHUB_REPOSITORY=company/demo "$APP" apply demo --release 20261101T120000Z-111111111111 --install-dir "$I")" || rc=$?
printf '%s' "$out" | grep -q 'is the head of main' && [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'incomplete on the box' \
  && pass "apply of the head of main passes the gate (then stops: no images in this test)" || bad "apply of the head: rc=$rc $out"
[ "$(wc -l < "$JF" | tr -d ' ')" = "$lines0" ] && pass "refused and skipped applies journal nothing" || bad "the journal grew: $(wc -l < "$JF") lines"
[ -z "$(ls "$I/apps")" ] && pass "nothing written under apps/" || bad "apps/ has: $(ls "$I/apps")"

[ "$FAILS" = 0 ] && { printf 'deploy journal: all checks passed\n'; exit 0; }
printf 'deploy journal: %d check(s) failed\n' "$FAILS"; exit 1
