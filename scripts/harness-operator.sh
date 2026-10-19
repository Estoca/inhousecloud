#!/usr/bin/env bash
# harness-operator: what an operator (a human or the agent profile's agent) reads first.
#
#   harness-operator brief [--json] [--out DIR] [--no-live]
#       The map of the box, generated from state.json, the rendered compose.yml,
#       inventory.json and `docker ps`: for each service where its configuration lives,
#       how it is changed, its Compose project, internal port, dependencies, health and
#       what healthy looks like; the apps with owners; the access matrix (variable names
#       and where they live, never values); the commands. Markdown by default.
#   harness-operator agent-sync
#       Refresh the agent's workspace (<install-dir>/agent/): AGENTS.md, the operator
#       contract, the runbooks, harness-ro and the brief. install.sh runs it; so does
#       harness-app provision after each deploy (the brief only).
#
# Options: --install-dir DIR (default $HARNESS_INSTALL_DIR, else /opt/open-company-harness).
# Read only, except the files it writes under <install-dir>/agent/. Contract:
# docs/operator-contract.md.
set -eu
HARNESS_ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$HARNESS_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${HARNESS_INSTALL_DIR:-/opt/open-company-harness}"
CMD="${1:-}"; [ $# -gt 0 ] && shift
ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --json|--no-live) ARGS="$ARGS $1" ;;
    --out) ARGS="$ARGS --out $2"; shift ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
INSTALL_DIR="${INSTALL_DIR%/}"
[ -f "$INSTALL_DIR/.env" ] || die "no installation at $INSTALL_DIR (.env not found)"
AGENT_DIR="$INSTALL_DIR/agent"

case "$CMD" in
  brief)
    # shellcheck disable=SC2086
    $PY "$HARNESS_LIB/operatorbrief.py" "$INSTALL_DIR" "$HARNESS_ROOT" $ARGS
    ;;
  agent-sync)
    [ -d "$AGENT_DIR" ] || die "no agent workspace at $AGENT_DIR (the agent profile is off)"
    ref="$AGENT_DIR/reference"
    mkdir -p "$ref/runbooks" "$ref/bin" "$AGENT_DIR/workspace"
    if [ -d "$HARNESS_ROOT/docs/runbooks" ]; then
      cp "$HARNESS_ROOT/docs/operator-contract.md" "$ref/operator-contract.md"
      rm -f "$ref/runbooks/"*.md; cp "$HARNESS_ROOT/docs/runbooks/"*.md "$ref/runbooks/"
      cp "$HARNESS_ROOT/docker/agent/harness-ro.mjs" "$ref/bin/harness-ro"; chmod 755 "$ref/bin/harness-ro"
      cp "$HARNESS_ROOT/docker/agent/AGENTS.md" "$AGENT_DIR/workspace/AGENTS.md"
    fi
    $PY "$HARNESS_LIB/operatorbrief.py" "$INSTALL_DIR" "$HARNESS_ROOT" --out "$ref" >/dev/null
    chmod -R a+rX "$ref"; chmod 644 "$AGENT_DIR/workspace/AGENTS.md" 2>/dev/null || true
    ok "agent workspace refreshed: $AGENT_DIR/workspace/AGENTS.md, $ref (contract, runbooks, brief)"
    ;;
  ""|help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command: $CMD (see --help)" ;;
esac
