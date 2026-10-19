#!/usr/bin/env python3
"""The ops tools' host paths: what FileBrowser and Wetty may mount (docs/security.md).

Usage:
  opspaths.py check INSTALL_DIR BACKUP_DEST PATH...
      Exit 1, with one line per problem on stderr, when a FileBrowser path is not allowed.
  opspaths.py compose INSTALL_DIR BACKUP_DEST [WETTY_KEY_DIR] < `docker compose config --format json`
      Check the rendered compose file: FileBrowser binds only allowed paths and mounts the
      backup reports read only; Wetty binds only its key directory, read only.

The rule: a FileBrowser path is absolute; it is never the install directory, the backup
destination, a home directory or / (nor an ancestor of any of them); inside the install
directory it must sit under app-data/; inside the backup destination, under reports/; and
it never reaches the install .env, local/ (keys), apps/ (the apps' env files), ~/.ssh or
the system directories. Symlinks are resolved before the check.
"""
import json, os, sys


def norm(p):
    return os.path.realpath(os.path.expanduser(p))


def inside(p, root):  # p == root or p below root
    return p == root or p.startswith(root.rstrip("/") + "/")


def problems(path, install_dir, backup_dest):
    out = []
    if not path or not os.path.isabs(os.path.expanduser(path)):
        return ["%r is not an absolute path" % path]
    p, inst, dest = norm(path), norm(install_dir), norm(backup_dest)
    home = norm("~")
    for root, what in ((inst, "the install directory"), (dest, "the backup destination"), (home, "a home directory"), ("/", "/")):
        if inside(root, p):
            out.append("%s is %s or contains it: mount a subdirectory (app-data/, reports/)" % (path, what))
    reports = os.path.join(dest, "reports")
    if inside(p, inst) and p != inst and not inside(p, os.path.join(inst, "app-data")) and not inside(p, reports):
        out.append("%s is inside the install directory but not under app-data/: only app data may be mounted" % path)
    if inside(p, dest) and p != dest and not inside(p, reports):
        out.append("%s is inside the backup destination but not under reports/: the restic repository stays out" % path)
    secret = [os.path.join(inst, ".env"), os.path.join(inst, "local"), os.path.join(inst, "apps"), os.path.join(home, ".ssh")]
    secret += ["/etc", "/root", "/run", "/var/run", "/var/lib/docker", "/proc", "/sys", "/dev", "/boot"]
    for s in secret:
        s = norm(s)
        if inside(p, s) or inside(s, p):
            out.append("%s reaches %s, which the file browser never sees" % (path, s))
    return sorted(set(out))


def binds(svc):
    for v in svc.get("volumes") or []:
        if isinstance(v, dict) and v.get("type") == "bind":
            yield v.get("source", ""), v.get("target", ""), bool(v.get("read_only"))


def cmd_compose(install_dir, backup_dest, key_dir=None):
    data = json.load(sys.stdin)
    services = data.get("services") or {}
    errs = []
    fb = services.get("filebrowser")
    if fb is None:
        errs.append("the compose file has no filebrowser service")
    else:
        targets = {}
        for src, dst, ro in binds(fb):
            targets[dst] = (src, ro)
            for e in problems(src, install_dir, backup_dest):
                errs.append("filebrowser: " + e)
        if not targets.get("/srv/backup-reports", ("", False))[1]:
            errs.append("filebrowser: /srv/backup-reports must be mounted read only")
        for dst in targets:
            if not dst.startswith("/srv/"):
                errs.append("filebrowser: bind mount at %s, outside /srv" % dst)
    wt = services.get("wetty")
    if wt is not None:
        want = norm(key_dir or os.path.join(install_dir, "local", "wetty"))
        for src, dst, ro in binds(wt):
            if norm(src) != want or dst != "/keys" or not ro:
                errs.append("wetty: unexpected bind %s -> %s%s (only %s -> /keys, read only)" % (src, dst, "" if ro else " (rw)", want))
    for name, svc in services.items():
        if name in ("filebrowser", "wetty", "backup"):
            continue
        for src, _, _ in binds(svc):
            if norm(src) == norm(install_dir):
                errs.append("%s: mounts the install directory itself" % name)
    for e in errs:
        print("ops-paths: " + e, file=sys.stderr)
    sys.exit(1 if errs else 0)


def main():
    a = sys.argv[1:]
    if len(a) >= 3 and a[0] == "check":
        errs = [e for p in a[3:] for e in problems(p, a[1], a[2])]
        for e in errs:
            print("ops-paths: " + e, file=sys.stderr)
        sys.exit(1 if errs else 0)
    if len(a) in (3, 4) and a[0] == "compose":
        cmd_compose(*a[1:])
    sys.exit(__doc__)


if __name__ == "__main__":
    main()
