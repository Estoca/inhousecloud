#!/usr/bin/env python3
"""Reads the installer config (format: bootstrap/config.example.yaml).

Usage: config.py FILE COMMAND
  flatten          shell assignments: CFG_section__key='value' (lists comma-joined)
  get KEY [DEFAULT]  dotted key; lists comma-joined; booleans true/false
  json             the whole config as JSON
  sha              sha256 of the normalized JSON (the config hash kept in state.json)

Uses PyYAML when present; otherwise a small parser for the subset the example uses:
nested maps by indentation, scalar lists ("- item"), quoted or bare scalars, comments.

A config written before the rename from Open Company App Harness still loads: every
*_env value HARNESS_<X> is read as OCC_<X>, and `flatten` warns on stderr about it and
about values that keep the old defaults (docs/install-design.md, "Renamed from ...").
"""
import hashlib, json, shlex, sys


def parse_scalar(v):
    v = v.strip()
    if v == "" or v == "~" or v == "null":
        return ""
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    low = v.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    try:
        if v.lstrip("-").isdigit():
            return int(v)
    except ValueError:
        pass
    return v


def strip_comment(line):
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            out.append(ch)
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        else:
            out.append(ch)
    return "".join(out).rstrip()


def mini_yaml(text):
    root, stack = {}, [(-1, {})]
    stack[0] = (-1, root)
    lines = [strip_comment(l) for l in text.splitlines()]
    for raw in lines:
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        body = raw.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if body.startswith("- "):
            if not isinstance(parent, list):
                raise ValueError("list item outside a list: %r" % raw)
            parent.append(parse_scalar(body[2:]))
            continue
        if ":" not in body:
            raise ValueError("cannot parse line: %r" % raw)
        key, _, rest = body.partition(":")
        key = key.strip()
        if rest.strip() == "":
            # nested map or list: decide on the next non-empty line
            container = {}
            idx = lines.index(raw)
            for nxt in lines[idx + 1:]:
                if nxt.strip():
                    nind = len(nxt) - len(nxt.lstrip(" "))
                    if nind > indent and nxt.strip().startswith("- "):
                        container = []
                    elif nind <= indent:
                        container = ""
                    break
            else:
                container = ""
            parent[key] = container
            if container != "":
                stack.append((indent, container))
        else:
            parent[key] = parse_scalar(rest)
    return root


def load(path):
    text = open(path).read()
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text) or {}
    except ImportError:
        data = mini_yaml(text)
    # YAML 1.1 reads a bare `off` as false; tls_mode: off means the string "off".
    ingress = data.get("ingress") if isinstance(data, dict) else None
    if isinstance(ingress, dict) and ingress.get("tls_mode") is False:
        ingress["tls_mode"] = "off"
    if isinstance(data, dict):
        migrate_old_names(data)
    return data


# Old names found by load(), reported by `flatten` (once per install run).
OLD_ENV_NAMES, OLD_VALUES = [], []


def migrate_old_names(d, prefix=""):
    for k, v in list(d.items()):
        key = prefix + str(k)
        if isinstance(v, dict):
            migrate_old_names(v, key + ".")
        elif isinstance(v, str) and str(k).endswith("_env") and v.startswith("HARNESS_"):
            d[k] = "OCC_" + v[len("HARNESS_"):]
            OLD_ENV_NAMES.append(key)
        elif isinstance(v, str) and "harness" in v.lower():
            OLD_VALUES.append(key)


def report_old_names():
    if OLD_ENV_NAMES:
        sys.stderr.write("[!!] config written before the rename from Open Company App Harness: %d *_env "
                         "names HARNESS_<X> are read as OCC_<X> for this version only (%s); rename them\n"
                         % (len(OLD_ENV_NAMES), ", ".join(OLD_ENV_NAMES)))
    if OLD_VALUES:
        sys.stderr.write("[!!] config keeps old default values, used as given (%s); new installs use "
                         "the occ / cloud.localhost names (docs/install-design.md)\n" % ", ".join(OLD_VALUES))


def scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return ""
    if isinstance(v, list):
        return ",".join(scalar(x) for x in v)
    if isinstance(v, dict):
        return json.dumps(v)
    return str(v)


def flatten(d, prefix=""):
    for k, v in d.items():
        key = prefix + str(k)
        if isinstance(v, dict):
            for item in flatten(v, key + "__"):
                yield item
        else:
            yield key, scalar(v)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    data = load(sys.argv[1])
    cmd = sys.argv[2]
    if cmd == "flatten":
        report_old_names()
        for k, v in flatten(data):
            print("CFG_%s=%s" % (k.replace("-", "_"), shlex.quote(v)))
    elif cmd == "get":
        cur = data
        for p in sys.argv[3].split("."):
            if isinstance(cur, dict) and p in cur:
                cur = cur[p]
            else:
                cur = None
                break
        if cur is None or cur == "":
            print(sys.argv[4] if len(sys.argv) > 4 else "")
        else:
            print(scalar(cur))
    elif cmd == "json":
        print(json.dumps(data, indent=2, sort_keys=True))
    elif cmd == "sha":
        blob = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
        print(hashlib.sha256(blob).hexdigest())
    else:
        sys.exit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
