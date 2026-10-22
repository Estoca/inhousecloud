#!/usr/bin/env bash
# copy_portal (install.sh) must give the copied portal tree modes the image's `node` user can
# read, whatever the checkout's modes are:
#
#   scripts/tests/copy-portal-perms.sh
#
# Builds a fake checkout whose files are 0600 and directories 0700 (a strict umask, seen on
# macOS), runs copy_portal into a scratch install dir, and checks every file is group/other
# readable and every directory traversable. Fails (exit 1) on any surprise.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-copy-portal.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }
# Octal mode of a path: GNU stat (-c) on Linux, BSD stat (-f) on macOS. GNU's -f is the
# filesystem stat, so try -c first.
mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# The function, alone: install.sh runs its CLI when sourced.
eval "$(sed -n '/^copy_portal() {/,/^}/p' "$ROOT/install.sh")"
declare -f copy_portal >/dev/null || { echo "copy_portal not found in install.sh"; exit 1; }

IHC_ROOT="$WORK/checkout"; INSTALL_DIR="$WORK/install"
mkdir -p "$IHC_ROOT/portal/src" "$IHC_ROOT/portal/node_modules/x" "$INSTALL_DIR"
echo 'ok' > "$IHC_ROOT/portal/src/server.js"
echo 'ok' > "$IHC_ROOT/portal/package.json"
echo 'x'  > "$IHC_ROOT/portal/node_modules/x/i.js"
chmod -R go-rwx "$IHC_ROOT/portal"
chmod 0600 "$IHC_ROOT/portal/src/server.js" "$IHC_ROOT/portal/package.json"

copy_portal || { bad "copy_portal failed"; exit 1; }

# `node` in the image is not the uid that owns the copy: judge by group/other bits.
while IFS= read -r f; do
  m=$(mode "$f")
  o=$(( 8#$m & 8#044 ))
  [ "$o" -eq $(( 8#044 )) ] && pass "file $(basename "$f") is $m" || bad "file $f is $m (not go+r)"
done < <(find "$INSTALL_DIR/portal" -type f)
while IFS= read -r d; do
  m=$(mode "$d")
  o=$(( 8#$m & 8#055 ))
  [ "$o" -eq $(( 8#055 )) ] && pass "dir ${d#$INSTALL_DIR/} is $m" || bad "dir $d is $m (not go+rx)"
done < <(find "$INSTALL_DIR/portal" -type d)
[ -e "$INSTALL_DIR/portal/node_modules" ] && bad "node_modules was copied" || pass "node_modules excluded"
# The checkout itself is left alone.
m=$(mode "$IHC_ROOT/portal/src/server.js")
[ "$m" = "600" ] && pass "checkout untouched (server.js still 600)" || bad "checkout changed: server.js is $m"

[ "$FAILS" -eq 0 ] && { echo "copy-portal-perms: all good"; exit 0; } || { echo "copy-portal-perms: $FAILS failure(s)"; exit 1; }
