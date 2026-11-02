"""Private proxy caller registry. No third-party credentials enter app env files."""
import json
import hashlib
import os
import re
import secrets
import sys
import tempfile

import config
import envfile

SERVICES = {'slack', 'github', 'linear', 'hubspot'}
METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'}


def policy_errors(policy):
    if not isinstance(policy, dict):
        return ['secrets_proxy must be a service map']
    errors = []
    for service, rule in policy.items():
        if service not in SERVICES or not isinstance(rule, dict) or set(rule) != {'methods', 'path_prefixes'}:
            errors.append('secrets_proxy: unknown service or invalid fields')
            continue
        methods, paths = rule['methods'], rule['path_prefixes']
        if not isinstance(methods, list) or not methods or not all(isinstance(m, str) and m in METHODS for m in methods):
            errors.append('secrets_proxy: methods must explicitly list uppercase HTTP methods')
        if not isinstance(paths, list) or not paths or not all(
            isinstance(p, str) and re.fullmatch(r'/[A-Za-z0-9/_~.-]*', p)
            and '//' not in p and not any(s in ('.', '..') for s in p.split('/')) for p in paths
        ):
            errors.append('secrets_proxy: path_prefixes must list canonical absolute paths')
    return errors


def initialize(install_dir):
    directory = os.path.join(install_dir, 'secrets-proxy')
    os.makedirs(os.path.join(directory, 'callers'), mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    os.chmod(os.path.join(directory, 'callers'), 0o700)
    path = os.path.join(directory, 'credentials.json')
    if not os.path.exists(path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write('{}\n')


def provision(install_dir, slug, manifest, app_env):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,62}[a-z0-9]', slug):
        raise ValueError('invalid caller slug')
    initialize(install_dir)
    directory = os.path.join(install_dir, 'secrets-proxy', 'callers')
    path = os.path.join(directory, slug + '.json')
    existing = json.load(open(path)) if os.path.exists(path) else None
    # An agent has no app release: its policy is maintained by the admin on the box.
    policy = config.load(manifest).get('secrets_proxy', {}) if manifest else (existing or {}).get('policy', {})
    errors = policy_errors(policy)
    if errors:
        raise ValueError('; '.join(errors))
    lines = envfile.read(app_env)
    token = next((envfile.unquote(line.split('=', 1)[1]) for line in lines if line.startswith('IHC_SECRETS_PROXY_TOKEN=')), '') if existing else secrets.token_hex(32)
    if not re.fullmatch(r'[a-f0-9]{64}', token):
        raise ValueError('invalid proxy caller token')
    digest = hashlib.sha256(token.encode()).hexdigest()
    if existing and existing.get('token_hash') != digest:
        raise ValueError('proxy caller token does not match registry')
    fd, temporary = tempfile.mkstemp(prefix='.' + slug, dir=directory)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump({'token_hash': digest, 'policy': policy}, output)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    lines = [line for line in lines if not line.startswith(('IHC_SECRETS_PROXY_URL=', 'IHC_SECRETS_PROXY_TOKEN='))]
    lines += ['IHC_SECRETS_PROXY_URL="http://secrets-proxy"', 'IHC_SECRETS_PROXY_TOKEN="%s"' % token]
    envfile.write(app_env, lines)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2:
            initialize(sys.argv[1])
        elif len(sys.argv) == 4 and sys.argv[1] == 'agent':
            provision(sys.argv[2], 'agent', None, sys.argv[3])
        else:
            provision(*sys.argv[1:])
    except Exception:
        sys.exit('cannot provision secrets proxy caller; check private registry and manifest')
