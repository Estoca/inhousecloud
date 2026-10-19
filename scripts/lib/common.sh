# Shared shell library for install.sh, first-run.sh and smoke-tests.sh.
# bash 3.2 compatible. Sourced, never executed.

HARNESS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_ROOT="$(cd "$HARNESS_LIB/../.." && pwd)"
PY="python3 -I"

JSON_OUTPUT="${JSON_OUTPUT:-false}"

# ------------------------------------------------------------------ output
# Human output always goes to stderr: stdout carries data (ids captured by callers,
# the final JSON with --json).
_out() { printf '%s\n' "$*" >&2; }
log()  { _out "    $*"; }
step() { _out "==> $*"; }
ok()   { _out "[ok] $*"; }
warn() { _out "[!!] $*"; }
fail() { _out "[xx] $*"; }
die()  { fail "$*"; exit 1; }

# ------------------------------------------------------------------ helpers
jsonq()   { $PY "$HARNESS_LIB/jsonq.py" "$@"; }
envfile() { $PY "$HARNESS_LIB/envfile.py" "$@"; }
state()   { $PY "$HARNESS_LIB/state.py" "$STATE_FILE" "$@"; }

env_get() { envfile get "$ENV_FILE" "$1"; }
# env_set KEY VALUE: the value travels on stdin, never on a command line.
env_set() { printf '%s' "$2" | envfile set "$ENV_FILE" "$1"; }

random_secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-40}"; }

# sha_fp VALUE: 12 hex chars of sha256, enough to tell "same value" without storing it.
sha_fp() { printf '%s' "$1" | $PY -c 'import hashlib,sys;print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:12])'; }

have() { command -v "$1" >/dev/null 2>&1; }

urlenc() { $PY -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# Hosts the box itself may not resolve (local ingress on a Mac): curl_resolve prints the
# --resolve argument that pins URL's host to the proxy on 127.0.0.1.
curl_resolve() { # URL
  local host port
  host="${1#*://}"; host="${host%%/*}"; host="${host%%:*}"
  case "$1" in https://*) port="${PROXY_HTTPS_PORT:-443}" ;; *) port="${PROXY_HTTP_PORT:-80}" ;; esac
  printf -- '--resolve\n%s:%s:127.0.0.1\n' "$host" "$port"
}

# load_env: export every variable of the install's .env into this shell.
load_env() {
  [ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE (run install.sh first)"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# dc: docker compose bound to the install directory.
dc() { docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yml" "$@"; }

# container_health SERVICE: healthy | unhealthy | starting | none | missing
container_health() {
  local id
  id="$(dc ps -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$id" ] || { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo missing
}

# wait_healthy TIMEOUT_SECONDS SERVICE...: polls the Docker healthcheck of each service.
wait_healthy() {
  local timeout="$1"; shift
  local svc start now status
  start=$(date +%s)
  for svc in "$@"; do
    while :; do
      status="$(container_health "$svc")"
      case "$status" in
        healthy) ok "$svc healthy"; break ;;
        none) ok "$svc running (no healthcheck)"; break ;;
      esac
      now=$(date +%s)
      if [ $((now - start)) -ge "$timeout" ]; then
        fail "$svc is $status after ${timeout}s"
        dc logs --tail 30 "$svc" >&2 || true
        return 1
      fi
      sleep 3
    done
  done
}

# http_code URL [EXTRA curl args...]: prints the HTTP status, 000 on connection failure.
http_code() {
  local url="$1"; shift
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" "$url" 2>/dev/null || echo 000
}

# wait_http TIMEOUT URL EXPECTED_CODE [EXTRA curl args...]
wait_http() {
  local timeout="$1" url="$2" want="$3"; shift 3
  local start now code
  start=$(date +%s)
  while :; do
    code="$(http_code "$url" "$@")"
    [ "$code" = "$want" ] && return 0
    now=$(date +%s)
    [ $((now - start)) -ge "$timeout" ] && { fail "$url answered $code (wanted $want) after ${timeout}s"; return 1; }
    sleep 3
  done
}

# wait_tcp TIMEOUT HOST PORT
wait_tcp() {
  local timeout="$1" host="$2" port="$3" start now
  start=$(date +%s)
  while :; do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 2>/dev/null; return 0; fi
    now=$(date +%s)
    [ $((now - start)) -ge "$timeout" ] && return 1
    sleep 2
  done
}

# port_in_use PORT: true when something already listens on 127.0.0.1:PORT.
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ---------------------------------------------------------------- JSON API
# A private curl config file carries the Authorization header, so no token ever
# appears on a command line. api_init NAME "Header: value"; api METHOD URL [JSON-BODY].
# After a call: API_CODE holds the status and API_BODY the response body.
API_TMPDIR=""
api_init() {
  if [ -z "$API_TMPDIR" ]; then
    API_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/harness-api.XXXXXX")"
    chmod 700 "$API_TMPDIR"
    trap 'rm -rf "$API_TMPDIR"' EXIT
  fi
  API_CFG="$API_TMPDIR/$1.cfg"
  (
    umask 077
    {
      printf 'silent\nshow-error\nmax-time = 60\n'
      printf 'header = "Accept: application/json"\n'
      printf 'header = "Content-Type: application/json"\n'
      if [ -n "$2" ]; then printf 'header = "%s"\n' "$2"; fi
    } > "$API_CFG"
  )
}
api() {
  local method="$1" url="$2" body="${3:-}" out rc
  rc=0
  if [ -n "$body" ]; then
    out="$(printf '%s' "$body" | curl -K "$API_CFG" -X "$method" --data-binary @- -w '\n%{http_code}' "$url" 2>/dev/null)" || rc=$?
  else
    out="$(curl -K "$API_CFG" -X "$method" -w '\n%{http_code}' "$url" 2>/dev/null)" || rc=$?
  fi
  API_CODE="${out##*$'\n'}"
  API_BODY="${out%$'\n'*}"
  case "$API_CODE" in [0-9][0-9][0-9]) ;; *) API_CODE=000 ;; esac
  [ $rc -ne 0 ] && [ "$API_CODE" = 000 ] && API_BODY=""
  return 0
}
api_ok() { case "$API_CODE" in 2*) return 0 ;; *) return 1 ;; esac; }
