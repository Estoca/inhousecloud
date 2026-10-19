#!/usr/bin/env python3
"""company-app.yaml for the harness executor (scripts/harness-app.sh).

  appmanifest.py vars MANIFEST [SLUG]      validate; print shell assignments M_*
  appmanifest.py compose-check SERVICE     compose JSON on stdin (docker compose config
                                           --format json); refuse local infrastructure
  appmanifest.py overlay SLUG SERVICE ENV_FILE NETWORK
                                           compose JSON on stdin; print compose.harness.yml
  appmanifest.py slug-check SLUG           exit 1 with the reason when SLUG is not usable

Errors go to stderr, one per line, each saying what to change. Exit 1 on any error.
Schema: schemas/company-app.schema.json. Rules: docs/app-contract.md.
"""
import json, os, re, shlex, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402  (the installer's YAML reader: PyYAML when present)

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")
# Names an app may not take: the compose services of the harness (an app's network
# alias would shadow them on the shared network) and the platform's own hostnames.
RESERVED = {
    "proxy", "authentik-postgres", "authentik-server", "authentik-worker", "postgres",
    "redis", "gitea", "portal", "garage", "gitea-runner", "portainer", "glances", "wetty",
    "filebrowser", "terminal", "files", "gitea-deployer",
    "cloudflared", "tailscale", "backup", "auth", "git", "s3", "s3-console", "harness",
    "authentik", "www", "api", "admin", "localhost", "harness-smoke",
}
# Local infrastructure an app built inside the cloud must not bring (install-design.md).
INFRA = {
    "postgres": ("postgres", "postgis", "timescaledb", "pgvector"),
    "redis": ("redis", "redis-stack", "redis-stack-server", "valkey", "keydb"),
    "s3": ("minio", "garage", "seaweedfs"),
}
ALTERNATIVE = {
    "postgres": "use the shared Postgres: remove the service and set `database.required: true`; "
                "harness-app provision creates the app's own database and role and writes "
                "DATABASE_URL into the app's env file",
    "redis": "use the shared Redis: remove the service and set `dependencies.redis.required: true`; "
             "harness-app provision creates an ACL user limited to the `<slug>:` key prefix and "
             "writes REDIS_URL and REDIS_PREFIX",
    "s3": "use the shared object storage: remove the service and set `object_storage.required: true` "
          "(the `storage` profile must be on); harness-app provision creates the app's bucket "
          "and access key and writes S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
}


def slug_problem(slug):
    if not SLUG.match(slug or ""):
        return "slug %r: use 3 to 32 lowercase letters, digits and hyphens, starting and ending with a letter or digit" % slug
    if slug in RESERVED:
        return "slug %r is reserved by the harness (%s); pick another name" % (slug, ", ".join(sorted(RESERVED)))
    if slug.startswith("app-") or slug.startswith("harness-"):
        return "slug %r: the prefixes app- and harness- are reserved for platform resources" % slug
    return None


def get(d, path, default=None):
    cur = d
    for p in path.split("."):
        if not isinstance(cur, dict) or p not in cur:
            return default
        cur = cur[p]
    return default if cur in (None, "") else cur


def truthy(v):
    return v is True or str(v).lower() == "true"


def cmd_vars(path, expected):
    errors = []
    try:
        m = config.load(path)
    except Exception as e:  # noqa: BLE001
        sys.exit("%s: cannot read: %s" % (path, e))
    if not isinstance(m, dict):
        sys.exit("%s: not a YAML mapping" % path)
    if get(m, "schema_version") != 1:
        errors.append("schema_version must be 1")
    slug = str(get(m, "app.slug", ""))
    p = slug_problem(slug)
    if p:
        errors.append("app.slug: " + p)
    if expected and slug != expected:
        errors.append("app.slug is %r but this deploy is for %r: the slug, the repository name and the "
                      "argument of harness-app provision must be the same" % (slug, expected))
    if not get(m, "app.name"):
        errors.append("app.name is required")
    owner = str(get(m, "app.owner_email", ""))
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", owner):
        errors.append("app.owner_email must be the email of the person who answers for the app")
    if get(m, "runtime.type") != "docker-compose":
        errors.append("runtime.type must be docker-compose for a deployable app")
    if get(m, "deploy.enabled") is not True:
        errors.append("deploy.enabled must be true (this repository is not deployable otherwise)")
    hc_type = get(m, "runtime.healthcheck.type", "http")
    hc_path = str(get(m, "runtime.healthcheck.path", ""))
    hc_status = get(m, "runtime.healthcheck.expected_status", 200)
    if hc_type != "http" or not re.match(r"^/[A-Za-z0-9/_.-]*$", hc_path):
        errors.append("runtime.healthcheck must be type http with a path such as /health")
    if not isinstance(hc_status, int) or not 100 <= hc_status <= 599:
        errors.append("runtime.healthcheck.expected_status must be an HTTP status")
    port = get(m, "runtime.port", 8080)
    if not isinstance(port, int) or not 1 <= port <= 65535:
        errors.append("runtime.port is the port the service listens on inside its container (default 8080)")
    dport = get(m, "deploy.port", "auto")
    if dport != "auto":
        errors.append("deploy.port must be auto: the app publishes no host port, the proxy reaches it on the harness network")
    domain = get(m, "deploy.domain")
    if domain and not str(domain).startswith(slug + "."):
        errors.append("deploy.domain %r: the harness serves the app at <slug>.<BASE_DOMAIN>; set it to %s.<BASE_DOMAIN> or leave it out" % (domain, slug))
    # Local infrastructure declared in the manifest
    for key, kind in (("database", "postgres"), ("object_storage", "s3")):
        sec = get(m, key, {})
        if isinstance(sec, dict) and (sec.get("shared") is False or str(sec.get("provider", "")).startswith("local")):
            errors.append("%s declares a local service: %s" % (key, ALTERNATIVE[kind]))
    deps = get(m, "dependencies", {}) or {}
    if isinstance(deps, dict):
        for name, dep in deps.items():
            kind = "postgres" if name in ("postgres", "postgresql", "database") else \
                   "redis" if name in INFRA["redis"] else "s3" if name in ("minio", "garage", "seaweedfs", "s3", "object_storage") else None
            if kind and isinstance(dep, dict) and dep.get("shared") is False:
                errors.append("dependencies.%s.shared is false: %s" % (name, ALTERNATIVE[kind]))
    if get(m, "infrastructure.exception"):
        errors.append("infrastructure.exception is not supported by the executor yet: an app that needs "
                      "its own database, cache or storage is deployed by hand until the portal reviews exceptions")
    if errors:
        for e in errors:
            print("%s: %s" % (path, e), file=sys.stderr)
        sys.exit(1)
    redis = get(m, "dependencies.redis", {}) or {}
    out = {
        "M_SLUG": slug,
        "M_NAME": str(get(m, "app.name")),
        "M_OWNER": owner,
        "M_COMPOSE_FILE": str(get(m, "runtime.compose_file", "docker-compose.yml")),
        "M_SERVICE": str(get(m, "runtime.service", "app")),
        "M_PORT": str(port),
        "M_HEALTH_PATH": hc_path,
        "M_HEALTH_STATUS": str(hc_status),
        "M_AUTH": "true" if get(m, "auth.required", True) is not False else "false",
        "M_DATABASE": "true" if truthy(get(m, "database.required", False)) else "false",
        "M_REDIS": "true" if isinstance(redis, dict) and truthy(redis.get("required", False)) else "false",
        "M_BUCKET": "true" if truthy(get(m, "object_storage.required", False)) else "false",
        "M_ENV_EXAMPLE": str(get(m, "deploy.env_example", ".env.example")),
    }
    for k, v in out.items():
        print("%s=%s" % (k, shlex.quote(v)))


def image_name(image):
    base = image.split("@", 1)[0].rsplit("/", 1)[-1]
    return base.split(":", 1)[0].lower()


def cmd_compose_check(service):
    data = json.load(sys.stdin)
    services = data.get("services") or {}
    errors = []
    if service not in services:
        errors.append("the compose file has no service %r (runtime.service in company-app.yaml)" % service)
    for name, svc in services.items():
        img = image_name(svc.get("image") or "") if svc.get("image") and not svc.get("build") else ""
        for kind, names in INFRA.items():
            if img in names or name.lower() in names:
                what = ("runs the image %s" % svc.get("image")) if img in names else "is named like one"
                errors.append("service %r %s, a local %s: apps built inside the cloud do not bring their own "
                              "Postgres, Redis or object storage; %s" % (name, what, {"s3": "S3 server"}.get(kind, kind), ALTERNATIVE[kind]))
        if svc.get("network_mode") == "host" or svc.get("privileged"):
            errors.append("service %r asks for host networking or privileged mode; the harness runs apps on "
                          "its internal network without privileges" % name)
        for v in svc.get("volumes") or []:
            src = v.get("source", "") if isinstance(v, dict) else str(v)
            if "docker.sock" in src:
                errors.append("service %r mounts the Docker socket; apps never get it" % name)
    if errors:
        for e in errors:
            print("compose: " + e, file=sys.stderr)
        sys.exit(1)


def cmd_overlay(slug, service, env_file, network, data_dir=""):
    data = json.load(sys.stdin)
    lines = [
        "# Generated by harness-app provision for %s. Do not edit: every deploy rewrites it." % slug,
        "# Puts the app on the harness network (alias %s), drops published host ports," % slug,
        "# points env_file at the app's env file in the install directory and mounts the",
        "# app's data directory at /data in its main service.",
        "services:",
    ]
    for name in sorted((data.get("services") or {}).keys()):
        lines += [
            "  %s:" % json.dumps(name),
            "    env_file: !override",
            "      - %s" % json.dumps(env_file),
            "    ports: !reset []",
            "    restart: unless-stopped",
            "    labels:",
            "      com.harness.app: %s" % json.dumps(slug),
            "    networks:",
            "      default: {}",
        ]
        if name == service:
            lines += ["      harness:", "        aliases:", "          - %s" % json.dumps(slug)]
            if data_dir:
                lines += ["    volumes:", "      - %s" % json.dumps(data_dir + ":/data")]
        else:
            lines += ["      harness: {}"]
    lines += ["networks:", "  harness:", "    name: %s" % json.dumps(network), "    external: true"]
    print("\n".join(lines))


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "vars":
        cmd_vars(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    elif cmd == "compose-check":
        cmd_compose_check(sys.argv[2])
    elif cmd == "overlay":
        cmd_overlay(*sys.argv[2:7])
    elif cmd == "slug-check":
        p = slug_problem(sys.argv[2])
        if p:
            sys.exit(p)
    else:
        sys.exit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
