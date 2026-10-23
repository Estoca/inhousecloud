#!/usr/bin/env bash
# The MCP gateway (docs/mcp-gateway.md), without a box:
#
#   scripts/tests/mcp-gateway.sh
#
#   1. portal/test/mcp-gateway.test.js: the actor JWT (issued RS256 with aud, scope and the
#      person, refused with another audience, issuer, key, alg none or expired), the
#      Authentik access token (ihc-users in, anyone else 403, userinfo fallback, key
#      rotation), routing by the <slug>__ prefix, scopes granted per group, the last good
#      catalog on a provider down or slow and never on a 403, the MCP endpoint over HTTP,
#      one issuer string in the resource metadata, the legacy metadata and the token check
#      (SEP-2352), ihc_platform_status never answering stale when the portal can probe and
#      saying the age of its reading, and the template app checking a real actor JWT;
#   2. the cloud side: the slug mcp is reserved; the loopback redirect rule first-run gives
#      the OAuth2 provider takes the redirects of local MCP clients and nothing else; the
#      compose service mcp runs as uid 1000 with no capability, no published port, no
#      Docker socket, and only on the ihc network.
# Needs node with portal/node_modules (npm ci in portal/) and python3. Exit 1 on any surprise.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="python3 -I"
FAILS=0
pass() { printf '[ok] %s\n' "$*"; }
bad()  { printf '[xx] %s\n' "$*"; FAILS=$((FAILS+1)); }

if (cd "$ROOT/portal" && node --test --test-reporter=dot test/mcp-gateway.test.js >/dev/null 2>&1); then
  pass "portal/test/mcp-gateway.test.js: actor JWT, access token, one issuer, routing, scopes, fallback, fresh status, HTTP, template app"
else
  (cd "$ROOT/portal" && node --test test/mcp-gateway.test.js 2>&1 | grep -E '^not ok|✖' | head -20) || true
  bad "portal/test/mcp-gateway.test.js failed (run it in portal/ for the detail)"
fi

out="$($PY "$ROOT/scripts/lib/appmanifest.py" slug-check mcp 2>&1 || true)"
case "$out" in *reserved*) pass "slug mcp is reserved for the gateway" ;; *) bad "slug mcp is not reserved: '$out'" ;; esac

regex="$(sed -n 's/.*"matching_mode":"regex","url":r"\([^"]*\)".*/\1/p' "$ROOT/scripts/first-run.sh" | head -n 1)"
out="$($PY - "$regex" <<'PY'
import re, sys
rx = re.compile(sys.argv[1])
good = ["http://127.0.0.1:53682/callback", "http://localhost:33418/callback", "http://localhost/callback",
        "http://[::1]:8000/callback", "http://localhost:6274/oauth/callback"]
evil = ["http://evil.example/callback", "http://localhost.evil.example/callback", "https://localhost:1/callback",
        "http://localhost:1/callback/../x", "http://127.0.0.1:1/callbackx", "http://user@evil.example/callback"]
bad = [u for u in good if not rx.fullmatch(u)] + ["accepts " + u for u in evil if rx.fullmatch(u)]
print("; ".join(bad) or "ok")
PY
)"
[ -n "$regex" ] && [ "$out" = ok ] && pass "redirect rule $regex: loopback callbacks only" || bad "redirect rule '$regex': $out"

out="$($PY - "$ROOT/docker/compose.yml" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r"(?ms)^  mcp:\n(.*?)(?=^  [a-z][a-z-]*:\n)", text)
if not m: print("no mcp service"); sys.exit()
block = m.group(1)
bad = []
if re.search(r"(?m)^    ports:", block): bad.append("publishes a port")
if "docker.sock" in block: bad.append("mounts the Docker socket")
if 'user: "1000:1000"' not in block: bad.append("not uid 1000")
if "cap_drop: [ALL]" not in block: bad.append("keeps capabilities")
if "networks: [ihc]" not in block: bad.append("networks are not [ihc]")
if "./catalog:/ihc/catalog:ro" not in block: bad.append("inventory not read only")
if "-portal:local" not in block or "src/mcp-gateway.js" not in block: bad.append("not the portal image's gateway entrypoint")
print("; ".join(bad) or "ok")
PY
)"
[ "$out" = ok ] && pass "compose service mcp: portal image, uid 1000, no capability, no port, no socket, ihc network only" || bad "compose service mcp: $out"

echo "mcp gateway: $([ "$FAILS" -eq 0 ] && echo "all checks passed" || echo "$FAILS failed")"
[ "$FAILS" -eq 0 ]
