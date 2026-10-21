#!/usr/bin/env bash
# The inventory.json contract between ihc-app and the portal, cloud side (the portal side is
# portal/test/inventory-ihc.test.js, on the same fixture):
#
#   scripts/tests/inventory-contract.sh
#
# Builds a record the way ihc-app provision does (appmanifest.py vars on the template's
# company-app.yaml, then inventory.py record), and checks: schema_version 1 and every field
# the portal reads (scripts/lib/inventory.py check); description, healthcheck, auth and mcp
# carried from the manifest; the portal's fixture portal/test/fixtures/ihc-inventory.json is
# a valid inventory with every field a real record has; `migrate` moves the file into
# catalog/ behind a symlink, and a save afterwards keeps the symlink (the portal mounts
# catalog/ read only and must see every write). Needs python3 only; agent_interface.mcp
# parsed from YAML only where PyYAML is installed (the deployer image has it). Exit 1 on any
# surprise.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="python3 -I"
LIB="$ROOT/scripts/lib"
FIXTURE="$ROOT/portal/test/fixtures/ihc-inventory.json"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ihc-inventory.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }

# The template app's manifest, as ihc-app new fills it in.
sed -e 's/__APP_SLUG__/demo-app/; s/__APP_NAME__/Demo App/; s/__OWNER_EMAIL__/owner@example.com/; s/__APP_DOMAIN__/demo-app.cloud.localhost/' \
  "$ROOT/templates/app/company-app.yaml" > "$WORK/company-app.yaml"
vars="$($PY "$LIB/appmanifest.py" vars "$WORK/company-app.yaml" demo-app)" || { bad "appmanifest.py vars refused the template manifest"; exit 1; }
eval "$vars"
[ "$M_DESCRIPTION" = "Internal app built on the company cloud." ] && pass "vars: M_DESCRIPTION from app.description" || bad "vars: M_DESCRIPTION is '$M_DESCRIPTION'"
[ "$M_MCP" = null ] && pass "vars: M_MCP is null without agent_interface.mcp" || bad "vars: M_MCP is '$M_MCP'"

if python3 -c 'import yaml' 2>/dev/null; then
  cat >> "$WORK/company-app.yaml" <<'YAML'

agent_interface:
  mcp:
    provider: mcp-gateway
    audience: demo-app.cloud
    scopes: [demo-app.read]
    tools:
      - name: demo_list
        access: read
YAML
  mcp="$($PY "$LIB/appmanifest.py" vars "$WORK/company-app.yaml" demo-app | sed -n 's/^M_MCP=//p')"
  eval "mcp=$mcp"
  [ "$(printf '%s' "$mcp" | $PY -c 'import json,sys;print(json.load(sys.stdin)["tools"][0]["name"])')" = demo_list ] \
    && pass "vars: agent_interface.mcp carried as JSON" || bad "vars: agent_interface.mcp came out as '$mcp'"
  M_MCP="$mcp"
else
  pass "vars: agent_interface.mcp parsing skipped (no PyYAML here; the deployer image has it)"
  M_MCP='{"provider":"mcp-gateway","audience":"demo-app.cloud","scopes":["demo-app.read"],"tools":[{"name":"demo_list","access":"read"}]}'
fi

INST="$WORK/install"; mkdir -p "$INST"
printf '{"installation_id":"test","apps":{}}\n' > "$INST/inventory.json"
$PY "$LIB/inventory.py" migrate "$INST"
[ -L "$INST/inventory.json" ] && [ -f "$INST/catalog/inventory.json" ] && pass "migrate: inventory.json is a symlink into catalog/" || bad "migrate: no symlink into catalog/"
$PY "$LIB/inventory.py" migrate "$INST" && [ -L "$INST/inventory.json" ] && pass "migrate: a second run changes nothing" || bad "migrate: not idempotent"

SLUG=demo-app APP_URL=http://demo-app.cloud.localhost APP_ENV="$INST/apps/demo-app/.env" APP_OVERLAY="$INST/apps/demo-app/compose.ihc.yml" \
RESOURCES="postgres:database:app_demo_app redis:prefix:demo-app:" GITHUB_REPOSITORY=company/demo-app GITHUB_SHA=0123456789abcdef \
M_NAME="$M_NAME" M_OWNER="$M_OWNER" M_SERVICE="$M_SERVICE" M_PORT="$M_PORT" M_HEALTH_PATH="$M_HEALTH_PATH" M_HEALTH_STATUS="$M_HEALTH_STATUS" \
M_AUTH="$M_AUTH" M_DESCRIPTION="$M_DESCRIPTION" M_MCP="$M_MCP" \
  $PY "$LIB/inventory.py" record "$INST/inventory.json"
[ -L "$INST/inventory.json" ] && pass "record: the symlink survives a write" || bad "record: the write replaced the symlink"
$PY "$LIB/inventory.py" check "$INST/inventory.json" && pass "check: the recorded inventory follows the contract" || bad "check: the recorded inventory breaks the contract"
$PY "$LIB/inventory.py" check "$FIXTURE" && pass "check: the portal's fixture follows the contract" || bad "check: the portal's fixture breaks the contract"

out="$($PY - "$INST/inventory.json" "$FIXTURE" <<'PY'
import json, sys
inv = json.load(open(sys.argv[1])); fx = json.load(open(sys.argv[2]))
a = inv["apps"]["demo-app"]
bad = []
want = {"installation_id": "test"}
for k, v in want.items():
    if inv.get(k) != v: bad.append("top-level %s dropped" % k)
for k, v in {"description": "Internal app built on the company cloud.", "healthcheck": {"path": "/health", "status": 200},
             "auth": {"required": True}, "repository": "company/demo-app", "last_commit": "0123456789abcdef"}.items():
    if a.get(k) != v: bad.append("%s is %r" % (k, a.get(k)))
if not (isinstance(a.get("mcp"), dict) and a["mcp"].get("tools")): bad.append("mcp is %r" % a.get("mcp"))
if a.get("runtime", {}).get("health_path") != "/health": bad.append("runtime.health_path missing (ihc doctor reads it)")
# Every field a real record has is also in the full record of the fixture: the portal is tested on it.
full = fx["apps"].get("pedidos", {})
missing = sorted(set(a) - set(full))
if missing: bad.append("the fixture app pedidos lacks fields a real record has: %s" % ", ".join(missing))
print("; ".join(bad) or "ok")
PY
)"
[ "$out" = ok ] && pass "record: description, healthcheck, auth, mcp and the deploy's commit carried; fixture has every field" || bad "record: $out"

printf '{"schema_version":2,"apps":{"x":{}}}\n' > "$WORK/bad.json"
$PY "$LIB/inventory.py" check "$WORK/bad.json" 2>/dev/null && bad "check: accepted schema_version 2 and an empty app" || pass "check: refuses another schema_version and an incomplete app"

echo "inventory contract: $([ "$FAILS" -eq 0 ] && echo "all checks passed" || echo "$FAILS failed")"
[ "$FAILS" -eq 0 ]
