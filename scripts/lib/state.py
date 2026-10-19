#!/usr/bin/env python3
"""state.json helper for install.sh. Contract: bootstrap/state.example.json.

Usage: state.py FILE COMMAND [args]
  init --install-dir DIR --config-sha SHA [--env-file F] [--compose-file F]
  stages                              print stage names in order
  stage NAME start --config-sha SHA [--resume CMD]
  stage NAME complete
  stage NAME fail --error-code CODE [--message TEXT]
  stage NAME reset
  stage NAME set FIELD JSON           merge into probe/resources (dict merge, list append)
  stage NAME get FIELD                print the field as JSON
  stage NAME status                   print the stage status (pending if unknown)
  reset-from NAME                     NAME and every later stage become pending
  set KEY VALUE                       dotted key, string value
  set-json KEY JSON                   dotted key, JSON value
  get KEY                             dotted key; scalars raw, objects as JSON
  finish                              status=completed when every stage completed
  status [--json]                     summary; exit 0 only when completed
Never store secrets here: names, fingerprints and ids only.
"""
import json, os, sys, uuid, datetime, tempfile

STAGES = ["preflight", "plan", "secrets", "foundation", "authentik", "shared_data",
          "proxy_ingress", "gitea", "portal", "first_run", "backup", "smoke_tests",
          "optional_profiles", "handoff"]
FIELDS = ["status", "attempts", "started_at", "finished_at", "config_sha256",
          "probe", "resources", "error_code", "resume_command"]
CONTRACT = {
    "fields": FIELDS,
    "preflight": "Docker and Compose, disk, memory, ports, domain, ingress matrix",
    "plan": "intended resources, profiles, derived URLs",
    "secrets": "names, fingerprints and permissions only; never values",
    "foundation": "networks, volumes, directories, rendered files",
    "authentik": "dependencies, health, bootstrap, provider and outpost ids",
    "shared_data": "shared Postgres and Redis; portal database and role",
    "proxy_ingress": "proxy, certificate, tunnel, local route",
    "gitea": "API healthy, admin, organization, OIDC source",
    "portal": "migrations, health, admin group, protected route",
    "first_run": "Authentik to Gitea, first login pending or done, groups",
    "backup": "backup job installed, schedule, destination, first run and its snapshot",
    "optional_profiles": "storage, ci and ops resources",
    "smoke_tests": "result per test; no headers, cookies or tokens",
    "handoff": "URLs, next steps, backup schedule, status command",
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def empty_stage():
    return {"status": "pending", "attempts": 0, "started_at": "", "finished_at": "",
            "config_sha256": "", "probe": {}, "resources": [], "error_code": None,
            "resume_command": ""}


def load(path):
    with open(path) as f:
        return json.load(f)


def save(path, data):
    data["updated_at"] = now()
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".state.", dir=d)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def stage(data, name):
    if name not in STAGES:
        sys.exit("unknown stage: %s" % name)
    st = data.setdefault("stages", {}).setdefault(name, {})
    for k, v in empty_stage().items():
        st.setdefault(k, v)
    return st


def opt(args, flag, default=None):
    if flag in args:
        i = args.index(flag)
        v = args[i + 1]
        del args[i:i + 2]
        return v
    return default


def walk(data, key, create=False):
    parts = key.split(".")
    cur = data
    for p in parts[:-1]:
        if isinstance(cur, list):
            cur = cur[int(p)]
        else:
            if create:
                cur = cur.setdefault(p, {})
            else:
                cur = cur.get(p)
                if cur is None:
                    return None, None
    return cur, parts[-1]


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    path, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]

    if cmd == "stages":
        print("\n".join(STAGES))
        return

    if cmd == "init":
        install_dir = opt(args, "--install-dir", os.path.dirname(os.path.abspath(path)))
        sha = opt(args, "--config-sha", "")
        env_file = opt(args, "--env-file", ".env")
        compose_file = opt(args, "--compose-file", "compose.generated.yml")
        if os.path.exists(path):
            data = load(path)
        else:
            data = {"schema_version": 1, "installation_id": str(uuid.uuid4()),
                    "status": "running", "created_at": now()}
        data["config_sha256"] = sha
        data["paths"] = {"install_dir": install_dir, "env_file": env_file,
                         "compose_file": compose_file}
        for s in STAGES:
            stage(data, s)
        data["_stage_contract"] = CONTRACT
        if data.get("status") == "completed" and all(
                data["stages"][s]["status"] == "completed" for s in STAGES):
            pass
        else:
            data["status"] = "running"
        save(path, data)
        print(data["installation_id"])
        return

    data = load(path)

    if cmd == "stage":
        name, sub = args[0], args[1]
        rest = args[2:]
        st = stage(data, name)
        if sub == "start":
            st["status"] = "running"
            st["attempts"] = int(st.get("attempts", 0)) + 1
            st["started_at"] = now()
            st["finished_at"] = ""
            st["error_code"] = None
            st["config_sha256"] = opt(rest, "--config-sha", st.get("config_sha256", ""))
            st["resume_command"] = opt(rest, "--resume", st.get("resume_command", ""))
            data["status"] = "running"
        elif sub == "complete":
            st["status"] = "completed"
            st["finished_at"] = now()
            st["error_code"] = None
        elif sub == "fail":
            st["status"] = "failed"
            st["finished_at"] = now()
            st["error_code"] = opt(rest, "--error-code", "E_UNKNOWN")
            msg = opt(rest, "--message", None)
            if msg is not None:
                st.setdefault("probe", {})["error"] = msg
            data["status"] = "failed"
        elif sub == "reset":
            data["stages"][name] = empty_stage()
        elif sub == "set":
            field, value = rest[0], json.loads(rest[1])
            cur = st.get(field)
            if isinstance(cur, dict) and isinstance(value, dict):
                cur.update(value)
            elif isinstance(cur, list) and isinstance(value, list):
                for v in value:
                    if v not in cur:
                        cur.append(v)
            elif isinstance(cur, list):
                if value not in cur:
                    cur.append(value)
            else:
                st[field] = value
        elif sub == "get":
            print(json.dumps(st.get(rest[0])))
            return
        elif sub == "status":
            print(st.get("status", "pending"))
            return
        else:
            sys.exit("unknown stage command: %s" % sub)
        save(path, data)
        return

    if cmd == "reset-from":
        name = args[0]
        if name not in STAGES:
            sys.exit("unknown stage: %s" % name)
        for s in STAGES[STAGES.index(name):]:
            data["stages"][s] = empty_stage()
        data["status"] = "running"
        save(path, data)
        return

    if cmd in ("set", "set-json"):
        key = args[0]
        value = json.loads(args[1]) if cmd == "set-json" else args[1]
        parent, last = walk(data, key, create=True)
        parent[last] = value
        save(path, data)
        return

    if cmd == "get":
        parent, last = walk(data, args[0])
        if parent is None:
            return
        v = parent[int(last)] if isinstance(parent, list) else parent.get(last)
        if v is None:
            return
        print(v if isinstance(v, (str, int, float)) and not isinstance(v, bool)
              else json.dumps(v))
        return

    if cmd == "finish":
        ok = all(data["stages"][s]["status"] == "completed" for s in STAGES)
        data["status"] = "completed" if ok else "running"
        save(path, data)
        sys.exit(0 if ok else 1)

    if cmd == "status":
        as_json = "--json" in args
        failed = [s for s in STAGES if data["stages"].get(s, {}).get("status") == "failed"]
        pending = [s for s in STAGES if data["stages"].get(s, {}).get("status") in (None, "pending", "running")]
        if as_json:
            out = dict(data)
            out["summary"] = {"failed": failed, "pending": pending}
            print(json.dumps(out, indent=2))
        else:
            print("installation %s: %s" % (data.get("installation_id"), data.get("status")))
            for s in STAGES:
                st = data["stages"].get(s, {})
                line = "  %-18s %-10s" % (s, st.get("status", "pending"))
                if st.get("error_code"):
                    line += " %s" % st["error_code"]
                print(line)
        sys.exit(0 if data.get("status") == "completed" and not failed and not pending else 1)

    sys.exit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
