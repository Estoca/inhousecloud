#!/usr/bin/env python3
"""Is this an installation made before a rename? (docs/install-design.md, "Renamed twice")

Usage: legacy.py INSTALL_DIR
  exit 0, silent: not an installation under a previous name (or no installation at all)
  exit 3: it is one; the message (what it is, what to do) goes to stderr

An installation keeps the names it was made with: its .env, Compose project, networks,
volumes, app overlays, deploy runner and groups. This checkout does not operate one
under the old names, and there is no in-place migration, so install.sh (status, handoff,
stop, start, remove, --plan, --apply), ihc-operator, ihc-app, ihc-backup and ihc-doctor
stop with this one message instead of mixing its names with the new ones.

What tells, read only: the names install.sh recorded in state.json (the foundation's
network and volumes), the .env (COMPOSE_PROJECT_NAME and the HARNESS_/OCC_ network
variables) and the app overlays (apps/<slug>/compose.harness.yml or compose.occ.yml).
Not the values a config may carry over on purpose (the groups, the install directory).
"""
import glob, json, os, sys

# prefix -> (product name, period, last commit of main under that name, does its install.sh have `remove`)
OLD = {
    "harness": ("Open Company App Harness", "until 2026-10-20", "a0057a5", False),
    "occ": ("Open Company Cloud", "2026-10-20 to 2026-10-21", "3a4f11a", True),
}
CLEANUP = "docs/cleanup.md#an-installation-made-under-a-previous-name"


def read_env(path):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.split(" #", 1)[0].strip().strip("\"'")
    except OSError:
        pass
    return env


def detect(install_dir):
    """-> (prefix, [evidence]) for an installation under a previous name, else None."""
    found = {p: [] for p in OLD}
    env = read_env(os.path.join(install_dir, ".env"))
    for p in OLD:
        if env.get("COMPOSE_PROJECT_NAME") == p:
            found[p].append(".env COMPOSE_PROJECT_NAME=%s" % p)
        for k in ("%s_NETWORK" % p.upper(), "%s_OPS_NETWORK" % p.upper()):
            if k in env and "IHC_NETWORK" not in env:
                found[p].append(".env %s" % k)
    try:
        with open(os.path.join(install_dir, "state.json")) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    res = ((st.get("stages") or {}).get("foundation") or {}).get("resources") or []
    for p in OLD:
        hits = [r for r in res if isinstance(r, str) and (r == "network:" + p or r.startswith("volume:%s_" % p))]
        if hits:
            found[p].append("state.json %s" % ", ".join(hits[:2]) + (" (+%d)" % (len(hits) - 2) if len(hits) > 2 else ""))
    for p in OLD:
        for f in sorted(glob.glob(os.path.join(install_dir, "apps", "*", "compose.%s.yml" % p)))[:2]:
            found[p].append(os.path.relpath(f, install_dir))
    best = max(OLD, key=lambda p: len(found[p]))
    return (best, found[best]) if found[best] else None


def message(install_dir, prefix, evidence):
    name, period, commit, has_remove = OLD[prefix]
    p = prefix
    lines = [
        "%s is an installation made before the rename to InHouseCloud: it uses the names of %s (%s, prefix %s:"
        " Compose project %s, apps/<slug>/compose.%s.yml, runner %s-deploy, groups %s-admins and %s-users)."
        % (install_dir, name, period, p, p, p, p, p, p),
        "Found: %s." % "; ".join(evidence),
        "There is no in-place migration, and this checkout does not operate an installation under the old names.",
        "What to do: remove it, then install InHouseCloud fresh.",
    ]
    if has_remove:
        lines.append("  1. Remove it with the checkout it was installed from, or one of that time:"
                     " git checkout %s && ./install.sh remove --install-dir %s (it asks you to type %s)."
                     " By hand instead: %s." % (commit, install_dir, p, CLEANUP))
    else:
        lines.append("  1. Remove it by hand (the installer of that time has no remove command): %s." % CLEANUP)
    lines.append("  2. Install fresh with this checkout (docs/try-it.md), in a new directory or in this one once it is empty."
                 " Data to keep: copy it out first (Gitea repositories, app databases); nothing moves over by itself.")
    return "\n".join(lines)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    install_dir = sys.argv[1].rstrip("/") or "/"
    hit = detect(install_dir)
    if not hit:
        return 0
    text = message(install_dir, *hit).splitlines()
    print("[xx] " + text[0], file=sys.stderr)
    for line in text[1:]:
        print("     " + line, file=sys.stderr)
    return 3


if __name__ == "__main__":
    sys.exit(main())
