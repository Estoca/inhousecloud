#!/usr/bin/env bash
# ihc-app: from an empty folder to an app running behind the SSO (docs/gitops-flow.md).
#
#   ihc-app new SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--push]
#       Generate the app repository from templates/app (manifest, compose file,
#       .gitea/workflows/deploy.yml), create SLUG in the Gitea organization and set it as
#       origin. --push pushes main, which is the deploy.
#   ihc-app init SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--port P] [--service S]
#                [--health PATH] [--push]
#       Adopt a project that already exists (DIR, default the current folder): add what
#       the deploy needs and is missing (company-app.yaml, .gitea/workflows/deploy.yml,
#       .env.example; docker-compose.yml and a Dockerfile only when there are none),
#       never touching the app's code; git init and commit them, create SLUG in the Gitea
#       organization and set it as a remote (origin, or `cloud` when origin is taken).
#       --push pushes the current commit to main, which is the deploy.
#   ihc-app provision SLUG [--manifest FILE]
#       The executor, run on the box by the deploy job: validates the manifest and the
#       compose file, then ensures the app's database and role on the shared Postgres,
#       its Redis ACL user and key prefix, its bucket (only when asked for and the storage
#       profile is on), <install-dir>/apps/SLUG/.env (0600), the data directory
#       <install-dir>/app-data/SLUG (mounted at /data), the compose overlay, the
#       Authentik provider and application, the proxy host SLUG.<BASE_DOMAIN> with
#       forward auth, and the app's record in inventory.json.
#   ihc-app checkout                   inside a deploy job: fetch the pushed commit
#   ihc-app lint [DIR]                 statically check the app trust boundary (default .)
#   ihc-app build SLUG [--manifest FILE]
#       Inside a deploy job, without the cloud's credentials: the files of the commit (git
#       archive, nothing else of the workspace) become a release in
#       <install-dir>/deploys/SLUG/releases/RID, its images are built and tagged
#       ihc-release/SLUG/<service>:RID, and release.json records commit and image ids.
#       Refuses a build that would read the box (build secrets, ssh, host network, a context
#       outside the repository). Prints RID and writes it to .ihc-release.
#   ihc-app apply SLUG [--release RID] [--lock-timeout S]
#       The reconciler: takes the app's lock (one apply or rollback per app at a time), applies
#       only a release whose commit is the head of main in Gitea (an older one of main is
#       skipped as superseded, any other refused), journals what it will change before
#       changing it, then provisions, starts the release's images (never builds) and waits
#       for the healthcheck. Every step and the result go to the deploy journal.
#   ihc-app rollback SLUG [--yes] [--reason TEXT] [--lock-timeout S]
#       On the box: undo the newest deploy in the journal not undone yet, going back to the
#       release (images and config) it replaced; journaled like a deploy and health-checked.
#       Refuses, changing nothing, when there is nothing to go back to. Never loops: an
#       unhealthy rollback is reported, not rolled back again.
#   ihc-app journal SLUG [--json] [--limit N]
#                                      the deploy journal of SLUG, newest first
#   ihc-app wait SLUG [--timeout S]    wait for the manifest healthcheck behind the proxy
#   ihc-app list [--all] [--json]      the apps in inventory.json; --all includes the ones a
#                                      system test created (kind: system-test), hidden otherwise
#   ihc-app remove SLUG [--yes]        remove an app a system test created, and only what its
#                                      deploy recorded, its releases and its journal
#                                      (docs/cleanup.md); asks for the slug
#
# Options: --install-dir DIR (default $IHC_INSTALL_DIR, else /opt/inhousecloud).
# Idempotent: every step probes first; a second run keeps every password. Only `remove`
# deletes a database, role, bucket, route or Authentik object, and only for a system test. Secrets go to the app's env file
# and travel on stdin or in the environment, never on a command line or in the output.
# `new` and `init` away from the box (a laptop) read IHC_GITEA_URL and IHC_GITEA_TOKEN (the
# person's own token, with repository write) from the environment when there is no
# readable install .env; IHC_GITEA_ORG (default: the one organization the token belongs to)
# and IHC_BASE_DOMAIN (default: IHC_GITEA_URL's host without `git.`) are optional.
set -eu
# Deploy jobs run through `docker exec`, whose umask is 0000: set ours. Env files are
# created 0600 on top of this.
umask 022
IHC_ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")/.." && pwd)"
# shellcheck source=lib/common.sh
. "$IHC_ROOT/scripts/lib/common.sh"

usage() { sed -n '2,/^set -eu/p' "$IHC_ROOT/scripts/ihc-app.sh" | sed '$d' | sed 's/^# \{0,1\}//'; }

INSTALL_DIR="${IHC_INSTALL_DIR:-/opt/inhousecloud}"
CMD="${1:-}"; [ $# -gt 0 ] && shift
SLUG=""; DIR=""; NAME=""; OWNER=""; PUSH=false; MANIFEST="company-app.yaml"; TIMEOUT=240; ALL=false; YES=false
PORT_OPT=""; SERVICE_OPT=""; HEALTH_OPT=""; RELEASE=""; REASON=""; LOCK_TIMEOUT=""; LIMIT=20
while [ $# -gt 0 ]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#*=}" ;;
    --dir) DIR="$2"; shift ;;
    --name) NAME="$2"; shift ;;
    --owner) OWNER="$2"; shift ;;
    --push) PUSH=true ;;
    --port) PORT_OPT="$2"; shift ;;
    --service) SERVICE_OPT="$2"; shift ;;
    --health) HEALTH_OPT="$2"; shift ;;
    --manifest) MANIFEST="$2"; shift ;;
    --timeout) TIMEOUT="$2"; shift ;;
    --release) RELEASE="$2"; shift ;;
    --reason) REASON="$2"; shift ;;
    --lock-timeout) LOCK_TIMEOUT="$2"; shift ;;
    --limit) LIMIT="$2"; shift ;;
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
legacy_guard "$INSTALL_DIR"
INVENTORY="$INSTALL_DIR/inventory.json"
# Releases and the per-app lock (0700: the apps' code), and the journal the portal reads.
DEPLOYS="$INSTALL_DIR/deploys"
JOURNAL_DIR="$INSTALL_DIR/catalog/deploys"
KEEP_RELEASES=5
RESOURCES=""
# die remembers its message: an interrupted transaction ends with it in the journal.
LAST_ERROR=""
die() { LAST_ERROR="$*"; fail "$*"; exit 1; }
record() { RESOURCES="$RESOURCES $1"; }

# Endpoints: the loopback control ports on the box itself, the service names on the
# ihc network inside a deploy job (IHC_ENDPOINTS=internal, set by the runner).
endpoints() {
  local mode="${IHC_ENDPOINTS:-auto}"
  if [ "$mode" = auto ]; then
    if $PY -c 'import socket;socket.gethostbyname("authentik-server")' >/dev/null 2>&1; then mode=internal; else mode=loopback; fi
  fi
  if [ "$mode" = internal ]; then
    AK="http://authentik-server:9000/api/v3"; GT_ROOT="http://gitea:3000"
    NPM="http://proxy:81/api"; PROXY="http://proxy:80"
    # TLS internal: https://<name> pinned to the proxy's address on the ihc network.
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
  docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-ihc}" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

app_url() { printf '%s://%s.%s' "${PORTAL_BASE_URL%%://*}" "$1" "$BASE_DOMAIN"; }
# The MCP gateway's public URL: the actor JWT's issuer (first-run writes MCP_BASE_URL).
mcp_public_url() { printf '%s' "${MCP_BASE_URL:-$(app_url mcp)}"; }
db_ident() { printf 'app_%s' "$(printf '%s' "$1" | tr '-' '_')"; }

# askpass FILE USER: a GIT_ASKPASS helper that answers USER and $IHC_GIT_TOKEN, so
# the token never appears in an argument or a remote URL.
askpass() {
  (umask 077; printf '#!/bin/sh\ncase "$1" in *sername*) printf "%%s\\n" "%s" ;; *) printf "%%s\\n" "$IHC_GIT_TOKEN" ;; esac\n' "$2" > "$1")
  chmod 700 "$1"
}

# ================================================================ new, init
# gitea_target: where the app's repository goes. On the box, the install's .env (the
# admin token, the loopback endpoints); elsewhere (a laptop), the person's own
# IHC_GITEA_URL and IHC_GITEA_TOKEN. Sets G_URL (what people clone), G_TOKEN, G_ORG,
# G_DOMAIN, G_PUSH (where this run pushes) and GT.
gitea_target() {
  local host orgs
  if [ -r "$ENV_FILE" ]; then
    load_env; endpoints
    G_URL="${GITEA_BASE_URL%/}"; G_TOKEN="$GITEA_ADMIN_TOKEN"; G_ORG="$GITEA_ORGANIZATION"; G_DOMAIN="$BASE_DOMAIN"
    G_PUSH="$GT_ROOT/$G_ORG/$SLUG.git"
    [ -n "$OWNER" ] || OWNER="$GITEA_ADMIN_EMAIL"
    api_init gt "Authorization: token $G_TOKEN"
    return 0
  fi
  G_URL="${IHC_GITEA_URL:-}"; G_URL="${G_URL%/}"; G_TOKEN="${IHC_GITEA_TOKEN:-}"
  [ -n "$G_URL" ] && [ -n "$G_TOKEN" ] || die "no readable $ENV_FILE: set IHC_GITEA_URL (the company's Git, http://git.<domain>) and IHC_GITEA_TOKEN (a token of yours with repository write: Gitea > Settings > Applications, docs/first-user.md), or pass --install-dir on the box"
  GT="$G_URL/api/v1"
  api_init gt "Authorization: token $G_TOKEN"
  G_ORG="${IHC_GITEA_ORG:-}"
  if [ -z "$G_ORG" ]; then
    api GET "$GT/user/orgs"
    case "$API_CODE" in
      2*) orgs="$(printf '%s' "$API_BODY" | $PY -c 'import json,sys;print(" ".join(o["username"] for o in json.load(sys.stdin)))')" ;;
      # Listing them needs the token's user scope; without it, the installer's default.
      403) orgs=company; warn "the token cannot list your organizations (no user scope): using company; set IHC_GITEA_ORG if yours has another name" ;;
      *) die "$G_URL does not accept IHC_GITEA_TOKEN (HTTP $API_CODE): make a new token (Gitea > Settings > Applications) with repository and organization read and write" ;;
    esac
    case "$orgs" in
      "") die "your Gitea account is in no organization: an admin adds you to a team that can create repositories (docs/first-user.md)" ;;
      *" "*) die "your Gitea account is in several organizations ($orgs): set IHC_GITEA_ORG to the one for apps" ;;
      *) G_ORG="$orgs" ;;
    esac
  fi
  G_DOMAIN="${IHC_BASE_DOMAIN:-}"
  if [ -z "$G_DOMAIN" ]; then
    host="${G_URL#*://}"; host="${host%%/*}"; host="${host%%:*}"
    case "$host" in git.*) G_DOMAIN="${host#git.}" ;; *) die "set IHC_BASE_DOMAIN: the cloud's domain (apps answer at <slug>.<domain>)" ;; esac
  fi
  G_PUSH="$G_URL/$G_ORG/$SLUG.git"
}

# gitea_repo MODE: the private repository <org>/SLUG with Actions on. `new` refuses one
# that already has commits; `init` accepts it (the push must then continue its history).
gitea_repo() {
  api GET "$GT/repos/$G_ORG/$SLUG"
  if [ "$API_CODE" = 404 ]; then
    api POST "$GT/orgs/$G_ORG/repos" "$(jsonq build name="$SLUG" description="$NAME (company app, deployed on push to main)" private:=true auto_init:=false default_branch=main)"
    if [ "$API_CODE" = 403 ]; then
      case "$API_BODY" in
        *scope*) die "the token cannot create repositories: make a new one (Gitea > Settings > Applications) with organization and repository Read and Write" ;;
        *) die "your Gitea account cannot create repositories in $G_ORG: an admin gives your team \"Create repositories\" (docs/first-user.md)" ;;
      esac
    fi
    api_ok || die "create repository $G_ORG/$SLUG: HTTP $API_CODE $API_BODY"
    ok "repository $G_ORG/$SLUG created in Gitea"
  else
    api_ok || die "probe repository $G_ORG/$SLUG: HTTP $API_CODE"
    if [ "$(printf '%s' "$API_BODY" | jsonq get empty)" = true ]; then
      ok "repository $G_ORG/$SLUG exists and is empty"
    elif [ "$1" = new ]; then
      die "repository $G_ORG/$SLUG already has commits: clone it instead of generating a new one"
    else
      ok "repository $G_ORG/$SLUG exists (it has commits: a push must continue its history)"
    fi
  fi
  api PATCH "$GT/repos/$G_ORG/$SLUG" '{"has_actions":true}'
  api_ok && ok "Actions enabled on $G_ORG/$SLUG" || warn "could not enable Actions on $G_ORG/$SLUG (HTTP $API_CODE): an admin enables them in the repository settings"
}

# push_main DIR: the current commit of DIR to main of the repository: the deploy. The
# token goes to git through GIT_ASKPASS, never in a URL or an argument, and no credential
# helper takes part: an old password the laptop keeps for this host (macOS Keychain, through
# the osxkeychain helper of Apple's git) would be sent instead, and the token would be stored.
push_main() {
  local ap
  ap="$(mktemp "${TMPDIR:-/tmp}/ihc-askpass.XXXXXX")"; askpass "$ap" "ihc"
  IHC_GIT_TOKEN="$G_TOKEN" git_auth_probe "$G_PUSH" "$ap" 30 2 || { rm -f "$ap"; die "git on $G_ORG/$SLUG does not answer with the token after $GIT_PROBE_TRIES tries: ${GIT_PROBE_ERR:-no message}"; }
  [ "$GIT_PROBE_TRIES" -le 1 ] || log "git answered with the token after $GIT_PROBE_TRIES tries"
  IHC_GIT_TOKEN="$G_TOKEN" GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git -c credential.helper= -C "$1" push -q "$G_PUSH" HEAD:main || { rm -f "$ap"; die "push to $G_ORG/$SLUG failed"; }
  rm -f "$ap"
  ok "pushed main: the deploy workflow runs now ($G_URL/$G_ORG/$SLUG/actions)"
}

# commit_as DIR MESSAGE: commit what is staged, as the person in git config or the owner.
commit_as() {
  git -C "$1" -c user.name="${GIT_AUTHOR_NAME:-$(git -C "$1" config user.name 2>/dev/null || echo "${OWNER%@*}")}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git -C "$1" config user.email 2>/dev/null || echo "$OWNER")}" commit -q -m "$2"
}

cmd_new() {
  [ -n "$SLUG" ] || die "usage: ihc-app new SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--push]"
  $PY "$IHC_LIB/appmanifest.py" slug-check "$SLUG" || exit 1
  local dir tmpl
  gitea_target
  [ -n "$OWNER" ] || OWNER="$(git config user.email 2>/dev/null || true)"
  [ -n "$OWNER" ] || die "--owner EMAIL is required: the person who answers for the app"
  [ -n "$NAME" ] || NAME="$(printf '%s' "$SLUG" | tr '-' ' ' | $PY -c 'import sys;print(sys.stdin.read().strip().title())')"
  dir="${DIR:-$SLUG}"
  if [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then die "$dir exists and is not empty (an app that already exists: ihc-app init $SLUG --dir $dir)"; fi
  have git || die "git is required"

  step "app repository $SLUG in $dir"
  mkdir -p "$dir"
  tmpl="$IHC_ROOT/templates/app"
  (cd "$tmpl" && tar cf - .) | (cd "$dir" && tar xf -)
  fill_placeholders "$dir"
  $PY "$IHC_LIB/appmanifest.py" vars "$dir/company-app.yaml" "$SLUG" >/dev/null || die "generated manifest does not validate"
  ! grep -rl '__APP_[A-Z]*__\|__OWNER_EMAIL__' "$dir" >/dev/null 2>&1 || die "template placeholders left in $dir: $(grep -rl '__APP_[A-Z]*__\|__OWNER_EMAIL__' "$dir" | head -n 3 | tr '\n' ' ')"
  ok "files from templates/app: company-app.yaml, docker-compose.yml, Dockerfile, .gitea/workflows/deploy.yml"
  (
    cd "$dir"
    git init -q -b main 2>/dev/null || { git init -q; git checkout -q -b main; }
    git add -A
    commit_as . "New app $SLUG from the cloud template"
    git remote add origin "$G_URL/$G_ORG/$SLUG.git"
  )
  ok "git repository on main, origin $G_URL/$G_ORG/$SLUG.git"
  gitea_repo new
  if [ "$PUSH" = true ]; then push_main "$dir"; else log "next: cd $dir && git push -u origin main   (push to main is the deploy)"; fi
  log "the app will answer at ${G_URL%%://*}://$SLUG.$G_DOMAIN once the workflow is green"
}

# fill_placeholders DIR [FILE...]: the template's __APP_*__ values, in FILEs or every file.
fill_placeholders() {
  $PY - "$SLUG" "$NAME" "$OWNER" "$SLUG.$G_DOMAIN" "${AUTHENTIK_APP_GROUP:-ihc-users}" "$@" <<'PY'
import os, sys
slug, name, owner, domain, group, root = sys.argv[1:7]
only = sys.argv[7:]
subs = {"__APP_SLUG__": slug, "__APP_NAME__": name, "__OWNER_EMAIL__": owner, "__APP_DOMAIN__": domain, "__APP_GROUP__": group}
paths = [os.path.join(root, f) for f in only]
if not only:
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x != ".git"]
        paths += [os.path.join(d, f) for f in files]
for p in paths:
    try: s = open(p).read()
    except UnicodeDecodeError: continue
    t = s
    for k, v in subs.items(): t = t.replace(k, v)
    if t != s: open(p, "w").write(t)
PY
}

# The manifest for an adopted project: the template's, with the project's service, port,
# compose file and health path, and without the template's MCP tools and npm test (the
# project has neither until someone writes them).
init_manifest() {
  $PY - "$1" "$SERVICE" "$PORT" "$COMPOSE" "$HEALTH" <<'PY'
import re, sys
path, service, port, compose, health = sys.argv[1:6]
s = open(path).read()
s = s.replace("  compose_file: docker-compose.yml", "  compose_file: " + compose, 1)
s = s.replace("  service: app\n", "  service: %s\n" % service, 1)
s = s.replace("  port: 8080\n", "  port: %s\n" % port, 1)
s = s.replace("    path: /health\n", "    path: %s\n" % health, 1)
s = re.sub(r"\n# Tools for AI agents.*?\nmcp:\n(?:  .*\n)+", "\n", s, flags=re.S)
s = s.replace("  test_command: npm test\n", "")
s = s.replace("# ihc-app provision reads it on every push to main.", "# ihc-app provision reads it on every push to main. Written by ihc-app init.")
open(path, "w").write(s)
PY
}

cmd_init() {
  [ -n "$SLUG" ] || die "usage: ihc-app init SLUG [--dir DIR] [--name NAME] [--owner EMAIL] [--port P] [--service S] [--health PATH] [--push]"
  $PY "$IHC_LIB/appmanifest.py" slug-check "$SLUG" || exit 1
  have git || die "git is required"
  local dir tmpl vars json f gd fresh=false created="" remote cur
  dir="${DIR:-.}"
  [ -d "$dir" ] || die "$dir is not a folder: run init in the app's folder (a new app from nothing: ihc-app new $SLUG)"
  dir="$(cd "$dir" && pwd)"; tmpl="$IHC_ROOT/templates/app"
  [ -f "$dir/company-app.yaml" ] && [ "$(sed -n 's/^  slug: *//p' "$dir/company-app.yaml" | head -n 1)" != "$SLUG" ] \
    && die "$dir/company-app.yaml names another slug: fix app.slug or pass that slug"

  # What the project already has decides the rest; nothing is written before every check passed.
  COMPOSE=""
  for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do [ -f "$dir/$f" ] && { COMPOSE="$f"; break; }; done
  SERVICE="${SERVICE_OPT:-app}"; PORT=""
  if [ -f "$dir/company-app.yaml" ]; then
    # Adopted before: the manifest says which compose file, service and port.
    vars="$($PY "$IHC_LIB/appmanifest.py" vars "$dir/company-app.yaml" "$SLUG")" || die "company-app.yaml does not validate: fix the lines above"
    eval "$vars"; COMPOSE="$M_COMPOSE_FILE"; SERVICE="$M_SERVICE"; PORT="$M_PORT"
  elif [ -n "$COMPOSE" ]; then
    # Docker's own reading when the laptop has Docker; the installer's YAML reader otherwise.
    if have docker && json="$(cd "$dir" && COMPANY_ENV_FILE=/dev/null docker compose -f "$COMPOSE" config --format json 2>/dev/null)"; then
      vars="$(printf '%s' "$json" | $PY "$IHC_LIB/appmanifest.py" inspect - "$SERVICE_OPT")"
    else
      vars="$($PY "$IHC_LIB/appmanifest.py" inspect "$dir/$COMPOSE" "$SERVICE_OPT")"
    fi || die "$COMPOSE cannot run on the cloud as it is: fix the lines above (init never edits it)"
    eval "$vars"
  fi
  # Without a compose file of its own, the project builds from a Dockerfile at its root.
  if { [ -z "$COMPOSE" ] || [ ! -f "$dir/$COMPOSE" ]; } && [ ! -f "$dir/Dockerfile" ] && [ ! -f "$dir/package.json" ]; then
    die "no Dockerfile in $dir: write one that installs what the app needs and starts it listening on 0.0.0.0 and the port in \$PORT, then run init again (init writes one only for a Node project with package.json)"
  fi
  PORT="${PORT_OPT:-${PORT:-8080}}"; HEALTH="${HEALTH_OPT:-/health}"
  case "$PORT" in *[!0-9]*|"") die "--port must be a number: the port the app listens on in its container" ;; esac
  gitea_target
  [ -n "$OWNER" ] || OWNER="$(git -C "$dir" config user.email 2>/dev/null || true)"
  [ -n "$OWNER" ] || die "--owner EMAIL is required: the person who answers for the app"
  [ -n "$NAME" ] || NAME="$(printf '%s' "$SLUG" | tr '-' ' ' | $PY -c 'import sys;print(sys.stdin.read().strip().title())')"
  # The commit needs a writable Git directory. An agent's sandbox may protect it (Codex's
  # workspace-write keeps .git read-only): say so before writing anything, not halfway.
  gd="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null || true)"
  if [ -n "$gd" ]; then
    { : > "$gd/ihc-write-check" && rm -f "$gd/ihc-write-check"; } 2>/dev/null \
      || die "cannot write $gd: this shell may not change the Git repository (an agent's sandbox, such as Codex's workspace-write, keeps .git read-only). Run init again outside the sandbox, or ask the person to run it in their own terminal"
  elif [ -z "${GIT_DIR:-}" ]; then
    { mkdir "$dir/.git" && rmdir "$dir/.git"; } 2>/dev/null \
      || die "cannot create $dir/.git: this shell may not create a Git repository there (an agent's sandbox, such as Codex's workspace-write, protects .git). Run init again outside the sandbox, or ask the person to run it in their own terminal"
  fi

  step "adopt $dir as the app $SLUG"
  if [ ! -f "$dir/Dockerfile" ] && [ -f "$dir/package.json" ]; then
    cat > "$dir/Dockerfile" <<EOF
# Written by ihc-app init for a Node project: npm start must listen on \$PORT.
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=$PORT
EXPOSE $PORT
CMD ["npm", "start"]
EOF
    created="$created Dockerfile"
    [ -e "$dir/.dockerignore" ] || { printf '.git\n.gitea\n.env\nnode_modules\n' > "$dir/.dockerignore"; created="$created .dockerignore"; }
  fi
  if [ -z "$COMPOSE" ] || [ ! -f "$dir/$COMPOSE" ]; then
    COMPOSE="${COMPOSE:-docker-compose.yml}"
    cat > "$dir/$COMPOSE" <<EOF
# Written by ihc-app init. Runs the same way on a laptop (docker compose up --build) and
# on the box, where the deploy adds the cloud network and the app's env file on top.
# Never add postgres, redis or object storage services here: the cloud provides them.
services:
  $SERVICE:
    build: .
    env_file:
      - path: \${COMPANY_ENV_FILE:-.env}
        required: false
    ports:
      - "\${PORT:-$PORT}:$PORT"
    restart: unless-stopped
EOF
    created="$created $COMPOSE"
  fi
  if [ ! -e "$dir/.env.example" ]; then
    printf '# Variables the app reads. No real values here, ever. On the box the deploy writes the\n# real file: PORT, APP_BASE_URL, DATA_DIR, DATABASE_URL (and PG*), REDIS_URL, REDIS_PREFIX.\nPORT=%s\n' "$PORT" > "$dir/.env.example"
    created="$created .env.example"
  fi
  if [ ! -e "$dir/.gitea/workflows/deploy.yml" ]; then
    mkdir -p "$dir/.gitea/workflows"; cp "$tmpl/.gitea/workflows/deploy.yml" "$dir/.gitea/workflows/deploy.yml"
    fill_placeholders "$dir" .gitea/workflows/deploy.yml; created="$created .gitea/workflows/deploy.yml"
  fi
  if [ ! -e "$dir/company-app.yaml" ]; then
    cp "$tmpl/company-app.yaml" "$dir/company-app.yaml"
    fill_placeholders "$dir" company-app.yaml; init_manifest "$dir/company-app.yaml"; created="$created company-app.yaml"
  fi
  # Secrets and local data stay on the laptop: the cloud gives the app its own.
  touch "$dir/.gitignore"
  for f in .env '*.db' '*.sqlite' '*.sqlite3'; do
    grep -qxF "$f" "$dir/.gitignore" || { printf '%s\n' "$f" >> "$dir/.gitignore"; case " $created " in *" .gitignore "*) ;; *) created="$created .gitignore" ;; esac; }
  done
  $PY "$IHC_LIB/appmanifest.py" vars "$dir/company-app.yaml" "$SLUG" >/dev/null || die "company-app.yaml does not validate: fix the lines above"
  if [ -n "$created" ]; then ok "added:$created (the app's code untouched)"; else ok "nothing to add: the project already has every file the deploy needs"; fi

  if [ ! -d "$dir/.git" ]; then
    git -C "$dir" init -q -b main 2>/dev/null || { git -C "$dir" init -q; git -C "$dir" checkout -q -b main; }
    fresh=true
  fi
  if [ "$fresh" = true ]; then
    git -C "$dir" add -A
  elif [ -n "$created" ]; then
    # shellcheck disable=SC2086
    (cd "$dir" && git add -- $created)
  fi
  if ! git -C "$dir" diff --cached --quiet 2>/dev/null || [ "$fresh" = true ]; then
    commit_as "$dir" "$([ "$fresh" = true ] && echo "$NAME, ready for the company cloud" || echo "Deploy on the company cloud (ihc-app init)")"
    ok "committed on $(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  fi
  [ -z "$(git -C "$dir" status --porcelain)" ] || warn "uncommitted changes in $dir stay out of the deploy until you commit them"

  remote=origin; cur="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  if [ -n "$cur" ] && [ "$cur" != "$G_URL/$G_ORG/$SLUG.git" ]; then
    remote=cloud; cur="$(git -C "$dir" remote get-url cloud 2>/dev/null || true)"
    [ -z "$cur" ] || [ "$cur" = "$G_URL/$G_ORG/$SLUG.git" ] || die "remotes origin and cloud both point elsewhere: remove one, then run init again"
  fi
  [ -n "$cur" ] || git -C "$dir" remote add "$remote" "$G_URL/$G_ORG/$SLUG.git"
  ok "remote $remote: $G_URL/$G_ORG/$SLUG.git"
  gitea_repo init
  if [ "$PUSH" = true ]; then push_main "$dir"; else log "next: git push $remote HEAD:main   (push to main is the deploy)"; fi
  log "the app must: listen on 0.0.0.0:\$PORT ($PORT); answer GET $HEALTH with 200 (no sign-in there);"
  log "  keep data in DATABASE_URL (Postgres, created empty) or under \$DATA_DIR (/data), never next to the code;"
  log "  read the person from the X-authentik-email header (docs/app-contract.md)"
  log "the app will answer at ${G_URL%%://*}://$SLUG.$G_DOMAIN once the workflow is green ($G_URL/$G_ORG/$SLUG/actions)"
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

# The app's record in inventory.json (scripts/lib/inventory.py has the contract the
# portal reads). Values travel in the environment, never on a command line.
inventory_record() {
  SLUG="$SLUG" APP_URL="$APP_URL" APP_ENV="$APP_ENV" APP_OVERLAY="$APP_DIR/compose.ihc.yml" RESOURCES="$RESOURCES" \
  M_NAME="$M_NAME" M_OWNER="$M_OWNER" M_SERVICE="$M_SERVICE" M_PORT="$M_PORT" M_HEALTH_PATH="$M_HEALTH_PATH" \
  M_HEALTH_STATUS="$M_HEALTH_STATUS" M_AUTH="$M_AUTH" M_DESCRIPTION="$M_DESCRIPTION" M_MCP="$M_MCP" \
    $PY "$IHC_LIB/inventory.py" record "$INVENTORY"
}

cmd_provision() {
  [ -n "$SLUG" ] || die "usage: ihc-app provision SLUG [--manifest FILE]"
  load_env; endpoints
  [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST (run from the app repository, or pass --manifest)"
  local mdir compose json vars errf owner_repo route_owner app_pk prov_pk group_pk
  mdir="$(cd "$(dirname "$MANIFEST")" && pwd)"

  step "manifest and compose file ($MANIFEST)"
  vars="$($PY "$IHC_LIB/appmanifest.py" vars "$MANIFEST" "$SLUG")" || die "company-app.yaml is not deployable: fix the lines above"
  eval "$vars"
  if [ -n "${GITHUB_REPOSITORY:-}" ] && [ "${GITHUB_REPOSITORY##*/}" != "$SLUG" ]; then
    die "this job runs for $GITHUB_REPOSITORY but provisions $SLUG: the repository name must be the slug"
  fi
  compose="$mdir/$M_COMPOSE_FILE"
  [ -f "$compose" ] || die "compose file not found: $M_COMPOSE_FILE (runtime.compose_file)"
  errf="$(mktemp "${TMPDIR:-/tmp}/ihc-compose.XXXXXX")"
  json="$(COMPANY_ENV_FILE=/dev/null docker compose --project-directory "$mdir" -p "$SLUG" -f "$compose" config --format json 2>"$errf")" \
    || { fail "$(tail -n 3 "$errf")"; rm -f "$errf"; die "docker compose config failed on $M_COMPOSE_FILE"; }
  rm -f "$errf"
  printf '%s' "$json" | $PY "$IHC_LIB/appmanifest.py" compose-check "$M_SERVICE" || die "the compose file brings services the cloud provides: fix the lines above"
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
  # The MCP gateway (docs/mcp-gateway.md): where the app checks the actor JWT. Written for
  # every app, so adding an mcp section later needs no other change on the box.
  for kv in "APP_SLUG=$SLUG" "APP_BASE_URL=$APP_URL" "PORT=$M_PORT" "DATA_DIR=/data" \
      "IHC_MCP_ISSUER=$(mcp_public_url)" "IHC_MCP_JWKS_URL=http://mcp:8090/.well-known/jwks.json" "IHC_MCP_AUDIENCE=${M_MCP_AUDIENCE:-$SLUG.mcp}"; do
    printf '%s' "${kv#*=}" | envfile set "$APP_ENV" "${kv%%=*}"
  done
  [ "$M_DATABASE" = true ] && ensure_app_database "$(db_ident "$SLUG")" "$(db_ident "$SLUG")"
  [ "$M_REDIS" = true ] && ensure_app_redis
  [ "$M_BUCKET" = true ] && ensure_app_bucket
  env_example_defaults "$mdir/$M_ENV_EXAMPLE"
  # Always reconcile: removing the manifest section revokes every service grant.
  $PY "$IHC_LIB/secretsproxy.py" "$INSTALL_DIR" "$SLUG" "$MANIFEST" "$APP_ENV" || die "secrets proxy caller registration failed"
  chmod 600 "$APP_ENV"
  printf '%s' "$json" | $PY "$IHC_LIB/appmanifest.py" overlay "$SLUG" "$M_SERVICE" "$APP_ENV" "$IHC_NETWORK" "$APP_DATA" > "$APP_DIR/compose.ihc.yml"
  chmod 644 "$APP_DIR/compose.ihc.yml"
  ok "env file $APP_ENV (0600: $(envfile keys "$APP_ENV" | tr '\n' ' '))"
  ok "compose overlay $APP_DIR/compose.ihc.yml (network $IHC_NETWORK, alias $SLUG, no host ports, $APP_DATA at /data)"

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
  [ -d "$INSTALL_DIR/agent/reference" ] && { "$IHC_ROOT/scripts/ihc-operator.sh" brief --install-dir "$INSTALL_DIR" --out "$INSTALL_DIR/agent/reference" >/dev/null 2>&1 || warn "operator brief not refreshed"; }
  if [ "$JSON_OUTPUT" = true ]; then
    jsonq build slug="$SLUG" url="$APP_URL" env_file="$APP_ENV" overlay="$APP_DIR/compose.ihc.yml" resources="${RESOURCES# }"
  fi
}

# =================================================================== checkout
cmd_checkout() {
  [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_SHA:-}" ] || die "checkout runs inside a deploy job (GITHUB_REPOSITORY and GITHUB_SHA unset)"
  [ -n "${IHC_GIT_TOKEN:-}" ] || die "IHC_GIT_TOKEN is empty: the workflow passes the job token (secrets.GITHUB_TOKEN)"
  endpoints
  local ap; ap="$(mktemp "${TMPDIR:-/tmp}/ihc-askpass.XXXXXX")"; askpass "$ap" "x-access-token"
  git init -q . 2>/dev/null
  git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
  GIT_ASKPASS="$ap" GIT_TERMINAL_PROMPT=0 git fetch -q --depth 1 "$GT_ROOT/$GITHUB_REPOSITORY.git" "$GITHUB_SHA" || { rm -f "$ap"; die "fetch of $GITHUB_REPOSITORY@$GITHUB_SHA from $GT_ROOT failed"; }
  rm -f "$ap"
  git checkout -q --force FETCH_HEAD
  ok "checked out $GITHUB_REPOSITORY@$(printf '%s' "$GITHUB_SHA" | cut -c1-12)"
}

# ======================================================================= wait
# app_wait: the manifest's healthcheck through the proxy, then the SSO in front of /.
# Returns 1 with WAIT_DETAIL (what it got) instead of exiting, so apply and rollback can
# journal the result.
app_wait() {
  local host="$SLUG.$BASE_DOMAIN" t0 code state loc vars
  WAIT_DETAIL=""
  vars="$($PY "$IHC_LIB/appmanifest.py" vars "$MANIFEST" "$SLUG")" || { WAIT_DETAIL="cannot read $MANIFEST"; return 1; }
  eval "$vars"
  t0=$(date +%s)
  step "waiting for $M_HEALTH_PATH = $M_HEALTH_STATUS on $host (up to ${TIMEOUT}s)"
  while :; do
    state="$(docker ps -a --filter "label=com.docker.compose.project=$SLUG" --filter "label=com.docker.compose.service=$M_SERVICE" --format '{{.State}}' | head -n 1)"
    code="$(http_code "$(proxy_url "$host" "$M_HEALTH_PATH")" $(proxy_args "$host"))"
    [ "$code" = "$M_HEALTH_STATUS" ] && break
    case "$state" in exited|dead) code="container $state" ;; esac
    if [ "$state" = exited ] || [ "$state" = dead ] || [ $(( $(date +%s) - t0 )) -ge "$TIMEOUT" ]; then
      WAIT_DETAIL="$M_HEALTH_PATH through the proxy answered '$code' (wanted $M_HEALTH_STATUS), container state '${state:-missing}'"
      fail "$SLUG did not come up: $WAIT_DETAIL"
      fail "last lines of the container log:"
      docker logs --tail 40 "$(docker ps -aq --filter "label=com.docker.compose.project=$SLUG" --filter "label=com.docker.compose.service=$M_SERVICE" | head -n 1)" >&2 2>&1 || true
      fail "check that the service listens on port $M_PORT (runtime.port) and answers $M_HEALTH_PATH, then push again"
      return 1
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
        WAIT_DETAIL="/ is not protected: got '${loc%% *}' (wanted 302 to the outpost)"
        fail "$WAIT_DETAIL; re-run ihc-app provision $SLUG"; return 1
      fi
      sleep 3
    done
    ok "anonymous requests to / are sent to the Authentik sign-in"
  fi
  WAIT_DETAIL="$M_HEALTH_PATH answered $code"
  ok "$SLUG is up at $(app_url "$SLUG")"
}

cmd_wait() {
  [ -n "$SLUG" ] || die "usage: ihc-app wait SLUG [--timeout SECONDS]"
  load_env; endpoints
  app_wait || exit 1
  # A workflow from before the journal (provision, compose up --build, wait) deploys without
  # it: no lock, no record of what changed, nothing for rollback to go back to.
  if [ -n "${GITHUB_SHA:-}" ] && ! grep -q "\"commit\":\"$GITHUB_SHA\"" "$JOURNAL_DIR/$SLUG.jsonl" 2>/dev/null; then
    warn "this deploy is not in the deploy journal: the repository's .gitea/workflows/deploy.yml predates it. Copy the cloud's templates/app/.gitea/workflows/deploy.yml (build, then apply) to get the lock, the journal and ihc-app rollback (docs/gitops-flow.md)"
  fi
  return 0
}

# ============================================================ build, apply, rollback
# A deploy is two steps (docs/gitops-flow.md): `build` turns the commit into a release
# (its files and images, tagged per release) and changes nothing that runs; `apply` is the
# reconciler that puts a release on the air under the app's lock, journaled. `rollback`
# applies the release the newest deploy replaced. The journal, one JSON line per event, is
# <install-dir>/catalog/deploys/SLUG.jsonl (scripts/lib/deployjournal.py has the format).
journal() { $PY "$IHC_LIB/deployjournal.py" "$@"; }
journal_file() { printf '%s/%s.jsonl' "$JOURNAL_DIR" "$SLUG"; }
releases_dir() { printf '%s/%s/releases' "$DEPLOYS" "$SLUG"; }
rel_get() { journal release-get "$(releases_dir)/$1/release.json" "$2"; } # RID KEY
file_sha() { [ -f "$1" ] && $PY -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1" || true; }
actor() {
  if [ -n "${GITHUB_ACTOR:-}" ]; then printf '%s' "$GITHUB_ACTOR"
  else printf '%s@%s' "${SUDO_USER:-$(id -un)}" "$(hostname 2>/dev/null || echo box)"; fi
}

# running_images: {service: {image, id}} of the app's containers now.
running_images() {
  local ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$SLUG")"
  if [ -z "$ids" ]; then printf '{}'; else
    # shellcheck disable=SC2086
    docker inspect $ids | journal images
  fi
}

# app_lock TIMEOUT WHAT: the app's lock, held by this shell until it exits (a flock on fd 9,
# so a crash releases it). Waits up to TIMEOUT seconds, then refuses saying who holds it.
app_lock() {
  local dir="$DEPLOYS/$SLUG" holder
  (umask 077; mkdir -p "$dir"); chmod 700 "$DEPLOYS" 2>/dev/null || true
  exec 9>>"$dir/lock"
  if ! $PY -c 'import fcntl,sys,time
end = time.time() + float(sys.argv[1]); said = False
while True:
    try:
        fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB); break
    except OSError:
        if time.time() >= end: sys.exit(1)
        if not said: print("    waiting for the lock of the app (another apply or rollback runs)", file=sys.stderr); said = True
        time.sleep(1)' "$1"; then
    holder="$(cat "$dir/lock.holder" 2>/dev/null || echo unknown)"
    die "another apply or rollback of $SLUG is running ($holder): nothing changed; try again when it ends"
  fi
  printf '%s, pid %s, since %s\n' "$2" "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/lock.holder"
}

# Journal writes. JOURNAL_TX is the open transaction: the EXIT trap ends it as failed when the
# script stops halfway (a die), with the step it was in and the error.
JOURNAL_TX=""; JOURNAL_STEP=""; JOURNAL_OP=""
journal_add() { # PHASE [jsonq build args...]
  local phase="$1"; shift
  jsonq build tx="$JOURNAL_TX" phase="$phase" slug="$SLUG" "$@" | journal append "$(journal_file)"
}
journal_exit() {
  local rc=$?
  if [ -n "$JOURNAL_TX" ]; then
    journal_add end result=failed step="$JOURNAL_STEP" error="$(printf '%s' "${LAST_ERROR:-exit $rc}" | cut -c1-400)" || true
    rm -f "$INSTALL_DIR/apps/$SLUG/.env.journal"
    fail "$JOURNAL_OP $JOURNAL_TX of $SLUG failed at $JOURNAL_STEP; recorded in the deploy journal (ihc-app journal $SLUG)"
  fi
  [ -z "$API_TMPDIR" ] || rm -rf "$API_TMPDIR"
}

cmd_build() {
  [ -n "$SLUG" ] || die "usage: ihc-app build SLUG [--manifest FILE]"
  # No load_env: the build needs no credential of the cloud, and gets none.
  [ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST (run from the app repository, or pass --manifest)"
  local mdir prefix sha rid rel src pdir compose json errf vars mf tags
  mdir="$(cd "$(dirname "$MANIFEST")" && pwd)"; mf="$(basename "$MANIFEST")"
  if [ -n "${GITHUB_REPOSITORY:-}" ] && [ "${GITHUB_REPOSITORY##*/}" != "$SLUG" ]; then
    die "this job runs for $GITHUB_REPOSITORY but builds $SLUG: the repository name must be the slug"
  fi
  have git || die "git is required"
  sha="${GITHUB_SHA:-$(git -C "$mdir" rev-parse HEAD 2>/dev/null || true)}"
  git -C "$mdir" rev-parse -q --verify "$sha^{commit}" >/dev/null 2>&1 || die "commit ${sha:-?} is not in $mdir: build runs in a checkout of the app (ihc-app checkout)"
  prefix="$(git -C "$mdir" rev-parse --show-prefix)"
  rid="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$sha" | cut -c1-12)"
  rel="$(releases_dir)/$rid"; src="$rel/src"; pdir="$src/$prefix"; pdir="${pdir%/}"

  step "release $rid of $SLUG (commit $(printf '%s' "$sha" | cut -c1-12))"
  (umask 077; mkdir -p "$DEPLOYS/$SLUG"); chmod 700 "$DEPLOYS" "$DEPLOYS/$SLUG" 2>/dev/null || true
  mkdir -p "$src"
  # The files of the commit and nothing else of the workspace.
  git -C "$mdir" archive "$sha" | tar -x -C "$src" || die "git archive of $sha failed"
  vars="$($PY "$IHC_LIB/appmanifest.py" vars "$pdir/$mf" "$SLUG")" || die "company-app.yaml is not deployable: fix the lines above"
  eval "$vars"
  compose="$pdir/$M_COMPOSE_FILE"
  [ -f "$compose" ] || die "compose file not found: $M_COMPOSE_FILE (runtime.compose_file)"
  errf="$(mktemp "${TMPDIR:-/tmp}/ihc-compose.XXXXXX")"
  json="$(COMPANY_ENV_FILE=/dev/null docker compose --project-directory "$pdir" -p "$SLUG" -f "$compose" config --format json 2>"$errf")" \
    || { fail "$(tail -n 3 "$errf")"; rm -f "$errf"; die "docker compose config failed on $M_COMPOSE_FILE"; }
  rm -f "$errf"
  printf '%s' "$json" | $PY "$IHC_LIB/appmanifest.py" compose-check "$M_SERVICE" || die "the compose file brings services the cloud provides: fix the lines above"
  printf '%s' "$json" | $PY "$IHC_LIB/appmanifest.py" build-check "$src" || die "the build would read more than the repository: fix the lines above"
  ok "files of the commit in $src; manifest and compose file valid"

  step "build"
  COMPANY_ENV_FILE=/dev/null docker compose --project-directory "$pdir" -p "$SLUG" -f "$compose" build >&2 || die "build of $SLUG failed: the error is above"
  COMPANY_ENV_FILE=/dev/null docker compose --project-directory "$pdir" -p "$SLUG" -f "$compose" pull --ignore-buildable --quiet >&2 2>&1 \
    || warn "pulling the images the app does not build failed; using the copies on the box"
  # Every service, built or pulled, gets a tag of this release: the image a rollback finds is
  # the one this release ran, whatever happens later to the app's tags or upstream's.
  tags="$(printf '%s' "$json" | SLUG="$SLUG" RID="$rid" $PY -c 'import json,os,sys
d=json.load(sys.stdin); slug=os.environ["SLUG"]; rid=os.environ["RID"]
for n,s in sorted((d.get("services") or {}).items()):
    img=s.get("image") or "%s-%s"%(slug,n)
    print("%s\t%s\tihc-release/%s/%s:%s"%(n,img,slug,n.lower(),rid))')"
  printf '%s\n' "$tags" | while IFS="$(printf '\t')" read -r svc img tag; do
    [ -n "$svc" ] || continue
    docker image inspect "$img" >/dev/null 2>&1 || die "image $img of service $svc is not on the box after the build"
    docker tag "$img" "$tag" || die "docker tag $tag failed"
  done || exit 1
  printf '%s\n' "$tags" | SLUG="$SLUG" $PY -c 'import json,os,sys
print(json.dumps({l.split("\t")[0]: l.split("\t")[2] for l in sys.stdin.read().splitlines() if l.strip()}))' \
    | journal pin "$SLUG" > "$rel/pin.yml"
  printf '%s\n' "$tags" | REL="$rel" RID="$rid" SLUG="$SLUG" SHA="$sha" MF="$prefix$mf" COMPOSE_FILE="$prefix$M_COMPOSE_FILE" \
    PREFIX="$prefix" REPO="${GITHUB_REPOSITORY:-}" REF="${GITHUB_REF:-}" ACTOR="$(actor)" $PY -c 'import datetime,hashlib,json,os,subprocess,sys
e=os.environ; images={}
for l in sys.stdin.read().splitlines():
    if not l.strip(): continue
    svc,img,tag=l.split("\t")
    iid=subprocess.run(["docker","image","inspect","-f","{{.Id}}",tag],capture_output=True,text=True).stdout.strip()
    images[svc]={"tag":tag,"id":iid,"source":img}
def sha(p):
    return hashlib.sha256(open(os.path.join(e["REL"],"src",p),"rb").read()).hexdigest()
rel={"schema_version":1,"slug":e["SLUG"],"release":e["RID"],"commit":e["SHA"],"repository":e["REPO"],"ref":e["REF"],
     "built_by":e["ACTOR"],"built_at":datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
     "project_dir":e["PREFIX"],"manifest":e["MF"],"compose_file":e["COMPOSE_FILE"],
     "manifest_sha256":sha(e["MF"]),"compose_sha256":sha(e["COMPOSE_FILE"]),"images":images}
json.dump(rel,open(os.path.join(e["REL"],"release.json"),"w"),indent=2,sort_keys=True)' || die "could not write release.json"
  printf '%s\n' "$rid" > "$mdir/.ihc-release" 2>/dev/null || true
  ok "release $rid: $(printf '%s\n' "$tags" | cut -f3 | tr '\n' ' ')"
  printf '%s\n' "$rid"
}

# merged_check RID: 0 when the release's commit is the head of main in Gitea; 2 when it is an
# older commit of main (a newer push is queued, its run applies it); dies otherwise.
merged_check() {
  local commit repo head
  commit="$(rel_get "$1" commit)"; repo="${GITHUB_REPOSITORY:-$(rel_get "$1" repository)}"
  [ -n "$repo" ] || repo="$GITEA_ORGANIZATION/$SLUG"
  if [ -n "${GITHUB_REF:-}" ] && [ "$GITHUB_REF" != refs/heads/main ]; then
    die "this run is for $GITHUB_REF: only commits merged into main are applied (a push to main is the approval); nothing changed"
  fi
  api GET "$GT/repos/$repo/branches/main"
  api_ok || die "cannot read main of $repo in Gitea (HTTP $API_CODE): nothing applied"
  head="$(printf '%s' "$API_BODY" | jsonq get commit.id)"
  if [ "$head" = "$commit" ]; then ok "commit $(printf '%s' "$commit" | cut -c1-12) is the head of main of $repo"; return 0; fi
  api GET "$GT/repos/$repo/commits?sha=main&limit=50&stat=false&verification=false&files=false"
  if api_ok && printf '%s' "$API_BODY" | $PY -c 'import json,sys
sys.exit(0 if any(c.get("sha")==sys.argv[1] for c in json.load(sys.stdin) or []) else 1)' "$commit"; then
    log "main of $repo moved on to $(printf '%s' "$head" | cut -c1-12): the run for that commit applies it; nothing applied for $(printf '%s' "$commit" | cut -c1-12)"
    return 2
  fi
  die "commit $(printf '%s' "$commit" | cut -c1-12) is not on main of $repo (main is at $(printf '%s' "$head" | cut -c1-12)): only merged commits are applied; nothing changed"
}

# check_release RID: the release's files and every image it recorded, unchanged.
check_release() {
  local rel; rel="$(releases_dir)/$1"
  [ -f "$rel/release.json" ] && [ -f "$rel/pin.yml" ] || return 1
  rel_get "$1" images | $PY -c 'import json,subprocess,sys
for svc,i in json.load(sys.stdin).items():
    try: got=subprocess.run(["docker","image","inspect","-f","{{.Id}}",i["tag"]],capture_output=True,text=True).stdout.strip()
    except OSError: got=""
    if got!=i["id"]:
        print("image %s of %s is %s"%(i["tag"],svc,"missing" if not got else "another one (%s)"%got[:19]),file=sys.stderr); sys.exit(1)'
}

# reconcile OP RID [REVERTS]: put release RID on the air as a journaled transaction. Sets
# RECONCILE_OK (true: healthy). Never call it in a condition (`if reconcile`): bash turns
# set -e off inside, and provision relies on it.
RECONCILE_OK=false
reconcile() {
  local op="$1" rid="$2" reverts="${3:-}" rel pdir prev prev_commit commit before_images overlay app_env envdiff ec=0
  rel="$(releases_dir)/$rid"; pdir="$rel/src/$(rel_get "$rid" project_dir)"; pdir="${pdir%/}"
  commit="$(rel_get "$rid" commit)"
  check_release "$rid" || die "release $rid of $SLUG is incomplete on the box (files or images gone): nothing changed"
  prev="$(cat "$DEPLOYS/$SLUG/current" 2>/dev/null || true)"
  prev_commit=""; [ -n "$prev" ] && [ -f "$(releases_dir)/$prev/release.json" ] && prev_commit="$(rel_get "$prev" commit)"
  before_images="$(running_images)"
  APP_DIR="$INSTALL_DIR/apps/$SLUG"; app_env="$APP_DIR/.env"; overlay="$APP_DIR/compose.ihc.yml"
  if [ -f "$app_env" ]; then (umask 077; cp "$app_env" "$APP_DIR/.env.journal"); else (umask 077; mkdir -p "$APP_DIR"; : > "$APP_DIR/.env.journal"); fi

  # Write-ahead: what this transaction will change, before it changes anything.
  JOURNAL_OP="$op"; JOURNAL_STEP=begin
  JOURNAL_TX="$(date -u +%Y%m%dT%H%M%SZ)-$op-$(random_secret 6 | tr 'A-Z' 'a-z')"
  trap journal_exit EXIT
  journal_add begin op="$op" actor="$(actor)" reason="$REASON" reverts="$reverts" ref="${GITHUB_REF:-}" \
    run_url="$([ -n "${GITHUB_RUN_NUMBER:-}" ] && printf '%s/%s/actions/runs/%s' "${GITEA_BASE_URL%/}" "${GITHUB_REPOSITORY:-}" "$GITHUB_RUN_NUMBER")" \
    before:="$(jsonq build release="$prev" commit="$prev_commit" images:="$before_images" overlay_sha256="$(file_sha "$overlay")" \
      env_keys:="$(envfile keys "$APP_DIR/.env.journal" | $PY -c 'import json,sys;print(json.dumps(sys.stdin.read().split()))')")" \
    after:="$(jsonq build release="$rid" commit="$commit" images:="$(rel_get "$rid" images)" \
      manifest_sha256="$(rel_get "$rid" manifest_sha256)" compose_sha256="$(rel_get "$rid" compose_sha256)")" \
    || die "could not write the deploy journal $(journal_file): nothing changed"
  ok "journal: $op $JOURNAL_TX, ${prev:-nothing journaled} -> $rid"

  JOURNAL_STEP=provision
  MANIFEST="$pdir/$(basename "$(rel_get "$rid" manifest)")"
  IHC_RELEASE="$rid" IHC_RELEASE_COMMIT="$commit"; export IHC_RELEASE IHC_RELEASE_COMMIT
  cmd_provision
  envdiff="$(journal envdiff "$APP_DIR/.env.journal" "$app_env")"; rm -f "$APP_DIR/.env.journal"
  journal_add step step=provision overlay_sha256="$(file_sha "$overlay")" \
    env_keys_added:="$(printf '%s' "$envdiff" | jsonq get env_keys_added)" \
    env_keys_removed:="$(printf '%s' "$envdiff" | jsonq get env_keys_removed)" \
    env_keys_changed:="$(printf '%s' "$envdiff" | jsonq get env_keys_changed)"
  cp "$overlay" "$rel/compose.ihc.yml" 2>/dev/null || true

  JOURNAL_STEP=up
  step "start release $rid (images of the release, never a build)"
  COMPANY_ENV_FILE="$app_env" docker compose -p "$SLUG" --project-directory "$pdir" -f "$pdir/$M_COMPOSE_FILE" -f "$overlay" -f "$rel/pin.yml" \
    up -d --no-build --pull never --remove-orphans >&2 || die "docker compose up of release $rid failed: the error is above"
  printf '%s\n' "$rid" > "$DEPLOYS/$SLUG/current"
  journal_add step step=applied images:="$(running_images)"

  JOURNAL_STEP=health
  if app_wait; then
    journal_add end result=ok health="$WAIT_DETAIL"
  else
    journal_add end result=unhealthy health="$WAIT_DETAIL"; ec=1
  fi
  JOURNAL_TX=""
  # Releases kept: the newest KEEP_RELEASES, the one running and the one it replaced.
  local old
  for old in $(journal prune "$(releases_dir)" "$KEEP_RELEASES" "$rid" "$prev"); do
    rel_get "$old" images | $PY -c 'import json,sys
for i in json.load(sys.stdin).values(): print(i["tag"])' 2>/dev/null | xargs docker image rm >/dev/null 2>&1 || true
    rm -rf "$(releases_dir)/$old"
  done
  if [ "$ec" = 0 ]; then RECONCILE_OK=true; else RECONCILE_OK=false; fi
}

cmd_apply() {
  [ -n "$SLUG" ] || die "usage: ihc-app apply SLUG [--release RID] [--lock-timeout SECONDS]"
  load_env; endpoints
  local rid rc=0
  rid="${RELEASE:-$(cat .ihc-release 2>/dev/null || true)}"
  [ -n "$rid" ] || die "no release to apply: ihc-app build $SLUG first (it writes .ihc-release), or pass --release"
  [ -f "$(releases_dir)/$rid/release.json" ] || die "release $rid of $SLUG not found in $(releases_dir)"
  [ "$(rel_get "$rid" slug)" = "$SLUG" ] || die "release $rid is not one of $SLUG"
  api_init gt "Authorization: token $GITEA_ADMIN_TOKEN"
  app_lock "${LOCK_TIMEOUT:-900}" "deploy of $(rel_get "$rid" commit | cut -c1-12) by $(actor)"
  merged_check "$rid" || rc=$?
  [ "$rc" = 2 ] && return 0
  reconcile deploy "$rid"
  if [ "$RECONCILE_OK" = true ]; then
    ok "deploy of $SLUG: release $rid on the air"
  else
    fail "release $rid of $SLUG is running but unhealthy; to go back to the release before it: ihc-app rollback $SLUG (on the box), or fix and push again"
    exit 1
  fi
}

cmd_rollback() {
  [ -n "$SLUG" ] || die "usage: ihc-app rollback SLUG [--yes] [--reason TEXT]"
  load_env; endpoints
  local target errf to from reverts from_commit to_commit current typed
  [ -f "$(journal_file)" ] || die "$SLUG has no deploy journal ($(journal_file)): nothing to roll back to. Its deploys ran before the journal existed, or its workflow predates it (copy templates/app/.gitea/workflows/deploy.yml)"
  [ -w "$JOURNAL_DIR" ] && { [ ! -e "$INSTALL_DIR/apps/$SLUG" ] || [ -w "$INSTALL_DIR/apps/$SLUG" ]; } \
    || die "this user cannot write the journal or $INSTALL_DIR/apps/$SLUG: run as the user that owns $INSTALL_DIR"
  api_init gt "Authorization: token $GITEA_ADMIN_TOKEN"
  app_lock "${LOCK_TIMEOUT:-60}" "rollback by $(actor)"
  errf="$(mktemp "${TMPDIR:-/tmp}/ihc-rollback.XXXXXX")"
  target="$(journal undo-target "$(journal_file)" 2>"$errf")" || { LAST_ERROR="$(cat "$errf")"; rm -f "$errf"; die "$SLUG: $LAST_ERROR"; }
  rm -f "$errf"
  to="$(printf '%s' "$target" | jsonq get to_release)"; from="$(printf '%s' "$target" | jsonq get from_release)"
  reverts="$(printf '%s' "$target" | jsonq get reverts)"
  from_commit="$(printf '%s' "$target" | jsonq get from_commit | cut -c1-12)"; to_commit="$(printf '%s' "$target" | jsonq get to_commit | cut -c1-12)"
  [ -f "$(releases_dir)/$to/release.json" ] || die "release $to (commit $to_commit) is no longer on the box (the newest $KEEP_RELEASES are kept): nothing rolled back"
  check_release "$to" || die "release $to (commit $to_commit) cannot be started again (above): nothing rolled back"
  current="$(cat "$DEPLOYS/$SLUG/current" 2>/dev/null || true)"
  [ "$current" = "$from" ] || warn "the app runs release ${current:-unknown}, not $from, the newest deploy in the journal (a deploy outside the journal?): going back to $to anyway"
  step "rollback of $SLUG: $from (commit $from_commit) -> $to (commit $to_commit)"
  if [ "$YES" != true ]; then
    [ -t 0 ] || die "no terminal: pass --yes to roll back $SLUG without the question"
    printf 'Roll %s back to release %s (commit %s)? Type the slug: ' "$SLUG" "$to" "$to_commit" >&2
    read -r typed || typed=""; [ "$typed" = "$SLUG" ] || die "nothing rolled back"
  fi
  reconcile rollback "$to" "$reverts"
  if [ "$RECONCILE_OK" = true ]; then
    ok "rollback of $SLUG: release $to (commit $to_commit) on the air. The next push to main deploys over it: revert or fix the change in the repository"
  else
    die "rollback of $SLUG to $to is unhealthy too: it runs release $to and does not answer ($WAIT_DETAIL). Nothing else was tried; the journal has both (ihc-app journal $SLUG)"
  fi
}

cmd_journal() {
  [ -n "$SLUG" ] || die "usage: ihc-app journal SLUG [--json] [--limit N]"
  if [ "$JSON_OUTPUT" = true ]; then journal show "$(journal_file)" --json --limit "$LIMIT"; else journal show "$(journal_file)" --limit "$LIMIT"; fi
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
if hidden: print("(%d app(s) left by a system test hidden: %s; ihc-app list --all, ihc-app remove SLUG)"%(len(hidden)," ".join(sorted(hidden))))' "$INVENTORY" "$ALL" "$JSON_OUTPUT"
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
  [ -n "$SLUG" ] || die "usage: ihc-app remove SLUG [--yes]"
  load_env; endpoints
  [ -f "$INVENTORY" ] || die "no inventory.json in $INSTALL_DIR"
  local rec kind repo res r pk id ids typed left="" org="$GITEA_ORGANIZATION" cid
  rec="$($PY -c 'import json,sys
a=(json.load(open(sys.argv[1])).get("apps") or {}).get(sys.argv[2])
if a is None: sys.exit(3)
print("%s\t%s\t%s"%(a.get("kind","app"),a.get("repository","")," ".join(a.get("resources",[]))))' "$INVENTORY" "$SLUG")" || die "$SLUG is not in inventory.json: nothing to remove"
  kind="$(printf '%s' "$rec" | cut -f1)"; repo="$(printf '%s' "$rec" | cut -f2)"; res=" $(printf '%s' "$rec" | cut -f3) "
  [ "$kind" = system-test ] || die "$SLUG is an app (kind '$kind'), not a system test: ihc-app remove only removes what a test created. Removing a real app and its data is manual (docs/cleanup.md)"
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
  { docker images -q --filter "label=com.docker.compose.project=$SLUG"; docker images --format '{{.Repository}}:{{.Tag}}' | grep -e "^$SLUG-" -e "^ihc-release/$SLUG/" || true; } | sort -u | xargs docker image rm -f >/dev/null 2>&1 || true
  ok "containers, volumes, network, built images and release tags of Compose project $SLUG"
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
  rm -f "$(journal_file)" 2>/dev/null || true
  [ -e "$(journal_file)" ] && left="$left journal:$(journal_file)"
  $PY "$IHC_LIB/secretsproxy.py" remove "$INSTALL_DIR" "$SLUG" 2>/dev/null && ok "secrets proxy caller $SLUG removed" \
    || left="$left secrets-proxy:callers/$SLUG.json"
  for d in "$INSTALL_DIR/apps/$SLUG" "$INSTALL_DIR/app-data/$SLUG" "$DEPLOYS/$SLUG"; do
    rm -rf "$d" 2>/dev/null || docker run --rm -v "$(dirname "$d"):/parent" --entrypoint rm "$POSTGRES_IMAGE" -rf "/parent/$SLUG" >/dev/null 2>&1 || true
    [ -e "$d" ] && left="$left dir:$d"
  done
  [ -n "$left" ] && die "$SLUG not completely removed; left:$left. Its inventory record stays (kind system-test, hidden from ihc-app list)"
  $PY - "$IHC_LIB" "$INVENTORY" "$SLUG" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import inventory
path, slug = sys.argv[2:4]
inv = inventory.load(path); (inv.get("apps") or {}).pop(slug, None)
inventory.save(path, inv)
PY
  ok "$SLUG removed from inventory.json"
  [ -d "$INSTALL_DIR/agent/reference" ] && { "$IHC_ROOT/scripts/ihc-operator.sh" brief --install-dir "$INSTALL_DIR" --out "$INSTALL_DIR/agent/reference" >/dev/null 2>&1 || true; }
  return 0
}

# shellcheck source=lib/sso.sh
. "$IHC_LIB/sso.sh"
# shellcheck source=lib/garage.sh
. "$IHC_LIB/garage.sh"
case "$CMD" in
  lint) exec $PY "$IHC_LIB/applint.py" "${DIR:-${SLUG:-.}}" "$INSTALL_DIR" "$MANIFEST" ;;
  new) cmd_new ;;
  init) cmd_init ;;
  provision) cmd_provision ;;
  checkout) cmd_checkout ;;
  build) cmd_build ;;
  apply) cmd_apply ;;
  rollback) cmd_rollback ;;
  journal) cmd_journal ;;
  wait) cmd_wait ;;
  list) cmd_list ;;
  remove) cmd_remove ;;
  ""|-h|--help|help) usage ;;
  *) die "unknown command: $CMD (see --help)" ;;
esac
