#!/usr/bin/env bash
# ihc-doctor: is the cloud on the air, and if not, what to do. Run it when something
# looks wrong; the operator runs it before saying "it is on the air".
#
#   scripts/ihc-doctor.sh [--install-dir DIR] [--verbose] [--json]
#   <install-dir>/ihc doctor [--verbose] [--json]      the same, from the install directory
#
# Checks the box the way the smoke tests do, read only and in under 30 seconds: the
# install and state.json, Docker, the containers, disk and memory, the proxy's routes,
# DNS and TLS for the ingress, the sign-in, Gitea and its runners, Postgres, Redis, the
# backup, every app in the inventory, the operator agent, and this checkout's version.
# Each check answers ok, warn or fail in one line, and for warn and fail what to do.
# --verbose adds the evidence of each check; --json prints the report for an agent
# ({checks, summary, generated_at}, docs/operator-contract.md). Exit 1 when a check fails.
#
# The installation: --install-dir, else $IHC_INSTALL_DIR, else the current directory when
# it is one (state.json and compose.yml), else /opt/inhousecloud, else the directory the
# running Compose project was started from.
set -eu
IHC_ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$IHC_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${IHC_INSTALL_DIR:-}"
ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --json|--verbose) ARGS="$ARGS $1" ;;
    -v) ARGS="$ARGS --verbose" ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
if [ -z "$INSTALL_DIR" ]; then
  if [ -f ./state.json ] && [ -f ./compose.yml ]; then INSTALL_DIR="$(pwd)"
  elif [ -f /opt/inhousecloud/state.json ]; then INSTALL_DIR=/opt/inhousecloud
  else
    # The cloud's proxy container remembers where Compose ran: the install directory.
    INSTALL_DIR="$(docker ps -a --filter label=com.docker.compose.service=proxy --filter "label=com.docker.compose.project=${IHC_PROJECT:-ihc}" \
      --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n 1)"
    INSTALL_DIR="${INSTALL_DIR:-/opt/inhousecloud}"
  fi
fi
INSTALL_DIR="${INSTALL_DIR%/}"
# shellcheck disable=SC2086
exec $PY "$IHC_LIB/doctor.py" "$INSTALL_DIR" "$IHC_ROOT" $ARGS
