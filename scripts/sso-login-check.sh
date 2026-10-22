#!/usr/bin/env bash
# Proves the SSO path end to end with curl: Gitea sends the browser to Authentik, the
# user signs in through Authentik's flow executor API, Authentik sends the code back to
# Gitea, Gitea creates the session. Nothing a browser would not do; nothing is printed
# except status lines and the Gitea login that resulted.
#
#   scripts/sso-login-check.sh --install-dir DIR [--user akadmin] [--password-env VAR]
#       [--target URL [--expect allowed|denied] [--probe PATH=CODE ...]]
#
# Default user is akadmin with AUTHENTIK_BOOTSTRAP_PASSWORD from .env. Run it on the box
# (it pins the public names to the proxy on 127.0.0.1). Not part of the smoke tests with
# akadmin: the bootstrap password is meant to be replaced by a human.
# --target URL walks a forward-auth route instead of Gitea (an app, the portal, an ops
# tool): allowed means the user ends on URL with HTTP 200 behind the SSO; denied means
# Authentik refuses the user after a successful sign-in. Smoke test 18 runs it with the
# smoke user (AUTHENTIK_SMOKE_USER) and --expect denied on the ops tools.
# --probe PATH=CODE (repeatable, with --expect allowed): after the sign-in, GET URL+PATH
# with the same session and require HTTP CODE. Smoke test 24 runs it on the portal:
# the smoke user reads the catalog (200) and is refused the people list (403).
set -eu
IHC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$IHC_ROOT/scripts/lib/common.sh"

INSTALL_DIR="${IHC_INSTALL_DIR:-/opt/inhousecloud}"
USER_NAME=akadmin
PASSWORD_ENV=AUTHENTIK_BOOTSTRAP_PASSWORD
TARGET=""; EXPECT=allowed; PROBES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --user) USER_NAME="$2"; shift ;;
    --password-env) PASSWORD_ENV="$2"; shift ;;
    --target) TARGET="${2%/}"; shift ;;
    --expect) EXPECT="$2"; shift ;;
    --probe) case "$2" in /*=[0-9][0-9][0-9]) PROBES="$PROBES $2" ;; *) die "--probe is PATH=CODE, e.g. /api/people=403" ;; esac; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
case "$EXPECT" in allowed|denied) ;; *) die "--expect is allowed or denied" ;; esac
ENV_FILE="$INSTALL_DIR/.env"; STATE_FILE="$INSTALL_DIR/state.json"
load_env
eval "PASSWORD=\${$PASSWORD_ENV:-}"
[ -n "$PASSWORD" ] || die "$PASSWORD_ENV is empty"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ihc-sso.XXXXXX")"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"; : > "$JAR"
# TLS internal: certificates are checked against the cloud CA, as a device that
# installed it would.
INSECURE="$(ca_args)"
# shellcheck disable=SC2046
R="$(curl_resolve "$AUTHENTIK_BASE_URL" | tr '\n' ' ') $(curl_resolve "$GITEA_BASE_URL" | tr '\n' ' ') $(curl_resolve "$PORTAL_BASE_URL" | tr '\n' ' ') $INSECURE"
[ -n "$TARGET" ] && R="$R $(curl_resolve "$TARGET" | tr '\n' ' ')"

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
      ak-stage-access-denied)
        [ "$EXPECT" = denied ] && { log "flow $slug: access denied"; printf '%s' "__DENIED__"; return 0; }
        die "flow $slug: access denied: $(printf '%s' "$resp" | jsonq get error_message)" ;;
      "") die "flow $slug: empty or invalid response: $(printf '%.300s' "$resp")" ;;
      *) die "flow $slug: unhandled stage $component (errors: $(printf '%s' "$resp" | jsonq get response_errors))" ;;
    esac
  done
}

# denied_page: Authentik answered a page that refuses the signed-in user.
denied_page() { printf '%s' "$BODY" | grep -qiE 'access-denied|permission denied|access denied|not allowed'; }

if [ -n "$TARGET" ]; then
  # A forward-auth route: target -> outpost -> Authentik sign-in -> authorize -> target.
  step "SSO login: $TARGET -> Authentik ($USER_NAME) -> $TARGET, expecting $EXPECT"
  url="$TARGET/"; hops=0; outcome=""
  while :; do
    hops=$((hops+1)); [ $hops -le 20 ] || die "too many redirects"
    case "$url" in
      "$AUTHENTIK_BASE_URL"/if/flow/*)
        slug="${url#"$AUTHENTIK_BASE_URL"/if/flow/}"; slug="${slug%%/*}"
        query="${url#*\?}"; [ "$query" = "$url" ] && query=""
        to="$(run_flow "$slug" "$query")"
        [ "$to" = __DENIED__ ] && { outcome=denied; break; }
        url="$(abs "$to" "$AUTHENTIK_BASE_URL")"
        continue ;;
    esac
    get "$url"
    log "GET ${url%%\?*} -> $CODE"
    case "$CODE" in
      30[1237]|308) url="$(abs "$LOCATION" "$(origin "$url")")" ;;
      200|403)
        case "$url" in
          "$AUTHENTIK_BASE_URL"/*) denied_page && outcome=denied || die "stopped on an Authentik page (HTTP $CODE) at ${url%%\?*}" ;;
          "$TARGET"/*) [ "$CODE" = 200 ] && outcome=allowed || outcome=denied ;;
          *) die "ended on an unexpected page (HTTP $CODE) at ${url%%\?*}" ;;
        esac
        break ;;
      *) die "unexpected HTTP $CODE at ${url%%\?*}" ;;
    esac
  done
  if [ "$outcome" = "$EXPECT" ]; then
    ok "$USER_NAME: $outcome at $TARGET, as expected"
    seen=""; missed=""
    for p in $PROBES; do
      [ "$outcome" = allowed ] || break
      get "$TARGET${p%%=*}"
      seen="$seen ${p%%=*}=$CODE"
      [ "$CODE" = "${p##*=}" ] && log "GET ${p%%=*} -> $CODE, as expected" || { fail "GET ${p%%=*} -> $CODE (expected ${p##*=})"; missed="$missed ${p%%=*}=$CODE"; }
    done
    if [ -n "$missed" ]; then
      echo "sso-login-check: FAIL user=$USER_NAME target=$TARGET outcome=$outcome probes:$missed"
      exit 1
    fi
    echo "sso-login-check: PASS user=$USER_NAME target=$TARGET outcome=$outcome${seen:+ probes:$seen}"
    exit 0
  fi
  fail "$USER_NAME: $outcome at $TARGET (expected $EXPECT)"
  echo "sso-login-check: FAIL user=$USER_NAME target=$TARGET outcome=$outcome"
  exit 1
fi

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
