#!/usr/bin/env bash
# occ-app: from an empty folder to an app running behind the SSO (docs/gitops-flow.md).
#
#   occ-app new SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--push]
#       Generate the app repository from templates/app (manifest, compose file,
#       .gitea/workflows/deploy.yml), create SLUG in the Gitea organization and set it as
#       origin. --push pushes main, which is the deploy.
#   occ-app provision SLUG [--manifest FILE]
#       The executor, run on the box by the deploy job: validates the manifest and the
#       compose file, then ensures the app's database and role on the shared Postgres,
#       its Redis ACL user and key prefix, its bucket (only when asked for and the storage
#       profile is on), <install-dir>/apps/SLUG/.env (0600), the data directory
#       <install-dir>/app-data/SLUG (mounted at /data), the compose overlay, the
#       Authentik provider and application, the proxy host SLUG.<BASE_DOMAIN> with
#       forward auth, and the app's record in inventory.json.
#   occ-app checkout                   inside a deploy job: fetch the pushed commit
#   occ-app wait SLUG [--timeout S]    wait for the manifest healthcheck behind the proxy
#   occ-app list [--all] [--json]      the apps in inventory.json; --all includes the ones a
#                                      system test created (kind: system-test), hidden otherwise
#   occ-app remove SLUG [--yes]        remove an app a system test created, and only what its
#                                      deploy recorded (docs/cleanup.md); asks for the slug
#
# Options: --install-dir DIR (default $OCC_INSTALL_DIR, else /opt/open-company-cloud).
# Idempotent: every step probes first; a second run keeps every password. Only `remove`
# deletes a database, role, bucket, route or Authentik object, and only for a system test. Secrets go to the app's env file
# and travel on stdin or in the environment, never on a command line or in the output.
# `new` away from the box reads OCC_GITEA_URL, OCC_GITEA_TOKEN, OCC_GITEA_ORG
# and OCC_BASE_DOMAIN from the environment when there is no readable install .env.
set -eu
# Deploy jobs run through `docker exec`, whose umask is 0000: set ours. Env files are
# created 0600 on top of this.
umask 022
OCC_ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$OCC_ROOT/scripts/lib/common.sh"

usage() { sed -n '2,/^set -eu/p' "$OCC_ROOT/scripts/occ-app.sh" | sed '$d' | sed 's/^# \{0,1\}//'; }

INSTALL_DIR="${OCC_INSTALL_DIR:-/opt/open-company-cloud}"
CMD="${1:-}"; [ $# -gt 0 ] && shift
SLUG=""; DIR=""; NAME=""; OWNER=""; PUSH=false; MANIFEST="company-app.yaml"; TIMEOUT=240; ALL=false; YES=false
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --dir) DIR="$2"; shift ;;
    --name) NAME="$2"; shift ;;
    --owner) OWNER="$2"; shift ;;
    --push) PUSH=true ;;
    --manifest) MANIFEST="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --json) JSON_OUTPUT=true ;;
    --all) ALL=true ;;
    --yes|-y) YES=true ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$SLUG" ] && SLUG="$1" || die "unexpected argument: $1" ;;
  esac
  shift
done
INSTALL_DIR="${INSTALL_DIR%/}"
ENV_FILE="$INSTALL_DIR/.env"
INVENTORY="$INSTALL_DIR/inventory.json"
RESOURCES=""
record() { RESOURCES="$RESOURCES $1"; }

# Endpoints: the loopback control ports on the box itself, the service names on the
# occ network inside a deploy job (OCC_ENDPOINTS=internal, set by the runner).
endpoints() {
  local mode="${OCC_ENDPOINTS:-auto}"
  if [ "$mode" = auto ]; then
    if $PY -c 'import socket;socket.gethostbyname("authentik-server")' >/dev/null 2>&1; then mode=internal; else mode=loopback; fi
  fi
  if [ "$mode" = internal ]; then
    AK="http://authentik-server:9000/api/v3"; GT_ROOT="http://gitea:3000"
    NPM="http://proxy:81/api"; PROXY="http://proxy:80"
    # TLS internal: https://<name> pinned to the proxy's address on the occ network.
    PROXY_PIN="$($PY -c 'import socket;print(socket.gethostbyname("proxy"))' 2>/dev/null || true)"; PROXY_TLS_PORT=443
  else
    AK="http://127.0.0.1:${AUTHENTIK_LOCAL_PORT}/api/v3"; GT_ROOT="http://127.0.0.1:${GITEA_LOCAL_PORT}"
    NPM="http://127.0.0.1:${PROXY_ADMIN_PORT}/api"; PROXY="http://127.0.0.1:${PROXY_HTTP_PORT}"
  fi
  GT="$GT_ROOT/api/v1"
  ENDPOINTS="$mode"
}

# svc_cid SERVICE: the running container of a cloud service, found by its Compose labels.
svc_cid() {
  docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-occ}" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

app_url() { printf '%s://%s.%s' "${PORTAL_BASE_URL%%://*}" "$1" "$BASE_DOMAIN"; }
db_ident() { printf 'app_%s' "$(printf '%s' "$1" | tr '-' '_')"; }

# askpass FILE USER: a GIT_ASKPASS helper that answers USER and $OCC_GIT_TOKEN, so
# the token never appears in an argument or a remote URL.
askpass() {
  (umask 077; printf '#!/bin/sh\ncase "$1" in *sername*) printf "%%s\\n" "%s" ;; *) printf "%%s\\n" "$OCC_GIT_TOKEN" ;; esac\n' "$2" > "$1")
  chmod 700 "$1"
}

# ======================================================================== new
cmd_new() {
  [ -n "$SLUG" ] || die "usage: occ-app new SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--push]"
  $PY "$OCC_LIB/appmanifest.py" slug-check "$SLUG" || exit 1
  local gitea_url token org domain dir tmpl ap push_url
  if [ -r "$ENV_FILE" ]; then
    load_env; endpoints
    gitea_url="$GITEA_BASE_URL"; token="$GITEA_ADMIN_TOKEN"; org="$GITEA_ORGANIZATION"; domain="$BASE_DOMAIN"
    push_url="$GT_ROOT/$org/$SLUG.git"
    [ -n "$OWNER" ] || OWNER="$GITEA_ADMIN_EMAIL"
  else
    gitea_url="${OCC_GITEA_URL:-}"; token="${OCC_GITEA_TOKEN:-}"; org="${OCC_GITEA_ORG:-company}"; domain="${OCC_BASE_DOMAIN:-}"
    [ -n "$gitea_url" ] && [ -n "$token" ] && [ -n "$domain" ] || die "no readable $ENV_FILE: set OCC_GITEA_URL, OCC_GITEA_TOKEN (a token of yours with repository write) and OCC_BASE_DOMAIN, or pass --install-dir on the box"
    GT="${gitea_url%/}/api/v1"; push_url="${gitea_url%/}/$org/$SLUG.git"
  fi
  [ -n "$OWNER" ] || OWNER="$(git config user.email 2>/dev/null || true)"
  [ -n "$OWNER" ] || die "--owner EMAIL is required: the person who answers for the app"
  [ -n "$NAME" ] || NAME="$(printf '%s' "$SLUG" | tr '-' ' ' | $PY -c 'import sys;print(sys.stdin.read().strip().title())')"
  dir="${DIR:-$SLUG}"
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then die "$dir exists and is not empty"; fi
  have git || die "git is required"

  step "app repository $SLUG in $dir"
  mkdir -p "$dir"
  tmpl="$OCC_ROOT/templates/app"
  (cd "$tmpl" && tar cf - .) | (cd "$dir" && tar xf -)
  $PY - "$dir" "$SLUG" "$NAME" "$OWNER" "$SLUG.$domain" <<'PY'
import os, sys
root, slug, name, owner, domain = sys.argv[1:6]
subs = {"__APP_SLUG__": slug, "__APP_NAME__": name, "__OWNER_EMAIL__": owner, "__APP_DOMAIN__": domain}
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x != ".git"]
    for f in files:
        p = os.path.join(d, f)
        try: s = open(p).read()
        except UnicodeDecodeError: continue
        t = s
        for k, v in subs.items(): t = t.replace(k, v)
        if t != s: open(p, "w").write(t)
PY
  $PY "$OCC_LIB/appmanifest.py" vars "$dir/company-app.yaml" "$SLUG" >/dev/null || die "generated manifest does not validate"
  ! grep -rl '__APP_[A-Z]*__\|__OWNER_EMAIL__' "$dir" >/dev/null 2>&1 || die "template placeholders left in $dir: $(grep -rl '__APP_[A-Z]*__\|__OWNER_EMAIL__' "$dir" | head -n 3 | tr '\n' ' ')"
  ok "files from templates/app: company-app.yaml, docker-compose.yml, Dockerfile, .gitea/workflows/deploy.yml"
  (
    cd "$dir"
    git init -q -b main 2>/dev/null || { git init -q; git checkout -q -b main; }
    git add -A
    git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name 2>/dev/null || echo "${OWNER%@*}")}" -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email 2>/dev/null || echo "$OWNER")}" commit -q -m "New app $SLUG from the cloud template"
    git remote add origin "${gitea_url%/}/$org/$SLUG.git"
  )
  ok "git repository on main, origin ${gitea_url%/}/$org/$SLUG.git"

  api_init gt "Authorization: token $token"
  api GET "$GT/repos/$org/$SLUG"
  if [ "$API_CODE" = 404 ]; then
    api POST "$GT/orgs/$org/repos" "$(jsonq build name="$SLUG" description="$NAME (company app, deployed on push to main)" private:=true auto_init:=false default_branch=main)"
    api_ok || die "create repository $org/$SLUG: HTTP $API_CODE $API_BODY"
    ok "repository $org/$SLUG created in Gitea"
  else
    api_ok || die "probe repository $org/$SLUG: HTTP $API_CODE"
    [ "$(printf '%s' "$API_BODY" | jsonq get empty)" = true ] || die "repository $org/$SLUG already has commits: clone it instead of generating a new one"
    ok "repository $org/$SLUG exists and is empty"
  fi
  api PATCH "$GT/repos/$org/$SLUG" '{"has_actions":true}'
  api_ok && ok "Actions enabled on $org/$SLUG" || warn "could not enable Actions on $org/$SLUG (HTTP $API_CODE): enable them in the repository settings"

  if [ "$PUSH" = true ]; then
    ap="$(mktemp "${TMPDIR:-/tmp}/occ-askpass.XXXXXX")"; askpass "$ap" "occ"
    OCC_GIT_TOKEN="$token" GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git -C "$dir" push -q "$push_url" main:main || { rm -f "$ap"; die "push to $org/$SLUG failed"; }
    rm -f "$ap"
    ok "pushed main: the deploy workflow runs now ($gitea_url/$org/$SLUG/actions)"
  else
    log "next: cd $dir && git push -u origin main   (push to main is the deploy)"
  fi
  log "the app will answer at $(printf '%s' "${gitea_url%%://*}")://$SLUG.$domain once the workflow is green"
}

# ================================================================== provision
# ensure_database ROLE DB: role LOGIN NOSUPERUSER owning DB, no public connect. The
# password is created once and kept in the app's env file; it is set on the role only
# when the role is created (or when the env file lost it), so a re-run never changes it.
ensure_app_database() {
  local role="$1" db="$2" pw exists cid
  cid="$(svc_cid postgres)"; [ -n "$cid" ] || die "the shared Postgres container is not running"
  pw="$(envfile get "$APP_ENV" PGPASSWORD)"
  exists="$(docker exec -i "$cid" psql -U "$POSTGRES_USER" -d postgres -Atq -c "SELECT 1 FROM pg_roles WHERE rolname = '$role'" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$pw" ]; then
    pw="$(random_secret 32)"
    [ "$exists" = 1 ] && warn "role $role exists but $APP_ENV has no password for it: setting a new one"
    printf '%s' "$pw" | envfile set "$APP_ENV" PGPASSWORD
    exists=reset
  fi
  docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN
    CREATE ROLE "$role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$pw';
  ELSE
    ALTER ROLE "$role" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END \$\$;
$( [ "$exists" = reset ] && printf "ALTER ROLE \"%s\" PASSWORD '%s';" "$role" "$pw" )
SELECT 'CREATE DATABASE "$db" OWNER "$role"' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$db') \gexec
REVOKE CONNECT, TEMPORARY ON DATABASE "$db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$db" TO "$role";
SQL
  printf '%s' "postgres://$role:$pw@postgres:5432/$db" | envfile set "$APP_ENV" DATABASE_URL
  for kv in "PGHOST=postgres" "PGPORT=5432" "PGDATABASE=$db" "PGUSER=$role"; do
    printf '%s' "${kv#*=}" | envfile set "$APP_ENV" "${kv%%=*}"
  done
  ok "database $db and role $role (LOGIN NOSUPERUSER, no public connect); DATABASE_URL in the env file"
  record "postgres:database:$db"; record "postgres:role:$role"
}

# Redis: an ACL user limited to the SLUG: key and channel prefix, persisted in the ACL
# file the shared Redis loads at start (docker/compose.yml). Commands go on stdin.
ensure_app_redis() {
  local user="app-$SLUG" pw cid out
  cid="$(svc_cid redis)"; [ -n "$cid" ] || die "the shared Redis container is not running"
  pw="$(envfile get "$APP_ENV" REDIS_PASSWORD)"
  [ -n "$pw" ] || { pw="$(random_secret 32)"; printf '%s' "$pw" | envfile set "$APP_ENV" REDIS_PASSWORD; }
  if [ "$(printf 'ACL WHOAMI\n' | docker exec -i "$cid" redis-cli 2>&1 | tr -d '[:space:]')" = default ]; then
    out="$(printf 'ACL SETUSER %s reset on >%s ~%s:* &%s:* +@all -@admin -@dangerous +info\nACL SAVE\n' "$user" "$pw" "$SLUG" "$SLUG" | docker exec -i "$cid" redis-cli 2>&1)"
    case "$out" in *ERR*) die "Redis ACL for $user failed: $(printf '%s' "$out" | grep ERR | head -n 1)" ;; esac
    printf '%s' "redis://$user:$pw@redis:6379/0" | envfile set "$APP_ENV" REDIS_URL
    ok "Redis ACL user $user limited to keys and channels $SLUG:*; REDIS_URL in the env file"
    record "redis:acl-user:$user"
  else
    warn "Redis ACL not available: the app gets the shared default user and a key prefix only"
    printf '%s' "redis://redis:6379/0" | envfile set "$APP_ENV" REDIS_URL
  fi
  printf '%s' "$SLUG:" | envfile set "$APP_ENV" REDIS_PREFIX
  record "redis:prefix:$SLUG:"
}

# Object storage (Garage, storage profile): a bucket app-SLUG and an access key app-SLUG
# with read and write on that bucket only (scripts/lib/garage.sh). Never Garage's RPC
# secret or admin token in the app's env file.
ensure_app_bucket() {
  garage_app_bucket "$SLUG" "$APP_ENV" "${PORTAL_BASE_URL%%://*}://s3.$BASE_DOMAIN" || die "object storage for $SLUG failed: fix the lines above and push again"
  ok "bucket app-$SLUG and access key app-$SLUG ($GARAGE_RESULT; read and write on this bucket only); S3_* in the env file"
  record "garage:bucket:app-$SLUG"; record "garage:key:app-$SLUG"
}

# env_example_defaults FILE: keys of the app's .env.example that the env file lacks are
# added with the example's value (the example holds no secrets by contract). LOCAL_*
# keys are for development on a laptop and never reach the box.
env_example_defaults() {
  local f="$1" k v
  [ -f "$f" ] || return 0
  for k in $(envfile keys "$f"); do
    [ -n "$(envfile get "$APP_ENV" "$k")" ] && continue
    case "$k" in DATABASE_URL|REDIS_URL|PG*|S3_*|REDIS_*|LOCAL_*) continue ;; esac
    v="$(envfile get "$f" "$k")"
    printf '%s' "$v" | envfile set "$APP_ENV" "$k"
  done
}

inventory_record() {
  $PY - "$INVENTORY" "$SLUG" "$M_NAME" "$M_OWNER" "$APP_URL" "${GITHUB_REPOSITORY:-}" "${GITHUB_SHA:-}" "$APP_ENV" "$APP_DIR/compose.occ.yml" "$RESOURCES" <<'PY'
import datetime, json, os, sys, tempfile
path, slug, name, owner, url, repo, sha, envf, overlay, res = sys.argv[1:11]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
try:
    inv = json.load(open(path))
except (OSError, ValueError):
    inv = {}
apps = inv.setdefault("apps", {})
cur = apps.get(slug, {})
cur.update({"slug": slug, "name": name, "owner_email": owner, "url": url, "env_file": envf,
            "compose_overlay": overlay, "resources": sorted(set(res.split())),
            "provisioned_at": now})
cur.setdefault("created_at", now)
if repo: cur["repository"] = repo
if sha: cur["last_commit"] = sha
apps[slug] = cur
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".inventory.")
with os.fdopen(fd, "w") as f:
    json.dump(inv, f, indent=2); f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

cmd_provision() {
  [ -n "$SLUG" ] || die "usage: occ-app provision SLUG [--manifest FILE]"
  load_env; endpoints
  [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST (run from the app repository, or pass --manifest)"
  local mdir compose json vars errf owner_repo route_owner app_pk prov_pk group_pk
  mdir="$(cd "$(dirname "$MANIFEST")" && pwd)"

  step "manifest and compose file ($MANIFEST)"
  vars="$($PY "$OCC_LIB/appmanifest.py" vars "$MANIFEST" "$SLUG")" || die "company-app.yaml is not deployable: fix the lines above"
  eval "$vars"
  if [ -n "${GITHUB_REPOSITORY:-}" ] && [ "${GITHUB_REPOSITORY##*/}" != "$SLUG" ]; then
    die "this job runs for $GITHUB_REPOSITORY but provisions $SLUG: the repository name must be the slug"
  fi
  compose="$mdir/$M_COMPOSE_FILE"
  [ -f "$compose" ] || die "compose file not found: $M_COMPOSE_FILE (runtime.compose_file)"
  errf="$(mktemp "${TMPDIR:-/tmp}/occ-compose.XXXXXX")"
  json="$(COMPANY_ENV_FILE=/dev/null docker compose --project-directory "$mdir" -p "$SLUG" -f "$compose" config --format json 2>"$errf")" \
    || { fail "$(tail -n 3 "$errf")"; rm -f "$errf"; die "docker compose config failed on $M_COMPOSE_FILE"; }
  rm -f "$errf"
  printf '%s' "$json" | $PY "$OCC_LIB/appmanifest.py" compose-check "$M_SERVICE" || die "the compose file brings services the cloud provides: fix the lines above"
  if [ "$M_BUCKET" = true ]; then
    case ",$COMPOSE_PROFILES," in *,storage,*) ;; *) die "company-app.yaml asks for object storage but the storage profile is off: set install.profile.storage: true and re-run install.sh, or set object_storage.required: false" ;; esac
  fi
  ok "manifest valid: $M_NAME, owner $M_OWNER, service $M_SERVICE on port $M_PORT, health $M_HEALTH_PATH"

  # Ownership: an app already registered for another repository is never taken over.
  owner_repo="$($PY -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["apps"][sys.argv[2]].get("repository",""))
except Exception: print("")' "$INVENTORY" "$SLUG")"
  if [ -n "$owner_repo" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ "$owner_repo" != "$GITHUB_REPOSITORY" ]; then
    die "$SLUG is registered in inventory.json for $owner_repo, not $GITHUB_REPOSITORY: nothing changed"
  fi

  step "app environment"
  APP_DIR="$INSTALL_DIR/apps/$SLUG"; APP_ENV="$APP_DIR/.env"; APP_URL="$(app_url "$SLUG")"
  (umask 077; mkdir -p "$APP_DIR"); chmod 700 "$INSTALL_DIR/apps" "$APP_DIR" 2>/dev/null || true
  # The app's files: <install-dir>/app-data/SLUG, mounted at /data. Kept apart from
  # apps/SLUG (which holds the env file) so the ops file browser can show data, never
  # secrets. Backed up with the install directory.
  APP_DATA="$INSTALL_DIR/app-data/$SLUG"
  (umask 077; mkdir -p "$APP_DATA"); chmod 700 "$INSTALL_DIR/app-data" 2>/dev/null || true
  [ -f "$APP_ENV" ] || (umask 077; : > "$APP_ENV")
  for kv in "APP_SLUG=$SLUG" "APP_BASE_URL=$APP_URL" "PORT=$M_PORT" "DATA_DIR=/data"; do
    printf '%s' "${kv#*=}" | envfile set "$APP_ENV" "${kv%%=*}"
  done
  [ "$M_DATABASE" = true ] && ensure_app_database "$(db_ident "$SLUG")" "$(db_ident "$SLUG")"
  [ "$M_REDIS" = true ] && ensure_app_redis
  [ "$M_BUCKET" = true ] && ensure_app_bucket
  env_example_defaults "$mdir/$M_ENV_EXAMPLE"
  chmod 600 "$APP_ENV"
  printf '%s' "$json" | $PY "$OCC_LIB/appmanifest.py" overlay "$SLUG" "$M_SERVICE" "$APP_ENV" "$OCC_NETWORK" "$APP_DATA" > "$APP_DIR/compose.occ.yml"
  chmod 644 "$APP_DIR/compose.occ.yml"
  ok "env file $APP_ENV (0600: $(envfile keys "$APP_ENV" | tr '\n' ' '))"
  ok "compose overlay $APP_DIR/compose.occ.yml (network $OCC_NETWORK, alias $SLUG, no host ports, $APP_DATA at /data)"

  step "route and SSO for $APP_URL"
  npm_login
  route_owner="$(proxy_host_field "$SLUG.$BASE_DOMAIN" forward_host)"
  if [ -n "$route_owner" ] && [ "$route_owner" != "$SLUG" ]; then
    die "the proxy already routes $SLUG.$BASE_DOMAIN to $route_owner: not touching a route the cloud did not create for this app"
  fi
  if [ "$M_AUTH" = true ]; then
    api_init ak "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}"
    group_pk="$(ak_list_find "core/groups/?name=$(urlenc "$AUTHENTIK_APP_GROUP")" name "$AUTHENTIK_APP_GROUP" pk)"
    [ -n "$group_pk" ] || die "Authentik group $AUTHENTIK_APP_GROUP not found: run scripts/first-run.sh"
    prov_pk="$(ensure_proxy_provider "app-$SLUG" "$APP_URL" "^$M_HEALTH_PATH\$")"
    app_pk="$(ensure_application "$SLUG" "$M_NAME" "$prov_pk" "$APP_URL")"
    record "authentik:provider:proxy:app-$SLUG"; record "authentik:application:$SLUG"
    outpost_serve "$prov_pk" >/dev/null; ok "embedded outpost serves $APP_URL"
    ensure_binding "$app_pk" "$group_pk" "$SLUG <- $AUTHENTIK_APP_GROUP"
    npm_login
    ensure_proxy_host "$SLUG.$BASE_DOMAIN" "$SLUG" "$M_PORT" "$(forward_auth_conf "$M_HEALTH_PATH")"
  else
    warn "auth.required is false: $APP_URL is public to whoever reaches the proxy"
    ensure_proxy_host "$SLUG.$BASE_DOMAIN" "$SLUG" "$M_PORT" ""
  fi

  inventory_record
  ok "inventory.json: $SLUG, owner $M_OWNER${GITHUB_REPOSITORY:+, repository $GITHUB_REPOSITORY}"
  # The operator agent's map follows the inventory (agent profile only; never fails a deploy).
  [ -d "$INSTALL_DIR/agent/reference" ] && { "$OCC_ROOT/scripts/occ-operator.sh" brief --install-dir "$INSTALL_DIR" --out "$INSTALL_DIR/agent/reference" >/dev/null 2>&1 || warn "operator brief not refreshed"; }
  if [ "$JSON_OUTPUT" = true ]; then
    jsonq build slug="$SLUG" url="$APP_URL" env_file="$APP_ENV" overlay="$APP_DIR/compose.occ.yml" resources="${RESOURCES# }"
  fi
}

# =================================================================== checkout
cmd_checkout() {
  [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_SHA:-}" ] || die "checkout runs inside a deploy job (GITHUB_REPOSITORY and GITHUB_SHA unset)"
  [ -n "${OCC_GIT_TOKEN:-}" ] || die "OCC_GIT_TOKEN is empty: the workflow passes the job token (secrets.GITHUB_TOKEN)"
  endpoints
  local ap; ap="$(mktemp "${TMPDIR:-/tmp}/occ-askpass.XXXXXX")"; askpass "$ap" "x-access-token"
  git init -q . 2>/dev/null
  git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
  GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git fetch -q --depth 1 "$GT_ROOT/$GITHUB_REPOSITORY.git" "$GITHUB_SHA" || { rm -f "$ap"; die "fetch of $GITHUB_REPOSITORY@$GITHUB_SHA from $GT_ROOT failed"; }
  rm -f "$ap"
  git checkout -q --force FETCH_HEAD
  ok "checked out $GITHUB_REPOSITORY@$(printf '%s' "$GITHUB_SHA" | cut -c1-12)"
}

# ======================================================================= wait
cmd_wait() {
  [ -n "$SLUG" ] || die "usage: occ-app wait SLUG [--timeout SECONDS]"
  load_env; endpoints
  local host="$SLUG.$BASE_DOMAIN" t0 code state loc vars
  vars="$($PY "$OCC_LIB/appmanifest.py" vars "$MANIFEST" "$SLUG")" || exit 1
  eval "$vars"
  t0=$(date +%s)
  step "waiting for $M_HEALTH_PATH = $M_HEALTH_STATUS on $host (up to ${TIMEOUT}s)"
  while :; do
    state="$(docker ps -a --filter "label=com.docker.compose.project=$SLUG" --filter "label=com.docker.compose.service=$M_SERVICE" --format '{{.State}}' | head -n 1)"
    code="$(http_code "$(proxy_url "$host" "$M_HEALTH_PATH")" $(proxy_args "$host"))"
    [ "$code" = "$M_HEALTH_STATUS" ] && break
    case "$state" in exited|dead) code="container $state" ;; esac
    if [ "$state" = exited ] || [ "$state" = dead ] || [ $(( $(date +%s) - t0 )) -ge "$TIMEOUT" ]; then
      fail "$SLUG did not come up: $M_HEALTH_PATH through the proxy answered '$code' (wanted $M_HEALTH_STATUS), container state '${state:-missing}'"
      fail "last lines of the container log:"
      docker logs --tail 40 "$(docker ps -aq --filter "label=com.docker.compose.project=$SLUG" --filter "label=com.docker.compose.service=$M_SERVICE" | head -n 1)" >&2 2>&1 || true
      fail "check that the service listens on port $M_PORT (runtime.port) and answers $M_HEALTH_PATH, then push again"
      exit 1
    fi
    sleep 3
  done
  ok "$host$M_HEALTH_PATH answers $code through the proxy"
  if [ "$M_AUTH" = true ]; then
    # The embedded outpost loads a new provider a few seconds after provision; until then
    # the forward-auth call answers 500. Retry for up to 60 s before calling it unprotected.
    t0=$(date +%s)
    while :; do
      loc="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 $(proxy_args "$host") "$(proxy_url "$host" /)" 2>/dev/null || echo 000)"
      case "$loc" in 302*outpost.goauthentik.io*|302*"$AUTHENTIK_HOST"*) break ;; esac
      if [ $(( $(date +%s) - t0 )) -ge 60 ]; then
        fail "/ is not protected: got '${loc%% *}' (wanted 302 to the outpost); re-run occ-app provision $SLUG"; exit 1
      fi
      sleep 3
    done
    ok "anonymous requests to / are sent to the Authentik sign-in"
  fi
  ok "$SLUG is up at $(app_url "$SLUG")"
}

# ======================================================================= list
cmd_list() {
  [ -f "$INVENTORY" ] || die "no inventory.json in $INSTALL_DIR"
  $PY -c 'import json,sys
apps=json.load(open(sys.argv[1])).get("apps",{})
hidden=[s for s,a in apps.items() if a.get("kind")=="system-test" and sys.argv[2]!="true"]
apps={s:a for s,a in apps.items() if s not in hidden}
if sys.argv[3]=="true":
    print(json.dumps(apps,indent=2)); sys.exit()
for s,a in sorted(apps.items()):
    print("%-24s %-40s %-28s %s%s"%(s,a.get("url",""),a.get("owner_email",""),a.get("provisioned_at",""),"  [system test]" if a.get("kind")=="system-test" else ""))
if not apps: print("no apps yet")
if hidden: print("(%d app(s) left by a system test hidden: %s; occ-app list --all, occ-app remove SLUG)"%(len(hidden)," ".join(sorted(hidden))))' "$INVENTORY" "$ALL" "$JSON_OUTPUT"
}

# ===================================================================== remove
# Only an app a system test created (kind: system-test in inventory.json, which smoke test
# 16 sets): a real app's data has no automated removal. Only what the inventory recorded
# for it is removed, each item probed first: its containers, volumes, network and built
# images (Compose project SLUG), its database and role, its Redis user and keys, its bucket
# and key, its Authentik application and provider, its proxy host (only when it forwards
# to SLUG), its Gitea repository (only ORG/SLUG), its env file and data directory, and
# its inventory record. Anything that cannot be removed is reported and the record stays.
cmd_remove() {
  [ -n "$SLUG" ] || die "usage: occ-app remove SLUG [--yes]"
  load_env; endpoints
  [ -f "$INVENTORY" ] || die "no inventory.json in $INSTALL_DIR"
  local rec kind repo res r pk id ids typed left="" org="$GITEA_ORGANIZATION" cid
  rec="$($PY -c 'import json,sys
a=(json.load(open(sys.argv[1])).get("apps") or {}).get(sys.argv[2])
if a is None: sys.exit(3)
print("%s\t%s\t%s"%(a.get("kind","app"),a.get("repository","")," ".join(a.get("resources",[]))))' "$INVENTORY" "$SLUG")" || die "$SLUG is not in inventory.json: nothing to remove"
  kind="$(printf '%s' "$rec" | cut -f1)"; repo="$(printf '%s' "$rec" | cut -f2)"; res=" $(printf '%s' "$rec" | cut -f3) "
  [ "$kind" = system-test ] || die "$SLUG is an app (kind '$kind'), not a system test: occ-app remove only removes what a test created. Removing a real app and its data is manual (docs/cleanup.md)"
  [ -z "$repo" ] || [ "$repo" = "$org/$SLUG" ] || die "$SLUG is recorded for repository $repo, not $org/$SLUG: nothing removed"
  if [ "$YES" != true ]; then
    [ -t 0 ] || die "no terminal: pass --yes to remove $SLUG without the question"
    printf 'Remove the system-test app %s and everything its deploy recorded? Type the slug: ' "$SLUG" >&2
    read -r typed || typed=""; [ "$typed" = "$SLUG" ] || die "nothing removed"
  fi
  step "remove $SLUG (system test)"
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$SLUG")"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null
  docker volume ls -q --filter "label=com.docker.compose.project=$SLUG" | xargs docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter "label=com.docker.compose.project=$SLUG" | xargs docker network rm >/dev/null 2>&1 || true
  { docker images -q --filter "label=com.docker.compose.project=$SLUG"; docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$SLUG-" || true; } | sort -u | xargs docker image rm -f >/dev/null 2>&1 || true
  ok "containers, volumes, network and built images of Compose project $SLUG"
  for r in $res; do
    case "$r" in
      postgres:database:*)
        cid="$(svc_cid postgres)"
        docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"${r#postgres:database:}\" WITH (FORCE)" >/dev/null \
          && ok "database ${r#postgres:database:} dropped" || left="$left $r" ;;
    esac
  done
  for r in $res; do
    case "$r" in
      postgres:role:*)
        cid="$(svc_cid postgres)"
        docker exec -i "$cid" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -q -c "DROP ROLE IF EXISTS \"${r#postgres:role:}\"" >/dev/null \
          && ok "role ${r#postgres:role:} dropped" || left="$left $r" ;;
      redis:acl-user:*)
        cid="$(svc_cid redis)"
        printf 'ACL DELUSER %s\nACL SAVE\n' "${r#redis:acl-user:}" | docker exec -i "$cid" redis-cli >/dev/null 2>&1 \
          && ok "Redis user ${r#redis:acl-user:} deleted" || left="$left $r" ;;
      redis:prefix:*)
        cid="$(svc_cid redis)"
        docker exec -i "$cid" sh -c 'redis-cli --scan --pattern "$1*" | while read -r k; do redis-cli DEL "$k" >/dev/null; done' sh "${r#redis:prefix:}" \
          && ok "Redis keys ${r#redis:prefix:}* deleted" || left="$left $r" ;;
      garage:key:*)
        garage_need && id="$(printf null | garage_api ListKeys | jsonq find "" name "${r#garage:key:}" id)" && [ -n "$id" ] \
          && printf '{"id":"%s"}' "$id" | garage_api DeleteKey >/dev/null && ok "S3 key ${r#garage:key:} deleted" || left="$left $r" ;;
      garage:bucket:*)
        garage_need && id="$(printf '{"globalAlias":"%s"}' "${r#garage:bucket:}" | garage_api GetBucketInfo 2>/dev/null | jsonq get id)" && [ -n "$id" ] \
          && printf '{"id":"%s"}' "$id" | garage_api DeleteBucket >/dev/null && ok "bucket ${r#garage:bucket:} deleted (it was empty)" || left="$left $r" ;;
    esac
  done
  case "$res" in *" authentik:application:$SLUG "*)
    api_init ak "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}"
    api DELETE "$AK/core/applications/$SLUG/"
    case "$API_CODE" in 204|404) ok "Authentik application $SLUG deleted" ;; *) left="$left authentik:application:$SLUG" ;; esac ;;
  esac
  case "$res" in *" authentik:provider:proxy:app-$SLUG "*)
    api_init ak "Authorization: Bearer ${AUTHENTIK_BOOTSTRAP_TOKEN}"
    pk="$(ak_list_find "providers/proxy/?name=$(urlenc "app-$SLUG")" name "app-$SLUG" pk)"
    if [ -n "$pk" ]; then api DELETE "$AK/providers/proxy/$pk/"; api_ok && ok "Authentik provider app-$SLUG deleted" || left="$left authentik:provider:proxy:app-$SLUG"; fi ;;
  esac
  npm_login
  if [ "$(proxy_host_field "$SLUG.$BASE_DOMAIN" forward_host)" = "$SLUG" ]; then
    id="$(proxy_host_field "$SLUG.$BASE_DOMAIN" id)"
    api DELETE "$NPM/nginx/proxy-hosts/$id"
    api_ok && ok "proxy host $SLUG.$BASE_DOMAIN deleted" || left="$left proxy:$SLUG.$BASE_DOMAIN"
  fi
  api_init gt "Authorization: token $GITEA_ADMIN_TOKEN"
  api DELETE "$GT/repos/$org/$SLUG"
  case "$API_CODE" in 204|404) ok "Gitea repository $org/$SLUG deleted" ;; *) left="$left gitea:$org/$SLUG" ;; esac
  for d in "$INSTALL_DIR/apps/$SLUG" "$INSTALL_DIR/app-data/$SLUG"; do
    rm -rf "$d" 2>/dev/null || docker run --rm -v "$(dirname "$d"):/parent" --entrypoint rm "$POSTGRES_IMAGE" -rf "/parent/$SLUG" >/dev/null 2>&1 || true
    [ -e "$d" ] && left="$left dir:$d"
  done
  [ -n "$left" ] && die "$SLUG not completely removed; left:$left. Its inventory record stays (kind system-test, hidden from occ-app list)"
  $PY - "$INVENTORY" "$SLUG" <<'PY'
import json, os, sys, tempfile
path, slug = sys.argv[1:3]
inv = json.load(open(path)); (inv.get("apps") or {}).pop(slug, None)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".inventory.")
with os.fdopen(fd, "w") as f:
    json.dump(inv, f, indent=2); f.write("\n")
os.chmod(tmp, 0o644); os.replace(tmp, path)
PY
  ok "$SLUG removed from inventory.json"
  [ -d "$INSTALL_DIR/agent/reference" ] && { "$OCC_ROOT/scripts/occ-operator.sh" brief --install-dir "$INSTALL_DIR" --out "$INSTALL_DIR/agent/reference" >/dev/null 2>&1 || true; }
  return 0
}

# shellcheck source=lib/sso.sh
. "$OCC_LIB/sso.sh"
# shellcheck source=lib/garage.sh
. "$OCC_LIB/garage.sh"
case "$CMD" in
  new) cmd_new ;;
  provision) cmd_provision ;;
  checkout) cmd_checkout ;;
  wait) cmd_wait ;;
  list) cmd_list ;;
  remove) cmd_remove ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $CMD (see --help)" ;;
esac
