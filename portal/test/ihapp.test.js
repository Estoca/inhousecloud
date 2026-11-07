import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { createIhappTools, IHAPP_TOOLS, PROVIDED_ENV } from '../src/ihapp-tools.js';
import { createIhappStore, TTL, candidateId } from '../src/ihapp-store.js';
import { createGatewayApp } from '../src/mcp-gateway.js';
import { inlineFiles, readTree, archiveFiles, validPath } from '../src/ihapp-files.js';
import { RULES, secretMatches, redactText, bounded, finding } from '../src/ihapp-rules.js';
import { validateInput } from '../src/ihapp-input.js';
import { gitEnvironment } from '../src/ihapp-git.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const contract = JSON.parse(readFileSync(path.join(root, 'schemas/chat-deploy.schema.json')));
const ajv = new Ajv2020({ strict: false, allErrors: true }); ajv.addSchema(contract);
const valid = (def, value) => { const check = ajv.getSchema(`${contract.$id}#/$defs/${def}`); assert.ok(check(value), `${def}: ${ajv.errorsText(check.errors)}\n${JSON.stringify(value)}`); };
const alice = { email: 'alice@example.com', username: 'alice', groups: ['ihc-users', 'ihc-admins'], admin: true, is_active: true };
const bob = { email: 'bob@example.com', username: 'bob', groups: ['ihc-users', 'ihc-admins'], is_active: true };
const slug = 'sample-app';
const entries = tree => [...tree].map(([p, b]) => ({ path: p, content: b.toString('base64'), encoding: 'base64' }));
const rawGit = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

// Exercise Express's real route stack without a TCP listener (sandbox may refuse bind).
async function request(app, method, url, { body, bytes, headers = {} } = {}) {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const req = new IncomingMessage(socket);
  req.complete = true;
  req._readableState.autoDestroy = false;
  Object.assign(req, { method, url, headers: { ...headers }, ...(body ? { body } : {}) });
  const res = new ServerResponse(req); res.assignSocket(socket);
  const done = once(res, 'finish');
  app.handle(req, res);
  if (bytes) req.push(bytes); req.push(null);
  await done; socket.destroy();
  const output = Buffer.concat(chunks), offset = output.indexOf('\r\n\r\n');
  const text = output.subarray(offset + 4).toString();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.statusCode, bytes: output.subarray(offset + 4), text, json, headers: res.getHeaders() };
}

function fixture(t, options = {}) {
  // All task working files live in one checkout-local folder and are cleaned up.
  const dir = mkdtempSync(path.join(root, '.ihapp-test-'));
  let clock = Date.now();
  const remote = path.join(dir, 'remote.git');
  mkdirSync(remote); rawGit(remote, 'init', '--bare', '--quiet');
  const env = { IHC_CHAT_GITEA_TOKEN: 'deploy-test-token', IHC_CHAT_DIR: path.join(dir, 'chat'), IHC_TEMPLATE_DIR: path.join(root, 'templates/app'), IHC_APPLINT: path.join(root, 'scripts/lib/applint.py'), GITEA_URL: 'http://gitea.test', GITEA_ORG: 'company', BASE_DOMAIN: 'cloud.localhost', MCP_PUBLIC_URL: 'https://mcp.example.com', ...options.env };
  const people = [{ ...alice, groups: [...alice.groups] }, { ...bob, groups: [...bob.groups] }];
  const auditRows = [], calls = [], permissions = new Map([['alice', 'write'], ['bob', 'write']]);
  let repoExists = false, runs = [], health = true;
  const head = () => { try { return rawGit(remote, 'rev-parse', 'refs/heads/main'); } catch { return null; } };
  const apiResponse = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function fakeFetch(url, init = {}) {
    assert.equal(init.headers.authorization || init.headers.Authorization, `token ${env.IHC_CHAT_GITEA_TOKEN}`);
    const u = new URL(url), route = u.pathname.replace('/api/v1', ''), method = init.method || 'GET';
    calls.push({ route, method, body: init.body ? JSON.parse(init.body) : null });
    if (route === '/orgs/company/repos' && method === 'POST') { repoExists = true; return apiResponse(201, { name: slug, empty: true }); }
    if (route === `/repos/company/${slug}`) {
      if (!repoExists) return apiResponse(404);
      return apiResponse(200, { name: slug, empty: !head() });
    }
    const permission = route.match(/\/collaborators\/([^/]+)\/permission$/);
    if (permission) return permissions.has(permission[1]) ? apiResponse(200, { permission: permissions.get(permission[1]) }) : apiResponse(404);
    if (route.endsWith('/actions/tasks')) return apiResponse(200, { workflow_runs: runs });
    if (route.includes('/git/commits/')) return apiResponse(200, { author: { login: 'ihc-chat' } });
    throw new Error(`Unexpected Gitea request ${method} ${route}`);
  }
  const directory = { configured: true, listUsers: async () => people };
  const audit = { configured: true, record: async row => { auditRows.push(structuredClone(row)); return { ok: true }; } };
  const service = createIhappTools({ env, directory, audit, now: () => clock, fetchFn: fakeFetch, remoteUrl: () => remote, lintTimeoutMs: options.lintTimeoutMs,
    listAppsFn: () => [{ slug, name: slug, url: `https://${slug}.cloud.localhost`, auth_required: true }],
    listHttpHealthFn: async () => ({ checked_at: new Date(clock).toISOString(), checks: [{ slug, checked: true, ok: health, sso_effective: health }] }) });
  const app = createGatewayApp({ signer: {}, verifier: { verify: async token => ({ ok: true, user: token === 'bob' ? bob : alice }) }, ihappTools: service, directory, audit, providerGateway: { listTools: async () => ({ tools: [] }) }, log: () => {} });
  const rpc = async (name, args, token = 'alice') => (await request(app, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${token}` } })).json.result;
  const call = (name, args, user = alice, context = {}) => service.call(user, name, args, context);
  async function template() { const s = await call('ihapp_spec', { include: ['template'], slug }); return new Map(s.template.files.map(e => [e.path, Buffer.from(e.content)])); }
  async function waitJob(job) {
    for (let i = 0; i < 200; i++) {
      const result = await call('ihapp_deploy_status', { job_id: job.job_id });
      if (!['queued', 'running'].includes(result.state)) { valid('DeployStatusOutput', result); await new Promise(r => setImmediate(r)); return result; }
      await new Promise(r => setTimeout(r, 20));
    }
    assert.fail('check did not finish');
  }
  async function check(tree, extra = {}) { const accepted = await call('ihapp_check', { slug, base_commit: null, tree: 'full', files: entries(tree), ...extra }); valid('JobAccepted', accepted); return waitJob(accepted); }
  async function seed(tree, base = null, state = 'passed') {
    const { store } = service.resources(), id = store.put(tree), job = store.create('check', slug, alice.email);
    Object.assign(job, { candidate_id: id, base_commit: base, state }); store.save(job);
    return { slug, candidate_id: id, base_commit: base, message: 'Update the app' };
  }
  async function base(tree) { repoExists = true; return service.resources().git.push(slug, null, tree, 'Initial fixture\n'); }
  t.after(async () => {
    for (let i = 0; service.configured && i < 200 && service.resources().store.jobs().some(j => j.kind === 'check' && ['queued', 'running'].includes(j.state)); i++) await new Promise(r => setTimeout(r, 20));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, service, people, audit, auditRows, permissions, calls, remote, head, app, rpc, call, template, waitJob, check, seed, base, fakeFetch,
    advance: ms => { clock += ms; }, setRuns: value => { runs = value; }, setHealth: value => { health = value; }, setRepo: value => { repoExists = value; } };
}

function run(commit, status, id = 1) { return { id, status, head_sha: commit, head_branch: 'main', event: 'push', created_at: '2026-11-07T10:00:00Z', url: `https://git.example.com/company/${slug}/actions/runs/${id}` }; }

test('ihapp listing is gated by deploy token and USER_GROUP, including direct calls', async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.toolsFor(alice).map(t => t.name), IHAPP_TOOLS.map(t => t.name));
  assert.equal(f.service.toolsFor({ ...alice, groups: ['ihc-admins'] }).length, 0);
  assert.equal(f.service.toolsFor(alice).find(t => t.name === 'ihapp_deploy').annotations.readOnlyHint, false);
  assert.equal(f.service.toolsFor(alice).find(t => t.name === 'ihapp_check').annotations.readOnlyHint, true);
  const off = createIhappTools({ env: {} });
  assert.deepEqual(off.toolsFor(alice), []);
  await assert.rejects(off.call(alice, 'ihapp_spec', {}), /configured deploy account/);
  const response = await request(f.app, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { authorization: 'Bearer alice' } });
  assert.equal(response.json.result.tools.filter(t => t.name.startsWith('ihapp_')).length, 4);
});

test('spec uses real template, manifest schema, variables, rules and v1 skipped stages', async t => {
  const f = fixture(t), spec = await f.call('ihapp_spec', { slug, include: ['template', 'upload'] });
  valid('AppSpecOutput', spec);
  assert.equal(spec.app.exists, false);
  assert.ok(spec.template.files.some(f => f.path === '.gitea/workflows/deploy.yml'));
  assert.ok(spec.template.files.every(f => !/__APP_|__OWNER_EMAIL__/.test(f.content)));
  assert.equal(YAML.parse(spec.manifest.example).app.slug, slug);
  assert.ok(readFileSync(path.join(root, 'templates/app/Dockerfile'), 'utf8').includes(`FROM ${spec.stack.starters[0].image}`));
  assert.deepEqual(spec.manifest.schema, JSON.parse(readFileSync(path.join(root, 'schemas/company-app.schema.json'))));
  assert.deepEqual(spec.rules.map(r => r.code), RULES.map(r => r[0]));
  assert.equal(spec.check_stage_states.filter(s => s.state === 'skipped').length, 5);
  assert.ok(spec.check_stage_states.filter(s => s.state === 'skipped').every(s => s.reason.includes('LAB-170')));
  const doc = readFileSync(path.join(root, 'docs/app-contract.md'), 'utf8');
  for (const v of PROVIDED_ENV) assert.ok(doc.includes('`' + v.name + '`'), v.name);
  const codes = readFileSync(path.join(root, 'docs/chat-deploy-contract.md'), 'utf8');
  for (const r of RULES) assert.ok(codes.includes('`' + r[0] + '`'), r[0]);
});

test('input validation rejects malformed shapes and unsupported catalog input', async t => {
  const f = fixture(t);
  for (const args of [{ start_from: 'catalog-app' }, { include: ['nope'] }, { include: ['upload', 'upload'] }, { extra: true }, { slug: 'ab' }]) await assert.rejects(f.call('ihapp_spec', args));
  for (const args of [{ slug, base_commit: null, tree: 'changes', files: [] }, { slug, base_commit: null, tree: 'full', files: [], delete: [] }, { slug, base_commit: null, tree: 'full', files: [], upload_id: 'up_12345678' }]) assert.throws(() => validateInput('ihapp_check', args));
  assert.throws(() => validateInput('ihapp_deploy_status', { job_id: 'job_12345678', slug }));
  assert.throws(() => validateInput('ihapp_spec', JSON.parse('{"constructor":{}}')));
});

test('real Python static check passes starter and never executes candidate scripts', async t => {
  const f = fixture(t), tree = await f.template();
  tree.set('run-me.js', Buffer.from('throw new Error("candidate must not execute");'));
  const result = await f.check(tree);
  assert.equal(result.state, 'passed', JSON.stringify(result.findings));
  assert.equal(result.stages.filter(s => s.state === 'passed').length, 3);
  assert.equal(result.stages.filter(s => s.state === 'skipped').length, 5);
  assert.equal(f.auditRows.filter(r => r.status === 'check').length, 2);
  assert.ok(f.auditRows.every(r => !Object.hasOwn(r.arguments, 'files')));
});

test('manifest errors and slug mismatch have stable codes and YAML lines', async t => {
  const f = fixture(t), tree = await f.template();
  tree.set('company-app.yaml', Buffer.from(tree.get('company-app.yaml').toString().replace('schema_version: 1', 'schema_version: 2').replace(`slug: ${slug}`, 'slug: wrong-app')));
  const result = await f.check(tree);
  assert.equal(result.state, 'failed');
  assert.ok(result.findings.some(f => f.code === 'IHC-MANIFEST-INVALID' && f.line === 3));
  assert.ok(result.findings.some(f => f.code === 'IHC-MANIFEST-SLUG' && f.line === 6));
});

test('malformed YAML fails manifest, never an accidental pass', async t => {
  const f = fixture(t), tree = await f.template(); tree.set('company-app.yaml', Buffer.from('app: [\n'));
  const result = await f.check(tree);
  assert.equal(result.state, 'failed'); assert.ok(result.findings.some(f => f.code === 'IHC-MANIFEST-INVALID'));
});

test('lint maps real trust-boundary violations and path:line prefixes', async t => {
  const f = fixture(t), tree = await f.template();
  tree.set('docker-compose.yml', Buffer.from('services:\n  app:\n    image: node:20-alpine\n    cap_add: [SYS_ADMIN]\n    pid: host\n    volumes: ["/etc:/host"]\n'));
  tree.set('bad.sh', Buffer.from('#!/bin/sh\nsudo systemctl restart evil\n'));
  const result = await f.check(tree), codes = result.findings.map(f => f.code);
  for (const code of ['IHC-LINT-PRIVILEGES', 'IHC-LINT-HOST-NETWORK', 'IHC-LINT-HOST-MOUNT', 'IHC-LINT-LIFECYCLE-HOOKS']) assert.ok(codes.includes(code), JSON.stringify(result.findings));
  assert.ok(result.findings.some(f => f.file === 'bad.sh' && f.line === 2));
});

for (const mode of ['unknown', 'crash', 'timeout']) test(`linter ${mode} fails with a clear stable code`, async t => {
  const f = fixture(t, { lintTimeoutMs: mode === 'timeout' ? 30 : 1000 });
  const lint = path.join(f.dir, 'lint.py');
  writeFileSync(lint, mode === 'timeout' ? 'import time\ntime.sleep(3)\n' : mode === 'crash' ? 'raise RuntimeError("broken")\n' : 'print("mystery.py:7: unexpected diagnostic")\nraise SystemExit(1)\n');
  f.service.resources();
  // Config is immutable inside the service; build a fixture with an alternate trusted linter.
  const alt = createIhappTools({ env: { ...f.env, IHC_CHAT_DIR: path.join(f.dir, 'alternate'), IHC_APPLINT: lint }, directory: { listUsers: async () => f.people }, lintTimeoutMs: mode === 'timeout' ? 30 : 1000 });
  const job = await alt.call(alice, 'ihapp_check', { slug, base_commit: null, tree: 'full', files: entries(await f.template()) });
  let result;
  for (let i = 0; i < 100; i++) { result = await alt.call(alice, 'ihapp_deploy_status', { job_id: job.job_id }); if (result.state === 'failed') break; await new Promise(r => setTimeout(r, 10)); }
  assert.equal(result.state, 'failed'); assert.ok(result.findings.some(f => f.code === (mode === 'unknown' ? 'IHC-LINT-OTHER' : 'IHC-LINT-FAILED')));
});

test('secrets shapes, assignments, example exception and redaction are deterministic', async t => {
  const f = fixture(t), tree = await f.template(), token = 'ghp_' + 'a'.repeat(36), password = 'SuperPrivateLiteral987654321';
  tree.set('creds.js', Buffer.from(`const token = "${token}";\nconst password = "${password}";\n`));
  const result = await f.check(tree);
  assert.equal(result.state, 'failed');
  const findings = result.findings.filter(f => f.code === 'IHC-SECRETS-IN-TREE');
  assert.ok(findings.some(f => f.line === 1)); assert.ok(findings.some(f => f.line === 2));
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(f.auditRows).includes(token)); assert.ok(!JSON.stringify(f.auditRows).includes(password));
  for (const value of ['AKIA' + 'A'.repeat(16), 'sk-ant-' + 'z'.repeat(30), 'sk-proj-' + 'z'.repeat(30), 'xoxb-' + 'a'.repeat(25), 'gitea_' + 'b'.repeat(30), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----']) assert.ok(secretMatches(value).length, value);
  assert.equal(secretMatches(`password=${password}`, { example: true }).length, 0);
  assert.equal(redactText(`password=${password}`), 'password=[redacted]');
  tree.set('another.js', Buffer.from(`const password = "${password}";`));
  const forward = await f.check(tree);
  const reverse = await f.check(new Map([...tree].reverse()));
  assert.equal(forward.candidate_id, reverse.candidate_id);
  assert.deepEqual(forward.findings, reverse.findings);
});

for (const p of ['../bad', '/absolute', 'a/../b', '.git/config', 'a/.git/config', 'a\\b', 'a\0b', 'C:/file', 'a//b', './bad']) test(`unsafe path ${JSON.stringify(p)} is refused`, () => {
  assert.equal(validPath(p), false); assert.throws(() => inlineFiles([{ path: p, content: 'x' }]), e => e.code === 'IHC-FILES-PATH');
});
for (const p of ['.env', '.env.production', 'dir/.env.local']) test(`environment file ${p} is refused before materialization`, async t => {
  const f = fixture(t), result = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', files: [{ path: p, content: 'secret' }] });
  valid('JobAccepted', result); assert.equal(result.state, 'refused'); assert.equal(result.findings[0].code, 'IHC-FILES-ENV');
  assert.equal(readdirSync(path.join(f.env.IHC_CHAT_DIR, 'candidates')).length, 0);
});

test('file count, bytes, base64 and conflicting paths obey limits', () => {
  for (const files of [[{ path: 'large', content: 'x'.repeat(262145) }], Array.from({ length: 301 }, (_, i) => ({ path: `f${i}`, content: '' })), Array.from({ length: 3 }, (_, i) => ({ path: `f${i}`, content: 'x'.repeat(200000) }))]) assert.throws(() => inlineFiles(files), e => e.code === 'IHC-FILES-LIMIT');
  assert.throws(() => inlineFiles([{ path: 'a', content: '?' , encoding: 'base64' }]), /base64/);
  assert.throws(() => inlineFiles([{ path: 'a', content: '' }, { path: 'a', content: '' }]), /Duplicate/);
  assert.throws(() => inlineFiles([{ path: 'a', content: '' }, { path: 'a/b', content: '' }]), /directory/);
  assert.equal(inlineFiles([{ path: '.env.example', content: '' }]).size, 1);
  assert.equal(inlineFiles([{ path: 'bin', content: Buffer.from([0, 255, 10]).toString('base64'), encoding: 'base64' }]).get('bin')[1], 255);
});

test('changes materialize the exact base and apply replacements and delete', async t => {
  const f = fixture(t), tree = await f.template(); tree.set('remove.txt', Buffer.from('old'));
  const base = await f.base(tree);
  const result = await f.check(new Map([['new.txt', Buffer.from('new')]]), { base_commit: base, tree: 'changes', delete: ['remove.txt'] });
  assert.equal(result.state, 'passed', JSON.stringify(result.findings));
  const stored = readTree(f.service.resources().store.treePath(result.candidate_id));
  assert.equal(stored.has('remove.txt'), false); assert.equal(stored.get('new.txt').toString(), 'new'); assert.ok(stored.has('company-app.yaml'));
});

test('source spec lists exact head and signed GET serves the captured tree then expires', async t => {
  const f = fixture(t), tree = await f.template(), base = await f.base(tree);
  const spec = await f.call('ihapp_spec', { slug, include: ['source'] }); valid('AppSpecOutput', spec);
  assert.equal(spec.app.head_commit, base); assert.equal(spec.app.files.length, tree.size);
  const url = new URL(spec.app.source.url).pathname, response = await request(f.app, 'GET', url);
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
  const archive = path.join(f.dir, 'source.tar.gz'); writeFileSync(archive, response.bytes);
  const received = await archiveFiles(archive);
  assert.deepEqual([...received.keys()].sort(), [...tree.keys()].sort());
  for (const [p, bytes] of tree) assert.deepEqual(received.get(p), bytes, p);
  assert.equal(candidateId(received), candidateId(tree));
  f.advance(300001); assert.equal((await request(f.app, 'GET', url)).status, 410);
});

test('signed upload PUT round trip, single use, tampering, owner and expiry', async t => {
  const f = fixture(t), tree = await f.template(), temp = path.join(f.dir, 'upload-tree'); mkdirSync(temp);
  for (const [p, b] of tree) { const file = path.join(temp, p); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, b); }
  const archive = path.join(f.dir, 'upload.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', temp, '.'], { env: { PATH: process.env.PATH, COPYFILE_DISABLE: '1' } });
  const spec = await f.call('ihapp_spec', { include: ['upload'] }), url = new URL(spec.upload.url).pathname;
  const upload = await request(f.app, 'PUT', url, { bytes: readFileSync(archive) });
  assert.equal(upload.status, 201, upload.text);
  assert.equal((await request(f.app, 'PUT', url, { bytes: readFileSync(archive) })).status, 410);
  assert.equal((await request(f.app, 'PUT', url + 'x')).status, 410);
  const checked = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', upload_id: spec.upload.upload_id });
  assert.equal((await f.waitJob(checked)).state, 'passed');
  const foreign = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', upload_id: spec.upload.upload_id }, bob);
  assert.equal(foreign.state, 'refused');
  const later = await f.call('ihapp_spec', { include: ['upload'] }); f.advance(900001);
  assert.equal((await request(f.app, 'PUT', new URL(later.upload.url).pathname)).status, 410);
});

for (const type of ['symlink', 'traversal', 'env', 'large']) test(`archive ${type} is refused before unpacking`, async t => {
  const f = fixture(t), archive = path.join(f.dir, 'bad.tar.gz');
  execFileSync('python3', ['-c', `import tarfile,io,sys\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n m=tarfile.TarInfo(${type === 'traversal' ? "'../escape'" : type === 'env' ? "'.env.production'" : "'file'"})\n ${type === 'symlink' ? "m.type=tarfile.SYMTYPE; m.linkname='/etc/passwd'; t.addfile(m)" : `m.size=${type === 'large' ? '262145' : '1'}; t.addfile(m,io.BytesIO(b'x'*m.size))`}\n`, archive]);
  const link = (await f.call('ihapp_spec', { include: ['upload'] })).upload;
  const response = await request(f.app, 'PUT', new URL(link.url).pathname, { bytes: readFileSync(archive) });
  assert.equal(response.status, type === 'large' ? 413 : 400);
  assert.equal(response.json.error, type === 'symlink' ? 'IHC-FILES-ARCHIVE' : type === 'traversal' ? 'IHC-FILES-PATH' : type === 'env' ? 'IHC-FILES-ENV' : 'IHC-FILES-LIMIT');
  assert.equal(existsSync(path.join(f.dir, 'escape')), false);
});

test('gateway deploy reuses confirmer and requested/completed audit, creates private repo and workflow', async t => {
  const f = fixture(t), tree = await f.template(); tree.delete('.gitea/workflows/deploy.yml');
  const input = await f.seed(tree);
  const missing = await f.rpc('ihapp_deploy', input); assert.equal(missing.isError, true); assert.equal(f.head(), null);
  const response = await f.rpc('ihapp_deploy', { ...input, confirmed_by: 'bob' });
  assert.equal(response.isError, false, JSON.stringify(response)); const result = response.structuredContent; valid('JobAccepted', result);
  assert.equal(f.head(), result.commit);
  const create = f.calls.find(c => c.method === 'POST'); assert.deepEqual(create.body, { name: slug, private: true, auto_init: false, default_branch: 'main' });
  assert.ok(f.calls.some(c => c.method === 'PATCH' && c.body.has_actions));
  const message = rawGit(f.remote, 'log', 'main', '-1', '--format=%B');
  for (const trailer of [`Requested-by: ${alice.email}`, `Confirmed-by: ${bob.email}`, `Candidate: ${input.candidate_id}`]) assert.ok(message.includes(trailer));
  assert.ok(rawGit(f.remote, 'show', 'main:.gitea/workflows/deploy.yml').includes(`APP_SLUG: ${slug}`));
  const rows = f.auditRows.filter(r => r.phase !== 'refused'); assert.deepEqual(rows.map(r => r.phase), ['requested', 'completed']);
  assert.equal(rows[1].previousValue, null); assert.equal(rows[1].newValue, result.commit);
  assert.ok(rows.every(row => row.provider === slug));
  const status = await f.call('ihapp_deploy_status', { job_id: result.job_id }); valid('DeployStatusOutput', status); assert.equal(status.added_workflow, '.gitea/workflows/deploy.yml');
});

for (const reason of ['unknown', 'failed', 'expired', 'base', 'slug']) test(`deploy refuses ${reason} candidate without changing main`, async t => {
  const f = fixture(t), tree = await f.template(), input = await f.seed(tree);
  if (reason === 'unknown') input.candidate_id = 'sha256:' + '0'.repeat(64);
  if (reason === 'failed') { const job = f.service.resources().store.jobs()[0]; job.state = 'failed'; f.service.resources().store.save(job); }
  if (reason === 'expired') f.advance(TTL + 1);
  if (reason === 'base') input.base_commit = 'a'.repeat(40);
  if (reason === 'slug') input.slug = 'another-app';
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  assert.equal(result.state, 'refused'); assert.equal(result.findings[0].code, 'IHC-DEPLOY-CANDIDATE-EXPIRED'); assert.equal(f.head(), null);
});

for (const who of ['caller', 'approver']) for (const kind of ['new-group', 'push-permission', 'no-account']) test(`deploy denies ${who} without ${kind}`, async t => {
  const f = fixture(t), tree = await f.template();
  const base = kind === 'new-group' ? null : await f.base(tree), input = await f.seed(tree, base);
  const person = who === 'caller' ? f.people[0] : f.people[1];
  if (kind === 'new-group') person.groups = ['ihc-users']; else if (kind === 'no-account') f.permissions.delete(person.username); else f.permissions.set(person.username, 'read');
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  assert.equal(result.state, 'refused'); assert.equal(result.findings[0].code, 'IHC-DEPLOY-NOT-ALLOWED'); assert.equal(f.head(), base);
});

test('existing app deploy continues base; stale base never overwrites a concurrent push', async t => {
  const f = fixture(t), tree = await f.template(), base = await f.base(tree);
  tree.set('change.txt', Buffer.from('checked')); const input = await f.seed(tree, base);
  const concurrentTree = new Map(tree); concurrentTree.set('change.txt', Buffer.from('someone else'));
  const concurrent = await f.service.resources().git.push(slug, base, concurrentTree, 'Concurrent push\n');
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  assert.equal(result.findings[0].code, 'IHC-DEPLOY-STALE-BASE'); assert.equal(f.head(), concurrent);
  // Exercise the actual non-fast-forward race primitive, independently of the early head probe.
  await assert.rejects(f.service.resources().git.push(slug, base, tree, 'Late push\n'), e => e.code === 'IHC-DEPLOY-STALE-BASE');
  assert.equal(f.head(), concurrent);
});

test('an existing deployment commit has the checked base as parent', async t => {
  const f = fixture(t), tree = await f.template(), base = await f.base(tree);
  tree.set('feature.txt', Buffer.from('added')); const input = await f.seed(tree, base);
  const { result, audit } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  assert.equal(rawGit(f.remote, 'rev-parse', 'main^'), base); assert.equal(audit.previous, base); assert.equal(audit.new, result.commit);
  assert.equal(rawGit(f.remote, 'show', 'main:feature.txt'), 'added');
});

for (const state of ['queued', 'running', 'failed', 'healthy', 'unhealthy', 'superseded']) test(`Actions and app health map to ${state}`, async t => {
  const f = fixture(t), tree = await f.template(), base = await f.base(tree);
  tree.set('update.txt', Buffer.from('updated')); const input = await f.seed(tree, base);
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  if (state === 'superseded') { tree.set('later.txt', Buffer.from('later')); await f.service.resources().git.push(slug, result.commit, tree, 'Newer\n'); }
  else if (state !== 'queued') f.setRuns([run(result.commit, ['healthy', 'unhealthy'].includes(state) ? 'success' : state === 'failed' ? 'failure' : 'running')]);
  if (state === 'unhealthy') f.setHealth(false);
  const status = await f.call('ihapp_deploy_status', { job_id: result.job_id }); valid('DeployStatusOutput', status);
  assert.equal(status.state, state, JSON.stringify(status)); assert.ok(status.summary); assert.ok(status.poll_after_seconds);
  if (state === 'failed') { assert.equal(status.findings[0].code, 'IHC-BUILD-FAILED'); assert.ok(status.run_log); assert.ok(!status.findings[0].log_excerpt); }
  if (state === 'unhealthy') { assert.equal(status.rollback_available, true); assert.equal(status.findings[0].code, 'IHC-HEALTH-STATUS'); }
  if (state === 'healthy') assert.equal(status.url, `https://${slug}.cloud.localhost`);
});

test('a successful run wins over a newer unsuccessful run of the same commit', async t => {
  const f = fixture(t), tree = await f.template(), input = await f.seed(tree);
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  f.setRuns([run(result.commit, 'failure', 2), run(result.commit, 'success', 1)]);
  assert.equal((await f.call('ihapp_deploy_status', { job_id: result.job_id })).state, 'healthy');
});

test('status by slug and ID is private to the submitting person', async t => {
  const f = fixture(t), result = await f.check(await f.template());
  assert.equal((await f.call('ihapp_deploy_status', { slug })).job_id, result.job_id);
  await assert.rejects(f.call('ihapp_deploy_status', { slug }, bob), /visible/);
  await assert.rejects(f.call('ihapp_deploy_status', { job_id: result.job_id }, bob), /visible/);
});

test('one running check per person and a persistent hourly allowance', async t => {
  const f = fixture(t, { env: { IHC_CHAT_CHECKS_PER_HOUR: '1' } }), tree = await f.template();
  const first = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', files: entries(tree) });
  const second = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', files: entries(tree) });
  assert.equal(second.state, 'refused'); assert.equal(second.findings[0].code, 'IHC-CHECK-LIMIT');
  await f.waitJob(first);
  const third = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', files: entries(tree) });
  assert.equal(third.state, 'refused'); assert.ok(third.findings[0].message.includes('hourly'));
  f.advance(3600001);
  assert.equal((await f.check(tree)).state, 'passed');
});

test('candidate hash is canonical; pruning retains pending deploys then removes expired data', async t => {
  const f = fixture(t), { store } = f.service.resources(), tree = new Map([['a', Buffer.from('one')], ['b', Buffer.from('two')]]);
  const id = store.put(tree); assert.equal(store.put(new Map([...tree].reverse())), id);
  assert.notEqual(candidateId(new Map([['a', Buffer.from('onetwo')]])), id);
  const job = store.create('deploy', slug, alice.email); job.candidate_id = id; store.save(job);
  f.advance(TTL + 1); store.prune(); assert.ok(existsSync(store.treePath(id))); assert.ok(store.get(job.job_id));
  job.state = 'failed'; store.save(job); store.prune(); assert.equal(existsSync(store.treePath(id)), false); assert.equal(store.get(job.job_id), null);
  assert.deepEqual(readdirSync(path.join(store.dir, 'work')), []);
});

test('restart turns an interrupted static check into a failure instead of a permanent lock', async t => {
  const f = fixture(t), { store } = f.service.resources(), job = store.create('check', slug, alice.email);
  const reopened = createIhappStore({ dir: store.dir });
  assert.equal(reopened.get(job.job_id).state, 'failed'); assert.equal(reopened.get(job.job_id).findings[0].code, 'IHC-LINT-FAILED');
});

test('findings are bounded, errors first and messages redacted before truncation', () => {
  const warnings = Array.from({ length: 5 }, () => finding('IHC-LINT-OTHER', 'warning', { severity: 'warning' }));
  const errors = Array.from({ length: 60 }, () => finding('IHC-LINT-OTHER', 'x'.repeat(700)));
  const result = bounded([...warnings, ...errors]); assert.equal(result.findings.length, 50); assert.equal(result.findings_truncated, true);
  assert.ok(result.findings.every(f => f.severity === 'error' && f.message.length === 500));
});

test('git credentials are confined to environment configuration and helpers are disabled', () => {
  const env = gitEnvironment({ token: 'private-value', gitUser: 'ihc-chat', baseDomain: 'example.com' });
  assert.equal(env.GIT_CONFIG_VALUE_0, ''); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.extraheader'); assert.ok(env.GIT_CONFIG_VALUE_1.startsWith('Authorization: Basic '));
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.GIT_CONFIG_VALUE_2, '/dev/null');
});

test('the local write path stops before Gitea when the requested audit insert fails', async t => {
  const f = fixture(t), input = await f.seed(await f.template());
  const before = f.calls.length;
  f.audit.record = async () => ({ ok: false, error: 'database unavailable' });
  const result = await f.rpc('ihapp_deploy', { ...input, confirmed_by: bob.email });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /audit log/);
  assert.equal(f.calls.length, before); assert.equal(f.head(), null);
});

test('refused checks are audited without their file contents or credentials', async t => {
  const f = fixture(t), credential = 'sk-proj-' + 'p'.repeat(30);
  const result = await f.call('ihapp_check', { slug, base_commit: null, tree: 'full', files: [{ path: '.env', content: credential }] });
  assert.equal(result.state, 'refused'); assert.equal(f.auditRows.length, 2);
  assert.ok(f.auditRows.every(r => r.status === 'check'));
  assert.ok(!JSON.stringify(f.auditRows).includes(credential));
});

test('malformed deploy arguments cannot smuggle file contents into the audit', async t => {
  const f = fixture(t), input = await f.seed(await f.template()), credential = 'AKIA' + 'X'.repeat(16);
  const result = await f.rpc('ihapp_deploy', { ...input, confirmed_by: bob.email, files: [{ path: 'secret', content: credential }] });
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(f.auditRows).includes(credential));
  assert.ok(f.auditRows.every(row => !Object.hasOwn(row.arguments, 'files'))); assert.equal(f.head(), null);
});

test('latest slug lookup is deterministic when jobs share a timestamp', async t => {
  const f = fixture(t), input = await f.seed(await f.template());
  const { result } = await f.call('ihapp_deploy', input, alice, { confirmedBy: bob.email });
  assert.equal((await f.call('ihapp_deploy_status', { slug })).job_id, result.job_id);
});

test('upload rejects a declared body larger than 25 MB and consumes the link', async t => {
  const f = fixture(t), link = (await f.call('ihapp_spec', { include: ['upload'] })).upload;
  const url = new URL(link.url).pathname;
  const result = await request(f.app, 'PUT', url, { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } });
  assert.equal(result.status, 413); assert.equal(result.json.error, 'IHC-FILES-LIMIT');
  assert.equal((await request(f.app, 'PUT', url)).status, 410);
});

test('assignment scanning covers quoted punctuation and skips environment expressions', () => {
  const password = 'many characters ! @ # $ % 1234567890';
  assert.ok(secretMatches(`password = "${password}"`).length);
  assert.equal(redactText(`password = "${password}"`), 'password = "[redacted]"');
  assert.equal(secretMatches('secretKey: process.env.S3_SECRET_ACCESS_KEY').length, 0);
  assert.equal(secretMatches('token: "${MY_TOKEN_FROM_ENV}"').length, 0);
});

test('fresh checks retain an older identical candidate until the fresh check expires', async t => {
  const f = fixture(t), tree = await f.template(), input = await f.seed(tree);
  f.advance(TTL - 1000); await f.seed(tree); f.advance(2000);
  f.service.resources().store.prune();
  assert.ok(existsSync(f.service.resources().store.treePath(input.candidate_id)));
  f.advance(TTL); f.service.resources().store.prune();
  assert.equal(existsSync(f.service.resources().store.treePath(input.candidate_id)), false);
});

test('HTTP integration with a local fake Gitea (skips only if sandbox refuses listen)', async t => {
  const f = fixture(t);
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await f.fakeFetch(`http://gitea.test${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
      res.statusCode = response.status; res.setHeader('content-type', 'application/json'); res.end(await response.text());
    } catch { res.statusCode = 500; res.end('{}'); }
  });
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  catch (e) { if (e.code === 'EPERM') { t.skip('sandbox forbids loopback listeners'); return; } throw e; }
  t.after(() => new Promise(resolve => server.close(resolve)));
  const service = createIhappTools({ env: { ...f.env, GITEA_URL: `http://127.0.0.1:${server.address().port}`, IHC_CHAT_DIR: path.join(f.dir, 'http-chat') },
    directory: { listUsers: async () => f.people }, remoteUrl: () => f.remote,
    listAppsFn: () => [{ slug, name: slug, url: 'https://sample-app.example.com' }],
    listHttpHealthFn: async () => ({ checks: [{ slug, checked: true, ok: true, sso_effective: true }] }) });
  const spec = await service.call(alice, 'ihapp_spec', { slug, include: ['template'] });
  assert.equal(spec.app.exists, false);
  const check = await service.call(alice, 'ihapp_check', { slug, base_commit: null, tree: 'full', files: spec.template.files });
  let checked;
  for (let i = 0; i < 200; i++) { checked = await service.call(alice, 'ihapp_deploy_status', { job_id: check.job_id }); if (checked.state === 'passed') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(checked.state, 'passed');
  const { result } = await service.call(alice, 'ihapp_deploy', { slug, base_commit: null, candidate_id: check.candidate_id, message: 'Deploy through HTTP' }, { confirmedBy: bob.email });
  assert.equal(result.commit, f.head()); f.setRuns([run(result.commit, 'success')]);
  assert.equal((await service.call(alice, 'ihapp_deploy_status', { job_id: result.job_id })).state, 'healthy');
  // Existing-app permission probes also travel over HTTP, with the directory username.
  const { store } = service.resources(), job = store.create('check', slug, alice.email);
  Object.assign(job, { candidate_id: check.candidate_id, base_commit: result.commit, state: 'passed' }); store.save(job);
  const updated = await service.call(alice, 'ihapp_deploy', { slug, base_commit: result.commit, candidate_id: check.candidate_id, message: 'Update through HTTP' }, { confirmedBy: bob.email });
  assert.ok(updated.result.commit);
  assert.ok(f.calls.some(c => c.route.endsWith('/collaborators/alice/permission')));
  assert.ok(f.calls.some(c => c.route.endsWith('/collaborators/bob/permission')));
});

test('chat deploy commits scripts as executable and everything else as regular files', async () => {
  const { fileMode } = await import('../src/ihapp-git.js');
  assert.equal(fileMode(Buffer.from('#!/bin/sh\nexec node server.js\n')), '100755');
  assert.equal(fileMode(Buffer.from('const a = 1;\n')), '100644');
  assert.equal(fileMode(Buffer.from('#')), '100644');
  assert.equal(fileMode(Buffer.alloc(0)), '100644');
});
