#!/usr/bin/env bash
# An installation made under a previous name (harness, occ) is detected, not operated:
#
#   scripts/tests/legacy-install.sh
#
# Copies the fixtures in scripts/tests/fixtures/ (state.json, .env, config, compose file
# and an app overlay with the names of their time) to a temporary directory and runs the
# commands that read an installation against each. For legacy-harness and legacy-occ every
# command must stop with the one message of scripts/lib/legacy.py (which name, no in-place
# migration, remove and install fresh) and print none of the new names it would have mixed
# in. For current (an ihc install made from an Open Company Cloud config, so it keeps the
# occ group names on purpose) nothing may fire. No Docker needed: every command stops
# before it. Exit 1 on any surprise.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-legacy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
check() { if [ "$1" = 0 ]; then echo "[ok] $2"; else echo "[xx] $2"; FAILS=$((FAILS + 1)); fi; }

fixture() { # NAME -> prints the install directory made from it
  local d="$WORK/$1"
  cp -R "$ROOT/scripts/tests/fixtures/$1" "$d"
  mv "$d/env" "$d/.env"; chmod 600 "$d/.env"
  echo "$d"
}

# legacy_case FIXTURE PRODUCT-NAME
legacy_case() {
  local dir out rc n label
  dir="$(fixture "$1")"
  [ -n "$(cd "$ROOT" && python3 -I scripts/lib/legacy.py "$dir" 2>&1)" ]; check $? "$1: legacy.py speaks"
  while IFS='|' read -r label cmd; do
    rc=0; out="$(cd "$ROOT" && env -u IHC_INSTALL_DIR bash -c "$cmd" 2>&1)" || rc=$?
    n="$(printf '%s\n' "$out" | grep -c 'is an installation made before the rename to InHouseCloud')"
    [ "$rc" != 0 ] && [ "$n" = 1 ]; check $? "$1: $label stops with the message, once (exit $rc)"
    printf '%s' "$out" | grep -q "names of $2"; check $? "$1: $label names $2"
    printf '%s' "$out" | grep -q 'There is no in-place migration'; check $? "$1: $label says there is no in-place migration"
    printf '%s' "$out" | grep -q 'docs/cleanup.md#an-installation-made-under-a-previous-name'; check $? "$1: $label points to docs/cleanup.md"
    ! printf '%s' "$out" | grep -q -E 'ihc-deploy|compose\.ihc\.yml|ihc-admins|ihc-users'; check $? "$1: $label mixes in no new name"
  done <<EOF
install.sh status|./install.sh status --install-dir $dir
install.sh status --verbose|./install.sh status --verbose --install-dir $dir
install.sh handoff|./install.sh handoff --install-dir $dir
install.sh doctor|./install.sh doctor --install-dir $dir
install.sh --plan|./install.sh --plan --install-dir $dir
ihc-operator brief|scripts/ihc-operator.sh brief --install-dir $dir
ihc-operator brief --json|scripts/ihc-operator.sh brief --json --no-live --install-dir $dir
ihc-doctor|scripts/ihc-doctor.sh --install-dir $dir
ihc-app list|scripts/ihc-app.sh list --install-dir $dir
ihc-backup status|scripts/ihc-backup.sh status --install-dir $dir
EOF
  # The doctor's JSON: the install check, failed, alone.
  out="$(cd "$ROOT" && scripts/ihc-doctor.sh --json --install-dir "$dir" 2>/dev/null)"
  printf '%s' "$out" | python3 -I -c 'import json,sys; r=json.load(sys.stdin); c=r["checks"]
assert [x["name"] for x in c] == ["install"] and c[0]["status"] == "fail", c
assert "before the rename" in c[0]["detail"] and "install InHouseCloud fresh" in c[0]["action"], c[0]
assert r["summary"] == {"ok": 0, "warn": 0, "fail": 1}, r["summary"]'
  check $? "$1: ihc-doctor --json is one failed install check"
}

legacy_case legacy-harness "Open Company App Harness"
legacy_case legacy-occ "Open Company Cloud"

out="$(cd "$ROOT" && scripts/ihc-doctor.sh --json --install-dir "$WORK/legacy-harness" 2>/dev/null)"
printf '%s' "$out" | grep -q 'the installer of that time has no remove command'; check $? "legacy-harness: points to removal by hand (no remove command then)"
out="$(cd "$ROOT" && scripts/ihc-doctor.sh --json --install-dir "$WORK/legacy-occ" 2>/dev/null)"
printf '%s' "$out" | grep -q 'git checkout 3a4f11a && ./install.sh remove'; check $? "legacy-occ: points to install.sh remove of its time"

dir="$(fixture current)"
rc=0; out="$(cd "$ROOT" && python3 -I scripts/lib/legacy.py "$dir" 2>&1)" || rc=$?
[ "$rc" = 0 ] && [ -z "$out" ]; check $? "current: legacy.py silent (groups occ-admins and /opt/open-company-cloud carried by the config are not a legacy install)"
out="$(cd "$ROOT" && ./install.sh status --install-dir "$dir" 2>&1)"
! printf '%s' "$out" | grep -q 'before the rename'; check $? "current: install.sh status runs"
printf '%s' "$out" | grep -q -i 'complete'; check $? "current: install.sh status reads its state.json"

[ "$FAILS" = 0 ] && echo "legacy install: all checks passed" || { echo "legacy install: $FAILS failed"; exit 1; }
