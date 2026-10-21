#!/usr/bin/env bash
# Minimal backup job (docs/install-design.md "Backup", docs/backup.md).
#
#   scripts/ihc-backup.sh [--install-dir DIR] run                 dump + volumes + config into restic, apply retention
#   scripts/ihc-backup.sh [--install-dir DIR] verify --latest [--json]   check the newest run: manifest, checksums, snapshots, repository
#   scripts/ihc-backup.sh [--install-dir DIR] status [--json]    the status file the portal reads, plus its age
#
# The work happens inside the `backup` container (docker/backup/Dockerfile: restic,
# pg_dump, bash, python3), where this same file is installed as `ihc-backup`.
# On the host this script is a thin wrapper that execs it there. In the container:
#   /ihc   the install directory, read-only   (config, .env, compose.yml, state.json)
#   /backups   BACKUP_DESTINATION, read-write     (restic/ repository and reports/)
#   /volumes   the named volumes, read-only
# Every dump streams from pg_dump straight into `restic backup --stdin`: nothing is
# staged on disk. One run = one manifest (reports/runs/<run_id>.json) and the status
# file reports/latest-status.json (status, started_at, finished_at, snapshot_id, error).
# A lock (atomic mkdir) refuses a second concurrent run; a hard timeout
# (BACKUP_MAX_RUN_MINUTES) kills a hung run and records it as failed.
set -eu

PY="python3 -I"
_out()  { printf '%s\n' "$*" >&2; }
log()   { _out "    $*"; }
ok()    { _out "[ok] $*"; }
warn()  { _out "[!!] $*"; }
fail()  { _out "[xx] $*"; }
die()   { fail "$*"; exit 1; }
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

# ============================================================ host wrapper
if [ -z "${IHC_BACKUP_CONTAINER:-}" ]; then
  IHC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  # shellcheck source=lib/common.sh
  . "$IHC_ROOT/scripts/lib/common.sh"
  INSTALL_DIR="${IHC_INSTALL_DIR:-/opt/inhousecloud}"
  ARGS=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --install-dir) INSTALL_DIR="$2"; shift ;;
      --install-dir=*) INSTALL_DIR="${1#*=}" ;;
      -h|--help) usage; exit 0 ;;
      *) ARGS="$ARGS $1" ;;
    esac
    shift
  done
  INSTALL_DIR="${INSTALL_DIR%/}"
  ENV_FILE="$INSTALL_DIR/.env"
  STATE_FILE="$INSTALL_DIR/state.json"
  load_env
  [ "${BACKUP_ENABLED:-true}" = true ] || die "backup is disabled in this installation (BACKUP_ENABLED=false in $ENV_FILE)"
  # shellcheck disable=SC2086
  set -- $ARGS
  [ $# -gt 0 ] || { usage; exit 1; }
  if [ -n "$(dc ps -q --status running backup 2>/dev/null)" ]; then
    exec docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yml" exec -T backup ihc-backup "$@"
  else
    exec docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yml" run --rm --no-deps -T --entrypoint ihc-backup backup "$@"
  fi
fi

# ============================================================ in container
umask 022   # reports/ is read by the portal: 0755 directories, 0644 files
BACKUPS=/backups
IHC=/ihc
VOLUMES=/volumes
REPORTS="$BACKUPS/reports"
RUNS="$REPORTS/runs"
STATUS_FILE="$REPORTS/latest-status.json"
SUCCESS_FILE="$REPORTS/latest-success.json"
LOCK_DIR="$BACKUPS/.lock"
export RESTIC_REPOSITORY="$BACKUPS/restic"
export RESTIC_HOST=ihc
export RESTIC_CACHE_DIR="${RESTIC_CACHE_DIR:-/var/cache/restic}"
MAX_MIN="${BACKUP_MAX_RUN_MINUTES:-240}"
MAX_AGE_H="${BACKUP_MAX_AGE_HOURS:-26}"
KEEP_D="${BACKUP_RETENTION_DAILY:-7}"; KEEP_W="${BACKUP_RETENTION_WEEKLY:-4}"; KEEP_M="${BACKUP_RETENTION_MONTHLY:-12}"
JSON_OUTPUT=false
TMP=""

[ -n "${RESTIC_PASSWORD:-}" ] || die "RESTIC_PASSWORD is empty: BACKUP_ENCRYPTION_KEY missing from .env"
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
redact() { # repository string without credentials
  $PY -c 'import sys,re;print(re.sub(r"://([^/@:]+):[^/@]*@", r"://\1:***@", sys.argv[1]))' "$1"
}
REPO_SHOWN="$(redact "$RESTIC_REPOSITORY")"

# json_write FILE key=value key:=json ...  (atomic; 0644)
json_write() {
  local f="$1"; shift
  $PY - "$f" "$@" <<'EOF'
import json, os, sys, tempfile
path, args = sys.argv[1], sys.argv[2:]
out = {}
for a in args:
    if ":=" in a.split("=", 1)[0] + "=" and ":=" in a:
        k, v = a.split(":=", 1); out[k] = json.loads(v)
    else:
        k, v = a.split("=", 1); out[k] = v
d = os.path.dirname(path); os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(prefix=".status.", dir=d)
with os.fdopen(fd, "w") as f:
    json.dump(out, f, indent=2); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
EOF
}
# json_get FILE PATH [DEFAULT]
json_get() {
  $PY - "$@" <<'EOF'
import json, sys
path, key = sys.argv[1], sys.argv[2]
default = sys.argv[3] if len(sys.argv) > 3 else ""
try:
    cur = json.load(open(path))
    for p in key.split("."):
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
except Exception:
    print(default); sys.exit(0)
if cur is None: print(default)
elif isinstance(cur, bool): print("true" if cur else "false")
elif isinstance(cur, (str, int, float)): print(cur)
else: print(json.dumps(cur))
EOF
}
sha256_file() { sha256sum "$1" | awk '{print $1}'; }

# Status file: the contract the portal reads (docs/backup.md).
write_status() { # STATUS RUN_ID STARTED FINISHED SNAPSHOT_ID ERROR [extra key=value...]
  local st="$1" run="$2" started="$3" finished="$4" snap="$5" err="$6"; shift 6
  local errj='null'; [ -n "$err" ] && errj="$($PY -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$err")"
  local dur=0
  [ -n "$finished" ] && dur="$($PY -c 'import sys,datetime as d;f=lambda s:d.datetime.strptime(s,"%Y-%m-%dT%H:%M:%SZ");print(int((f(sys.argv[2])-f(sys.argv[1])).total_seconds()))' "$started" "$finished")"
  json_write "$STATUS_FILE" schema_version:=1 status="$st" run_id="$run" started_at="$started" finished_at="$finished" \
    duration_seconds:="$dur" snapshot_id="$snap" error:="$errj" repository="$REPO_SHOWN" \
    schedule="${BACKUP_SCHEDULE:-}" timezone="${TZ:-UTC}" max_run_minutes:="$MAX_MIN" max_age_hours:="$MAX_AGE_H" \
    manifest="runs/$run.json" "$@"
}

# ---------------------------------------------------------------- lock
# A previous run whose process is gone (container killed, box rebooted) left the lock
# and a "running" status: release it and record that run as failed.
# The pid is only meaningful in the container that wrote it; from any other container
# a lock is stale once it is older than the hard timeout plus a margin.
reap() {
  local pid host since age
  [ -d "$LOCK_DIR" ] || { fix_dead_running; return 0; }
  [ -f "$LOCK_DIR/epoch" ] || return 1   # a lock being taken right now
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo 0)"
  host="$(cat "$LOCK_DIR/host" 2>/dev/null || echo ?)"
  since="$(cat "$LOCK_DIR/epoch" 2>/dev/null || echo 0)"
  age=$(( $(date +%s) - since ))
  if [ "$host" = "$(hostname)" ]; then
    { [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null; } && return 1
  else
    [ "$age" -le $(( ${MAX_MIN%%.*} * 60 + 120 )) ] && return 1
  fi
  warn "stale lock from pid $pid on $host (${age}s old, process gone): releasing"
  rm -rf "$LOCK_DIR"
  fix_dead_running
}
fix_dead_running() {
  [ -f "$STATUS_FILE" ] || return 0
  [ "$(json_get "$STATUS_FILE" status)" = running ] || return 0
  local run started
  run="$(json_get "$STATUS_FILE" run_id)"; started="$(json_get "$STATUS_FILE" started_at)"
  write_status failed "$run" "$started" "$(now_iso)" "" "run $run aborted: its process disappeared before finishing (container stopped or box rebooted)"
  warn "run $run recorded as failed (aborted)"
}
lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if reap; then mkdir "$LOCK_DIR" 2>/dev/null || die "cannot create lock $LOCK_DIR"
    else die "another run is in progress (pid $(cat "$LOCK_DIR/pid" 2>/dev/null), since $(cat "$LOCK_DIR/started" 2>/dev/null)); not starting a second one"; fi
  fi
  printf '%s\n' "$$" > "$LOCK_DIR/pid"; now_iso > "$LOCK_DIR/started"; hostname > "$LOCK_DIR/host"
  date +%s > "$LOCK_DIR/epoch"
}
unlock() { rm -rf "$LOCK_DIR"; }
# The container runs as root. What it writes goes back to whoever owns the destination
# directory, as seen from inside: the host user under rootful Docker, root (already the
# host user) under rootless Docker, so this is right in both.
give_back() {
  local owner; owner="$(stat -c %u:%g "$BACKUPS" 2>/dev/null)" || return 0
  [ "$owner" = 0:0 ] && return 0
  chown -R "$owner" "$REPORTS" "$RESTIC_REPOSITORY" 2>/dev/null || true
}

# ---------------------------------------------------------------- run
cmd_run() {
  mkdir -p "$REPORTS" "$RUNS" "$RESTIC_CACHE_DIR"
  chmod 755 "$REPORTS" "$RUNS"
  [ -w "$BACKUPS" ] || die "$BACKUPS (BACKUP_DESTINATION on the host) is not writable"
  lock
  trap 'unlock; give_back' EXIT
  local run started finished rc st
  run="$(date -u +%Y%m%dT%H%M%SZ)"; started="$(now_iso)"
  write_status running "$run" "$started" "" "" ""
  _out "==> backup run $run (repository $REPO_SHOWN, timeout ${MAX_MIN}m)"
  rc=0
  timeout -k 30 "${MAX_MIN}m" "$0" _run "$run" "$started" || rc=$?
  st="$(json_get "$STATUS_FILE" status)"
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    finished="$(now_iso)"
    write_status failed "$run" "$started" "$finished" "" "run $run killed after ${MAX_MIN} minutes (BACKUP_MAX_RUN_MINUTES); nothing of it is kept as the latest backup"
    fail "run $run timed out after ${MAX_MIN} minutes and was killed"
    return 1
  elif [ "$st" = running ]; then
    write_status failed "$run" "$started" "$(now_iso)" "" "run $run aborted with exit code $rc before writing its result"
    fail "run $run aborted (exit $rc)"
    return 1
  fi
  [ "$rc" -eq 0 ]
}

# Streams CMD into restic as /NAME. Records sha256, bytes and the snapshot id.
ITEMS=""   # JSON array body, built item by item
add_item() { ITEMS="$ITEMS,$1"; }
dump_stream() { # NAME KIND CMD...
  local name="$1" kind="$2"; shift 2
  local sums="$TMP/$name.sum" out="$TMP/$name.out" err="$TMP/$name.err" snap sha bytes
  log "dump $name"
  set +e
  "$@" 2>"$err.dump" | $PY "$TMP/hashtee.py" "$sums" | \
    restic backup --quiet --stdin --stdin-filename "$name" --tag ihc --tag "kind:$kind" --tag "item:$name" --json >"$out" 2>"$err"
  local s1=${PIPESTATUS[0]} s2=${PIPESTATUS[1]} s3=${PIPESTATUS[2]}
  set -e
  if [ "$s1" -ne 0 ] || [ "$s2" -ne 0 ] || [ "$s3" -ne 0 ]; then
    fail "$name: dump exit $s1, hash exit $s2, restic exit $s3"
    sed 's/^/      /' "$err.dump" "$err" | tail -n 20 >&2
    return 1
  fi
  snap="$(grep '"message_type":"summary"' "$out" | tail -n 1 | $PY -c 'import json,sys;print(json.load(sys.stdin).get("snapshot_id",""))')"
  [ -n "$snap" ] || { fail "$name: no snapshot id in restic output"; return 1; }
  sha="$(awk '{print $1}' "$sums")"; bytes="$(awk '{print $2}' "$sums")"
  add_item "{\"name\":\"$name\",\"kind\":\"$kind\",\"path\":\"/$name\",\"snapshot_id\":\"$snap\",\"sha256\":\"$sha\",\"bytes\":$bytes}"
  LAST_SNAP="$snap"
  ok "$name: $bytes bytes, snapshot ${snap:0:8}"
}
path_backup() { # NAME KIND "PATH PATH..." [EXCLUDE...]
  local name="$1" kind="$2" paths="$3"; shift 3
  local out="$TMP/$name.out" err="$TMP/$name.err" snap x excl=""
  for x in "$@"; do excl="$excl --exclude $x"; done
  log "backup $name: $paths"
  # shellcheck disable=SC2086
  if ! restic backup --quiet --tag ihc --tag "kind:$kind" --tag "item:$name" --json $excl $paths >"$out" 2>"$err"; then
    fail "$name: restic failed"; sed 's/^/      /' "$err" | tail -n 20 >&2; return 1
  fi
  snap="$(grep '"message_type":"summary"' "$out" | tail -n 1 | $PY -c 'import json,sys;print(json.load(sys.stdin).get("snapshot_id",""))')"
  [ -n "$snap" ] || { fail "$name: no snapshot id in restic output"; return 1; }
  # shellcheck disable=SC2086
  paths="$($PY -c 'import json,sys;print(json.dumps(sys.argv[1:]))' $paths)"
  add_item "{\"name\":\"$name\",\"kind\":\"$kind\",\"paths\":$paths,\"snapshot_id\":\"$snap\"}"
  LAST_SNAP="$snap"
  ok "$name: snapshot ${snap:0:8}"
}

pg_databases() { # HOST USER -> names, one per line
  PGPASSWORD="$3" psql -h "$1" -U "$2" -d postgres -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1"
}
dump_instance() { # LABEL HOST USER PASSWORD
  local label="$1" host="$2" user="$3" db dbs
  export PGPASSWORD="$4"
  dbs="$(pg_databases "$host" "$user" "$PGPASSWORD")" || { fail "$label: cannot list databases on $host"; return 1; }
  for db in $dbs; do
    dump_stream "${label}__${db}.dump" dump pg_dump -h "$host" -U "$user" -Fc "$db" || return 1
  done
  dump_stream "${label}__globals.sql" dump pg_dumpall -h "$host" -U "$user" --globals-only || return 1
  unset PGPASSWORD
}

cmd__run() { # RUN_ID STARTED   (child of cmd_run, under the timeout)
  local run="$1" started="$2" finished manifest sha nitems bytes snap vols v
  LAST_SNAP=""
  TMP="$(mktemp -d /tmp/ihc-backup.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
  cat > "$TMP/hashtee.py" <<'EOF'
import hashlib, sys
h = hashlib.sha256(); n = 0
out = sys.stdout.buffer
while True:
    chunk = sys.stdin.buffer.read(1 << 20)
    if not chunk: break
    h.update(chunk); n += len(chunk); out.write(chunk)
out.flush()
open(sys.argv[1], "w").write("%s %d\n" % (h.hexdigest(), n))
EOF
  # Repository: create on first use; clear locks left by a killed run (we hold the job lock).
  if restic cat config >/dev/null 2>"$TMP/cat.err"; then
    restic unlock --quiet >/dev/null 2>&1 || true
  else
    if grep -qi "wrong password\|ciphertext verification failed" "$TMP/cat.err"; then
      die "repository $REPO_SHOWN exists but BACKUP_ENCRYPTION_KEY does not open it"
    fi
    log "initialising repository $REPO_SHOWN"
    restic init --quiet >/dev/null 2>"$TMP/init.err" || { sed 's/^/      /' "$TMP/init.err" >&2; die "restic init failed at $REPO_SHOWN"; }
    ok "repository created"
  fi
  # 1. Databases: every database of the shared Postgres and of Authentik's, plus globals.
  dump_instance shared-postgres postgres "${POSTGRES_USER:?}" "${POSTGRES_PASSWORD:?}" || return 1
  dump_instance authentik-postgres authentik-postgres "${AUTHENTIK_PG_USER:?}" "${AUTHENTIK_PG_PASSWORD:?}" || return 1
  # 2. Volumes: whatever is mounted under /volumes; Garage's only with the storage profile.
  vols=""
  for v in "$VOLUMES"/*; do
    [ -d "$v" ] || continue
    case "$(basename "$v")" in
      garage-data) case ",${COMPOSE_PROFILES:-}," in *,storage,*) ;; *) continue ;; esac ;;
    esac
    vols="$vols $v"
  done
  if [ -n "$vols" ]; then path_backup volumes volumes "${vols# }" || return 1; fi
  # 3. The cloud configuration: the install directory without backups/ and local/.
  path_backup config config "$IHC" "$IHC/backups" "$IHC/local" "$IHC/portal-placeholder/node_modules" || return 1
  snap="$LAST_SNAP"
  # 4. Retention, grouped by host and tags (one group per dump name, one for volumes, one for config).
  log "retention: ${KEEP_D} daily, ${KEEP_W} weekly, ${KEEP_M} monthly"
  restic forget --group-by host,tags --keep-daily "$KEEP_D" --keep-weekly "$KEEP_W" --keep-monthly "$KEEP_M" --prune >"$TMP/forget.out" 2>"$TMP/forget.err" \
    || { sed 's/^/      /' "$TMP/forget.err" >&2; fail "restic forget --prune failed"; return 1; }
  # 5. Manifest and status.
  finished="$(now_iso)"
  manifest="$RUNS/$run.json"
  nitems="$(printf '[%s]' "${ITEMS#,}" | $PY -c 'import json,sys;print(len(json.load(sys.stdin)))')"
  bytes="$(printf '[%s]' "${ITEMS#,}" | $PY -c 'import json,sys;print(sum(i.get("bytes",0) for i in json.load(sys.stdin)))')"
  json_write "$manifest" schema_version:=1 run_id="$run" started_at="$started" finished_at="$finished" repository="$REPO_SHOWN" \
    host="$RESTIC_HOST" "items:=[${ITEMS#,}]" retention:="{\"daily\":$KEEP_D,\"weekly\":$KEEP_W,\"monthly\":$KEEP_M}"
  sha="$(sha256_file "$manifest")"
  write_status success "$run" "$started" "$finished" "$snap" "" manifest_sha256="$sha" items:="$nitems" bytes_dumped:="$bytes"
  cp "$STATUS_FILE" "$SUCCESS_FILE"
  ls -1t "$RUNS" 2>/dev/null | tail -n +101 | while read -r old; do rm -f "$RUNS/$old"; done
  ok "run $run: $nitems items, $bytes bytes of dumps, manifest runs/$run.json (sha256 ${sha:0:12})"
}

# ---------------------------------------------------------------- verify
cmd_verify() {
  local latest=false
  while [ $# -gt 0 ]; do case "$1" in --latest) latest=true ;; --json) JSON_OUTPUT=true ;; *) die "unknown verify argument: $1" ;; esac; shift; done
  [ "$latest" = true ] || die "verify needs --latest (the only mode so far)"
  local errors=0 checks="" st run manifest sha want got id ids name kind path snap age stale
  check() { # NAME pass|fail DETAIL
    checks="$checks,{\"name\":\"$1\",\"status\":\"$2\",\"detail\":$($PY -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$3")}"
    if [ "$2" = pass ]; then ok "$1: $3"; else fail "$1: $3"; errors=$((errors+1)); fi
  }
  TMP="$(mktemp -d /tmp/ihc-verify.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
  # 1. latest run: the status file, and its outcome
  if [ ! -f "$STATUS_FILE" ]; then check status-file fail "no $STATUS_FILE: no run yet (ihc-backup run)"
  else
    reap >/dev/null 2>&1 || true
    st="$(json_get "$STATUS_FILE" status)"; run="$(json_get "$STATUS_FILE" run_id)"
    case "$st" in
      success) check latest-run pass "run $run succeeded at $(json_get "$STATUS_FILE" finished_at)" ;;
      running) check latest-run pass "run $run in progress since $(json_get "$STATUS_FILE" started_at); verifying the previous success" ;;
      *) check latest-run fail "run $run $st: $(json_get "$STATUS_FILE" error)" ;;
    esac
    # 2. age against BACKUP_MAX_AGE_HOURS
    if [ -f "$SUCCESS_FILE" ]; then
      age="$($PY -c 'import sys,datetime as d;f=d.datetime.strptime(sys.argv[1],"%Y-%m-%dT%H:%M:%SZ");print(round((d.datetime.now(d.timezone.utc).replace(tzinfo=None)-f).total_seconds()/3600,1))' "$(json_get "$SUCCESS_FILE" finished_at)")"
      stale="$($PY -c 'import sys;print("true" if float(sys.argv[1])>float(sys.argv[2]) else "false")' "$age" "$MAX_AGE_H")"
      [ "$stale" = false ] && check age pass "newest successful backup is ${age}h old (max ${MAX_AGE_H}h)" || check age fail "newest successful backup is ${age}h old, older than BACKUP_MAX_AGE_HOURS=$MAX_AGE_H"
    else
      check age fail "no successful run recorded yet"
    fi
  fi
  # 3. manifest present and intact
  if [ -f "$SUCCESS_FILE" ]; then
    run="$(json_get "$SUCCESS_FILE" run_id)"; manifest="$RUNS/$run.json"
    if [ -f "$manifest" ]; then
      want="$(json_get "$SUCCESS_FILE" manifest_sha256)"; got="$(sha256_file "$manifest")"
      [ "$want" = "$got" ] && check manifest pass "runs/$run.json sha256 matches the status file" || check manifest fail "runs/$run.json sha256 $got, status file says $want"
    else
      check manifest fail "manifest runs/$run.json missing"; manifest=""
    fi
  else manifest=""; fi
  # 4. destination: repository reachable and opened by the key
  if restic cat config >/dev/null 2>"$TMP/cat.err"; then check repository pass "$REPO_SHOWN opens with the key"
  else check repository fail "$REPO_SHOWN: $(tail -n 1 "$TMP/cat.err")"; fi
  # 5. every snapshot of the manifest exists; every dump restores to its recorded checksum
  if [ -n "$manifest" ] && [ "$errors" -eq 0 ]; then
    ids="$(restic snapshots --json 2>/dev/null | $PY -c 'import json,sys;print("\n".join(s["id"] for s in json.load(sys.stdin)))')"
    $PY -c 'import json,sys
for i in json.load(open(sys.argv[1]))["items"]:
    print("%s %s %s %s %s" % (i["name"], i["kind"], i["snapshot_id"], i.get("path","-"), i.get("sha256","-")))' "$manifest" > "$TMP/items"
    while read -r name kind snap path sha; do
      if ! printf '%s\n' "$ids" | grep -q "^$snap"; then check "snapshot:$name" fail "snapshot ${snap:0:8} not in the repository"; continue; fi
      if [ "$kind" = dump ]; then
        got="$(restic dump --quiet "$snap" "$path" 2>"$TMP/dump.err" | sha256sum | awk '{print $1}')"
        [ "$got" = "$sha" ] && check "snapshot:$name" pass "${snap:0:8} restores to sha256 ${sha:0:12}" || check "snapshot:$name" fail "${snap:0:8} restored sha256 ${got:0:12}, manifest says ${sha:0:12}"
      else
        check "snapshot:$name" pass "${snap:0:8} present"
      fi
    done < "$TMP/items"
    # 6. structural check of the repository (needs an exclusive lock: skipped while a run is live)
    if [ "${st:-}" = running ]; then check repository-check pass "skipped: run in progress"
    elif restic check --quiet >"$TMP/check.out" 2>&1; then check repository-check pass "restic check: no errors"
    else check repository-check fail "restic check: $(grep -v '^$' "$TMP/check.out" | tail -n 1)"; fi
  fi
  if [ "$JSON_OUTPUT" = true ]; then
    printf '{"ok":%s,"errors":%s,"run_id":"%s","repository":"%s","checks":[%s]}\n' "$([ "$errors" -eq 0 ] && echo true || echo false)" "$errors" "${run:-}" "$REPO_SHOWN" "${checks#,}"
  fi
  [ "$errors" -eq 0 ] && _out "verify: ok" || _out "verify: $errors problem(s)"
  [ "$errors" -eq 0 ]
}

# ---------------------------------------------------------------- status
cmd_status() {
  while [ $# -gt 0 ]; do case "$1" in --json) JSON_OUTPUT=true ;; *) die "unknown status argument: $1" ;; esac; shift; done
  reap >/dev/null 2>&1 || true
  if [ ! -f "$STATUS_FILE" ]; then
    [ "$JSON_OUTPUT" = true ] && printf '{"status":"none","repository":"%s","error":"no run yet"}\n' "$REPO_SHOWN"
    _out "backup: no run yet (repository $REPO_SHOWN)"; return 1
  fi
  $PY - "$STATUS_FILE" "$SUCCESS_FILE" "$MAX_AGE_H" "$JSON_OUTPUT" <<'EOF'
import json, sys, datetime as d
st = json.load(open(sys.argv[1]))
try: ok = json.load(open(sys.argv[2]))
except Exception: ok = None
f = lambda s: d.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")
age = round((d.datetime.now(d.timezone.utc).replace(tzinfo=None) - f(ok["finished_at"])).total_seconds() / 3600, 1) if ok else None
st["newest_success_age_hours"] = age
st["stale"] = (age is None) or (age > float(sys.argv[3]))
if sys.argv[4] == "true":
    print(json.dumps(st, indent=2))
line = "backup: %s (run %s, %s" % (st["status"], st.get("run_id"), st.get("finished_at") or st.get("started_at"))
if st.get("error"): line += ", " + st["error"]
line += "); newest success %s h ago%s" % (age if age is not None else "never", ", STALE" if st["stale"] else "")
print(line, file=sys.stderr)
sys.exit(0 if st["status"] == "success" and not st["stale"] else 1)
EOF
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  _run) shift; cmd__run "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  status) shift; cmd_status "$@" ;;
  -h|--help|"") usage; exit 0 ;;
  *) die "unknown command: $1" ;;
esac
