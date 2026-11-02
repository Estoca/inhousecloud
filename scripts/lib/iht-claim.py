#!/usr/bin/env python3
"""Redeem an installer claim. Code on stdin, credentials only in the 0600 .env.

Never follow redirects or report response bodies/transport exceptions.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def safe(value):
    return isinstance(value, str) and value and all(32 <= ord(c) < 127 and c not in '\"\\$`' for c in value)


def url(value):
    parsed = urllib.parse.urlsplit(value)
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1") or (parsed.hostname or "").endswith(".localhost")
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and local)) or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise ValueError()
    return parsed


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    config_path, env_path, issuer, endpoint = sys.argv[1:]
    issuer = issuer.rstrip("/")
    origin = url(issuer)
    target = url(endpoint)
    # An override can select a path, never send the bearer claim to another origin.
    if (origin.scheme, origin.hostname, origin.port) != (target.scheme, target.hostname, target.port):
        raise ValueError()
    code = sys.stdin.read().strip()
    if not code or len(code) > 256:
        raise ValueError()
    config = module("config")
    envfile = module("envfile")
    data = config.load(config_path)
    request = urllib.request.Request(endpoint, data=urllib.parse.urlencode({"code": code}).encode(), method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError()
        result = json.loads(response.read(16385))
    if result.get("issuer") != issuer or not all(safe(result.get(k)) for k in ("issuer", "client_id", "client_secret")):
        raise ValueError()
    lines = envfile.read(env_path)
    existing = {m.group(1): envfile.unquote(m.group(2)) for line in lines if (m := envfile.LINE.match(line))}
    # Rotation must not silently migrate identity to a different client or issuer.
    for key, value in (("IHT_CLIENT_ID", result["client_id"]), ("IHT_ISSUER", issuer)):
        if existing.get(key) and existing[key] != value:
            raise ValueError()
    values = {"IHC_IHT_CLIENT_SECRET": result["client_secret"], "IHT_CLIENT_SECRET": result["client_secret"],
              "IHT_CLIENT_ID": result["client_id"], "IHT_ISSUER": issuer,
              "IHT_DISCOVERY_URL": issuer + "/.well-known/openid-configuration", "IHT_ENABLED": "true"}
    lines = [line for line in lines if not ((m := envfile.LINE.match(line)) and m.group(1) in values)]
    lines.extend(k + '="' + v + '"' for k, v in values.items())
    # Persist the secret first, so an interrupted config save is recoverable locally.
    envfile.write(env_path, lines)
    iht = data.setdefault("authentik", {}).setdefault("iht", {})
    iht.update(issuer=issuer, client_id=result["client_id"], client_secret_env="IHC_IHT_CLIENT_SECRET")
    # JSON is YAML 1.2; config.load supports it even without PyYAML.
    fd, temporary = tempfile.mkstemp(prefix=".config.", dir=Path(config_path).parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(data, output, indent=2)
            output.write("\n")
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        print("iht claim failed (HTTP %s). Login configuration was kept. Request a fresh claim from the company owner and rerun --apply --from foundation --iht-claim <code>." % error.code, file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("iht claim failed. Login configuration was kept. Check the issuer/claim_url and network, then request a fresh claim and rerun --apply --from foundation --iht-claim <code>. Credentials already saved in .env can be recovered locally; never paste them into chat.", file=sys.stderr)
        sys.exit(1)
