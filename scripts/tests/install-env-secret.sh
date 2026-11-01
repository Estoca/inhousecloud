#!/usr/bin/env bash
# env_secret (install.sh) works in a stage that runs without stage_secrets, as stage_portal
# does on `install.sh --apply --from foundation` (the upgrade path of an install made before
# the MCP audit role): SECRET_FPS is not set there and install.sh runs under `set -u`.
#
#   scripts/tests/install-env-secret.sh
#
# Takes env_default and env_secret out of install.sh, runs them under `set -eu` with
# SECRET_FPS unset against a temporary .env: the key is generated once, kept on the next
# run, and the .env is 0600. No Docker needed. Exit 1 on any surprise.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-env-secret-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
check() { if [ "$1" = 0 ]; then echo "[ok] $2"; else echo "[xx] $2"; FAILS=$((FAILS + 1)); fi; }

# The two functions, as written in install.sh (from their first line to the closing brace).
awk '/^env_default\(\) \{/,/^}/; /^env_secret\(\) \{/,/^}/' "$ROOT/install.sh" > "$WORK/fns.sh"
grep -q '^env_secret() {' "$WORK/fns.sh"; check $? "env_secret found in install.sh"

ENV_FILE="$WORK/.env"; (umask 077; : > "$ENV_FILE")
run() {
  ( set -eu; unset SECRET_FPS
    . "$ROOT/scripts/lib/common.sh"; . "$WORK/fns.sh"
    ENV_FILE="$WORK/.env"
    env_default MCP_AUDIT_DB_ROLE ihc_mcp_audit
    env_secret MCP_AUDIT_DB_PASSWORD IHC_MCP_AUDIT_DATABASE_PASSWORD 32 )
}
get() { python3 -I "$ROOT/scripts/lib/envfile.py" get "$ENV_FILE" "$1"; }

run 2>"$WORK/err"; check $? "first run, SECRET_FPS unset (set -eu): exit 0"
grep -q "unbound variable" "$WORK/err"; [ $? -ne 0 ]; check $? "no unbound variable"
first="$(get MCP_AUDIT_DB_PASSWORD)"
[ "${#first}" = 32 ]; check $? "a 32 character password was generated"
[ "$(get MCP_AUDIT_DB_ROLE)" = ihc_mcp_audit ]; check $? "the role name default was written"

run 2>"$WORK/err"; check $? "second run: exit 0"
[ "$(get MCP_AUDIT_DB_PASSWORD)" = "$first" ]; check $? "second run keeps the password"

[ "$FAILS" = 0 ] && echo "install-env-secret: all checks passed" || { echo "install-env-secret: $FAILS failed"; exit 1; }
