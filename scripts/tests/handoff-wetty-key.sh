#!/usr/bin/env bash
# `install.sh handoff` alone repeats the command that authorizes the web terminal's key,
# and only while it is needed:
#
#   scripts/tests/handoff-wetty-key.sh
#
# Builds an install directory from scripts/tests/fixtures/current (its .env, plus the ops
# profile, OPS_TERMINAL and a key under local/wetty/) with HOME in a temporary directory,
# and reads what `handoff` prints: the line is there while the key is missing from
# ~/.ssh/authorized_keys, and gone once it is in, without ops, or without the terminal.
# No Docker needed. Exit 1 on any surprise.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-handoff-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
check() { if [ "$1" = 0 ]; then echo "[ok] $2"; else echo "[xx] $2"; FAILS=$((FAILS + 1)); fi; }

D="$WORK/install"; H="$WORK/home"
mkdir -p "$D/local/wetty" "$H"
cp "$ROOT/scripts/tests/fixtures/current/state.json" "$D/"
sed 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=ops,backup/' "$ROOT/scripts/tests/fixtures/current/env" > "$D/.env"
printf 'OPS_TERMINAL=true\nWETTY_SSH_USER=tester\n' >> "$D/.env"
chmod 600 "$D/.env"
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyNotARealOne0000000000000000000 ihc-wetty@fixture" > "$D/local/wetty/id_ed25519.pub"
CMD="cat $D/local/wetty/id_ed25519.pub >> ~/.ssh/authorized_keys"

handoff() { HOME="$H" "$ROOT/install.sh" handoff --install-dir "$D" 2>&1; }

out="$(handoff)"; rc=$?
check "$rc" "handoff exits 0"
printf '%s\n' "$out" | grep -qF "$CMD"; check $? "key not authorized: handoff prints the command"
printf '%s\n' "$out" | grep -qF "run as tester:"; check $? "key not authorized: handoff names the user (WETTY_SSH_USER)"

mkdir -p "$H/.ssh"; echo "ssh-ed25519 AAAAotherkey someone@else" > "$H/.ssh/authorized_keys"
handoff | grep -qF "$CMD"; check $? "another key in authorized_keys: still prints the command"

sh -c "$(echo "$CMD" | sed "s#~#$H#")"
! handoff | grep -qF "authorized_keys"; check $? "key authorized: no key line"

: > "$H/.ssh/authorized_keys"
sed -i.bak 's/^OPS_TERMINAL=.*/OPS_TERMINAL=false/' "$D/.env"
! handoff | grep -qF "authorized_keys"; check $? "terminal not installed (OPS_TERMINAL=false): no key line"

sed -i.bak -e 's/^OPS_TERMINAL=.*/OPS_TERMINAL=true/' -e 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=backup/' "$D/.env"
! handoff | grep -qF "authorized_keys"; check $? "ops profile off: no key line"

[ "$FAILS" = 0 ] && echo "handoff-wetty-key: all checks passed" || { echo "handoff-wetty-key: $FAILS failed"; exit 1; }
