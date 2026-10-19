#!/usr/bin/env python3
"""Read and write KEY="value" lines in the install directory's .env (mode 0600).

  envfile.py get FILE KEY            print the value (empty when missing)
  envfile.py set FILE KEY            value read from stdin; replaces or appends; keeps order
  envfile.py keys FILE               list keys
Values are written double-quoted so both Docker Compose and `. .env` read them.
"""
import os, re, sys, tempfile

LINE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def read(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return f.read().splitlines()


def write(path, lines):
    d = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".env.", dir=d)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, path = sys.argv[1], sys.argv[2]
    lines = read(path)
    if cmd == "get":
        key = sys.argv[3]
        for line in lines:
            m = LINE.match(line)
            if m and m.group(1) == key:
                print(unquote(m.group(2)))
                return
        return
    if cmd == "keys":
        for line in lines:
            m = LINE.match(line)
            if m:
                print(m.group(1))
        return
    if cmd == "set":
        key = sys.argv[3]
        value = sys.stdin.read()
        if value.endswith("\n"):
            value = value[:-1]
        if '"' in value or "\n" in value:
            sys.exit("envfile: value for %s may not contain quotes or newlines" % key)
        new = '%s="%s"' % (key, value)
        for i, line in enumerate(lines):
            m = LINE.match(line)
            if m and m.group(1) == key:
                lines[i] = new
                break
        else:
            lines.append(new)
        write(path, lines)
        return
    sys.exit("unknown command: %s" % cmd)


if __name__ == "__main__":
    main()
