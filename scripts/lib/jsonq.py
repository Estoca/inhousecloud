#!/usr/bin/env python3
"""Tiny JSON helper for the shell scripts (no jq dependency).

  jsonq.py get PATH [DEFAULT]   read JSON on stdin; PATH is dotted, with numeric indexes
                                (results.0.pk). Scalars print raw, containers as JSON.
  jsonq.py len PATH             length of the list or object at PATH
  jsonq.py build k=v k2:=json   build an object: k=v is a string, k:=json is raw JSON
  jsonq.py has PATH VALUE       exit 0 when the list at PATH contains VALUE (string or int)
  jsonq.py find PATH FIELD VALUE OUT   first element of the list at PATH whose FIELD equals
                                VALUE: prints its OUT field (raw scalar or JSON); empty if none
  jsonq.py merge JSON           deep-merge JSON (an object) into the object read on stdin
"""
import json, sys


def dig(data, path):
    cur = data
    if path in ("", "."):
        return cur
    for p in path.split("."):
        if isinstance(cur, list):
            try:
                cur = cur[int(p)]
            except (IndexError, ValueError):
                return None
        elif isinstance(cur, dict):
            if p not in cur:
                return None
            cur = cur[p]
        else:
            return None
    return cur


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "build":
        out = {}
        for arg in sys.argv[2:]:
            if ":=" in arg.split("=", 1)[0] + "=" and ":=" in arg:
                k, v = arg.split(":=", 1)
                out[k] = json.loads(v)
            else:
                k, v = arg.split("=", 1)
                out[k] = v
        print(json.dumps(out))
        return
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else None
    except json.JSONDecodeError:
        data = None
    if cmd == "get":
        v = dig(data, sys.argv[2]) if data is not None else None
        if v is None:
            if len(sys.argv) > 3:
                print(sys.argv[3])
            return
        if isinstance(v, bool):
            print("true" if v else "false")
        elif isinstance(v, (str, int, float)):
            print(v)
        else:
            print(json.dumps(v))
    elif cmd == "len":
        v = dig(data, sys.argv[2]) if data is not None else None
        print(len(v) if isinstance(v, (list, dict)) else 0)
    elif cmd == "find":
        v = dig(data, sys.argv[2]) if data is not None else None
        field, want, out = sys.argv[3], sys.argv[4], sys.argv[5]
        if isinstance(v, list):
            for el in v:
                if isinstance(el, dict) and str(el.get(field)) == want:
                    o = el.get(out) if out != "." else el
                    if o is None:
                        return
                    print(o if isinstance(o, (str, int, float)) and not isinstance(o, bool) else json.dumps(o))
                    return
    elif cmd == "merge":
        patch = json.loads(sys.argv[2])
        base = data if isinstance(data, dict) else {}
        def deep(a, b):
            for k, v in b.items():
                if isinstance(v, dict) and isinstance(a.get(k), dict):
                    deep(a[k], v)
                else:
                    a[k] = v
            return a
        print(json.dumps(deep(base, patch)))
    elif cmd == "has":
        v = dig(data, sys.argv[2]) if data is not None else None
        want = sys.argv[3]
        ok = isinstance(v, list) and (want in v or (want.isdigit() and int(want) in v))
        sys.exit(0 if ok else 1)
    else:
        sys.exit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
