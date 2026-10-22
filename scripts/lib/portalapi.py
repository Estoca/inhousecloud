#!/usr/bin/env python3
"""portalapi: the platform status from the portal's read-only API (docs/portal-api.md).

    portalapi.py fetch INSTALL_DIR     {source, platform, portal_api} as JSON; exit 1 when local
    portalapi.py merge INSTALL_DIR     stdin: `state status --json`; stdout: the same plus
                                       source, platform and portal_api

install.sh status --json and ihc doctor read the portal's GET /api/platform/status through
the proxy, the way a person's browser reaches it, with IHC_PORTAL_API_TOKEN from .env as
the bearer. When the portal answers with a valid status, the reading is
`source: "portal-api"` and `platform` is the portal's JSON. Otherwise the reading is
`source: "local"`, `platform` is null, and `portal_api.reason` says why (no token in
.env, no answer, HTTP code, a body that is not the status). The caller then keeps its own
local path.

The token travels in a 0600 curl config file, never on a command line, and is never
printed. Python standard library only.
"""
import json, os, re, subprocess, sys, tempfile

PATH = "/api/platform/status"
TOKEN_ENV = "IHC_PORTAL_API_TOKEN"
REQUIRED = ("checked_at", "overall", "summary", "services")
SUMMARY_KEYS = ("total", "healthy", "unhealthy", "unknown")
SERVICE_KEYS = ("name", "kind", "healthy", "detail")
OVERALL = ("healthy", "degraded")


class ParseError(ValueError):
    pass


def parse_status(body):
    """The portal's JSON, checked against the contract's required fields; ParseError otherwise."""
    try:
        data = json.loads(body) if isinstance(body, (str, bytes)) else body
    except ValueError:
        raise ParseError("the body is not JSON")
    if not isinstance(data, dict):
        raise ParseError("the body is not a JSON object")
    missing = [k for k in REQUIRED if k not in data]
    if missing:
        raise ParseError("missing field(s): %s" % ", ".join(missing))
    if data["overall"] not in OVERALL:
        raise ParseError("overall is %r, not one of %s" % (data["overall"], "/".join(OVERALL)))
    s = data["summary"]
    if not isinstance(s, dict) or any(not isinstance(s.get(k), int) for k in SUMMARY_KEYS):
        raise ParseError("summary needs integer %s" % ", ".join(SUMMARY_KEYS))
    services = data["services"]
    if not isinstance(services, list):
        raise ParseError("services is not a list")
    for i, svc in enumerate(services):
        if not isinstance(svc, dict) or any(k not in svc for k in SERVICE_KEYS):
            raise ParseError("service %d lacks one of %s" % (i, ", ".join(SERVICE_KEYS)))
        if svc["healthy"] not in (True, False, None):
            raise ParseError("service %s: healthy is not true, false or null" % svc.get("name"))
    if s["total"] != len(services):
        raise ParseError("summary.total %d but %d services" % (s["total"], len(services)))
    return data


def read_env(path):
    out = {}
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return None
    for line in lines:
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            out[m.group(1)] = v
    return out


def host_of(url):
    return url.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]


def target(env, install_dir):
    """-> (url curl calls, curl arguments, the public URL). Through the proxy from the box:
    TLS off, plain HTTP to its port with a Host header; TLS internal, https://NAME pinned to
    127.0.0.1 and verified against the cloud CA (never -k). The same as ihc doctor."""
    base = env.get("PORTAL_BASE_URL", "").rstrip("/")
    host = host_of(base) or "portal." + env.get("BASE_DOMAIN", "cloud.localhost")
    public = (base or "http://" + host) + PATH
    if env.get("TLS_MODE", "off") == "internal":
        port = env.get("PROXY_HTTPS_PORT", "443")
        args = ["--resolve", "%s:%s:127.0.0.1" % (host, port), "--cacert", os.path.join(install_dir, "local/ca/ca.crt")]
        return "https://%s%s" % (host, PATH), args, public
    port = env.get("PROXY_HTTP_PORT", "80")
    return "http://127.0.0.1:%s%s" % (port, PATH), ["-H", "Host: %s" % host], public


def curl_get(url, args, headers, timeout):
    """-> (http code as a string, body). The headers go in a 0600 config file."""
    fd, cfg = tempfile.mkstemp(prefix="ihc-portalapi.")
    try:
        with os.fdopen(fd, "w") as f:
            for h in headers:
                f.write('header = "%s"\n' % h.replace('"', '\\"'))
        cmd = ["curl", "-sS", "--max-time", str(timeout), "-o", "-", "-w", "\n%{http_code}", "-K", cfg] + list(args) + [url]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
            out = p.stdout
        except (OSError, subprocess.TimeoutExpired):
            out = "\n000"
    finally:
        os.unlink(cfg)
    body, _, code = out.rpartition("\n")
    return (code if re.match(r"^\d{3}$", code) else "000"), body


REASONS = {
    "000": "the portal did not answer through the proxy",
    "302": "the proxy sent the token request to the sign-in: the portal route has no status API rule (run scripts/first-run.sh)",
    "401": "the portal refused the token: .env and the portal container disagree (recreate the portal)",
    "403": "the portal refused the route for the token",
    "503": "the portal has no IHC_PORTAL_API_TOKEN (recreate the portal after first-run)",
}


def fetch_status(env, install_dir, http=curl_get, timeout=8):
    """{source, platform, portal_api}: the portal's reading, or why there is none."""
    env = env or {}
    url, args, public = target(env, install_dir)
    meta = {"url": public, "token_env": TOKEN_ENV}
    token = env.get(TOKEN_ENV, "")
    if not token:
        meta["reason"] = "%s is not in .env (install.sh --apply --from foundation generates it)" % TOKEN_ENV
        return {"source": "local", "platform": None, "portal_api": meta}
    code, body = http(url, args, ["Authorization: Bearer " + token, "Accept: application/json"], timeout)
    meta["http_code"] = int(code)
    if code != "200":
        meta["reason"] = REASONS.get(code, "the portal answered HTTP %s" % code)
        return {"source": "local", "platform": None, "portal_api": meta}
    try:
        platform = parse_status(body)
    except ParseError as e:
        meta["reason"] = "the answer is not the platform status: %s" % e
        return {"source": "local", "platform": None, "portal_api": meta}
    return {"source": "portal-api", "platform": platform, "portal_api": meta}


def merge(state, reading):
    """`state status --json` plus the reading: the portal's view when it answered."""
    out = dict(state)
    out.update(reading)
    return out


def main(argv):
    if len(argv) < 3 or argv[1] not in ("fetch", "merge"):
        sys.exit(__doc__)
    install_dir = argv[2].rstrip("/")
    env = read_env(os.path.join(install_dir, ".env"))
    if env is None:
        reading = {"source": "local", "platform": None,
                   "portal_api": {"token_env": TOKEN_ENV, "reason": "no readable .env in %s" % install_dir}}
    else:
        reading = fetch_status(env, install_dir)
    if argv[1] == "fetch":
        print(json.dumps(reading, indent=2))
        return 0 if reading["source"] == "portal-api" else 1
    try:
        state = json.load(sys.stdin)
    except ValueError:
        state = {}
    print(json.dumps(merge(state, reading), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
