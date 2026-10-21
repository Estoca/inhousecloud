#!/usr/bin/env bash
# The ops tools' host mounts, checked without a running box (docs/security.md):
#
#   scripts/tests/ops-mounts.sh
#
# Renders docker/compose.yml with the installer's defaults for a sample install directory
# and checks, with scripts/lib/opspaths.py, that FileBrowser mounts only app-data/ and the
# backup reports (read only) and Wetty only its key directory (read only). Then it proves
# the check bites: a compose rendered with the install directory itself, apps/ (the apps'
# env files) or local/ (keys) as the file browser's app data must be refused, and so must
# the same paths given as ops.filebrowser.paths. Fails (exit 1) on any surprise.
# Needs the docker CLI with Compose v2 and python3; no daemon.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="python3 -I"
CHECK="$ROOT/scripts/lib/opspaths.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-ops-mounts.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
WORK="$(cd "$WORK" && pwd -P)"
INST="$WORK/opt/ihc"; DEST="$WORK/backups"
mkdir -p "$INST/app-data" "$INST/apps/demo" "$INST/local/wetty" "$DEST/reports" "$DEST/restic"
: > "$INST/.env"; : > "$INST/apps/demo/.env"
INST="$(cd "$INST" && pwd -P)"; DEST="$(cd "$DEST" && pwd -P)"
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }

# render APP_DATA REPORTS: compose config as JSON, with the ops profile on.
render() {
  sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' "$ROOT/docker/.env.example" | grep -E '^[A-Z_]+=' > "$WORK/env"
  {
    echo "COMPOSE_PROFILES=ops,backup"
    echo "BACKUP_DESTINATION=$DEST"
    echo "WETTY_KEY_DIR=$INST/local/wetty"
    echo "FILEBROWSER_APP_DATA_DIR=$1"
    echo "FILEBROWSER_REPORTS_DIR=$2"
    echo "PORTAL_BUILD_CONTEXT=$ROOT/examples/minimal-web-app"
  } >> "$WORK/env"
  docker compose --project-directory "$INST" -f "$ROOT/docker/compose.yml" --env-file "$WORK/env" config --format json 2>"$WORK/err"
}

# 1. the defaults pass
if render "$INST/app-data" "$DEST/reports" > "$WORK/ok.json"; then
  if $PY "$CHECK" compose "$INST" "$DEST" "$INST/local/wetty" < "$WORK/ok.json"; then pass "defaults: filebrowser mounts app-data and reports (ro); wetty its key directory (ro)"
  else bad "defaults refused (see above)"; fi
  $PY -c 'import json,sys
s=json.load(open(sys.argv[1]))["services"]
for n in ("filebrowser","wetty"):
    for v in s[n].get("volumes",[]):
        if v.get("type")=="bind": print("    %s: %s -> %s%s"%(n,v["source"],v["target"]," (ro)" if v.get("read_only") else ""))
    if s[n].get("ports"): print("    %s publishes ports: %s"%(n,s[n]["ports"])); sys.exit(1)
    if set(s[n].get("networks",{}))!={"ops"}: print("    %s is on %s, not only ops"%(n,list(s[n].get("networks",{})))); sys.exit(1)' "$WORK/ok.json" \
    && pass "filebrowser and wetty publish no port and sit on the ops network only" || bad "ports or networks of the ops tools"
else
  bad "docker compose config failed: $(tail -n 3 "$WORK/err")"
fi

# 2. the check refuses the install directory, apps/ and local/ as rendered mounts
for p in "$INST" "$INST/apps" "$INST/apps/demo" "$INST/local" "$INST/.env" "$(dirname "$INST")" "$DEST"; do
  if render "$p" "$DEST/reports" > "$WORK/bad.json" && ! $PY "$CHECK" compose "$INST" "$DEST" "$INST/local/wetty" < "$WORK/bad.json" 2>/dev/null; then
    pass "refused: filebrowser mounting ${p#"$WORK"}"
  else bad "NOT refused: filebrowser mounting $p"; fi
done

# 3. the same through the installer's config check (ops.filebrowser.paths)
for p in "$INST" "$INST/apps" "$INST/local/wetty" "$DEST" "$DEST/restic" "/" "$HOME" "relative/path"; do
  if $PY "$CHECK" check "$INST" "$DEST" "$p" 2>/dev/null; then bad "NOT refused: ops.filebrowser.paths $p"; else pass "refused: ops.filebrowser.paths ${p#"$WORK"}"; fi
done
for p in "$INST/app-data" "$INST/app-data/demo" "$DEST/reports"; do
  if $PY "$CHECK" check "$INST" "$DEST" "$p"; then pass "allowed: ${p#"$WORK"}"; else bad "refused a valid path: $p"; fi
done

# 4. the default layout, with the backup destination inside the install directory
if $PY "$CHECK" check "$INST" "$INST/backups" "$INST/backups/reports" "$INST/app-data"; then pass "allowed: backups/reports when the destination is <install-dir>/backups"; else bad "refused the default layout"; fi
if $PY "$CHECK" check "$INST" "$INST/backups" "$INST/backups" 2>/dev/null; then bad "NOT refused: <install-dir>/backups itself"; else pass "refused: <install-dir>/backups itself (restic repository)"; fi

# 5. a symlink in app-data pointing at the install directory is resolved and refused
ln -s "$INST" "$INST/app-data/escape"
if $PY "$CHECK" check "$INST" "$DEST" "$INST/app-data/escape" 2>/dev/null; then bad "NOT refused: symlink app-data/escape -> install directory"; else pass "refused: symlink app-data/escape -> install directory"; fi

echo
[ "$FAILS" -eq 0 ] && echo "ops-mounts: PASS" || { echo "ops-mounts: FAIL ($FAILS)"; exit 1; }
