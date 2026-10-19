#!/usr/bin/env bash
# Proves the SSO path end to end with curl: Gitea sends the browser to Authentik, the
# user signs in through Authentik's flow executor API, Authentik sends the code back to
# Gitea, Gitea creates the session. Nothing a browser would not do; nothing is printed
# except status lines and the Gitea login that resulted.
#
#   scripts/sso-login-check.sh --install-dir DIR [--user akadmin] [--password-env VAR]
#
# Default user is akadmin with AUTHENTIK_BOOTSTRAP_PASSWORD from .env. Run it on the box
# (it pins the public names to the proxy on 127.0.0.1). Not part of the smoke tests:
# it needs a password, and the bootstrap password is meant to be replaced by a human.
set -eu
HARNESS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$HARNESS_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${HARNESS_INSTALL_DIR:-/opt/open-company-harness}"
USER_NAME=akadmin
PASSWORD_ENV=AUTHENTIK_BOOTSTRAP_PASSWORD
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --user) USER_NAME="$2"; shift ;;
    --password-env) PASSWORD_ENV="$2"; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
ENV_FILE="$INSTALL_DIR/.env"; STATE_FILE="$INSTALL_DIR/state.json"
load_env
eval "PASSWORD=\${$PASSWORD_ENV:-}"
[ -n "$PASSWORD" ] || die "$PASSWORD_ENV is empty"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/harness-sso.XXXXXX")"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"; : > "$JAR"
INSECURE=""; [ "$TLS_MODE" = internal ] && INSECURE="-k"
# shellcheck disable=SC2046
R="$(curl_resolve "$AUTHENTIK_BASE_URL" | tr '\n' ' ') $(curl_resolve "$GITEA_BASE_URL" | tr '\n' ' ') $(curl_resolve "$PORTAL_BASE_URL" | tr '\n' ' ') $INSECURE"

# get URL -> sets CODE, LOCATION, BODY (no redirects followed)
get() {
  local out
  out="$(curl -sS -c "$JAR" -b "$JAR" $R --max-time 30 -o "$TMP/body" -w '%{http_code} %{redirect_url}' "$1")"
  CODE="${out%% *}"; LOCATION="${out#* }"; BODY="$(cat "$TMP/body")"
}
origin() { local h="${1#*://}"; printf '%s://%s' "${1%%://*}" "${h%%/*}"; }
# A completed stage answers 302 to the executor itself: -L turns that into the GET
# that fetches the next challenge, as the browser's executor does.
post_json() { # URL BODY
  printf '%s' "$2" | curl -sS -L -c "$JAR" -b "$JAR" $R --max-time 30 -H 'Content-Type: application/json' -H 'Referer: '"$AUTHENTIK_BASE_URL/" --data-binary @- "$1"
}
abs() { case "$1" in http*) printf '%s' "$1" ;; *) printf '%s%s' "$2" "$1" ;; esac; }

# run_flow SLUG QUERY -> prints the URL the flow ends on
run_flow() {
  local slug="$1" query="$2" url resp component tries=0
  url="$AUTHENTIK_BASE_URL/api/v3/flows/executor/$slug/?query=$(urlenc "$query")"
  resp="$(curl -sS -c "$JAR" -b "$JAR" $R --max-time 30 "$url")"
  while :; do
    tries=$((tries+1)); [ $tries -le 8 ] || die "flow $slug: too many steps"
    component="$(printf '%s' "$resp" | jsonq get component)"
    case "$component" in
      ak-stage-identification)
        log "flow $slug: identification"
        resp="$(post_json "$url" "$(jsonq build component=ak-stage-identification uid_field="$USER_NAME" password="$PASSWORD")")" ;;
      ak-stage-password)
        log "flow $slug: password"
        resp="$(post_json "$url" "$(jsonq build component=ak-stage-password password="$PASSWORD")")" ;;
      ak-stage-consent)
        log "flow $slug: consent"
        resp="$(post_json "$url" "$(jsonq build component=ak-stage-consent token="$(printf '%s' "$resp" | jsonq get token)")")" ;;
      xak-flow-redirect)
        printf '%s' "$resp" | jsonq get to; return 0 ;;
      ak-stage-access-denied) die "flow $slug: access denied: $(printf '%s' "$resp" | jsonq get error_message)" ;;
      "") die "flow $slug: empty or invalid response: $(printf '%.300s' "$resp")" ;;
      *) die "flow $slug: unhandled stage $component (errors: $(printf '%s' "$resp" | jsonq get response_errors))" ;;
    esac
  done
}

# Follow the browser's path, running every Authentik flow page through the executor API.
step "SSO login: $GITEA_BASE_URL -> Authentik ($USER_NAME) -> Gitea"
url="$GITEA_BASE_URL/user/oauth2/$GITEA_OIDC_SOURCE_NAME"
hops=0
while :; do
  hops=$((hops+1)); [ $hops -le 15 ] || die "too many redirects"
  case "$url" in
    "$AUTHENTIK_BASE_URL"/if/flow/*)
      slug="${url#"$AUTHENTIK_BASE_URL"/if/flow/}"; slug="${slug%%/*}"
      query="${url#*\?}"; [ "$query" = "$url" ] && query=""
      to="$(run_flow "$slug" "$query")"
      url="$(abs "$to" "$AUTHENTIK_BASE_URL")"
      continue ;;
  esac
  get "$url"
  log "GET ${url%%\?*} -> $CODE"
  case "$CODE" in
    30[1237]|308) url="$(abs "$LOCATION" "$(origin "$url")")" ;;
    200) break ;;
    *) die "unexpected HTTP $CODE at $url: $(printf '%.300s' "$BODY")" ;;
  esac
  case "$url" in "$GITEA_BASE_URL"/) break ;; esac
done

# Gitea's API refuses session cookies, so the proof is the page itself: the signed-in
# user name, and the OIDC source listed among the linked accounts.
login="$(curl -sS -c "$JAR" -b "$JAR" $R --max-time 30 "$GITEA_BASE_URL/" | sed -n 's/.*signed-in-username="\([^"]*\)".*/\1/p' | head -n 1)"
[ -n "$login" ] || die "no Gitea session after the callback"
ok "Gitea session established through Authentik: signed in as '$login'"
if curl -sS -c "$JAR" -b "$JAR" $R --max-time 30 "$GITEA_BASE_URL/user/settings/security" | grep -q "$GITEA_OIDC_SOURCE_NAME"; then
  ok "linked account '$GITEA_OIDC_SOURCE_NAME' listed in the user's security settings"
fi
echo "sso-login-check: PASS user=$login source=$GITEA_OIDC_SOURCE_NAME"
