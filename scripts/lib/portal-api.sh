# The portal's read-only status API on the proxy (docs/portal-api.md). bash 3.2
# compatible. Sourced after sso.sh, never executed.
#
# The rule: GET /api/platform/status carrying an Authorization header skips the forward
# auth and goes to the portal, which checks the bearer against IHC_PORTAL_API_TOKEN (401
# wrong token, 403 any other route). Without the header, the same path goes through
# Authentik like the rest of the portal, so a browser still signs in. Nothing else skips:
# every other path with a token still meets the forward auth.
#
# How: nginx rewrite rules at server level run before location matching. They send the
# request (exact path, header present) to an internal location that proxies it with
# $request_uri unchanged and drops any X-authentik-* header the client sent, so a token
# request can never carry a forged identity. `internal` keeps that location unreachable
# from outside.

PORTAL_API_SKIP_CONF='# InHouseCloud: the portal status API for agents (docs/portal-api.md). GET
# /api/platform/status with an Authorization header skips the forward auth; the portal
# checks the token. Without the header it goes through Authentik like every other path.
set $ihc_portal_api "";
if ($http_authorization != "") { set $ihc_portal_api "A"; }
if ($uri = /api/platform/status) { set $ihc_portal_api "${ihc_portal_api}P"; }
if ($ihc_portal_api = "AP") { rewrite ^ /.ihc-portal-api-token last; }

location = /.ihc-portal-api-token {
    internal;
    proxy_pass $forward_scheme://$server:$port$request_uri;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-authentik-username "";
    proxy_set_header X-authentik-groups "";
    proxy_set_header X-authentik-entitlements "";
    proxy_set_header X-authentik-email "";
    proxy_set_header X-authentik-name "";
    proxy_set_header X-authentik-uid "";
}
'

# portal_forward_auth_conf: the portal host's advanced config, the forward auth with
# /health public (sso.sh forward_auth_conf) plus the status API rule above.
portal_forward_auth_conf() {
  printf '%s\n%s' "$PORTAL_API_SKIP_CONF" "$(forward_auth_conf /health)"
}
