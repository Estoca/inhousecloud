#!/usr/bin/env bash
# The doctor's disk criteria (scripts/lib/doctor.py, disk_level), without a box:
#
#   scripts/tests/doctor-disk.sh
#
# Absolute free space decides (below 10 GiB warn, below 2 GiB fail); a high percentage
# alone is a note inside ok, and warns only when the free space is also within 1.5x of
# the minimum. Fails (exit 1) on any surprise. Needs python3.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0
python3 -I - "$ROOT/scripts/lib" <<'PY' || FAILS=1
import importlib.util, sys
spec = importlib.util.spec_from_file_location("doctor", sys.argv[1] + "/doctor.py")
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
cases = [
    ("plenty of space, high percent (26.8 GiB, 88%)", 26.8, 88, "ok"),
    ("small disk: little space, low percent (5 GiB, 30%)", 5, 30, "warn"),
    ("little space, high percent (6 GiB, 92%)", 6, 92, "warn"),
    ("plenty of space, low percent (200 GiB, 40%)", 200, 40, "ok"),
    ("nearly full (1.5 GiB, 40%)", 1.5, 40, "fail"),
    ("high percent near the minimum (14 GiB, 90%)", 14, 90, "warn"),
    ("high percent just past 1.5x (15 GiB, 90%)", 15, 90, "ok"),
]
bad = 0
for name, free, pct, want in cases:
    got, why = d.disk_level(free, pct)
    print("[%s] %s: %s (%s)" % ("ok" if got == want else "xx", name, got, why or "-"))
    bad += got != want
sys.exit(1 if bad else 0)
PY
[ "$FAILS" = 0 ] && echo "doctor-disk: all cases pass" || { echo "doctor-disk: FAILED"; exit 1; }
