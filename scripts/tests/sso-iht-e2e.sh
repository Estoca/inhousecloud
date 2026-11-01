#!/usr/bin/env bash
# Opt-in integration test. All Docker operations happen inside this dedicated VM.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VM=ihc-sso-e2e
KEEP=false
REUSE=false
IHT_SOURCE="${IHT_SOURCE:-$(dirname "$ROOT")/inhouse-technology}"
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-vm) KEEP=true ;;
    --reuse) REUSE=true ;;
    --iht-source) IHT_SOURCE="$2"; shift ;;
    --help) echo "Usage: $0 [--iht-source PATH] [--keep-vm] [--reuse]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -f "$IHT_SOURCE/src/iht/oidc_provider.py" ] || { echo "Missing local iht source: use --iht-source PATH" >&2; exit 2; }
command -v limactl >/dev/null
locked=false
owned=false
cleanup() {
  rc=$?
  if $owned; then
    if $KEEP; then echo "Kept $VM (--keep-vm); contains throwaway credentials.";
    elif limactl delete --force "$VM"; then echo "Deleted VM $VM";
    else echo "FAILED to delete VM $VM" >&2; rc=1; fi
  fi
  if $locked && { ! $owned || ! limactl list --format '{{.Name}}' | grep -qx "$VM"; }; then rmdir /tmp/inhouse-lima-ihc.lock; fi
  if [ "$rc" -ne 0 ]; then printf "| check | result |\n| --- | --- |\n| harness | FAIL (exit %s; see preceding output) |\n" "$rc"; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for attempt in $(seq 1 61); do
  if mkdir /tmp/inhouse-lima-ihc.lock 2>/dev/null; then locked=true; break; fi
  [ "$attempt" -lt 61 ] || { echo "Lima mutex unavailable after 2 hours" >&2; exit 1; }
  echo "Waiting for shared Lima mutex (retry in 2 minutes)..."
  sleep 120
done
if limactl list --format '{{.Name}}' | grep -qx "$VM"; then
  $REUSE || { echo "$VM exists; refusing to touch it without --reuse" >&2; exit 2; }
  limactl shell "$VM" bash -c 'test -f ~/sso-e2e/.owned-by-sso-harness'
  owned=true
else
  owned=true
  limactl start --tty=false --name "$VM" --cpus 4 --memory 6 --disk 40 template:docker-rootful
fi
# Copy allowlisted source files only: no .env, keys, database or private git history.
limactl shell "$VM" bash -c 'mkdir -p ~/sso-e2e/{ihc,iht}; touch ~/sso-e2e/.owned-by-sso-harness'
git -C "$ROOT" ls-files -z | COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT" --null -T - -cf - | limactl shell "$VM" bash -c 'tar xf - -C ~/sso-e2e/ihc'
# New harness files are intentionally uncommitted during development.
COPYFILE_DISABLE=1 tar --no-xattrs -C "$ROOT" -cf - scripts/tests/sso-iht-e2e.sh scripts/tests/fixtures | limactl shell "$VM" bash -c 'tar xf - -C ~/sso-e2e/ihc'
COPYFILE_DISABLE=1 tar --no-xattrs -C "$IHT_SOURCE" --exclude=__pycache__ -cf - src pyproject.toml README.md | limactl shell "$VM" bash -c 'tar xf - -C ~/sso-e2e/iht'
# Rootful deploy jobs own their host artifacts as root. Install and run operator
# smoke checks as the same user, entirely within this disposable VM.
limactl shell "$VM" bash -c 'cd ~/sso-e2e; sudo bash ihc/scripts/tests/fixtures/sso-vm.sh'
