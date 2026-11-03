#!/usr/bin/env bash
# Doctor v2 modes, backups, repairs and redaction, without Docker or network.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d "$ROOT/.ihc-doctor-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PYTHONDONTWRITEBYTECODE=1 python3 -B - "$ROOT" "$WORK" <<'PY'
import contextlib, hashlib, importlib.util, io, json, os, pathlib, shlex, shutil, subprocess, sys
from unittest.mock import patch
root, work = map(pathlib.Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('doctor', root / 'scripts/lib/doctor.py')
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
inst, checkout, bin_dir = work / 'install', work / 'checkout', work / 'bin'
for path in [inst / 'secrets-proxy/callers', checkout / 'scripts/lib', bin_dir]:
    path.mkdir(parents=True)
secret = 'fake-doctor-secret-value'
(inst / '.env').write_text('TEST_SECRET="' + secret + '"\nGITEA_ORGANIZATION=company\nRUNNER_NAME=company-runner\n')
(inst / 'compose.yml').write_text('services: {}\n')
(inst / 'config.yaml').write_text('{}\n')
(inst / 'inventory.json').write_text('{"apps":{}}\n')
state = {'status': 'completed', 'stages': {'foundation': {'status': 'completed'}}}
def save_state():
    (inst / 'state.json').write_text(json.dumps(state))
save_state()
for slug in ['smoke-app', 'agent']:
    (inst / 'secrets-proxy/callers' / (slug + '.json')).write_text('{"policy":{}}\n')
for name in ['secretsproxy.py', 'config.py', 'envfile.py']:
    shutil.copy2(root / 'scripts/lib' / name, checkout / 'scripts/lib' / name)
def executable(path, text):
    path.write_text(text); path.chmod(0o700)
executable(bin_dir / 'docker', '#!/bin/sh\necho "' + secret + '" >&2\nexit 1\n')
executable(bin_dir / 'curl', '#!/bin/sh\nexit 1\n')
executable(bin_dir / 'git', '#!/bin/sh\nexit 1\n')
executable(bin_dir / 'ps', '#!/bin/sh\nexit 0\n')
# The actual installer CLI is exercised separately; only repair execution is stubbed.
executable(checkout / 'install.sh', '''#!/usr/bin/env python3
import json, pathlib, sys
p = pathlib.Path(sys.argv[sys.argv.index('--install-dir') + 1])
with (p / 'installer-calls.jsonl').open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
s = json.loads((p / 'state.json').read_text())
s['status'] = 'completed'
for stage in s['stages'].values(): stage['status'] = 'completed'
(p / 'state.json').write_text(json.dumps(s))
''')
env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'], PYTHONDONTWRITEBYTECODE='1')
def cli(*flags, command=None):
    cmd = command or [sys.executable, '-B', str(root / 'scripts/lib/doctor.py'), str(inst), str(checkout)]
    p = subprocess.run(cmd + list(flags), stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env)
    # Never put captured output in assertions; a redaction regression must not leak.
    assert secret not in p.stdout and secret not in p.stderr, 'secret escaped redaction'
    return p

def report(*flags):
    p = cli('--json', *flags)
    assert p.returncode == 1, 'Docker fail must remain exit 1'
    return json.loads(p.stdout)
def check(r, name):
    return next(c for c in r['checks'] if c['name'] == name)
def digest():
    h = hashlib.sha256()
    for p in sorted(inst.rglob('*')):
        h.update(str(p.relative_to(inst)).encode())
        if p.is_file(): h.update(p.read_bytes())
    return h.hexdigest()

before = digest()
r = report()
c = check(r, 'secrets-proxy-callers')
assert c['status'] == 'warn' and 'smoke-app' in c['detail'] and 'agent' not in c['detail']
assert c['repair']['id'] == 'remove-orphan-callers' and c['repair']['safe'] is True
assert digest() == before, 'report wrote installation data'
r = report('--lint')
assert digest() == before and r['mode'] == 'lint'
ref = inst / 'agent/reference'; ref.mkdir(parents=True)
before = digest(); report('--lint')
assert digest() == before and not (ref / 'doctor.json').exists()
r = report()
assert json.loads((ref / 'doctor.json').read_text()) == r
before = digest(); report('--lint'); assert digest() == before
p = cli('--fix', '--json')
assert 'no repairs applied' in p.stderr and (inst / 'secrets-proxy/callers/smoke-app.json').exists()
p = cli('--fix')
assert 'no repairs applied' in p.stderr and (inst / 'secrets-proxy/callers/smoke-app.json').exists()
p = cli('--verbose')
assert '[redacted]' in p.stderr
assert p.stderr.index('Fix now:') < p.stderr.index('Recommended:') < p.stderr.index('Repaired:')
r = report('--fix', '--yes')
c = check(r, 'secrets-proxy-callers')
assert c['status'] == 'ok' and c['repaired']['ok'] and r['summary']['repaired'] >= 1
assert not (inst / 'secrets-proxy/callers/smoke-app.json').exists()
assert (inst / 'secrets-proxy/callers/agent.json').exists()
backup = pathlib.Path(c['repaired']['backup'])
assert (backup / 'secrets-proxy/callers/smoke-app.json').read_text() == '{"policy":{}}\n'
assert backup.stat().st_mode & 0o777 == 0o700
assert (inst / 'doctor-backups').stat().st_mode & 0o777 == 0o700
print('[ok] orphan callers, agent retained, backup, recheck, modes, nonterminal refusal and redaction')

command = shlex.join([str(checkout / 'install.sh'), '--apply', '--install-dir', str(inst), '--from', 'foundation'])
state['status'] = 'failed'
state['stages']['foundation'] = {'status': 'failed', 'resume_command': command}
save_state()
r = report('--lint'); c = check(r, 'install-stages')
assert c['status'] == 'fail' and 'foundation' in c['detail']
assert c['repair']['id'] == 'resume-install' and c['repair']['safe']
assert shlex.split(c['repair']['command']) == shlex.split(command) + ['--yes', '--non-interactive']
r = report('--fix', '--yes'); c = check(r, 'install-stages')
assert c['status'] == 'ok' and c['repaired']['ok']
calls = (inst / 'installer-calls.jsonl').read_text().splitlines()
assert len(calls) == 1 and json.loads(calls[0]) == shlex.split(command)[1:] + ['--yes', '--non-interactive']
assert json.loads((pathlib.Path(c['repaired']['backup']) / 'state.json').read_text())['status'] == 'failed'
# Interrupted running stages are failures only without a live installer.
box = d.Box(str(inst), str(checkout), 'lint')
box.state['stages']['foundation']['status'] = 'running'
with patch.object(d, 'install_running', return_value=False): assert d.c_install_stages(box).status == 'fail'
with patch.object(d, 'install_running', return_value=True): assert d.c_install_stages(box).status == 'ok'
print('[ok] failed/interrupted stages, exact noninteractive resume once, state backup and recheck')

# Test-only cleanup never receives a real app or another app's resources.
apps = {'smoke-app': {'kind': 'system-test', 'repository': 'company/smoke-app'}, 'real-app': {'kind': 'app'}}
(inst / 'inventory.json').write_text(json.dumps({'apps': apps}))
(inst / 'apps/smoke-app').mkdir(parents=True)
(inst / 'apps/smoke-app/.env').write_text('CUSTOM="fake-app-secret-value"\n')
executable(checkout / 'scripts/ihc-app.sh', '''#!/usr/bin/env python3
import json, pathlib, sys
assert sys.argv[1:3] == ['remove', 'smoke-app'] and '--yes' in sys.argv
p = pathlib.Path(sys.argv[sys.argv.index('--install-dir') + 1])
s = json.loads((p / 'inventory.json').read_text()); s['apps'].pop('smoke-app')
(p / 'inventory.json').write_text(json.dumps(s))
''')
r = report('--fix', '--yes'); c = check(r, 'system-test-apps')
assert c['status'] == 'ok' and c['repaired']['ok']
assert 'real-app' in json.loads((inst / 'inventory.json').read_text())['apps']
assert (pathlib.Path(c['repaired']['backup']) / 'apps/smoke-app/.env').exists()
box = d.Box(str(inst), str(checkout), 'fix')
box.inventory['apps']['smoke-app'] = {'kind': 'system-test', 'resources': ['postgres:database:company']}
c = d.c_system_test_apps(box)
assert not c.repair['safe'] and 'something else' in c.repair['description']
# A backup failure must prevent any destructive command.
box.inventory['apps']['smoke-app']['resources'] = []
with patch.object(d, 'backup_files', side_effect=OSError('fixture backup failure')), patch.object(d, 'run') as runner:
    result = d.apply_repair(box, d.c_system_test_apps(box))
    assert not result['ok'] and not runner.called
print('[ok] system-test cleanup, real apps retained, unsafe resources refused, backup failure prevents repair')

# Version mismatch is report-only even with --fix --yes, and commit stays public metadata.
box = d.Box(str(inst), str(checkout), 'fix')
box.state['installed_commit'] = 'a' * 40
box.commit = 'b' * 40
with patch.object(d, 'run', side_effect=[(0, box.commit, ''), (0, 'main', ''), (0, '', '')]):
    c = d.c_version(box)
assert c.name == 'version' and c.status == 'warn' and c.repair['id'] == 'apply-checkout' and not c.repair['safe']
with patch.object(d, 'apply_repair') as repair:
    d.fix_checks(box, [c], yes=True); assert not repair.called
r = d.report(box, [c], [], d.time.time())
assert r['commit'] == box.commit
for key in ['doctor_version', 'product', 'mode', 'commit', 'checkout', 'generated_at', 'install_dir', 'duration_seconds',
            'checks', 'summary', 'not_applicable', 'source', 'platform', 'portal_api', 'ingress', 'profiles']:
    assert key in r
assert r['doctor_version'] == 2 and r['product'] == 'ihc' and r['mode'] == 'fix'
assert set(r['summary']) == {'ok', 'warn', 'fail', 'fix_now', 'recommended', 'repaired'}
assert r['summary']['recommended'] == r['summary']['warn']
assert box.redact('token=' + 'Ab9/' * 10) == 'token=[redacted]'
# Settings in the install's .env stay readable; only secret-named keys are values to hide.
assert box.redact('runners company-runner, company-runner-deploy') == 'runners company-runner, company-runner-deploy'
assert box.redact('x fake-doctor-secret-value') == 'x [redacted]'
box.secret_values.add('fake-app-secret-value')
c.see('app returned fake-app-secret-value ghp_exampletoken123 eyJexampletoken123 ' + 'c' * 40)
r = d.report(box, [c], [], d.time.time())
assert 'fake-app-secret-value' not in json.dumps(r) and '[redacted]' in json.dumps(r)
# Lint does not invoke quick backup verification or write its locks/cache.
box.mode = 'lint'; box.env.update(BACKUP_DESTINATION=str(inst / 'backups'))
reports = inst / 'backups/reports'; reports.mkdir(parents=True)
(reports / 'latest-success.json').write_text(json.dumps({'finished_at': d.iso(d.now_utc())}))
box.containers[(box.project, 'backup')] = {'status': 'running'}
with patch.object(d, 'run', side_effect=AssertionError('lint invoked a backup command')):
    assert d.c_backup(box).status == 'ok'
for command in [None, [str(root / 'scripts/ihc-doctor.sh'), '--install-dir', str(inst)],
                [str(root / 'install.sh'), 'doctor', '--install-dir', str(inst)]]:
    assert cli('--fix', '--lint', command=command).returncode == 2
    if command:
        p = cli('--lint', '--json', command=command)
        assert json.loads(p.stdout)['mode'] == 'lint'
# Exercise the Docker-available lint path: portal transport and fetched manifests
# must not create the temporary files used by the older implementations.
with contextlib.ExitStack() as stack:
    for name in ['c_docker', 'c_version', 'c_containers', 'c_disk', 'c_memory', 'c_dns', 'c_login', 'c_gitea', 'c_runners', 'c_postgres', 'c_redis']:
        stack.enter_context(patch.object(d, name, side_effect=lambda b: d.Check('fixture').ok('healthy')))
    stack.enter_context(patch.object(d.Box, 'look'))
    stack.enter_context(patch.object(d, 'npm_hosts', return_value=([], '')))
    stack.enter_context(patch.object(d, 'run', return_value=(1, '', 'offline')))
    stack.enter_context(patch.object(d.tempfile, 'mkstemp', side_effect=AssertionError('lint created a temporary file')))
    with patch.dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH']):
        with (inst / '.env').open('a') as f: f.write('IHC_PORTAL_API_TOKEN="fake-portal-token-value"\n')
        b, checks, na, t0 = d.doctor(str(inst), str(checkout), 'lint')
        assert check(d.report(b, checks, na, t0), 'portal-api')['status'] == 'warn'
        assert b.reading['portal_api']['reason'] == d.portalapi.REASONS['000']
    manifest = (root / 'templates/app/company-app.yaml').read_text().replace('__APP_SLUG__', 'smoke-app').replace('__APP_NAME__', 'Smoke App').replace('__OWNER_EMAIL__', 'owner@example.com').replace('__APP_DOMAIN__', 'smoke-app.cloud.localhost').replace('__APP_GROUP__', 'ihc-users')
    stack.enter_context(patch.object(d.urllib.request, 'urlopen', return_value=io.BytesIO(manifest.encode())))
    stack.enter_context(patch.object(d.tempfile, 'NamedTemporaryFile', side_effect=AssertionError('lint wrote a fetched manifest')))
    runtime, source = d.app_runtime(b, 'smoke-app', {})
    assert source.startswith('company-app.yaml in '), 'fetched manifest was not parsed'
# Exercise the shortcut the installer actually writes, including conflict exit 2.
installer = (root / 'install.sh').read_text()
shortcut = 'write_shortcut() {' + installer.split('write_shortcut() {', 1)[1].split('\n}\n', 1)[0] + '\n}\n'
p = subprocess.run(['bash', '-c', shortcut + '\nINSTALL_DIR="$1"; IHC_ROOT="$2"; write_shortcut', 'test', str(inst), str(root)], capture_output=True)
assert p.returncode == 0
# Recording deployment metadata must follow an applied foundation, never a no-op.
run_stage = 'run_stage() {' + installer.split('run_stage() {', 1)[1].split('\n}\n', 1)[0] + '\n}\n'
stage_fixture = r'''
IHC_ROOT="$1"; RECORD="$2"; CONFIG_SHA=fixture; RESUME_PREFIX=unused
ok() { :; }; log() { :; }; step() { :; }; stage_foundation() { :; }
ST=completed
state() {
  case "$*" in
    'stage foundation status') printf '%s' "$ST" ;;
    'stage foundation get config_sha256') printf '"fixture"' ;;
    'set installed_commit '*) printf '%s' "$3" > "$RECORD" ;;
  esac
}
run_stage foundation
[ ! -e "$RECORD" ] || exit 1
ST=pending
run_stage foundation
[ -s "$RECORD" ]
'''
p = subprocess.run(['bash', '-c', run_stage + stage_fixture, 'test', str(root), str(work / 'recorded-commit')], capture_output=True)
assert p.returncode == 0, 'foundation commit recording advanced on a no-op or failed to record apply'
p = cli('--lint', '--json', command=[str(inst / 'ihc'), 'doctor'])
assert json.loads(p.stdout)['mode'] == 'lint'
assert cli('--fix', '--lint', command=[str(inst / 'ihc'), 'doctor']).returncode == 2
# JSON must not prompt even when stdin happens to be a terminal.
with patch.object(sys.stdin, 'isatty', return_value=True), patch.object(d, 'apply_repair') as repair, contextlib.redirect_stderr(io.StringIO()):
    assert d.fix_checks(box, [c], as_json=True) == {} and not repair.called
# A check that remains warning after a failed command stays unrepaired.
box.inventory['apps']['smoke-app'] = {'kind': 'system-test'}
c = d.c_system_test_apps(box)
c.repaired = {'ok': False, 'detail': 'fixture command failure', 'backup': None}
r = d.report(box, [c], [], d.time.time())
assert r['summary']['repaired'] == 0 and r['summary']['recommended'] == 1
assert 'fixture command failure' in d.text(r, False)
# Exit zero when all checks are healthy, including the missing-install JSON shape.
with patch.object(d, 'doctor', return_value=(box, [d.Check('fixture').ok('healthy')], [], d.time.time())), patch.object(sys, 'argv', ['doctor', str(inst), str(checkout), '--lint', '--json']), contextlib.redirect_stdout(io.StringIO()):
    try:
        d.main()
    except SystemExit as e:
        assert e.code == 0
missing = work / 'missing'
p = subprocess.run([sys.executable, '-B', str(root / 'scripts/lib/doctor.py'), str(missing), str(checkout), '--lint', '--json'], capture_output=True, text=True, env=env)
assert p.returncode == 1 and json.loads(p.stdout)['summary']['fix_now'] == 1
p = subprocess.run(['node', str(root / 'docker/agent/ihc-ro.mjs'), 'doctor', '--json', '--fix'], capture_output=True, text=True)
assert p.returncode != 0 and '--fix is refused' in p.stderr
print('[ok] JSON contract, commit comparison, unsafe update skipped, lint verification, flag forwarding and ihc-ro refusal')
print('doctor-fix: all cases pass')
PY
