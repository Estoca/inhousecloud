#!/usr/bin/env python3
"""Static trust-boundary review aid; never execute app code or load its .env.

Uses the executor validators verbatim. Requires PyYAML (in the deployer image),
or the portal's installed yaml package in a development checkout.
"""
import contextlib, copy, io, json, os, re, stat, subprocess, sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import appmanifest

ROOT = Path(__file__).resolve().parents[2]
SKIP = {".git", "node_modules", ".venv", "__pycache__"}
HOST_PATH = r"/(?:etc|opt|root|boot|usr/(?:local/)?(?:s?bin|lib/systemd)|lib/systemd|run|var/(?:run|spool/cron))(?:/|\b)"
HOST_COMMAND = re.compile(r"\b(?:sudo|systemctl|crontab|setcap)\b|\bchmod\s+(?:[ug]\+s|[2467][0-7]{3})\b|" + HOST_PATH)
PRIV_CONTAINER = re.compile(r"--privileged(?:[=\s]|$)|--(?:cap-add|device)(?:[=\s]|$)|--(?:net(?:work)?|pid|ipc)[=\s]+host\b|docker\.sock|(?:--volume|--mount|-v)[=\s]+|\bcap_add:|\b(?:network_mode|pid|ipc):\s*host\b")
HOST_WRITE = re.compile(r"(?:\b(?:cp|mv|install|tee|mkdir|touch|rsync)\b[^\n]*\s|>{1,2}\s*)[\"']?/(?!dev/null\b)[\w.]")


def within(path, parent):
    path, parent = os.path.realpath(path), os.path.realpath(parent)
    return path == parent or path.startswith(parent.rstrip(os.sep) + os.sep)


def load_yaml(path, template=False):
    text = Path(path).read_text()
    if template:
        for key, value in {"__APP_SLUG__": "sample-app", "__APP_NAME__": "Sample app",
                           "__OWNER_EMAIL__": "owner@example.com", "__APP_DOMAIN__": "sample-app.cloud.localhost",
                           "__APP_GROUP__": "ihc-users"}.items():
            text = text.replace(key, value)
    try:
        import yaml
    except ImportError:
        module = ROOT / "portal/node_modules/yaml"
        script = "process.stdout.write(JSON.stringify(require(process.argv[1]).parse(require('fs').readFileSync(0,'utf8'))))"
        try:
            p = subprocess.run(["node", "-e", script, str(module)], input=text, text=True,
                               capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError("YAML reader unavailable: install python3 PyYAML") from None
        if p.returncode:
            raise ValueError("cannot parse YAML; requires PyYAML or the portal's installed yaml package")
        return json.loads(p.stdout)
    return yaml.safe_load(text)


def executor_findings(fn, *args, **kwargs):
    """Keep the executor's diagnostics, including their compose: prefix."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
        try:
            fn(*args, **kwargs)
        except SystemExit as e:
            if isinstance(e.code, str):
                err.write(e.code + "\n")
    return err.getvalue().splitlines()


def bind_finding(source, slug, install_dir):
    allowed = os.path.join(os.path.realpath(install_dir), "app-data", slug)
    source = str(source).replace("${IHC_INSTALL_DIR}", install_dir).replace("$IHC_INSTALL_DIR", install_dir)
    real = os.path.realpath(source)
    if "$" not in source and (real == allowed or real.startswith(allowed + os.sep)):
        return None
    if "$" not in source and (within(source, install_dir) or within(install_dir, source)):
        return "mount overlaps paths managed by install.sh under %s; only app-data/%s belongs to this app" % (install_dir, slug)
    return "host bind mount outside the app data directory (%s); use DATA_DIR or a named volume" % allowed


def compose_findings(data, slug, install_dir):
    errors = []
    if data.get("include"):
        errors.append("compose: include can import files outside review; keep the app compose in this repository")
    for name, svc in (data.get("services") or {}).items():
        if svc.get("extends"):
            errors.append("compose: service %r uses extends; declare the service here so lint can check its privileges" % name)
        for key in ("pid", "ipc", "network_mode", "userns_mode"):
            if "$" in str(svc.get(key, "")):
                errors.append("compose: service %r uses an unresolved %s; declare its isolation explicitly" % (name, key))
        if "$" in json.dumps(svc.get("build", {})):
            errors.append("compose: service %r has an unresolved build variable; build inputs must stay in the repository" % name)
        for key in ("cap_add", "devices", "device_cgroup_rules"):
            if svc.get(key):
                errors.append("compose: service %r asks for %s; apps run without added host privileges" % (name, key))
        if svc.get("pid") == "host" or svc.get("ipc") == "host" or svc.get("userns_mode") == "host":
            errors.append("compose: service %r shares a host namespace; apps must be isolated" % name)
        if svc.get("post_start") or svc.get("pre_stop"):
            errors.append("compose: service %r declares lifecycle deploy hooks; keep host lifecycle in the platform" % name)
        for mount in svc.get("volumes") or []:
            if isinstance(mount, str):
                parts = mount.split(":")
                source = parts[0] if len(parts) > 1 else ""
                bind = source.startswith(("/", ".", "~", "$"))
            elif isinstance(mount, dict):
                source = mount.get("source", "")
                bind = mount.get("type") == "bind" or str(source).startswith(("/", ".", "~", "$"))
            else:
                raise ValueError("invalid compose volume")
            if bind:
                why = bind_finding(source, slug, install_dir)
                if why:
                    errors.append("compose: service %r: %s" % (name, why))
    # Named volumes must not disguise host mounts via the local driver.
    for name, volume in (data.get("volumes") or {}).items():
        if isinstance(volume, dict) and (volume.get("driver_opts") or volume.get("external")):
            errors.append("compose: volume %r uses driver_opts or external storage; apps must not adopt host/platform volumes" % name)
    for kind in ("configs", "secrets"):
        for name, item in (data.get(kind) or {}).items():
            if not isinstance(item, dict):
                continue
            if item.get("external"):
                errors.append("compose: %s.%s adopts an external platform resource" % (kind, name))
            if item.get("file"):
                why = bind_finding(item["file"], slug, install_dir)
                if why:
                    errors.append("compose: %s.%s: %s" % (kind, name, why))
    return errors


def repo_findings(root, install_dir):
    errors = []
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP)
        for name in sorted(dirs + files):
            p = Path(base) / name
            rel = p.relative_to(root).as_posix()
            if p.is_symlink():
                if not within(p, root):
                    errors.append("%s: symlink leaves the repository; host artifacts must have a protected platform origin" % rel)
                continue
            if p.is_dir():
                continue
            mode = p.stat().st_mode
            if mode & (stat.S_ISUID | stat.S_ISGID):
                errors.append("%s: setuid/setgid binary or script; apps cannot supply privileged host executables" % rel)
            artifact = (name.endswith((".service", ".timer", ".socket", ".path", ".cron")) or name in ("crontab", "Procfile.deploy", "deploy.sh")
                        or re.search(r"(?:^|/)(?:cron\.[^/]+|systemd|deploy-hooks|deploy\.d)(?:/|$)", rel)
                        or re.search(r"(?:^|/)(?:pre[-_]?deploy|post[-_]?deploy)(?:[./_-]|$)", rel)
                        or re.search(r"(?:^|/)(?:\.platform/hooks/|hooks/(?:deploy|predeploy|postdeploy)(?:[./_-]|$)|usr/(?:local/)?s?bin/|host/s?bin/|sbin/)", rel))
            if artifact:
                errors.append("%s: host cron, systemd, deploy hook or privileged binary artifact; move host installation to protected platform code" % rel)
            if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
                continue
            try:
                content = p.read_text()
            except UnicodeError:
                continue
            if not artifact and re.search(r"(?m)^\s*\[(?:Unit|Service|Timer)\]\s*$", content):
                errors.append("%s: systemd unit content; host units must come from protected platform code" % rel)
            workflow = rel.startswith((".gitea/workflows/", ".github/workflows/"))
            script = name.endswith((".sh", ".bash")) or content.startswith("#!")
            for n, line in enumerate(content.splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                if (workflow or script) and (HOST_COMMAND.search(line) or HOST_WRITE.search(line) or install_dir in line or "IHC_INSTALL_DIR" in line):
                    errors.append("%s:%d: host path or privileged host command; workflows and scripts must use ihc-app build/apply" % (rel, n))
                if workflow and (PRIV_CONTAINER.search(line) or re.search(r"\bprivileged:\s*true\b", line)):
                    errors.append("%s:%d: workflow requests privileged containers or host access" % (rel, n))
                if re.match(r"^\s*(?:@(?:reboot|hourly|daily|weekly|monthly|yearly)\s+|(?:[\d*/,-]+\s+){5})\S", line):
                    errors.append("%s:%d: cron entry from the app workspace; host scheduling belongs to the platform" % (rel, n))
    return errors


def lint(directory, install_dir="/opt/inhousecloud", manifest="company-app.yaml"):
    root = Path(directory).resolve()
    errors = []
    try:
        if not root.is_dir():
            return ["lint: app directory does not exist"]
        template = root == ROOT / "templates/app"
        mp = root / manifest
        if not within(mp, root):
            return ["lint: manifest must be inside the repository"]
        m = load_yaml(mp, template)
        errors += executor_findings(appmanifest.cmd_vars, str(mp), "", manifest=m)
        slug = str(appmanifest.get(m, "app.slug", ""))
        if appmanifest.slug_problem(slug):
            slug = "invalid-app"
        cp = root / str(appmanifest.get(m, "runtime.compose_file", "docker-compose.yml"))
        if not within(cp, root):
            errors.append("compose: runtime.compose_file must stay inside the repository")
        else:
            data = load_yaml(cp, template)
            if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
                raise ValueError("compose must contain a services mapping")
            errors += executor_findings(appmanifest.cmd_compose_check, appmanifest.get(m, "runtime.service", "app"), data)
            build_data = copy.deepcopy(data)
            for svc in build_data["services"].values():
                b = svc.get("build")
                if isinstance(b, dict) and isinstance(b.get("additional_contexts"), list):
                    b["additional_contexts"] = dict(x.split("=", 1) for x in b["additional_contexts"])
            errors += executor_findings(appmanifest.cmd_build_check, str(root), build_data)
            errors += compose_findings(data, slug, str(Path(install_dir).resolve()))
    except Exception as e:  # malformed input is a finding, never a traceback or YAML source dump
        errors.append("lint: cannot validate manifest/compose (%s); check YAML and install PyYAML if unavailable" % type(e).__name__)
    try:
        errors += repo_findings(root, str(Path(install_dir).resolve()))
    except OSError:
        errors.append("lint: cannot inspect repository files")
    return list(dict.fromkeys(errors))


if __name__ == "__main__":
    findings = lint(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "company-app.yaml")
    for finding in findings:
        print(finding)
    sys.exit(1 if findings else 0)
