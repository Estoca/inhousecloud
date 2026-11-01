#!/usr/bin/env python3
"""The deploy journal of an app and its releases (scripts/ihc-app.sh build, apply, rollback).

  deployjournal.py append JOURNAL            one JSON object on stdin, appended as one line
  deployjournal.py show JOURNAL [--json] [--limit N]
                                             the transactions, newest first
  deployjournal.py undo-target JOURNAL       what `ihc-app rollback` would undo, as JSON;
                                             exit 3 with the reason when there is nothing
  deployjournal.py envdiff OLD NEW           names of the keys added, removed and changed
                                             between two env files (never a value)
  deployjournal.py images                    `docker inspect` JSON of containers on stdin:
                                             {service: {"image", "id"}}
  deployjournal.py pin SLUG                  {service: tag} on stdin: the compose overlay that
                                             pins every service to its release image
  deployjournal.py release-get FILE KEY      one field of release.json (dotted path)
  deployjournal.py prune RELEASES_DIR KEEP [RID...]
                                             release ids to delete: all but the KEEP newest
                                             and the RIDs given (current, undo target)

The journal is <install-dir>/catalog/deploys/<slug>.jsonl: append-only, one JSON object per
line, readable by the portal (it mounts catalog/ read only). Every apply and rollback is a
transaction `tx`: a `begin` line written before anything changes (what it will change: the
release before and after, their images and commits, the overlay's sha256 and the env file's
key names), `step` lines as it goes (provision with the env keys added, removed and changed;
`applied` once the containers run the new release), and an `end` line with the result
(ok, unhealthy, failed, skipped). A transaction without `end` was interrupted. Values of the
env file never reach the journal, only key names. Rollback undoes applied deploys in reverse
order: the newest applied deploy not undone yet goes back to the release it replaced.
"""
import datetime, fcntl, json, os, re, sys

RID = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append(path):
    entry = json.load(sys.stdin)
    if not isinstance(entry, dict) or not entry.get("tx") or not entry.get("phase"):
        sys.exit("journal entry needs tx and phase")
    entry.setdefault("at", now())
    line = json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n"
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        os.write(fd, line.encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def entries(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                print("%s:%d: not JSON, skipped" % (path, n), file=sys.stderr)
                continue
            if isinstance(e, dict) and e.get("tx"):
                out.append(e)
    return out


def transactions(path):
    """The journal grouped by tx, oldest first. Each: the begin entry's fields, plus
    `steps`, `applied` (the containers were changed), `result` and `ended_at`."""
    txs, order = {}, []
    for e in entries(path):
        tx = e["tx"]
        if tx not in txs:
            txs[tx] = {"tx": tx, "steps": [], "applied": False, "result": None, "ended_at": None}
            order.append(tx)
        t = txs[tx]
        phase = e.get("phase")
        if phase == "begin":
            for k, v in e.items():
                if k not in ("phase", "at"):
                    t[k] = v
            t["started_at"] = e.get("at")
        elif phase == "step":
            t["steps"].append({k: v for k, v in e.items() if k not in ("tx", "phase")})
            if e.get("step") == "applied":
                t["applied"] = True
            if e.get("step") == "provision":
                t["env"] = {k: e.get(k, []) for k in ("env_keys_added", "env_keys_removed", "env_keys_changed")}
        elif phase == "end":
            t["result"] = e.get("result")
            t["ended_at"] = e.get("at")
            for k in ("error", "health", "step", "message"):
                if k in e:
                    t["end_" + k] = e[k]
    for t in txs.values():
        if t["result"] is None:
            t["result"] = "interrupted"
    return [txs[k] for k in order]


def undo_target(path):
    txs = transactions(path)
    if not txs:
        return None, "no deploy in the journal yet: nothing to roll back to"
    reverted = {t.get("reverts") for t in txs if t.get("op") == "rollback" and t["applied"]}
    stack = [t for t in txs if t.get("op") == "deploy" and t["applied"] and t["tx"] not in reverted]
    if not stack:
        if any(t.get("op") == "deploy" and t["applied"] for t in txs):
            return None, "every deploy in the journal has been rolled back already: nothing older to go back to"
        return None, "no deploy in the journal changed the app yet: nothing to roll back to"
    top = stack[-1]
    before = top.get("before") or {}
    after = top.get("after") or {}
    if not before.get("release"):
        return None, ("the deploy being undone (%s, commit %s) replaced a version the journal does not have "
                      "(the app's first deploy, or one made before the journal existed): nothing to roll back to"
                      % (after.get("release") or "?", (after.get("commit") or "?")[:12]))
    return {
        "reverts": top["tx"],
        "from_release": after.get("release"),
        "from_commit": after.get("commit"),
        "to_release": before.get("release"),
        "to_commit": before.get("commit"),
    }, None


def short(v, n=12):
    return (v or "-")[:n]


def show(path, as_json, limit):
    txs = list(reversed(transactions(path)))[:limit]
    if as_json:
        print(json.dumps(txs, indent=2, sort_keys=True))
        return
    if not txs:
        print("no deploys in the journal (%s)" % path)
        return
    print("%-20s %-8s %-12s %-12s %-30s %-30s %s" % ("started", "op", "result", "commit", "release", "replaced", "by"))
    for t in txs:
        before, after = t.get("before") or {}, t.get("after") or {}
        print("%-20s %-8s %-12s %-12s %-30s %-30s %s" % (
            t.get("started_at") or "-", t.get("op") or "-", t["result"], short(after.get("commit")),
            after.get("release") or "-", before.get("release") or "(none)", t.get("actor") or "-"))
        env = t.get("env") or {}
        changed = ["+%s" % k for k in env.get("env_keys_added", [])] + ["-%s" % k for k in env.get("env_keys_removed", [])] \
            + ["~%s" % k for k in env.get("env_keys_changed", [])]
        if changed:
            print("    env keys: %s" % " ".join(changed))
        if t.get("reverts"):
            print("    undoes %s" % t["reverts"])
        for k in ("end_error", "end_message"):
            if t.get(k):
                print("    %s" % t[k])
        if t["result"] != "ok" and t.get("end_health"):
            print("    health: %s" % t["end_health"])


def envdiff(old, new):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import envfile  # noqa: E402

    def load(p):
        out = {}
        for line in envfile.read(p):
            m = envfile.LINE.match(line)
            if m:
                out[m.group(1)] = envfile.unquote(m.group(2))
        return out
    a, b = load(old), load(new)
    print(json.dumps({
        "env_keys_added": sorted(set(b) - set(a)),
        "env_keys_removed": sorted(set(a) - set(b)),
        "env_keys_changed": sorted(k for k in set(a) & set(b) if a[k] != b[k]),
    }, sort_keys=True))


def images():
    data = json.load(sys.stdin) or []
    out = {}
    for c in data:
        labels = (c.get("Config") or {}).get("Labels") or {}
        svc = labels.get("com.docker.compose.service")
        if not svc or labels.get("com.docker.compose.oneoff") == "True":
            continue
        out[svc] = {"image": (c.get("Config") or {}).get("Image", ""), "id": c.get("Image", "")}
    print(json.dumps(out, sort_keys=True))


def pin(slug):
    tags = json.load(sys.stdin)
    lines = ["# Generated by ihc-app build for %s: every service runs the image of this release," % slug,
             "# never a build. ihc-app apply and rollback put it on top of the app's compose file.",
             "services:"]
    for svc in sorted(tags):
        lines += ["  %s:" % json.dumps(svc), "    build: !reset null", "    image: %s" % json.dumps(tags[svc]),
                  "    pull_policy: never"]
    print("\n".join(lines))


def release_get(path, key):
    try:
        v = json.load(open(path))
    except (OSError, ValueError) as e:
        sys.exit("%s: %s" % (path, e))
    for part in key.split("."):
        v = v.get(part) if isinstance(v, dict) else None
    if v is None:
        print("")
    elif isinstance(v, (dict, list)):
        print(json.dumps(v, sort_keys=True))
    else:
        print(v)


def prune(releases, keep, protect):
    if not os.path.isdir(releases):
        return
    rids = sorted((d for d in os.listdir(releases) if RID.match(d)), reverse=True)
    for rid in rids[keep:]:
        if rid not in protect:
            print(rid)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "append" and len(args) == 1:
        append(args[0])
    elif cmd == "show" and args:
        limit = 20
        if "--limit" in args:
            limit = int(args[args.index("--limit") + 1])
        show(args[0], "--json" in args, limit)
    elif cmd == "undo-target" and len(args) == 1:
        target, why = undo_target(args[0])
        if target is None:
            print(why, file=sys.stderr)
            sys.exit(3)
        print(json.dumps(target, sort_keys=True))
    elif cmd == "envdiff" and len(args) == 2:
        envdiff(*args)
    elif cmd == "images":
        images()
    elif cmd == "pin" and len(args) == 1:
        pin(args[0])
    elif cmd == "release-get" and len(args) == 2:
        release_get(*args)
    elif cmd == "prune" and len(args) >= 2:
        prune(args[0], int(args[1]), set(args[2:]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
