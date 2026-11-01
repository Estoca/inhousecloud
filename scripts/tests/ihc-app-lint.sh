#!/usr/bin/env bash
# Static trust-boundary checks and doctor warnings, without Docker or a running box.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "$ROOT/.ihc-lint-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
python3 -I - "$ROOT" "$WORK" <<'PY'
import copy, json, os, pathlib, shutil, stat, subprocess, sys
from unittest.mock import patch
root, work = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(root / 'scripts/lib'))
import applint, doctor
app = root / 'scripts/ihc-app.sh'
repo = work / 'app'
shutil.copytree(root / 'templates/app', repo)
for p in repo.rglob('*'):
    if p.is_file():
        text = p.read_text()
        for k, v in {'__APP_SLUG__': 'sample-app', '__APP_NAME__': 'Sample app',
                     '__OWNER_EMAIL__': 'owner@example.com', '__APP_DOMAIN__': 'sample-app.cloud.localhost',
                     '__APP_GROUP__': 'ihc-users'}.items():
            text = text.replace(k, v)
        p.write_text(text)
manifest = (repo / 'company-app.yaml').read_text()
compose = repo / 'docker-compose.yml'
base = {'services': {'app': {'build': '.'}}}
bad = 0
def check(name, ok):
    global bad
    print('[%s] %s' % ('ok' if ok else 'xx', name))
    bad += not ok

check('unchanged template passes', subprocess.run([str(app), 'lint', str(root / 'templates/app')]).returncode == 0)
check('generated app passes', not applint.lint(repo))
check('default directory', subprocess.run([str(app), 'lint'], cwd=repo).returncode == 0)

cases = [
    ('privileged', {'privileged': True}, 'host networking or privileged mode'),
    ('host network', {'network_mode': 'host'}, 'host networking or privileged mode'),
    ('host PID', {'pid': 'host'}, 'host namespace'),
    ('host IPC', {'ipc': 'host'}, 'host namespace'),
    ('capabilities', {'cap_add': ['SYS_ADMIN']}, 'cap_add'),
    ('device access', {'devices': ['/dev/sda:/dev/sda']}, 'devices'),
    ('socket short', {'volumes': ['/var/run/docker.sock:/var/run/docker.sock']}, 'mounts the Docker socket'),
    ('socket long', {'volumes': [{'type': 'bind', 'source': '/run/docker.sock', 'target': '/socket'}]}, 'mounts the Docker socket'),
    ('etc', {'volumes': ['/etc:/host:ro']}, 'outside the app data'),
    ('systemd directory', {'volumes': ['/lib/systemd/system:/host']}, 'outside the app data'),
    ('cron directory', {'volumes': ['/var/spool/cron:/host']}, 'outside the app data'),
    ('install root', {'volumes': ['/opt/inhousecloud:/host']}, 'managed by install.sh'),
    ('install parent', {'volumes': ['/opt:/host']}, 'managed by install.sh'),
    ('platform directory', {'volumes': ['/opt/inhousecloud/runner:/host']}, 'managed by install.sh'),
    ('another app data', {'volumes': ['/opt/inhousecloud/app-data/other:/data']}, 'managed by install.sh'),
    ('data traversal', {'volumes': ['/opt/inhousecloud/app-data/sample-app/../../catalog:/data']}, 'managed by install.sh'),
    ('relative mount', {'volumes': ['./data:/data']}, 'outside the app data'),
    ('unresolved mount', {'volumes': ['${HOST_PATH}:/data']}, 'outside the app data'),
    ('extends', {'extends': {'file': '../other.yml', 'service': 'app'}}, 'uses extends'),
    ('variable namespace', {'pid': '${PID_MODE}'}, 'unresolved pid'),
    ('container lifecycle hook', {'post_start': [{'command': 'true', 'privileged': True}]}, 'deploy hooks'),
    ('build secrets', {'build': {'context': '.', 'secrets': ['secret']}}, 'build.secrets'),
    ('build SSH', {'build': {'context': '.', 'ssh': ['default']}}, 'build.ssh'),
    ('build host network', {'build': {'context': '.', 'network': 'host'}}, 'builds on the network'),
    ('build outside', {'build': {'context': '..'}}, 'outside the repository'),
    ('Dockerfile outside', {'build': {'context': '.', 'dockerfile': '../Dockerfile'}}, 'outside the repository'),
    ('extra context', {'build': {'context': '.', 'additional_contexts': ['host=../host']}}, 'outside the repository'),
    ('build variable', {'build': '${CONTEXT}'}, 'unresolved build variable'),
    ('local infrastructure', {'image': 'postgres:16', 'build': None}, 'use the shared Postgres'),
]
for name, delta, expected in cases:
    data = copy.deepcopy(base)
    data['services']['app'].update(delta)
    compose.write_text(json.dumps(data))  # JSON is YAML, exercises both YAML readers.
    findings = applint.lint(repo)
    check(name, any(expected in x for x in findings))

for name, data, expected in [
    ('host-backed volume', {'services': {'app': {'volumes': ['data:/data']}}, 'volumes': {'data': {'driver_opts': {'device': '/etc', 'o': 'bind'}}}}, 'driver_opts'),
    ('external platform volume', {'services': {'app': {'volumes': ['data:/data']}}, 'volumes': {'data': {'external': True}}}, 'external storage'),
    ('compose include', dict(base, include='../host.yml'), 'include'),
    ('config host file', dict(base, configs={'host': {'file': '/opt/inhousecloud/runner/deploy.yaml'}}), 'managed by install.sh'),
    ('secret host file', dict(base, secrets={'host': {'file': '/etc/shadow'}}), 'outside the app data'),
]:
    compose.write_text(json.dumps(data))
    check(name, any(expected in x for x in applint.lint(repo)))

for mount in ['/opt/inhousecloud/app-data/sample-app:/data', '${IHC_INSTALL_DIR}/app-data/sample-app/uploads:/data', 'data:/data']:
    compose.write_text(json.dumps({'services': {'app': {'build': '.', 'volumes': [mount]}}}))
    check('allowed mount ' + mount, not applint.lint(repo))
compose.write_text(json.dumps(base))

for file, content, expected in [
    ('jobs/task.service', '[Service]\nExecStart=/app/run\n', 'host cron'),
    ('jobs/task.timer', '[Timer]\nOnCalendar=daily\n', 'host cron'),
    ('jobs/cron.d/task', '* * * * * root /app/run\n', 'host cron'),
    ('jobs/schedule', '@reboot /app/run\n', 'cron entry'),
    ('jobs/schedule', '0 3 * * * root /app/run\n', 'cron entry'),
    ('jobs/renamed.conf', '[Unit]\nDescription=host task\n', 'systemd unit content'),
    ('hooks/deploy.sh', '#!/bin/sh\ntrue\n', 'host cron'),
    ('.platform/hooks/predeploy/01-run', '#!/bin/sh\ntrue\n', 'host cron'),
    ('usr/local/bin/helper', 'binary placeholder', 'privileged binary artifact'),
    ('scripts/setup.sh', 'install helper /usr/local/bin/helper\n', 'host path'),
    ('scripts/setup.sh', 'setcap cap_net_admin+ep ./helper\n', 'host path'),
    ('.gitea/workflows/bad.yml', 'run: echo task >> /etc/crontab\n', 'host path'),
    ('.github/workflows/bad.yml', 'run: docker run --privileged alpine\n', 'privileged containers'),
    ('.gitea/workflows/bad.yml', 'run: docker run --cap-add=SYS_ADMIN alpine\n', 'privileged containers'),
    ('.gitea/workflows/bad.yml', 'run: docker run --pid=host alpine\n', 'privileged containers'),
    ('.gitea/workflows/bad.yml', 'run: docker run -v /etc:/host alpine\n', 'host path'),
    ('.gitea/workflows/bad.yml', 'run: docker run --mount type=bind,source=/srv/host,target=/host alpine\n', 'privileged containers'),
    ('.gitea/workflows/bad.yml', 'run: echo task > /srv/host/job\n', 'host path'),
    ('.gitea/workflows/bad.yml', 'run: cp helper "$IHC_INSTALL_DIR/runner/helper"\n', 'host path'),
]:
    p = repo / file
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    check(file + ': ' + expected, any(expected in x for x in applint.lint(repo)))
    p.unlink()

p = repo / 'helper'
p.write_bytes(b'\x7fELF\x00')
p.chmod(0o4755)
# Some development filesystems strip setuid on chmod; simulate that metadata there.
original_stat = pathlib.Path.stat
def setuid_stat(path, *args, **kwargs):
    result = original_stat(path, *args, **kwargs)
    if path == p:
        values = list(result)
        values[0] |= stat.S_ISUID
        return os.stat_result(values)
    return result
with patch.object(pathlib.Path, 'stat', setuid_stat):
    check('setuid binary', any('setuid/setgid' in x for x in applint.lint(repo)))
p.unlink()
p.symlink_to(work)
check('escaping symlink', any('symlink leaves' in x for x in applint.lint(repo)))
p.unlink()

install = work / 'custom-cloud'
install.mkdir()
compose.write_text(json.dumps({'services': {'app': {'volumes': [str(install / 'portal') + ':/host']}}}))
check('custom install directory', any('managed by install.sh' in x for x in applint.lint(repo, str(install))))
cli = subprocess.run([str(app), 'lint', str(repo), '--install-dir', str(install)], capture_output=True, text=True)
check('CLI nonzero and one diagnostic per line', cli.returncode == 1 and len(cli.stdout.splitlines()) == 1
      and 'managed by install.sh' in cli.stdout and not cli.stderr)
cli = subprocess.run([str(app), 'lint', str(repo)], env=dict(os.environ, IHC_INSTALL_DIR=str(install)), capture_output=True, text=True)
check('CLI install directory from environment', cli.returncode == 1 and 'managed by install.sh' in cli.stdout)
outside = work / 'outside'
outside.mkdir()
data_dir = install / 'app-data/sample-app'
data_dir.parent.mkdir()
data_dir.symlink_to(outside)
check('symlink data escape', applint.bind_finding(str(data_dir / 'file'), 'sample-app', str(install)) is not None)
data_dir.unlink()

# A real doctor invocation still reports source findings when Docker is unavailable.
(install / '.env').write_text('COMPOSE_PROJECT_NAME="ihc"\n')
(install / 'inventory.json').write_text(json.dumps({'apps': {'sample-app': {}}}))
rid = '20261101T100000Z-abcdef0'
deploy = install / 'deploys/sample-app'
release = deploy / 'releases' / rid
release.mkdir(parents=True)
shutil.copytree(repo, release / 'src')
(release / 'release.json').write_text(json.dumps({'project_dir': '', 'manifest': 'company-app.yaml'}))
(deploy / 'current').write_text(rid)
bin_dir = work / 'commands'
bin_dir.mkdir()
(bin_dir / 'docker').write_text('#!/bin/sh\nexit 1\n')
(bin_dir / 'docker').chmod(0o755)
p = subprocess.run([str(root / 'install.sh'), 'doctor', '--install-dir', str(install), '--json'],
                   env=dict(os.environ, PATH=str(bin_dir) + ':' + os.environ['PATH']), capture_output=True, text=True)
report = json.loads(p.stdout)
check('install.sh doctor warns with lint details', any(c['name'] == 'app-lint:sample-app' and c['status'] == 'warn'
      and 'managed by install.sh' in c['detail'] for c in report['checks']))
box = doctor.Box(str(install), str(root))
box.containers = {('sample-app', 'app'): {'mounts': [{'Type': 'bind', 'Source': str(install / 'runner')}]}}
c = doctor.c_app_lint(box, 'sample-app')
check('doctor checks running bind mounts too', c.status == 'warn' and any('running service' in e for e in c.evidence))
(release / 'src/docker-compose.yml').write_text(json.dumps(base))
box.containers = {}
check('doctor clean active release passes', doctor.c_app_lint(box, 'sample-app').status == 'ok')

# The original diagnostics are identical when the executor and lint see the same input.
compose.write_text(json.dumps({'services': {'app': {'privileged': True}}}))
expected = applint.executor_findings(applint.appmanifest.cmd_compose_check, 'app', {'services': {'app': {'privileged': True}}})
check('executor diagnostics reused verbatim', all(x in applint.lint(repo) for x in expected))
(repo / 'company-app.yaml').write_text(manifest.replace('  port: auto', '  port: 80'))
check('manifest rules reused', any('deploy.port must be auto' in x for x in applint.lint(repo)))
compose.write_text('services: [malformed\n')
check('malformed YAML fails closed', bool(applint.lint(repo)))
workflow = (root / 'templates/app/.gitea/workflows/deploy.yml').read_text()
check('CI lints before building', workflow.index('run: ihc-app lint') < workflow.index('run: ihc-app build'))
sys.exit(1 if bad else 0)
PY
