#!/usr/bin/env python3
"""The operator brief: the map an operator (human or agent) reads before touching the box.

Usage: operatorbrief.py INSTALL_DIR IHC_ROOT [--json] [--out DIR] [--no-live]

Generated, never written by hand, from what the box itself says:
  state.json        install status, stages, profiles
  compose.yml       the rendered file (`docker compose config`): services, images, ports,
                    networks, mounts, healthchecks, dependencies; environment NAMES only
  .env              variable NAMES only, to build the access matrix
  inventory.json    the apps, their owners, repositories and resources
  docker ps         runtime state per container (skipped with --no-live)
plus the cloud's own knowledge of each core service (role, where its configuration
lives, how it is changed, what healthy looks like), kept in this file.

Never prints a secret value: before writing, every value of .env and of the apps' env
files is searched for in the output and the brief is refused if one is found.
docs/operator-contract.md says what the brief is for; docs/runbooks/ say how to use it.
"""
import datetime, json, os, re, subprocess, sys

SECRET_NAME = re.compile(r"(PASSWORD|SECRET|TOKEN|_KEY$|^KEY_|AUTHKEY|PGPASSWORD|DATABASE_URL|REDIS_URL|S3_SECRET)")

# What the cloud knows about its own services. `config` is where the configuration
# lives, `change` how it is changed, `health` what healthy looks like and what does not
# mean broken.
SERVICES = {
    "proxy": dict(
        role="reverse proxy (Nginx Proxy Manager): every <name>.<BASE_DOMAIN>, TLS, forward auth to Authentik",
        internal="80, 443; admin API 81",
        config="volume proxy-data (its own database of proxy hosts); certificates in proxy-letsencrypt",
        change="admin API on 127.0.0.1:PROXY_ADMIN_PORT as PROXY_ADMIN_EMAIL. App routes: only ihc-app provision. Never edit the volume",
        health="Docker healthcheck. A Host it does not know gets the proxy's default page: an answer is not an app"),
    "authentik-server": dict(
        role="SSO: OIDC for Gitea, proxy providers and the embedded outpost (forward auth)",
        internal="9000",
        config="Authentik's own Postgres (authentik-postgres); volumes authentik-media, authentik-templates",
        change="API with AUTHENTIK_BOOTSTRAP_TOKEN; first-run.sh (core) and ihc-app provision (apps) create providers, applications and bindings",
        health="GET /-/health/ready/ = 200. A protected root answering 302 to /outpost.goauthentik.io/ is correct. App /health 200 with / at 500 through the proxy is the outpost or the provider, not the app"),
    "authentik-worker": dict(
        role="Authentik background tasks and outpost management",
        internal="-", config="same as authentik-server", change="same as authentik-server",
        health="Docker healthcheck (ak healthcheck)"),
    "authentik-postgres": dict(
        role="Authentik's own database: identity never depends on app data",
        internal="5432", config="volume authentik-postgres-data",
        change="never by hand; Authentik migrates it on upgrade",
        health="pg_isready"),
    "postgres": dict(
        role="shared Postgres: one database and role app_<slug> per app, plus Gitea's and the portal's",
        internal="5432", config="volume postgres-data; roles by install.sh (core) and ihc-app provision (apps)",
        change="role and database: ihc-app provision. Schema: the app's migrations. Anything destructive: runbook database-migration",
        health="pg_isready; then the app's own connection"),
    "redis": dict(
        role="shared Redis: ACL user app-<slug> limited to <slug>:*",
        internal="6379", config="volume redis-data, ACL file /data/users.acl",
        change="ACL users: ihc-app provision",
        health="redis-cli ping = PONG"),
    "gitea": dict(
        role="Git and Actions for the organization; deploys start here (push to main)",
        internal="3000 (HTTP), 22 (SSH)",
        config="GITEA__* environment in compose.yml (rendered by install.sh) and volume gitea-data",
        change="install.sh for configuration; the web UI or API for repositories and users",
        health="GET /api/healthz = 200"),
    "portal": dict(
        role="the app portal (placeholder until the real portal replaces it)",
        internal="8080", config="build context PORTAL_BUILD_CONTEXT; its database on the shared Postgres",
        change="install.sh", health="/health = 200 through the proxy; / = 302 to the SSO"),
    "gitea-runner": dict(
        role="CI runner (label ubuntu-latest): jobs get no Docker socket, no ihc network, no install directory",
        internal="-", config="runner/ci.yaml (rendered by install.sh); registration in its /data/.runner",
        change="install.sh",
        health="'running' is not proof: the newest run in Gitea Actions is"),
    "gitea-deployer": dict(
        role="deploy runner (label ihc-deploy, organization only): its jobs are root on the box",
        internal="-", config="runner/deploy.yaml (rendered by install.sh); image <project>-deployer:local",
        change="install.sh",
        health="'running' is not proof: the newest deploy run in Gitea Actions is"),
    "backup": dict(
        role="backup job: crond runs ihc-backup (pg_dump + volumes + config into restic)",
        internal="-", config="BACKUP_* in .env; repository and reports under BACKUP_DESTINATION",
        change="config.yaml backup.* then install.sh --apply",
        health="reports/latest-status.json: status success and age under BACKUP_MAX_AGE_HOURS; a live process without progress is not success"),
    "garage": dict(role="object storage (S3) for apps: one bucket app-<slug> and one key per app; s3.<BASE_DOMAIN> through the proxy",
                   internal="3900 (S3); 3903 (admin API, not routed)",
                   config="garage/garage.toml (rendered by install.sh, no secrets) and volume garage-data; the layout applied by install.sh",
                   change="buckets and keys: ihc-app provision. Layout and capacity: config.yaml storage.* then install.sh",
                   health="Docker healthcheck is `garage status` (the node answers); `garage health` says whether the layout gives it storage"),
    "portainer": dict(role="ops: Docker UI (admin access to the machine)", internal="9000",
                      config="volume portainer-data", change="admins only, through the SSO", health="/api/system/status"),
    "glances": dict(role="ops: host resource usage", internal="61208", config="-", change="-", health="/api/4/status"),
    "wetty": dict(role="ops: web terminal, a shell on the host", internal="3000",
                  config="local/wetty (key, known_hosts)", change="install.sh", health="Docker healthcheck"),
    "filebrowser": dict(role="ops: app data (rw) and backup reports (ro)", internal="80",
                        config="volume filebrowser-db", change="install.sh", health="/health"),
    "cloudflared": dict(role="tunnel to the edge (public ingress)", internal="-",
                        config="CLOUDFLARED_TUNNEL_TOKEN; routes in the tunnel provider's dashboard",
                        change="a human, in the provider's account: public exposure", health="the public name answers through the tunnel"),
    "tailscale": dict(role="tailnet node (private ingress)", internal="-", config="volume tailscale-state",
                      change="a human, in the tailnet admin", health="tailscale status"),
    "agent": dict(role="the operator agent (reference implementation: OpenClaw)", internal="18789 (gateway, loopback only)",
                  config="agent/state/openclaw.json (rendered by install.sh); workspace agent/workspace",
                  change="config.yaml ops.agent.* then install.sh --apply", health="Docker healthcheck"),
    "agent-docker-proxy": dict(role="read-only Docker API for the agent (allowlist; Env as names only)", internal="2375",
                               config="agent-proxy/docker-ro-proxy.py; AGENT_ALLOW_WRITE",
                               change="config.yaml ops.agent.allow_write then install.sh --apply", health="GET /_ping"),
}

# Where each credential comes from and what it opens. `agent`: what the operator agent of
# the agent profile gets (docs/operator-contract.md, "Never received").
APPROVER = "the platform admin (a human in ihc-admins)"
CREDENTIALS = {
    "PROXY_ADMIN_PASSWORD": ("proxy admin account: every route and certificate", "change it in the proxy admin, then in .env", "never"),
    "AUTHENTIK_SECRET_KEY": ("signs Authentik sessions and tokens", "changing it signs everybody out", "never"),
    "AUTHENTIK_PG_PASSWORD": ("owner of Authentik's database", "ALTER ROLE, then .env, then recreate authentik-*", "never"),
    "AUTHENTIK_BOOTSTRAP_PASSWORD": ("akadmin, a person's account: all of identity", "replaced by the admin after the first MFA enrolment", "never"),
    "AUTHENTIK_BOOTSTRAP_TOKEN": ("Authentik API, admin: every user, group, provider", "revoke and recreate in Authentik, then .env", "never"),
    "AUTHENTIK_SMOKE_USER_PASSWORD": ("ihc-smoke-user (ihc-users only), smoke test 18", "set it in Authentik, then .env", "never"),
    "GITEA_ADMIN_PASSWORD": ("Gitea admin account", "change in Gitea, then .env", "never"),
    "GITEA_ADMIN_TOKEN": ("Gitea API, scope all (admin)", "delete the token in Gitea; first-run.sh makes a new one", "never"),
    "GITEA_READONLY_TOKEN": ("Gitea API, read:misc, read:repository, read:organization, read:user", "delete in Gitea, empty it in .env, run first-run.sh", "receives it (read only)"),
    "GITEA_OIDC_CLIENT_SECRET": ("Gitea's OIDC client at Authentik", "change in both, re-run first-run.sh", "never"),
    "GITEA_DB_PASSWORD": ("owner of Gitea's database", "ALTER ROLE, then .env, then recreate gitea", "never"),
    "GITEA_RUNNER_TOKEN": ("registers a CI runner", "used once; regenerate with gitea actions generate-runner-token", "never"),
    "GITEA_DEPLOY_RUNNER_TOKEN": ("registers a deploy runner for the organization: root on the box", "used once; regenerate scoped to the organization", "never"),
    "POSTGRES_PASSWORD": ("superuser of the shared Postgres: every app's data", "ALTER ROLE, then .env, then recreate postgres and backup", "never"),
    "PORTAL_DB_PASSWORD": ("owner of the portal's database", "ALTER ROLE, then .env", "never"),
    "GARAGE_ADMIN_TOKEN": ("object storage admin API: every bucket and every key", "new value in .env, then recreate garage", "never"),
    "GARAGE_RPC_SECRET": ("object storage node RPC and CLI: full control of the node", "new value in .env, then recreate garage", "never"),
    "GARAGE_METRICS_TOKEN": ("object storage metrics on the admin port", "new value in .env, then recreate garage", "never"),
    "CLOUDFLARED_TUNNEL_TOKEN": ("runs the tunnel: public exposure of the box", "rotate in the provider's dashboard", "never"),
    "TAILSCALE_AUTHKEY": ("joins the tailnet", "expire it in the tailnet admin", "never"),
    "BACKUP_ENCRYPTION_KEY": ("opens the restic repository: every backup", "cannot be rotated in place; keep a copy off the box", "never"),
    "AGENT_ANTHROPIC_API_KEY": ("the agent's LLM provider account", "rotate at the provider, then .env, then recreate agent", "receives it"),
    "AGENT_OPENAI_API_KEY": ("the agent's LLM provider account", "rotate at the provider, then .env, then recreate agent", "receives it"),
    "AGENT_SLACK_BOT_TOKEN": ("the agent's chat bot (Slack)", "reinstall the Slack app, then .env", "receives it"),
    "AGENT_SLACK_APP_TOKEN": ("the agent's Socket Mode connection (Slack)", "regenerate in the Slack app, then .env", "receives it"),
    "AGENT_TELEGRAM_BOT_TOKEN": ("the agent's chat bot (Telegram)", "/revoke in BotFather, then .env", "receives it"),
    "AGENT_GITEA_TOKEN": ("optional, made by a human: lets the agent re-run deploys", "delete it in Gitea", "receives it, when a human created it"),
}


def run(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def read_env(path):
    out = {}
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return out
    for line in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[m.group(1)] = v
    return out


def load_json(path, default):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


def env_refs(raw_compose):
    """Service -> variables its definition references, from the unrendered compose.yml."""
    refs, svc, in_services = {}, None, False
    for line in raw_compose.splitlines():
        if re.match(r"^services:\s*$", line):
            in_services = True; continue
        if re.match(r"^\S", line):
            in_services = False; svc = None; continue
        m = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", line)
        if in_services and m:
            svc = m.group(1); refs.setdefault(svc, set()); continue
        if svc:
            for v in re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)", line):
                refs[svc].add(v)
    return refs


def mounts(svc):
    out = []
    for v in svc.get("volumes") or []:
        if isinstance(v, dict):
            out.append({"type": v.get("type"), "source": v.get("source", ""), "target": v.get("target"),
                        "read_only": bool(v.get("read_only"))})
    return out


def ports(svc):
    out = []
    for p in svc.get("ports") or []:
        if isinstance(p, dict) and p.get("published"):
            out.append("%s:%s->%s" % (p.get("host_ip") or "0.0.0.0", p.get("published"), p.get("target")))
    return out


def healthcheck(svc):
    t = (svc.get("healthcheck") or {}).get("test")
    if isinstance(t, list):
        t = " ".join(t[1:]) if t and t[0] in ("CMD", "CMD-SHELL") else " ".join(t)
    return t or ""


def live_containers(project_label=None):
    rc, out = run(["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
    rows = []
    if rc != 0:
        return None
    for line in out.splitlines():
        try:
            c = json.loads(line)
        except ValueError:
            continue
        labels = dict(kv.split("=", 1) for kv in (c.get("Labels") or "").split(",") if "=" in kv)
        rows.append({"name": c.get("Names"), "project": labels.get("com.docker.compose.project", ""),
                     "service": labels.get("com.docker.compose.service", ""), "state": c.get("State"),
                     "status": c.get("Status"), "image": c.get("Image")})
    return rows


def build(install_dir, ihc_root, live):
    env_file = os.path.join(install_dir, ".env")
    env = read_env(env_file)
    state = load_json(os.path.join(install_dir, "state.json"), {})
    inv = load_json(os.path.join(install_dir, "inventory.json"), {})
    compose_file = os.path.join(install_dir, "compose.yml")
    project = env.get("COMPOSE_PROJECT_NAME", "ihc")
    rc, out = run(["docker", "compose", "--project-directory", install_dir, "-f", compose_file, "config", "--format", "json"])
    rendered = json.loads(out) if rc == 0 and out.strip().startswith("{") else {"services": {}}
    try:
        refs = env_refs(open(compose_file).read())
    except OSError:
        refs = {}
    containers = live_containers() if live else None

    stages = {k: v.get("status") for k, v in (state.get("stages") or {}).items()}
    profiles = [p for p in env.get("COMPOSE_PROFILES", "").split(",") if p]
    scheme = env.get("PORTAL_BASE_URL", "http://").split("://")[0]
    b = {
        "brief_version": 1,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_by": "scripts/ihc-operator.sh brief",
        "install_dir": install_dir,
        "ihc_checkout": ihc_root,
        "installation_id": state.get("installation_id", ""),
        "install": {"status": state.get("status", "unknown"), "stages": stages,
                    "failed": [s for s, v in stages.items() if v == "failed"],
                    "status_command": "%s/install.sh status --install-dir %s --json" % (ihc_root, install_dir)},
        "endpoints": {"base_domain": env.get("BASE_DOMAIN", ""), "ingress": "%s/%s/%s" % (env.get("INGRESS", ""), env.get("TLS_MODE", ""), env.get("TUNNEL_PROVIDER", "")),
                      "portal": env.get("PORTAL_BASE_URL", ""), "authentik": env.get("AUTHENTIK_BASE_URL", ""), "gitea": env.get("GITEA_BASE_URL", ""),
                      "proxy_admin": "http://127.0.0.1:%s (loopback only)" % env.get("PROXY_ADMIN_PORT", "81"),
                      "inside_the_ihc_network": {"proxy": "http://proxy:80 (send Host: <name>.%s)" % env.get("BASE_DOMAIN", ""),
                                                     "authentik": "http://authentik-server:9000", "gitea": "http://gitea:3000", "portal": "http://portal:8080"}},
        "profiles": ["core"] + profiles,
        "compose": {"project": project, "file": compose_file, "rendered_from": os.path.join(ihc_root, "docker/compose.yml"),
                    "rendered_by": "install.sh (stage foundation): never edit the copy; change the config or this repository and re-run install.sh",
                    "command": "docker compose --project-directory %s -f %s" % (install_dir, compose_file),
                    "env_file": env_file + " (0600; values never shown here)"},
        "services": [], "apps": [], "access_matrix": [], "app_credentials": [], "other_credentials": [],
    }

    for name, svc in sorted((rendered.get("services") or {}).items()):
        info = SERVICES.get(name, {})
        row = {"service": name, "profile": (svc.get("profiles") or ["core"])[0],
               "role": info.get("role", "not described by the brief: read docker/compose.yml"),
               "image": svc.get("image", ""), "restart": svc.get("restart", ""),
               "internal_port": info.get("internal", "-"), "published": ports(svc),
               "networks": sorted((svc.get("networks") or {}).keys()),
               "mounts": mounts(svc), "depends_on": sorted((svc.get("depends_on") or {}).keys()),
               "healthcheck": healthcheck(svc), "health_semantics": info.get("health", ""),
               "config_lives_in": info.get("config", ""), "change_through": info.get("change", ""),
               "env_names": sorted((svc.get("environment") or {}).keys())}
        if containers is not None:
            row["runtime"] = [{"name": c["name"], "state": c["state"], "status": c["status"]}
                              for c in containers if c["project"] == project and c["service"] == name]
        b["services"].append(row)

    apps_dir = os.path.join(install_dir, "apps")
    for slug, a in sorted((inv.get("apps") or {}).items()):
        app_env = read_env(a.get("env_file") or os.path.join(apps_dir, slug, ".env"))
        row = {"slug": slug, "kind": a.get("kind", "app"), "name": a.get("name", ""), "owner": a.get("owner_email", ""), "url": a.get("url", ""),
               "repository": a.get("repository", ""), "last_commit": a.get("last_commit", ""),
               "provisioned_at": a.get("provisioned_at", ""), "compose_project": slug,
               "compose_overlay": a.get("compose_overlay", ""), "env_file": a.get("env_file", ""),
               "env_names": sorted(app_env), "data_dir": os.path.join(install_dir, "app-data", slug),
               "resources": a.get("resources", []),
               "health": "the manifest's healthcheck (company-app.yaml in the repository): path through the proxy, then / = 302 to the SSO when auth.required",
               "deploy": "push to main in %s; runs in Gitea Actions on the deployer" % (a.get("repository") or "its repository")}
        if containers is not None:
            row["runtime"] = [{"name": c["name"], "service": c["service"], "state": c["state"], "status": c["status"]}
                              for c in containers if c["project"] == slug]
        b["apps"].append(row)
        b["app_credentials"].append({"file": a.get("env_file", ""), "mode": "0600", "names": sorted(k for k in app_env if SECRET_NAME.search(k)),
                                     "opens": "app %s only: its database role, its Redis user, its bucket" % slug, "agent": "never"})
    if containers is not None:
        known = {project} | {a["slug"] for a in b["apps"]}
        b["unclaimed_containers"] = [c for c in containers if c["project"] not in known]

    for var in sorted(env):
        if not SECRET_NAME.search(var):
            continue
        what, rotation, agent = CREDENTIALS.get(var, ("not described by the brief: treat as a secret", "ask the platform admin", "never"))
        b["access_matrix"].append({"variable": var, "lives_in": env_file, "set": bool(env[var]), "opens": what,
                                   "consumers": sorted(s for s, r in refs.items() if var in r),
                                   "approves": APPROVER, "rotation": rotation, "agent": agent})
    b["other_credentials"] = [
        {"what": "web terminal key (ops)", "lives_in": os.path.join(install_dir, "local/wetty/id_ed25519"), "opens": "a shell on the host", "agent": "never"},
        {"what": "people's passwords and MFA", "lives_in": "Authentik's database (hashed)", "opens": "their accounts", "agent": "never"},
        {"what": "BACKUP_ENCRYPTION_KEY, copy off the box", "lives_in": "the admin's password manager", "opens": "every backup", "agent": "never"},
        {"what": "DNS, tunnel and tailnet accounts", "lives_in": "the providers, with the admin", "opens": "public exposure", "agent": "never"},
    ]

    dest = env.get("BACKUP_DESTINATION", "")
    b["backup"] = {"enabled": env.get("BACKUP_ENABLED", "") == "true", "schedule": env.get("BACKUP_SCHEDULE", ""),
                   "timezone": env.get("BACKUP_TZ", ""), "max_age_hours": env.get("BACKUP_MAX_AGE_HOURS", ""),
                   "repository": os.path.join(dest, "restic") if dest else "", "status_file": os.path.join(dest, "reports/latest-status.json") if dest else "",
                   "latest": load_json(os.path.join(dest, "reports/latest-status.json"), {}) if dest else {}}
    agent_on = "agent" in profiles
    b["agent"] = {"enabled": agent_on, "allow_write": env.get("AGENT_ALLOW_WRITE", "false") == "true",
                  "receives": sorted(r["variable"] for r in b["access_matrix"] if r["agent"].startswith("receives") and r["set"]),
                  "write_allowlist": ["POST /containers/<id>/restart for app containers", "POST /build/prune"] if env.get("AGENT_ALLOW_WRITE") == "true" else []}
    h = ihc_root
    b["commands"] = {
        "install status": "%s/install.sh status --install-dir %s --json" % (h, install_dir),
        "smoke tests": "%s/scripts/smoke-tests.sh --install-dir %s" % (h, install_dir),
        "backup status": "%s/scripts/ihc-backup.sh --install-dir %s status --json" % (h, install_dir),
        "backup verify": "%s/scripts/ihc-backup.sh --install-dir %s verify --latest" % (h, install_dir),
        "apps": "%s/scripts/ihc-app.sh list --install-dir %s" % (h, install_dir),
        "app health": "%s/scripts/ihc-app.sh wait <slug> --install-dir %s (from the app repository)" % (h, install_dir),
        "compose": b["compose"]["command"] + " ps",
        "this brief": "%s/scripts/ihc-operator.sh brief --install-dir %s" % (h, install_dir),
    }
    # A deploy job's image carries scripts, not docs: fall back to the agent's copy.
    for d in (os.path.join(ihc_root, "docs/runbooks"), os.path.join(install_dir, "agent/reference/runbooks")):
        if os.path.isdir(d):
            b["runbooks"] = sorted(f for f in os.listdir(d) if f.endswith(".md"))
            break
    else:
        b["runbooks"] = []

    # The guard: no value of .env or of an app's env file may appear in the brief.
    values = [v for k, v in env.items() if SECRET_NAME.search(k) and len(v) >= 8]
    for a in b["apps"]:
        values += [v for k, v in read_env(a["env_file"]).items() if SECRET_NAME.search(k) and len(v) >= 8]
    text = json.dumps(b)
    if any(v in text for v in values):
        sys.exit("refused: a secret value would appear in the brief")
    return b


def md(b):
    L = []
    w = L.append
    w("# Operator brief")
    w("")
    w("Generated %s by `%s`. Do not edit: regenerate it. Contract: `docs/operator-contract.md`; runbooks: `docs/runbooks/`." % (b["generated_at"], b["commands"]["this brief"]))
    w("")
    w("- Install: **%s**%s (`%s`)" % (b["install"]["status"], (", failed: " + ", ".join(b["install"]["failed"])) if b["install"]["failed"] else "", b["install"]["status_command"]))
    e = b["endpoints"]
    w("- Ingress %s, domain `%s`; portal %s, Authentik %s, Gitea %s, proxy admin %s" % (e["ingress"], e["base_domain"], e["portal"], e["authentik"], e["gitea"], e["proxy_admin"]))
    w("- Profiles: %s. Compose project `%s`: `%s`" % (", ".join(b["profiles"]), b["compose"]["project"], b["compose"]["command"]))
    w("- Compose file %s, %s" % (b["compose"]["file"], b["compose"]["rendered_by"]))
    w("")
    w("## Sources of truth: services of the Compose project")
    w("")
    w("| Service | Role | Config lives in | Changed through | Internal port | Published | Depends on | Health | Runtime |")
    w("|---|---|---|---|---|---|---|---|---|")
    for s in b["services"]:
        rt = "; ".join("%s %s" % (r["state"], r["status"]) for r in s.get("runtime", [])) if "runtime" in s else "not read"
        w("| `%s` (%s) | %s | %s | %s | %s | %s | %s | `%s`. %s | %s |" % (
            s["service"], s["profile"], s["role"], s["config_lives_in"], s["change_through"], s["internal_port"],
            ", ".join(s["published"]) or "-", ", ".join(s["depends_on"]) or "-", s["healthcheck"] or "-", s["health_semantics"], rt or "no container"))
    w("")
    w("Mounts per service (source -> target, ro):")
    w("")
    for s in b["services"]:
        ms = ", ".join("%s -> %s%s" % (m["source"], m["target"], " ro" if m["read_only"] else "") for m in s["mounts"])
        w("- `%s`: %s" % (s["service"], ms or "none"))
    w("")
    w("## Apps (inventory.json)")
    w("")
    if not b["apps"]:
        w("No apps yet.")
    else:
        w("| Slug | Owner | URL | Repository | Last commit | Env names | Runtime |")
        w("|---|---|---|---|---|---|---|")
        for a in b["apps"]:
            rt = "; ".join("%s %s" % (r["service"], r["state"]) for r in a.get("runtime", [])) if "runtime" in a else "not read"
            w("| `%s`%s | %s | %s | %s | %s | %s | %s |" % (a["slug"], " (system test: `ihc-app remove %s`)" % a["slug"] if a["kind"] == "system-test" else "", a["owner"], a["url"], a["repository"], (a["last_commit"] or "")[:12],
                                                          ", ".join(a["env_names"]), rt or "no container"))
        w("")
        w("Each app: Compose project = its slug; overlay `apps/<slug>/compose.ihc.yml`; data `app-data/<slug>` at /data; health = its manifest's healthcheck through the proxy.")
    if b.get("unclaimed_containers"):
        w("")
        w("Containers that belong to neither the ihc project nor an app (discovery, not catalog: ask before treating them as apps):")
        w("")
        for c in b["unclaimed_containers"]:
            w("- `%s` project `%s`: %s" % (c["name"], c["project"] or "-", c["status"]))
    w("")
    w("## Access matrix (names and places, never values)")
    w("")
    w("| Variable | Set | Opens | Used by | Rotation | Approves | Agent |")
    w("|---|---|---|---|---|---|---|")
    for r in b["access_matrix"]:
        w("| `%s` | %s | %s | %s | %s | %s | %s |" % (r["variable"], "yes" if r["set"] else "empty", r["opens"], ", ".join(r["consumers"]) or "-", r["rotation"], r["approves"], r["agent"]))
    w("")
    w("All of the above live in `%s`." % b["compose"]["env_file"])
    w("")
    for c in b["app_credentials"]:
        w("- `%s` (%s): %s. Opens %s. Agent: %s." % (c["file"], c["mode"], ", ".join(c["names"]) or "no secrets", c["opens"], c["agent"]))
    for c in b["other_credentials"]:
        w("- %s: %s. Opens %s. Agent: %s." % (c["what"], c["lives_in"], c["opens"], c["agent"]))
    w("")
    bk = b["backup"]
    w("## Backup")
    w("")
    if bk["enabled"]:
        lt = bk["latest"]
        w("Schedule `%s` (%s), max age %s h; repository `%s`; status file `%s`." % (bk["schedule"], bk["timezone"], bk["max_age_hours"], bk["repository"], bk["status_file"]))
        w("Newest run when this brief was made: %s, started %s, finished %s%s." % (lt.get("status", "none"), lt.get("started_at", "-"), lt.get("finished_at", "-"), (", error: " + lt["error"]) if lt.get("error") else ""))
    else:
        w("Disabled.")
    w("")
    ag = b["agent"]
    w("## Operator agent")
    w("")
    if ag["enabled"]:
        w("On. Receives: %s. Writes allowed: %s." % (", ".join(ag["receives"]) or "nothing yet (no key or channel set)", ", ".join(ag["write_allowlist"]) or "none (read only)"))
    else:
        w("Off (the `agent` profile).")
    w("")
    w("## Commands")
    w("")
    for k, v in b["commands"].items():
        w("- %s: `%s`" % (k, v))
    w("")
    w("Runbooks: %s." % ", ".join(b["runbooks"]))
    return "\n".join(L) + "\n"


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        sys.exit(__doc__)
    install_dir, ihc_root = a[0].rstrip("/"), a[1].rstrip("/")
    as_json, live, out = "--json" in a, "--no-live" not in a, None
    if "--out" in a:
        out = a[a.index("--out") + 1]
    b = build(install_dir, ihc_root, live)
    if out:
        os.makedirs(out, exist_ok=True)
        for name, body in (("brief.json", json.dumps(b, indent=2) + "\n"), ("brief.md", md(b))):
            tmp = os.path.join(out, "." + name + ".tmp")
            with open(tmp, "w") as f:
                f.write(body)
            os.chmod(tmp, 0o644)
            os.replace(tmp, os.path.join(out, name))
        print(os.path.join(out, "brief.md"))
    elif as_json:
        print(json.dumps(b, indent=2))
    else:
        sys.stdout.write(md(b))


if __name__ == "__main__":
    main()
