#!/usr/bin/env python3
"""ihc-doctor: checks an installed box the way the smoke tests do, and says what is wrong.

    doctor.py INSTALL_DIR IHC_ROOT [--json] [--verbose] [--out DIR]

Called by scripts/ihc-doctor.sh. Read only: it reads state.json, .env, inventory.json and
the backup reports, asks Docker, the proxy's admin API and the services, and changes
nothing on the box. The one file it writes is its own report, <install-dir>/agent/
reference/doctor.json, when the agent profile's workspace exists (or --out DIR), so the
operator agent can read the last full run (ihc-ro doctor).

Every check has a stable name, a status (ok, warn, fail), one line of explanation and,
for warn and fail, one line of what to do (with the runbook when there is one). Checks
that do not apply to this box (TLS with tls off, the agent without its profile) are not
in the list; they are named under not_applicable. The JSON is
  {doctor_version, generated_at, install_dir, checkout, duration_seconds,
   checks: [{name, status, detail, action, runbook, evidence}], summary: {ok, warn, fail},
   not_applicable: [{name, reason}], source, platform, portal_api}
source says where the platform view came from: "portal-api" when the portal's read-only
API answered (platform is its GET /api/platform/status, docs/portal-api.md, and the
portal-api check compares it), "local" when it did not (platform is null, portal_api.reason
says why, and the report is the local checks alone).
Exit status: 0 without a fail, 1 with one. Secrets: the proxy admin password and the
Gitea tokens are read from .env into this process and sent only to loopback services,
never on a command line, never printed.
"""
import concurrent.futures, datetime, json, os, re, shutil, socket, subprocess, sys, tempfile, time
import urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import legacy  # noqa: E402  (an installation under a previous name: one message, no checks)
import portalapi  # noqa: E402  (the portal's read-only status API, docs/portal-api.md)

DOCTOR_VERSION = 1
RUNBOOK = "docs/runbooks/%s.md"
SECRET_NAME = re.compile(r"(PASSWORD|SECRET|TOKEN|_KEY$|AUTHKEY|DATABASE_URL|REDIS_URL)")

# Disk and memory: the preflight's thresholds (install.sh stage_preflight) are the warning
# line; a fail is a box that is about to stop writing.
DISK_WARN_GIB, DISK_FAIL_GIB = 10, 2
DISK_PCT_WARN, DISK_PCT_NEAR = 85, 1.5   # a high percentage only matters within 1.5x of the minimum
MEM_TOTAL_MIB = 3500
RESTART_WINDOW_S = 3600
RUNNER_ONLINE_S = 120
TLS_WARN_DAYS = 30


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    """Docker's and the backup's timestamps; None when unreadable."""
    if not s:
        return None
    s = re.sub(r"\.\d+", "", s).replace("Z", "+00:00")
    try:
        t = datetime.datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def ago(seconds):
    seconds = int(seconds)
    if seconds < 90:
        return "%d s" % seconds
    if seconds < 5400:
        return "%d min" % (seconds // 60)
    if seconds < 172800:
        return "%.1f h" % (seconds / 3600)
    return "%d days" % (seconds // 86400)


def run(cmd, timeout=20, stdin=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=stdin)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after %ds" % timeout
    except OSError as e:
        return 127, "", str(e)


def read_env(path):
    out = {}
    for line in open(path).read().splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[m.group(1)] = v
    return out


def load_json(path, default=None):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


class Check:
    def __init__(self, name):
        self.name, self.status, self.detail = name, "ok", ""
        self.action, self.runbook, self.evidence = "", "", []

    def ok(self, detail):
        self.status, self.detail = "ok", detail
        return self

    def warn(self, detail, action, runbook=""):
        self.status, self.detail, self.action, self.runbook = "warn", detail, action, runbook
        return self

    def fail(self, detail, action, runbook=""):
        self.status, self.detail, self.action, self.runbook = "fail", detail, action, runbook
        return self

    def see(self, line):
        self.evidence.append(line)

    def as_dict(self):
        d = {"name": self.name, "status": self.status, "detail": self.detail}
        if self.status != "ok":
            d["action"] = self.action
            d["runbook"] = (RUNBOOK % self.runbook) if self.runbook else ""
        d["evidence"] = self.evidence
        return d


class Box:
    """What every check reads: the files of the installation and one look at Docker."""

    def __init__(self, install_dir, root):
        self.I, self.H = install_dir, root
        self.env_file = os.path.join(install_dir, ".env")
        self.env = read_env(self.env_file)
        e = self.env.get
        self.project = e("COMPOSE_PROJECT_NAME", "ihc")
        self.profiles = [p for p in e("COMPOSE_PROFILES", "").split(",") if p]
        self.base = e("BASE_DOMAIN", "cloud.localhost")
        self.ingress, self.tls = e("INGRESS", "local"), e("TLS_MODE", "off")
        self.portal_host = host_of(e("PORTAL_BASE_URL", "")) or "portal." + self.base
        self.auth_host = host_of(e("AUTHENTIK_BASE_URL", "")) or "auth." + self.base
        self.git_host = host_of(e("GITEA_BASE_URL", "")) or "git." + self.base
        self.http_port, self.https_port = e("PROXY_HTTP_PORT", "80"), e("PROXY_HTTPS_PORT", "443")
        self.ca = os.path.join(install_dir, "local/ca/ca.crt")
        self.state = load_json(os.path.join(install_dir, "state.json"), {})
        self.inventory = load_json(os.path.join(install_dir, "inventory.json"), {}) or {}
        self.containers = {}
        self.dc = ["docker", "compose", "--project-directory", install_dir, "-f", os.path.join(install_dir, "compose.yml")]
        self.dc_shown = "docker compose --project-directory %s -f %s/compose.yml" % (install_dir, install_dir)

    def has(self, profile):
        return profile in self.profiles

    def services(self):
        """The cloud's own services for the profiles in .env (install.sh core_services)."""
        s = ["proxy", "authentik-postgres", "authentik-server", "authentik-worker", "postgres", "redis",
             "gitea", "docker-ro", "portal", "gitea-runner", "gitea-deployer"]
        if self.has("storage"): s += ["garage"]
        if self.has("ops"):
            s += ["portainer", "glances", "filebrowser"]
            if self.env.get("OPS_TERMINAL") == "true": s += ["wetty"]
        if self.has("backup"): s += ["backup"]
        if self.has("cloudflared"): s += ["cloudflared"]
        if self.has("tailscale"): s += ["tailscale", "tailnet-dns"]
        if self.has("agent"): s += ["agent"]
        return s

    def apps(self):
        return sorted((self.inventory.get("apps") or {}).items())

    def look(self):
        """One docker ps and one docker inspect for every container: project/service -> state."""
        rc, out, _ = run(["docker", "ps", "-aq", "--no-trunc"], timeout=15)
        ids = out.split()
        if rc != 0 or not ids:
            return
        rc, out, _ = run(["docker", "inspect"] + ids, timeout=20)
        try:
            rows = json.loads(out) if rc == 0 else []
        except ValueError:
            rows = []
        for c in rows:
            labels = (c.get("Config") or {}).get("Labels") or {}
            st = c.get("State") or {}
            key = (labels.get("com.docker.compose.project", ""), labels.get("com.docker.compose.service", ""))
            row = {"name": c.get("Name", "").lstrip("/"), "id": c.get("Id", "")[:12], "status": st.get("Status", "?"),
                   "health": (st.get("Health") or {}).get("Status", "none"), "restarts": c.get("RestartCount", 0),
                   "started": parse_iso(st.get("StartedAt")), "exit_code": st.get("ExitCode"),
                   "oom": st.get("OOMKilled", False)}
            # A one-off container of the same service (compose run) is not the service.
            if labels.get("com.docker.compose.oneoff") == "True":
                continue
            if key not in self.containers or row["status"] == "running":
                self.containers[key] = row

    def container(self, service, project=None):
        return self.containers.get((project or self.project, service))

    # HTTP through the proxy, the way smoke tests reach a public name from the box:
    # TLS off, plain HTTP to the proxy's port with a Host header; TLS internal, https://NAME
    # pinned to 127.0.0.1 and verified against the cloud CA (never -k).
    def proxy(self, host, path="/", headers=()):
        if self.tls == "internal":
            url = "https://%s%s" % (host, path)
            args = ["--resolve", "%s:%s:127.0.0.1" % (host, self.https_port), "--cacert", self.ca]
        else:
            url = "http://127.0.0.1:%s%s" % (self.http_port, path)
            args = ["-H", "Host: %s" % host]
        return curl(url, args, headers)


def host_of(url):
    h = url.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]
    return h


def curl(url, args=(), headers=(), timeout=10):
    """-> (code, redirect_url, first bytes of the body). A header with a secret travels in
    a 0600 config file, never as an argument."""
    cfg = None
    cmd = ["curl", "-sS", "--max-time", str(timeout), "-o", "-", "-w", "\n%{http_code} %{redirect_url}"] + list(args)
    if headers:
        fd, cfg = tempfile.mkstemp(prefix="ihc-doctor.")
        with os.fdopen(fd, "w") as f:
            for h in headers:
                f.write('header = "%s"\n' % h.replace('"', '\\"'))
        cmd += ["-K", cfg]
    try:
        rc, out, err = run(cmd + [url], timeout=timeout + 5)
    finally:
        if cfg:
            os.unlink(cfg)
    body, _, tail = out.rpartition("\n")
    code, _, loc = tail.partition(" ")
    if not re.match(r"^\d{3}$", code):
        code = "000"
    return code, loc.strip(), body[:65536] if code != "000" else (err.strip().splitlines() or [""])[-1][:200]


def to_sso(code, loc, box):
    return code == "302" and ("outpost.goauthentik.io" in loc or box.auth_host in loc)


# ------------------------------------------------------------------------------ checks

def c_install(box):
    c = Check("install")
    st = box.state
    if not st:
        return c.fail("no readable state.json in %s" % box.I,
                      "install first: %s/install.sh (docs/quickstart.md)" % box.H)
    stages = st.get("stages") or {}
    failed = [s for s, v in stages.items() if v.get("status") == "failed"]
    pending = [s for s, v in stages.items() if v.get("status") != "completed"]
    c.see("installation %s, status %s, %d stages, updated %s" % (st.get("installation_id", "?"), st.get("status"), len(stages), st.get("updated_at", "?")))
    recorded = (st.get("paths") or {}).get("install_dir", box.I)
    if os.path.realpath(recorded) != os.path.realpath(box.I):
        return c.warn("state.json says it belongs to %s, not %s" % (recorded, box.I),
                      "run the doctor with --install-dir %s, or check which directory the cloud runs from" % recorded)
    for f in ("compose.yml", "config.yaml"):
        if not os.path.isfile(os.path.join(box.I, f)):
            return c.fail("%s is missing from %s" % (f, box.I), "re-run the install: %s/install.sh --apply --install-dir %s" % (box.H, box.I))
    if failed:
        resume = stages[failed[0]].get("resume_command") or "%s/install.sh --apply --install-dir %s --from %s" % (box.H, box.I, failed[0])
        return c.fail("the install stopped at stage %s" % failed[0], "fix what that stage printed, then resume: %s" % resume)
    if st.get("status") != "completed" or pending:
        return c.warn("the install has not finished (next stage: %s)" % (pending[0] if pending else "?"),
                      "if no install is running now, resume it: %s/install.sh --apply --install-dir %s" % (box.H, box.I))
    return c.ok("installed and complete (%d stages), installation %s" % (len(stages), st.get("installation_id", "?")[:8]))


def c_docker(box):
    c = Check("docker")
    rc, out, err = run(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=15)
    if rc != 0:
        return c.fail("the Docker daemon does not answer (%s)" % (err.strip().splitlines() or ["no output"])[-1][:120],
                      "start Docker (rootless: systemctl --user start docker; Docker Desktop: open it), then run the doctor again")
    c.see("Docker %s" % out.strip())
    rc, cv, _ = run(["docker", "compose", "version", "--short"], timeout=10)
    if rc != 0:
        return c.fail("Docker Compose v2 is missing", "install the Docker Compose v2 plugin (docs/quickstart.md)")
    c.see("Compose %s" % cv.strip())
    rc, _, err = run(box.dc + ["config", "--quiet"], timeout=20)
    if rc != 0:
        return c.fail("compose.yml does not validate: %s" % (err.strip().splitlines() or ["?"])[-1][:160],
                      "re-render it: %s/install.sh --apply --install-dir %s --from foundation" % (box.H, box.I))
    return c.ok("Docker %s, Compose %s, compose.yml valid" % (out.strip(), cv.strip()))


def c_containers(box):
    c = Check("containers")
    down, sick, flappy, good = [], [], [], 0
    t = now_utc()
    for s in box.services():
        r = box.container(s)
        if not r:
            down.append("%s (no container)" % s); continue
        c.see("%s: %s, health %s, %d restarts" % (r["name"], r["status"], r["health"], r["restarts"]))
        if r["status"] != "running":
            down.append("%s (%s%s)" % (s, r["status"], ", killed for memory" if r["oom"] else ""))
        elif r["health"] in ("unhealthy",):
            sick.append("%s (unhealthy)" % s)
        elif r["health"] == "starting":
            flappy.append("%s (starting)" % s); good += 1
        elif r["restarts"] and r["started"] and (t - r["started"]).total_seconds() < RESTART_WINDOW_S:
            flappy.append("%s (restarted %d times, last %s ago)" % (s, r["restarts"], ago((t - r["started"]).total_seconds())))
            good += 1
        else:
            good += 1
    total = len(box.services())
    if down and len(down) == total:
        return c.fail("the cloud is stopped: none of its %d services runs" % total,
                      "start it: %s/install.sh start --install-dir %s" % (box.H, box.I), "restart-service")
    if down or sick:
        first = (down + sick)[0].split(" ")[0]
        return c.fail("%d of %d services not working: %s" % (len(down) + len(sick), total, ", ".join(down + sick)),
                      "read its log (%s logs --tail 50 %s); to start it again: %s up -d %s" % (box.dc_shown, first, box.dc_shown, first),
                      "restart-service")
    if flappy:
        first = flappy[0].split(" ")[0]
        act = ("it is still starting: run the doctor again in a minute" if "(starting)" in flappy[0] else
               "read why it restarted (%s logs --tail 100 %s); run the doctor again in a few minutes" % (box.dc_shown, first))
        return c.warn("%d of %d services running; watch: %s" % (good, total, ", ".join(flappy)), act, "restart-service")
    return c.ok("all %d services of %s running and healthy" % (total, "core" + "".join("+" + p for p in box.profiles)))


def disk_level(free_gib, pct):
    """(level, criterion) for one volume. Absolute free space decides: below DISK_FAIL_GIB is
    a fail, below DISK_WARN_GIB (the installer's minimum) a warn. A high percentage warns
    only when the free space is also near that minimum; with room to spare it is a note."""
    if free_gib < DISK_FAIL_GIB:
        return "fail", "free space"
    if free_gib < DISK_WARN_GIB:
        return "warn", "free space"
    if pct >= DISK_PCT_WARN:
        if free_gib < DISK_WARN_GIB * DISK_PCT_NEAR:
            return "warn", "percentage"
        return "ok", "percentage note"
    return "ok", ""


def c_disk(box):
    c = Check("disk")
    places = [("install directory", box.I)]
    rc, out, _ = run(["docker", "info", "--format", "{{.DockerRootDir}}"], timeout=10)
    if rc == 0 and out.strip() and os.path.isdir(out.strip()):
        places.append(("Docker data", out.strip()))
    dest = box.env.get("BACKUP_DESTINATION", "")
    if box.env.get("BACKUP_ENABLED") == "true" and dest and os.path.isdir(dest):
        places.append(("backups", dest))
    seen, worst, notes = {}, None, []
    for label, path in places:
        try:
            dev = os.stat(path).st_dev
            u = shutil.disk_usage(path)
        except OSError:
            continue
        if dev in seen:
            seen[dev][0].append(label); continue
        seen[dev] = ([label], u, path)
    for labels, u, path in seen.values():
        free = u.free / 1073741824
        pct = 100.0 * (u.total - u.free) / u.total if u.total else 0
        line = "%s (%s): %.1f GiB free of %.0f GiB, %.0f%% used" % (" + ".join(labels), path, free, u.total / 1073741824, pct)
        c.see(line)
        level, why = disk_level(free, pct)
        if why == "percentage note":
            notes.append("%.0f%% used, %.1f GiB free" % (pct, free))
        if worst is None or ["ok", "warn", "fail"].index(level) > ["ok", "warn", "fail"].index(worst[0]):
            worst = (level, line, why)
    if worst is None:
        return c.warn("could not read free disk space", "check by hand: df -h %s" % box.I)
    if worst[0] == "fail":
        return c.fail("the disk is almost full: " + worst[1],
                      "free space now (build cache and unused images first): free space is below %d GiB" % DISK_FAIL_GIB, "disk-pressure")
    if worst[0] == "warn":
        if worst[2] == "percentage":
            act = ("make room before the next deploy or backup: the volume is %d%% or more used and its free space is within %gx of the %d GiB minimum"
                   % (DISK_PCT_WARN, DISK_PCT_NEAR, DISK_WARN_GIB))
        else:
            act = "make room before the next deploy or backup: free space is below the %d GiB minimum (the installer would refuse)" % DISK_WARN_GIB
        return c.warn("free disk is low: " + worst[1], act, "disk-pressure")
    return c.ok("; ".join(c.evidence) + ("" if not notes else " (note: " + "; ".join(notes) + ")"))


def c_memory(box):
    c = Check("memory")
    total = avail = None
    try:
        m = dict(re.findall(r"^(\w+):\s+(\d+) kB", open("/proc/meminfo").read(), re.M))
        total, avail = int(m["MemTotal"]) // 1024, int(m.get("MemAvailable", 0)) // 1024
    except (OSError, KeyError):
        rc, out, _ = run(["sysctl", "-n", "hw.memsize"], timeout=5)
        if rc == 0 and out.strip().isdigit():
            total = int(out) // 1048576
    if total is None:
        return c.warn("could not read the memory of this machine", "check by hand: free -m")
    line = "%d MiB total" % total + (", %d MiB available" % avail if avail is not None else "")
    c.see(line)
    oom = [r["name"] for r in box.containers.values() if r["oom"]]
    if oom:
        c.see("killed for memory: " + ", ".join(oom))
    if avail is not None and avail < max(200, total * 0.03):
        return c.fail("memory is exhausted: " + line, "find the container using it (docker stats --no-stream) before the kernel kills one", "diagnose-app-down")
    if total < MEM_TOTAL_MIB or (avail is not None and avail < total * 0.10) or oom:
        return c.warn("memory is short: " + line + ("; killed for memory: " + ", ".join(oom) if oom else ""),
                      "give the machine more memory (%d MiB is the installer's minimum) or stop what you do not need" % MEM_TOTAL_MIB, "diagnose-app-down")
    return c.ok(line)


def npm_hosts(box):
    """The proxy's routes, from its admin API on loopback. -> (list, error)."""
    base = "http://127.0.0.1:%s/api" % box.env.get("PROXY_ADMIN_PORT", "81")
    try:
        req = urllib.request.Request(base + "/tokens", method="POST", headers={"Content-Type": "application/json"},
                                     data=json.dumps({"identity": box.env.get("PROXY_ADMIN_EMAIL", ""),
                                                      "secret": box.env.get("PROXY_ADMIN_PASSWORD", "")}).encode())
        tok = json.load(urllib.request.urlopen(req, timeout=10)).get("token", "")
        req = urllib.request.Request(base + "/nginx/proxy-hosts", headers={"Authorization": "Bearer " + tok})
        return json.load(urllib.request.urlopen(req, timeout=10)), ""
    except urllib.error.HTTPError as e:
        return None, "the proxy admin API answered %d" % e.code
    except (OSError, ValueError) as e:
        return None, "the proxy admin API does not answer (%s)" % e


def expected_routes(box):
    r = [(box.portal_host, "portal", "core"), (box.git_host, "gitea", "core"), (box.auth_host, "authentik-server", "core")]
    if box.has("storage"):
        r.append(("s3." + box.base, "garage", "core"))
    if box.has("ops"):
        r += [("portainer." + box.base, "portainer", "core"), ("glances." + box.base, "glances", "core"), ("files." + box.base, "filebrowser", "core")]
        if box.env.get("OPS_TERMINAL") == "true":
            r.append(("terminal." + box.base, "wetty", "core"))
    for slug, a in box.apps():
        r.append(("%s.%s" % (slug, box.base), slug, "app"))
    return r


def c_routes(box, hosts, err):
    c = Check("routes")
    if hosts is None:
        return c.fail(err, "is the proxy running? (%s ps proxy); PROXY_ADMIN_EMAIL and PROXY_ADMIN_PASSWORD in .env must be the proxy's admin" % box.dc_shown, "route-and-provider")
    by = {}
    for h in hosts:
        for d in h.get("domain_names") or []:
            by[d] = h
    missing, wrong = [], []
    exp = expected_routes(box)
    for name, upstream, kind in exp:
        h = by.get(name)
        if not h:
            missing.append((name, kind)); continue
        c.see("%s -> %s:%s%s" % (name, h.get("forward_host"), h.get("forward_port"), "" if h.get("enabled", True) else " (disabled)"))
        if not h.get("enabled", True):
            wrong.append((name, kind, "%s is disabled" % name))
        elif h.get("forward_host") != upstream:
            wrong.append((name, kind, "%s goes to %s, not %s" % (name, h.get("forward_host"), upstream)))
        elif box.tls == "internal" and str(h.get("certificate_id") or "") != box.env.get("PROXY_CERTIFICATE_ID", ""):
            wrong.append((name, kind, "%s has no HTTPS certificate of the cloud" % name))
    def fix(n, kind):
        if kind == "app":
            return ("put it back by re-running the deploy of %s: in Gitea, re-run its last workflow run, or push to main (ihc-app provision recreates the route)" % n.split(".", 1)[0])
        return "recreate the cloud's routes: %s/install.sh --apply --install-dir %s --from first_run" % (box.H, box.I)
    if missing:
        return c.fail("the proxy has no route for %s" % ", ".join(n for n, _ in missing), fix(*missing[0]), "route-and-provider")
    if wrong:
        return c.fail("route problem: %s" % "; ".join(w for _, _, w in wrong), "do not edit it by hand: " + fix(wrong[0][0], wrong[0][1]), "route-and-provider")
    return c.ok("%d routes present and pointing where they should (portal, Gitea, Authentik%s)" % (len(exp), ", %d app(s)" % len(box.apps()) if box.apps() else ""))


def resolves(name):
    try:
        return sorted({a[4][0] for a in socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)})
    except OSError:
        return []


def c_dns(box):
    c = Check("dns")
    names = [box.portal_host, box.auth_host, box.git_host] + ["%s.%s" % (s, box.base) for s, a in box.apps() if a.get("kind") != "system-test"]
    if box.ingress == "private":
        ip = box.env.get("TAILSCALE_IP", "")
        rc, out, _ = run(box.dc + ["exec", "-T", "tailscale", "tailscale", "status", "--json"], timeout=10)
        state = ""
        try:
            state = json.loads(out).get("BackendState", "") if rc == 0 else ""
        except ValueError:
            pass
        c.see("tailscale node: %s, address %s" % (state or "no answer", ip or "?"))
        if state != "Running":
            return c.fail("the Tailscale node is %s, not logged in: the tailnet cannot reach the cloud" % (state or "not answering"),
                          "export IHC_TAILSCALE_AUTHKEY (a new auth key), then %s/install.sh --apply --install-dir %s --from proxy_ingress" % (box.H, box.I),
                          "route-and-provider")
        bad = []
        for n in names[:3] + ["doctor-check.%s" % box.base]:
            rc, out, _ = run(box.dc + ["exec", "-T", "tailscale", "nslookup", "-type=a", n, "127.0.0.1"], timeout=8)
            got = [l.split()[-1] for l in out.splitlines() if l.startswith("Address") and not re.search(r"[#:]53$", l)]
            c.see("%s -> %s (split DNS on the node)" % (n, ", ".join(got) or "nothing"))
            if ip not in got:
                bad.append("%s -> %s" % (n, ", ".join(got) or "nothing"))
        if bad:
            return c.fail("the cloud's DNS server does not answer the tailnet address %s: %s" % (ip, "; ".join(bad)),
                          "re-render it: %s/install.sh --apply --install-dir %s --from proxy_ingress; then check the split DNS entry for %s in the Tailscale admin console" % (box.H, box.I, box.base),
                          "route-and-provider")
        return c.ok("Tailscale node logged in at %s; *.%s answers %s on the split DNS" % (ip, box.base, ip))
    bad = []
    for n in names:
        a = resolves(n)
        c.see("%s -> %s" % (n, ", ".join(a) or "does not resolve here"))
        if box.ingress == "local":
            if not any(x.startswith("127.") or x == "::1" for x in a):
                bad.append(n)
        elif not a:
            bad.append(n)
    if box.ingress == "local":
        if bad:
            return c.warn("%s does not resolve to this machine here (the doctor reaches the proxy directly, so other checks are unaffected)" % ", ".join(bad),
                          "for a browser on this machine, add '127.0.0.1 %s' to /etc/hosts; *.localhost names resolve on their own in Chrome, Edge, Firefox and curl" % " ".join(bad))
        return c.ok("%d names resolve to this machine (local ingress)" % len(names))
    if bad:
        level = c.fail if box.portal_host in bad else c.warn
        return level("%s does not resolve" % ", ".join(bad),
                     "add the DNS record (or the tunnel route) for *.%s at your DNS or tunnel provider" % box.base, "route-and-provider")
    return c.ok("%d names resolve (%s ingress)" % (len(names), box.ingress))


def cert_info(pem):
    """-> (not_after datetime or None, subjectAltName text)."""
    rc, out, _ = run(["openssl", "x509", "-noout", "-enddate", "-ext", "subjectAltName"], timeout=5, stdin=pem)
    m = re.search(r"notAfter=(.+)", out)
    end = None
    if m:
        try:
            end = datetime.datetime.strptime(m.group(1).strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            pass
    return end, out


def served_cert(connect, sni):
    rc, out, _ = run(["openssl", "s_client", "-connect", connect, "-servername", sni], timeout=10, stdin="")
    m = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", out, re.S)
    return m.group(0) + "\n" if m else ""


def c_tls(box):
    c = Check("tls")
    if not shutil.which("openssl"):
        return c.warn("openssl is not installed on this machine: the certificate was not checked", "install openssl (apt install openssl) and run the doctor again")
    renew = "%s/install.sh --apply --install-dir %s --from foundation" % (box.H, box.I)
    if box.tls == "internal":
        served = served_cert("127.0.0.1:%s" % box.https_port, box.portal_host)
        if not served:
            return c.fail("the proxy presents no certificate on port %s" % box.https_port, "re-run the install from first_run: %s/install.sh --apply --install-dir %s --from first_run" % (box.H, box.I), "route-and-provider")
        rc, _, _ = run(["openssl", "verify", "-CAfile", box.ca], timeout=5, stdin=served)
        end, san = cert_info(served)
        try:
            want = open(os.path.join(box.I, "local/ca/wildcard.crt")).read()
        except OSError:
            want = ""
        ca_end, _ = cert_info(open(box.ca).read()) if os.path.isfile(box.ca) else (None, "")
        days = int((end - now_utc()).total_seconds() // 86400) if end else -1
        ca_days = int((ca_end - now_utc()).total_seconds() // 86400) if ca_end else -1
        c.see("served certificate for %s: until %s (%d days), %s" % (box.portal_host, end and iso(end), days, "verifies against the cloud CA" if rc == 0 else "does NOT verify against the cloud CA"))
        c.see("cloud CA %s: until %s (%d days)" % (box.ca, ca_end and iso(ca_end), ca_days))
        if rc != 0:
            return c.fail("the certificate the proxy serves does not verify against the cloud's own CA", "upload it again: " + renew + " (then devices keep the CA they installed)")
        if days <= 0:
            return c.fail("the cloud's certificate has expired", "renew it: " + renew)
        if "DNS:*.%s" % box.base not in san:
            return c.fail("the certificate does not cover *.%s" % box.base, "renew it: " + renew)
        if want and re.sub(r"\s", "", want) != re.sub(r"\s", "", served):
            return c.warn("the proxy serves an older certificate than %s/local/ca/wildcard.crt" % box.I, "upload the current one: " + renew)
        if days <= TLS_WARN_DAYS:
            return c.warn("the cloud's certificate expires in %d days" % days, "renew it now (any install run renews it below 30 days): " + renew)
        if 0 <= ca_days <= 90:
            return c.warn("the cloud's CA expires in %d days: every device will have to install a new one" % ca_days, "plan the new CA with the admin (docs/install-design.md, TLS internal)")
        return c.ok("own CA (TLS internal): *.%s verifies, %d days left; CA %d days left" % (box.base, days, ca_days))
    # edge / acme: the certificate the world sees, by the public name.
    served = served_cert("%s:443" % box.portal_host, box.portal_host)
    if not served:
        return c.fail("%s:443 presents no certificate from here" % box.portal_host, "check the tunnel or the DNS record and the proxy's certificate", "route-and-provider")
    rc, _, _ = run(["openssl", "verify"], timeout=5, stdin=served)
    end, _ = cert_info(served)
    days = int((end - now_utc()).total_seconds() // 86400) if end else -1
    c.see("%s:443: until %s (%d days), %s" % (box.portal_host, end and iso(end), days, "trusted by this machine" if rc == 0 else "not trusted by this machine"))
    if days <= 0:
        return c.fail("the certificate of %s has expired" % box.portal_host, "renew it at the provider that issues it (TLS %s)" % box.tls, "route-and-provider")
    if days <= 14:
        return c.warn("the certificate of %s expires in %d days" % (box.portal_host, days), "check the renewal at the provider that issues it (TLS %s)" % box.tls, "route-and-provider")
    return c.ok("TLS %s: %s certificate valid for %d more days" % (box.tls, box.portal_host, days))


def c_login(box):
    c = Check("login")
    live = box.proxy(box.auth_host, "/-/health/live/")[0]
    ready = box.proxy(box.auth_host, "/-/health/ready/")[0]
    c.see("Authentik live %s, ready %s (through the proxy, %s)" % (live, ready, box.auth_host))
    if live != "200" or ready != "200":
        return c.fail("the sign-in (Authentik) does not answer: live %s, ready %s" % (live, ready),
                      "read its log: %s logs --tail 80 authentik-server authentik-worker" % box.dc_shown, "restart-service")
    code, loc, _ = box.proxy(box.portal_host, "/")
    c.see("anonymous %s/ -> %s %s" % (box.portal_host, code, loc[:120]))
    if not to_sso(code, loc, box):
        return c.fail("the outpost does not send an anonymous visitor of the portal to the sign-in (got %s)" % code,
                      "check the embedded outpost and the portal's provider", "route-and-provider")
    issuer = "https://" if box.tls == "internal" else "http://"
    issuer += box.auth_host + "/application/o/gitea/"
    code, _, body = box.proxy(box.auth_host, "/application/o/gitea/.well-known/openid-configuration")
    try:
        got = json.loads(body).get("issuer", "")
    except ValueError:
        got = ""
    c.see("OIDC discovery for Gitea: %s, issuer %s" % (code, got or "?"))
    if code == "200" and got and got != issuer:
        return c.warn("the OIDC issuer is %s, expected %s: Gitea's sign-in may break" % (got, issuer), "re-run the install from first_run: %s/install.sh --apply --install-dir %s --from first_run" % (box.H, box.I), "route-and-provider")
    return c.ok("Authentik live and ready; the portal sends anonymous visitors to the sign-in")


def c_gitea(box):
    c = Check("gitea")
    code, _, body = box.proxy(box.git_host, "/api/v1/version", ["Authorization: token " + box.env.get("GITEA_READONLY_TOKEN", "")])
    try:
        v = json.loads(body).get("version", "") if code == "200" else ""
    except ValueError:
        v = ""
    c.see("GET %s/api/v1/version with the read-only token: %s %s" % (box.git_host, code, v))
    if not v:
        return c.fail("Gitea does not answer through the proxy (HTTP %s)" % code,
                      "read its log: %s logs --tail 80 gitea" % box.dc_shown, "restart-service")
    return c.ok("Gitea %s answers through the proxy" % v)


def c_runners(box):
    c = Check("runners")
    want = [box.env.get("GITEA_RUNNER_NAME", "ihc-runner"), box.env.get("GITEA_RUNNER_NAME", "ihc-runner") + "-deploy"]
    sql = "SELECT name, last_online FROM action_runner WHERE deleted IS NULL ORDER BY id"
    rc, out, err = run(box.dc + ["exec", "-T", "postgres", "psql", "-U", box.env.get("POSTGRES_USER", "postgres"), "-d", box.env.get("GITEA_DB_NAME", "gitea"), "-AtF", "|", "-c", sql], timeout=15)
    if rc != 0:
        return c.warn("could not read the runners from Gitea's database (%s)" % (err.strip().splitlines() or ["?"])[-1][:120],
                      "look in Gitea: Site administration > Actions > Runners")
    rows = {}
    for line in out.splitlines():
        if "|" in line:
            n, t = line.split("|", 1)
            rows[n] = int(t) if t.strip().isdigit() else 0
    now = time.time()
    bad = []
    for n in want:
        if n not in rows:
            bad.append("%s is not registered" % n); c.see("%s: not registered" % n); continue
        age = now - rows[n]
        c.see("%s: last seen %s ago" % (n, ago(age)))
        if age > RUNNER_ONLINE_S:
            bad.append("%s offline (last seen %s ago)" % (n, ago(age)))
    if bad:
        svc = "gitea-deployer" if any("deploy" in b for b in bad) else "gitea-runner"
        return c.fail("Gitea Actions cannot run deploys: %s" % "; ".join(bad),
                      "read the runner's log (%s logs --tail 50 %s); to register it again: %s/install.sh --apply --install-dir %s --from foundation" % (box.dc_shown, svc, box.H, box.I),
                      "redeploy-app")
    return c.ok("both runners registered and online (%s)" % ", ".join(want))


def c_postgres(box):
    c = Check("postgres")
    rc, out, err = run(box.dc + ["exec", "-T", "postgres", "pg_isready", "-U", box.env.get("POSTGRES_USER", "postgres")], timeout=15)
    c.see((out or err).strip()[:160])
    if rc != 0:
        return c.fail("the shared Postgres does not accept connections", "read its log: %s logs --tail 50 postgres" % box.dc_shown, "restart-service")
    return c.ok("the shared Postgres accepts connections")


def c_redis(box):
    c = Check("redis")
    rc, out, err = run(box.dc + ["exec", "-T", "redis", "redis-cli", "ping"], timeout=15)
    c.see("redis-cli ping: %s" % (out or err).strip()[:80])
    if out.strip() != "PONG":
        return c.fail("the shared Redis does not answer", "read its log: %s logs --tail 50 redis" % box.dc_shown, "restart-service")
    return c.ok("the shared Redis answers PONG")


def c_backup(box):
    c = Check("backup")
    e = box.env.get
    dest = e("BACKUP_DESTINATION", "")
    reports = os.path.join(dest, "reports")
    max_h = float(e("BACKUP_MAX_AGE_HOURS", "26") or 26)
    st = load_json(os.path.join(reports, "latest-status.json"))
    okf = load_json(os.path.join(reports, "latest-success.json"))
    side = box.container("backup")
    c.see("backup container: %s" % (side["status"] if side else "none"))
    age = None
    if okf and parse_iso(okf.get("finished_at")):
        age = (now_utc() - parse_iso(okf["finished_at"])).total_seconds() / 3600
        c.see("newest success: run %s, %s ago (window %g h)" % (okf.get("run_id"), ago(age * 3600), max_h))
    if st:
        c.see("latest run: %s %s%s" % (st.get("run_id"), st.get("status"), ", " + st["error"] if st.get("error") else ""))
    run_line = "%s/scripts/ihc-backup.sh --install-dir %s run" % (box.H, box.I)
    if not side or side["status"] != "running":
        return c.fail("the backup container is not running: no backup will run on schedule '%s'" % e("BACKUP_SCHEDULE", "?"),
                      "start it: %s up -d backup; then run one now: %s" % (box.dc_shown, run_line), "backup-stuck")
    if age is None:
        return c.fail("no backup has ever succeeded", "run one now and read its output: " + run_line, "backup-stuck")
    if age > max_h:
        return c.fail("the newest good backup is %s old, older than the %g h window" % (ago(age * 3600), max_h),
                      "find why the scheduled run did not happen (%s logs --tail 50 backup), then run one: %s" % (box.dc_shown, run_line), "backup-stuck")
    # Quick verification: the repository opens with the key, the newest run's snapshots are
    # there, restic check (structure) passes. No dump is restored; that is verify --latest.
    rc, out, err = run([os.path.join(box.H, "scripts/ihc-backup.sh"), "--install-dir", box.I, "verify", "--latest", "--quick", "--json"], timeout=25)
    lines = [l for l in out.splitlines() if l.startswith("{")]
    v = None
    try:
        v = json.loads(lines[-1]) if lines else None
    except ValueError:
        pass
    if v is None:
        why = "it did not finish in 25 s" if rc == 124 else (err.strip().splitlines() or ["no output"])[-1][:160]
        if "unknown verify argument" in err:
            return c.warn("the backup container is older than this checkout (no quick verification): newest good backup %s old" % ago(age * 3600),
                          "rebuild it: %s/install.sh --apply --install-dir %s --from backup" % (box.H, box.I))
        return c.warn("newest good backup %s old, but the quick verification could not run: %s" % (ago(age * 3600), why),
                      "run the full one: %s/scripts/ihc-backup.sh --install-dir %s verify --latest" % (box.H, box.I), "backup-stuck")
    bad = [x for x in v.get("checks", []) if x.get("status") != "pass" and x.get("name") not in ("age",)]
    for x in v.get("checks", []):
        if x.get("name") in ("repository", "repository-check", "manifest", "latest-run") or x.get("status") != "pass":
            c.see("verify %s: %s %s" % (x.get("name"), x.get("status"), x.get("detail", "")))
    if any(x.get("name") in ("repository", "repository-check", "manifest") or x.get("name", "").startswith("snapshot:") for x in bad):
        x = bad[0]
        return c.fail("the backup repository has a problem: %s: %s" % (x.get("name"), x.get("detail", "")[:160]),
                      "run the full verification and keep its output: %s/scripts/ihc-backup.sh --install-dir %s verify --latest" % (box.H, box.I), "backup-stuck")
    if bad:
        x = bad[0]
        return c.warn("the newest good backup is %s old, but the latest run %s: %s" % (ago(age * 3600), x.get("name"), x.get("detail", "")[:160]),
                      "read why the latest run failed (%s logs --tail 80 backup) before the window of %g h runs out" % (box.dc_shown, max_h), "backup-stuck")
    return c.ok("newest good backup %s old (window %g h); repository opens, restic check clean" % (ago(age * 3600), max_h))


def app_runtime(box, slug, a):
    """What 'up' means for an app: recorded in the inventory by ihc-app provision; for an
    app provisioned before that, its company-app.yaml from Gitea; else the template's."""
    rt = a.get("runtime") or {}
    if rt.get("health_path"):
        return rt, "inventory"
    repo = a.get("repository") or "%s/%s" % (box.env.get("GITEA_ORGANIZATION", "company"), slug)
    url = "http://127.0.0.1:%s/api/v1/repos/%s/raw/company-app.yaml" % (box.env.get("GITEA_LOCAL_PORT", "3000"), repo)
    try:
        req = urllib.request.Request(url, headers={"Authorization": "token " + box.env.get("GITEA_READONLY_TOKEN", "")})
        text = urllib.request.urlopen(req, timeout=8).read().decode()
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
            f.write(text)
        rc, out, _ = run([sys.executable, "-I", os.path.join(os.path.dirname(os.path.abspath(__file__)), "appmanifest.py"), "vars", f.name, slug], timeout=10)
        os.unlink(f.name)
        v = dict(re.findall(r"^(M_[A-Z_]+)='?([^'\n]*)'?$", out, re.M))
        if rc == 0 and v.get("M_HEALTH_PATH"):
            return {"service": v["M_SERVICE"], "health_path": v["M_HEALTH_PATH"], "health_status": int(v["M_HEALTH_STATUS"]),
                    "auth_required": v["M_AUTH"] == "true"}, "company-app.yaml in %s" % repo
    except (OSError, ValueError):
        pass
    return {"service": "app", "health_path": "/health", "health_status": 200, "auth_required": True}, "template defaults (manifest not readable)"


def c_app(box, slug, a, hosts):
    c = Check("app:" + slug)
    rt, src = app_runtime(box, slug, a)
    host = "%s.%s" % (slug, box.base)
    svc, path, want = rt.get("service", "app"), rt.get("health_path", "/health"), str(rt.get("health_status", 200))
    c.see("expects %s = %s on %s (from %s)" % (path, want, host, src))
    r = box.container(svc, slug)
    deploy = "re-run its deploy: in Gitea (%s), re-run the last workflow run of %s, or push to main" % (box.env.get("GITEA_BASE_URL", ""), a.get("repository") or slug)
    if a.get("kind") == "system-test":
        c.see("left by a smoke test (kind system-test)")
    if not r:
        return c.fail("%s has no container (service %s of project %s)" % (slug, svc, slug), deploy, "diagnose-app-down")
    c.see("%s: %s, health %s, %d restarts" % (r["name"], r["status"], r["health"], r["restarts"]))
    if r["status"] != "running":
        return c.fail("%s is down: its container %s is %s%s" % (slug, r["name"], r["status"], " (killed for memory)" if r["oom"] else " (exit code %s)" % r["exit_code"]),
                      "start it: docker start %s; if it stops again, read docker logs --tail 50 %s" % (r["name"], r["name"]), "diagnose-app-down")
    code, loc, body = box.proxy(host, path)
    c.see("%s%s through the proxy: %s %s" % (host, path, code, body[:80].replace("\n", " ")))
    routed = hosts is None or any(host in (h.get("domain_names") or []) for h in hosts)
    if not routed:
        return c.fail("%s runs, but the proxy has no route for %s (answered %s)" % (slug, host, code),
                      "put the route back: " + deploy + " (ihc-app provision recreates it)", "route-and-provider")
    if code == "000":
        return c.fail("%s runs, but the proxy does not answer for %s (%s)" % (slug, host, body[:120]),
                      "the route is there but cannot be served%s: %s (ihc-app provision puts the route back whole)" % (
                          " (with TLS internal, usually a route without the cloud's certificate)" if box.tls == "internal" else "", deploy),
                      "route-and-provider")
    if code in ("502", "503", "504"):
        return c.fail("the proxy cannot reach %s: %s on %s (the container runs, but nothing answers on port %s)" % (slug, code, path, rt.get("port", "?")),
                      "read its log (docker logs --tail 50 %s): the app must listen on runtime.port on all interfaces" % r["name"], "diagnose-app-down")
    if code != want:
        return c.fail("%s answers %s on %s through the proxy (its manifest wants %s)" % (slug, code, path, want),
                      "read its log: docker logs --tail 50 %s" % r["name"], "diagnose-app-down")
    if rt.get("auth_required", True):
        root, loc, _ = box.proxy(host, "/")
        c.see("anonymous %s/ -> %s %s" % (host, root, loc[:100]))
        if not to_sso(root, loc, box):
            return c.fail("%s is up but not behind the sign-in: anonymous / got %s" % (slug, root),
                          deploy + " (provision restores the SSO in front of it)", "route-and-provider")
    if r["health"] == "unhealthy":
        return c.warn("%s answers %s through the proxy, but its own healthcheck says unhealthy" % (slug, code), "read docker inspect %s (State.Health) and its log" % r["name"], "diagnose-app-down")
    if a.get("kind") == "system-test":
        return c.warn("%s is a smoke test's app left on the box" % slug, "remove it: %s/scripts/ihc-app.sh remove %s --install-dir %s" % (box.H, slug, box.I))
    return c.ok("%s up: %s = %s through the proxy%s" % (slug, path, code, ", / sends to the sign-in" if rt.get("auth_required", True) else " (public by its manifest)"))


def c_agent(box):
    c = Check("agent")
    bad = []
    for s in ("docker-ro", "agent"):
        r = box.container(s)
        c.see("%s: %s" % (s, "%s, health %s" % (r["status"], r["health"]) if r else "no container"))
        if not r or r["status"] != "running" or r["health"] == "unhealthy":
            bad.append(s)
    if bad:
        return c.fail("the operator agent is down: %s" % ", ".join(bad), "read its log: %s logs --tail 80 %s" % (box.dc_shown, bad[0]), "restart-service")
    js = ("const a=process.env.IHC_DOCKER_API;(async()=>{const p=await fetch(a+'/_ping');"
          "const l=await fetch(a+'/containers/json');console.log(p.status+' '+l.status)})().catch(e=>console.log('error '+e.message))")
    rc, out, err = run(box.dc + ["exec", "-T", "agent", "node", "-e", js], timeout=15)
    c.see("from the agent: ihc-ro's Docker API /_ping and /containers/json: %s" % (out.strip() or err.strip()[:120]))
    if out.strip() != "200 200":
        return c.fail("the agent cannot read Docker through its read-only proxy (ihc-ro): %s" % (out.strip() or "no answer"),
                      "read the proxy's log: %s logs --tail 50 docker-ro" % box.dc_shown, "restart-service")
    return c.ok("agent running; its read-only Docker API (ihc-ro) answers")


def c_version(box):
    c = Check("version")
    rc, head, _ = run(["git", "-C", box.H, "rev-parse", "HEAD"], timeout=5)
    if rc != 0:
        return c.ok("%s is not a git checkout: version not compared" % box.H)
    head = head.strip()
    _, branch, _ = run(["git", "-C", box.H, "rev-parse", "--abbrev-ref", "HEAD"], timeout=5)
    c.see("checkout %s on %s at %s" % (box.H, branch.strip(), head[:12]))
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        p = subprocess.run(["git", "-C", box.H, "ls-remote", "origin", "refs/heads/main"], capture_output=True, text=True, timeout=8, env=env)
        remote = p.stdout.split()[0] if p.returncode == 0 and p.stdout.split() else ""
    except (OSError, subprocess.TimeoutExpired):
        remote = ""
    if not remote:
        return c.ok("checkout at %s (%s); origin/main not reachable from here, not compared" % (head[:12], branch.strip()))
    c.see("origin/main at %s" % remote[:12])
    if remote == head:
        return c.ok("checkout at %s, the same as origin/main" % head[:12])
    rc, n, _ = run(["git", "-C", box.H, "rev-list", "--left-right", "--count", "%s...%s" % (head, remote)], timeout=5)
    if rc == 0 and len(n.split()) == 2:
        ahead, behind = n.split()
        where = "%s commit(s) behind it, %s ahead" % (behind, ahead)
    else:
        where = "different from it (git fetch to compare)"
    return c.ok("checkout at %s (%s); origin/main is at %s: %s. Informative only: updating is the admin's call" % (head[:12], branch.strip(), remote[:12], where))


def c_portal_api(box, reading):
    """The platform as the portal sees it, read with IHC_PORTAL_API_TOKEN through the proxy."""
    c = Check("portal-api")
    meta = reading["portal_api"]
    c.see("GET %s -> %s" % (meta.get("url", portalapi.PATH), meta.get("http_code", "not sent")))
    if reading["source"] != "portal-api":
        reason = meta.get("reason", "no answer")
        if not box.env.get(portalapi.TOKEN_ENV):
            action = "update the install: %s/install.sh --apply --from foundation --install-dir %s" % (box.H, box.I)
        elif meta.get("http_code") == 302:
            action = "%s/scripts/first-run.sh --install-dir %s (puts the status API rule on the portal route)" % (box.H, box.I)
        elif meta.get("http_code") in (401, 503):
            action = "%s up -d portal (the container gets the token from .env)" % box.dc_shown
        else:
            action = "see the portal check of containers and routes above; docs/portal-api.md"
        return c.warn("portal API not read (%s); this report is from local checks only" % reason, action)
    p = reading["platform"]
    s = p["summary"]
    c.see("portal checked at %s, overall %s, %d healthy, %d unhealthy, %d unknown" % (p.get("checked_at"), p["overall"], s["healthy"], s["unhealthy"], s["unknown"]))
    bad = [x for x in p["services"] if x.get("healthy") is False]
    for x in bad:
        c.see("%s: %s" % (x["name"], x["detail"]))
    if bad:
        return c.warn("the portal sees %d of %d services unhealthy: %s" % (len(bad), s["total"], ", ".join(x["name"] for x in bad)),
                      "compare with the checks above; the portal's Platform page shows the same (docs/portal-api.md)")
    return c.ok("the portal sees %d of %d services healthy%s" % (s["healthy"], s["total"], (", %d not configured" % s["unknown"]) if s["unknown"] else ""))


# ------------------------------------------------------------------------------ main

def doctor(install_dir, root):
    t0 = time.time()
    box = Box(install_dir, root)
    checks, na = [], []
    checks.append(c_install(box))
    d = c_docker(box)
    checks.append(d)
    if d.status == "fail":
        return box, checks, na, t0
    box.look()
    jobs = [("containers", c_containers), ("disk", c_disk), ("memory", c_memory), ("dns", c_dns)]
    if box.tls == "off":
        na.append({"name": "tls", "reason": "TLS is off (%s ingress, plain HTTP on the box)" % box.ingress})
    else:
        jobs.append(("tls", c_tls))
    jobs += [("login", c_login), ("gitea", c_gitea), ("runners", c_runners), ("postgres", c_postgres), ("redis", c_redis)]
    if box.env.get("BACKUP_ENABLED") == "true":
        jobs.append(("backup", c_backup))
    else:
        na.append({"name": "backup", "reason": "backup is off (backup.enabled: false): nothing here is backed up"})
    if box.has("agent"):
        jobs.append(("agent", c_agent))
    else:
        na.append({"name": "agent", "reason": "the agent profile is off"})
    jobs.append(("version", c_version))
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        hosts_f = pool.submit(npm_hosts, box)
        portal_f = pool.submit(portalapi.fetch_status, box.env, box.I)
        futs = [(n, pool.submit(f, box)) for n, f in jobs]
        hosts, err = hosts_f.result()
        # routes after memory and the apps after backup: the order a person reads them in.
        futs.insert(3, ("routes", pool.submit(c_routes, box, hosts, err)))
        at = next((i for i, (n, _) in enumerate(futs) if n in ("agent", "version")), len(futs))
        futs[at:at] = [("app:" + slug, pool.submit(c_app, box, slug, a, hosts)) for slug, a in box.apps()]
        for name, f in futs:
            try:
                checks.append(f.result(timeout=40))
            except Exception as e:  # noqa: BLE001  (a broken check is a finding, not a crash)
                checks.append(Check(name).warn("the check itself failed: %s" % e, "run the doctor with --verbose and report it"))
        try:
            box.reading = portal_f.result(timeout=40)
        except Exception as e:  # noqa: BLE001
            box.reading = {"source": "local", "platform": None, "portal_api": {"token_env": portalapi.TOKEN_ENV, "reason": "the read failed: %s" % e}}
        at = next((i for i, c in enumerate(checks) if c.name in ("agent", "version")), len(checks))
        checks.insert(at, c_portal_api(box, box.reading))
    if not box.apps():
        na.append({"name": "app:*", "reason": "no app provisioned yet"})
    return box, checks, na, t0


def report(box, checks, na, t0):
    s = {"ok": 0, "warn": 0, "fail": 0}
    for c in checks:
        s[c.status] += 1
    r = {"doctor_version": DOCTOR_VERSION, "generated_at": iso(now_utc()), "install_dir": box.I, "checkout": box.H,
         "duration_seconds": round(time.time() - t0, 1),
         "ingress": "%s/%s" % (box.ingress, box.tls), "profiles": ["core"] + box.profiles,
         "checks": [c.as_dict() for c in checks], "summary": s, "not_applicable": na}
    reading = getattr(box, "reading", None) or {"source": "local", "platform": None, "portal_api": {"token_env": portalapi.TOKEN_ENV, "reason": "Docker is not answering: nothing else was read"}}
    r.update(reading)
    # The same guard as the brief: no value of .env may leave in a report.
    text = json.dumps(r)
    for k, v in box.env.items():
        if SECRET_NAME.search(k) and len(v) >= 8 and v in text:
            sys.exit("refused: a secret value would appear in the report")
    return r


def text(r, verbose):
    mark = {"ok": "[ok]", "warn": "[!!]", "fail": "[xx]"}
    out = ["InHouseCloud doctor: %s (%s ingress, TLS %s), %s, %.1f s, platform from %s" % (r["install_dir"], *r["ingress"].split("/"), r["generated_at"], r["duration_seconds"], r.get("source", "local"))]
    w = max(len(c["name"]) for c in r["checks"]) if r["checks"] else 10
    order = {"fail": 0, "warn": 1, "ok": 2}
    rows = r["checks"] if verbose else sorted(r["checks"], key=lambda c: order[c["status"]])
    oks = []
    for c in rows:
        if c["status"] == "ok" and not verbose:
            oks.append(c["name"]); continue
        out.append("%s %-*s  %s" % (mark[c["status"]], w, c["name"], c["detail"]))
        if c["status"] != "ok":
            out.append("     %-*s  do: %s%s" % (w, "", c["action"], " (%s)" % c["runbook"] if c.get("runbook") else ""))
        if verbose:
            for e in c["evidence"]:
                out.append("     %-*s  - %s" % (w, "", e))
    if oks:
        out.append("[ok] " + ", ".join(oks))
    if verbose and r["not_applicable"]:
        out.append("not applicable: " + "; ".join("%s (%s)" % (n["name"], n["reason"]) for n in r["not_applicable"]))
    s = r["summary"]
    if s["fail"] or s["warn"]:
        out.append("%d fail, %d warn, %d ok. %s" % (s["fail"], s["warn"], s["ok"],
                   "Start with the first [xx] line." if s["fail"] else "Nothing is down; the [!!] lines need attention soon."))
    else:
        out.append("All %d checks ok: the cloud is on the air." % s["ok"])
    if not verbose:
        out.append("Details: --verbose. For an agent: --json.")
    return "\n".join(out)


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    install_dir, root, args = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3:]
    as_json, verbose = "--json" in args, "--verbose" in args or "-v" in args
    out_dir = args[args.index("--out") + 1] if "--out" in args else os.path.join(install_dir, "agent/reference")
    # Two cases where no check can run: no installation, or one under a previous name
    # (legacy.py). Either is the install check, failed, alone.
    msg = action = None
    evidence = []
    old = legacy.detect(install_dir)
    if not os.access(os.path.join(install_dir, ".env"), os.R_OK):
        msg = "no readable .env in %s: no installation there, or run the doctor as the user who installed it (--install-dir DIR for another place)" % install_dir
        action = "pass --install-dir with the directory install.sh used"
    elif old:
        lines = legacy.message(install_dir, *old).splitlines()
        msg, action, evidence = lines[0], " ".join(l.strip() for l in lines[3:]), [lines[1], lines[2]]
    if msg:
        if as_json:
            print(json.dumps({"doctor_version": DOCTOR_VERSION, "generated_at": iso(now_utc()), "install_dir": install_dir,
                              "checks": [{"name": "install", "status": "fail", "detail": msg, "action": action, "runbook": "",
                                          "evidence": evidence}],
                              "summary": {"ok": 0, "warn": 0, "fail": 1}, "not_applicable": []}, indent=2))
        elif evidence:
            print("[xx] install  " + "\n             ".join(legacy.message(install_dir, *old).splitlines()), file=sys.stderr)
        else:
            print("[xx] install  " + msg, file=sys.stderr)
        sys.exit(1)
    box, checks, na, t0 = doctor(install_dir, root)
    r = report(box, checks, na, t0)
    # The operator agent's copy of the last full run (ihc-ro doctor reads it).
    if os.path.isdir(out_dir) and os.access(out_dir, os.W_OK):
        try:
            fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=".doctor.")
            with os.fdopen(fd, "w") as f:
                json.dump(r, f, indent=2); f.write("\n")
            os.chmod(tmp, 0o644); os.replace(tmp, os.path.join(out_dir, "doctor.json"))
        except OSError:
            pass
    if as_json:
        print(json.dumps(r, indent=2))
    else:
        print(text(r, verbose), file=sys.stderr)
    sys.exit(1 if r["summary"]["fail"] else 0)


if __name__ == "__main__":
    main()
