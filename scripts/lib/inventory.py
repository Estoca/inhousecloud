#!/usr/bin/env python3
"""<install-dir>/inventory.json: the one record of the installation and its apps.

  inventory.py migrate INSTALL_DIR     move the file into <install-dir>/catalog/ and leave
                                       inventory.json as a symlink to it (idempotent)
  inventory.py record FILE             add or update one app from the environment that
                                       ihc-app provision has (SLUG, APP_URL, M_* of
                                       appmanifest.py vars, RESOURCES, ...)
  inventory.py check FILE              validate FILE against the contract below; exit 1
                                       with one line per problem

Writers (ihc-app provision and remove, install.sh handoff, smoke test 16) go through
save(): the file is replaced atomically next to its real path, so the symlink stays and
the portal, which mounts <install-dir>/catalog/ read only (never the install directory),
sees every write. Readers open <install-dir>/inventory.json as before.

Contract, schema_version 1 (the portal's adapter reads it: portal/src/inventory.js; the
contract tests are scripts/tests/inventory-contract.sh and portal/test/inventory-ihc.test.js):
  schema_version  1
  apps            object keyed by slug; each app:
    slug, name, owner_email, url               strings
    description                                string ("" when the manifest has none)
    repository, last_commit                    strings, present once a deploy job ran
    healthcheck     {path, status}             runtime.healthcheck of company-app.yaml
    auth            {required}                 auth.required (true unless false)
    mcp             object or null             agent_interface.mcp of company-app.yaml
    runtime         {service, port, health_path, health_status, auth_required}
    kind            "system-test" only for apps a smoke test created
    resources, env_file, compose_overlay, created_at, provisioned_at
A change that removes or renames a field raises schema_version.
"""
import datetime, json, os, sys, tempfile

SCHEMA_VERSION = 1
CATALOG_DIR = "catalog"


def load(path):
    try:
        with open(path) as f:
            inv = json.load(f)
    except (OSError, ValueError):
        inv = {}
    return inv if isinstance(inv, dict) else {}


def save(path, inv):
    inv["schema_version"] = SCHEMA_VERSION
    inv.setdefault("apps", {})
    real = os.path.realpath(path)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(real) or ".", prefix=".inventory.")
    with os.fdopen(fd, "w") as f:
        json.dump(inv, f, indent=2); f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, real)


def migrate(install_dir):
    link = os.path.join(install_dir, "inventory.json")
    catalog = os.path.join(install_dir, CATALOG_DIR)
    target = os.path.join(catalog, "inventory.json")
    os.makedirs(catalog, exist_ok=True)
    os.chmod(catalog, 0o755)
    if os.path.islink(link):
        if not os.path.exists(target):
            save(target, {})
        return
    if os.path.exists(link):
        os.replace(link, target)
    elif not os.path.exists(target):
        save(target, {})
    os.symlink(os.path.join(CATALOG_DIR, "inventory.json"), link)


def record(path, env=os.environ):
    """The app's record from what ihc-app provision knows (company-app.yaml through
    appmanifest.py vars, the deploy job's GITHUB_* and the resources it ensured)."""
    slug = env["SLUG"]
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    inv = load(path)
    apps = inv.setdefault("apps", {})
    cur = apps.get(slug, {})
    hpath, hstatus, auth = env["M_HEALTH_PATH"], int(env["M_HEALTH_STATUS"]), env["M_AUTH"] == "true"
    cur.update({"slug": slug, "name": env["M_NAME"], "owner_email": env["M_OWNER"], "url": env["APP_URL"],
                "env_file": env.get("APP_ENV", ""), "compose_overlay": env.get("APP_OVERLAY", ""),
                "resources": sorted(set(env.get("RESOURCES", "").split())),
                "provisioned_at": now,
                # From company-app.yaml, for the portal's catalog.
                "description": env.get("M_DESCRIPTION", ""),
                "healthcheck": {"path": hpath, "status": hstatus},
                "auth": {"required": auth},
                "mcp": json.loads(env.get("M_MCP") or "null"),
                # What "up" means for this app, from its company-app.yaml: ihc-doctor reads it.
                "runtime": {"service": env["M_SERVICE"], "port": int(env["M_PORT"]), "health_path": hpath,
                            "health_status": hstatus, "auth_required": auth}})
    cur.setdefault("created_at", now)
    if env.get("GITHUB_REPOSITORY"): cur["repository"] = env["GITHUB_REPOSITORY"]
    if env.get("GITHUB_SHA"): cur["last_commit"] = env["GITHUB_SHA"]
    apps[slug] = cur
    save(path, inv)


def problems(inv):
    out = []
    if inv.get("schema_version") != SCHEMA_VERSION:
        out.append("schema_version is %r, not %d" % (inv.get("schema_version"), SCHEMA_VERSION))
    apps = inv.get("apps")
    if not isinstance(apps, dict):
        return out + ["apps is not an object keyed by slug"]
    for slug, a in apps.items():
        where = "apps.%s" % slug
        if not isinstance(a, dict):
            out.append(where + " is not an object"); continue
        for k in ("slug", "name", "owner_email", "url", "description"):
            if not isinstance(a.get(k), str):
                out.append("%s.%s is not a string" % (where, k))
        if a.get("slug") != slug:
            out.append("%s.slug is %r" % (where, a.get("slug")))
        hc = a.get("healthcheck")
        if not (isinstance(hc, dict) and isinstance(hc.get("path"), str) and hc["path"].startswith("/") and isinstance(hc.get("status"), int)):
            out.append(where + ".healthcheck is not {path, status}")
        if not (isinstance(a.get("auth"), dict) and isinstance(a["auth"].get("required"), bool)):
            out.append(where + ".auth is not {required: bool}")
        if "mcp" not in a or not (a["mcp"] is None or isinstance(a["mcp"], dict)):
            out.append(where + ".mcp is not an object or null")
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    if sys.argv[1] == "migrate":
        migrate(sys.argv[2])
    elif sys.argv[1] == "record":
        record(sys.argv[2])
    elif sys.argv[1] == "check":
        bad = problems(load(sys.argv[2]))
        for p in bad:
            print("%s: %s" % (sys.argv[2], p), file=sys.stderr)
        sys.exit(1 if bad else 0)
    else:
        sys.exit("unknown command: %s" % sys.argv[1])


if __name__ == "__main__":
    main()
