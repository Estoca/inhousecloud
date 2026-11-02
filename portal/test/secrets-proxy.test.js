import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { readProxyConfig, createSecretsProxy } from '../src/secrets-proxy.js';
import { policyErrors, allowedPrefix } from '../src/secrets-policy.js';

const token = 'a'.repeat(64), otherToken = 'b'.repeat(64), secret = 'external-super-secret';
const policy = { github: { methods: ['GET'], path_prefixes: ['/repos/acme'] } };
const caller = { app: 'demo', token_hash: crypto.createHash('sha256').update(token).digest('hex'), policy };
const state = { credentials: { github: secret }, callers: [caller] };
function harness(fetchFn = async () => Response.json({ ok: true }), options = {}) {
  const logs = [], calls = [];
  const handler = createSecretsProxy({ config: () => state,
    audit: line => logs.push(line), fetchFn: async (...args) => { calls.push(args); return fetchFn(...args); }, ...options });
  async function request(url = '/github/repos/acme/demo', { method = 'GET', auth = token, body = '', headers = {} } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { url, method, complete: true, headers: { authorization: `Bearer ${auth}`, ...headers } });
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, destroyed: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
      end(body) { this.body = body?.toString() ?? ''; } });
    await handler(req, res);
    return res;
  }
  return { request, logs, calls };
}

test('policy is explicit and segment bounded', () => {
  assert.deepEqual(policyErrors(policy), []);
  for (const invalid of [null, [], { unknown: [] }, { github: [{}] }, { github: [{ methods: ['TRACE'], path_prefix: '/' }] },
    { github: [{ methods: ['GET'], path_prefix: '/repos/../admin' }] }]) assert.ok(policyErrors(invalid).length);
  assert.equal(allowedPrefix(policy, 'github', 'GET', '/repos/acme/demo'), '/repos/acme');
  for (const path of ['/repos/acme-other', '/repos/other']) assert.equal(allowedPrefix(policy, 'github', 'GET', path), null);
});

test('allow GET, deny methods, prefixes, unknown service and mismatched tokens before forwarding', async () => {
  const h = harness();
  assert.equal((await h.request()).statusCode, 200);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']) {
    assert.equal((await h.request(undefined, { method })).statusCode, 403);
  }
  assert.equal((await h.request('/github/repos/acme-other')).statusCode, 403);
  assert.equal((await h.request('/slack/chat.postMessage')).statusCode, 403);
  assert.equal((await h.request('/unknown/path')).statusCode, 404);
  assert.equal((await h.request(undefined, { auth: otherToken })).statusCode, 401);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'https://api.github.com/repos/acme/demo');
  assert.equal(h.calls[0][1].headers.Authorization, `Bearer ${secret}`);
  assert.equal(h.calls[0][1].redirect, 'manual');
});

test('malformed paths cannot bypass grants or select hosts', async () => {
  const h = harness();
  for (const path of ['/github//evil.test', '/github/repos/acme/../admin', '/github/repos/acme/%2e%2e/admin',
    '/github/repos/acme/%252fadmin', '/github/repos/acme/demo\n', '/github/repos/acme\\admin', 'https://evil.test/github/repos/acme']) {
    assert.equal((await h.request(path)).statusCode, 400, path);
  }
  assert.equal(h.calls.length, 0);
});

test('credentials and caller token never appear in responses or audit; unsafe response headers stripped', async () => {
  for (const value of [secret, token, Buffer.from(secret).toString('base64')]) {
    const h = harness(async () => Response.json({ echo: value }));
    const res = await h.request('/github/repos/acme/demo?secret=do-not-log');
    assert.equal(res.statusCode, 502);
    assert.ok(!res.body.includes(value));
    assert.ok(!h.logs.join('').includes(value));
    assert.ok(!h.logs.join('').includes('do-not-log'));
    assert.deepEqual(JSON.parse(h.logs[0]), { app: 'demo', service: 'github', method: 'GET', path_prefix: '/repos/acme', status: 502 });
  }
  const h = harness(async () => new Response('{}', { headers: { authorization: secret, 'set-cookie': secret, location: secret, 'x-api-key': secret } }));
  const res = await h.request(undefined, { headers: { cookie: 'private-cookie', 'x-api-key': token } });
  assert.deepEqual(Object.keys(res.headers).sort(), ['Cache-Control', 'Content-Type', 'X-Content-Type-Options']);
  assert.ok(!JSON.stringify(h.calls[0][1]).includes('private-cookie'));
  assert.ok(!JSON.stringify(h.calls[0][1]).includes(token));
});

test('upstream failures, redirects, timeout and limits map to bounded generic responses', async () => {
  for (const [status, expected] of [[401, 502], [429, 429], [500, 502], [302, 502]]) {
    const h = harness(async () => new Response('sensitive failure', { status, headers: { location: 'https://evil.test' } }));
    const res = await h.request();
    assert.equal(res.statusCode, expected);
    assert.ok(!res.body.includes('sensitive failure'));
    assert.equal(h.calls.length, 1);
  }
  assert.equal((await harness(async () => { throw new Error(secret); }).request()).statusCode, 502);
  assert.equal((await harness(async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(secret)))), { timeoutMs: 5 }).request()).statusCode, 504);
  assert.equal((await harness(async () => new Response('x'.repeat(100)), { maxBytes: 10 }).request()).statusCode, 502);
  const h = harness(undefined, { maxBytes: 10 });
  assert.equal((await h.request(undefined, { body: 'x'.repeat(11) })).statusCode, 413);
  assert.equal(h.calls.length, 0);
});

test('fake HTTP upstream end to end', async t => {
  let received;
  const upstream = http.createServer((req, res) => { received = req.headers.authorization; res.setHeader('authorization', secret); res.end('{"ok":true}'); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());
  const proxy = http.createServer(createSecretsProxy({ config: () => state, audit: () => {},
    fetchFn: (url, options) => fetch(url.replace('https://api.github.com', `http://127.0.0.1:${upstream.address().port}`), options) }));
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  const res = await fetch(`http://127.0.0.1:${proxy.address().port}/github/repos/acme/demo`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(received, `Bearer ${secret}`);
  assert.equal(res.headers.get('authorization'), null);
});

test('POST works only with an explicit method grant and revocation takes effect on the next call', async () => {
  let current = { ...state, callers: [{ ...caller, policy: { github: { methods: ['POST'], path_prefixes: ['/repos/acme'] } } }] };
  const h = harness(async () => Response.json({ ok: true }), { config: () => current });
  assert.equal((await h.request(undefined, { method: 'POST', body: '{"title":"issue"}', headers: { 'content-type': 'application/json' } })).statusCode, 200);
  assert.equal(h.calls[0][1].body.toString(), '{"title":"issue"}');
  assert.equal((await h.request()).statusCode, 403);
  current = { ...state, callers: [{ ...caller, policy: {} }] };
  assert.equal((await h.request(undefined, { method: 'POST' })).statusCode, 403);
  current = { ...state, callers: [] };
  assert.equal((await h.request()).statusCode, 401);
});

test('configuration failure and missing credentials fail closed without logging errors', async () => {
  const h = harness(undefined, { config: () => { throw new Error(secret); } });
  assert.equal((await h.request()).statusCode, 503);
  assert.ok(!h.logs.join('').includes(secret));
  const missing = harness(undefined, { config: () => ({ ...state, credentials: {} }) });
  assert.equal((await missing.request()).statusCode, 503);
  assert.equal(missing.calls.length, 0);
});


test('upstream cannot smuggle a credential through a valid media type', async () => {
  const h = harness(async () => new Response('{}', { headers: { 'content-type': `application/${secret}` } }));
  const res = await h.request();
  assert.ok(!JSON.stringify(res.headers).includes(secret));
});

test('machine config enforces 0600, hashes identities and reloads policy atomically', () => {
  const dir = mkdtempSync(new URL('../../.ihc-proxy-config-', import.meta.url).pathname);
  try {
    mkdirSync(`${dir}/callers`, { mode: 0o700 });
    writeFileSync(`${dir}/credentials.json`, JSON.stringify({ github: secret }), { mode: 0o600 });
    writeFileSync(`${dir}/callers/demo.json`, JSON.stringify(caller), { mode: 0o600 });
    assert.deepEqual(readProxyConfig(dir).callers, [caller]);
    writeFileSync(`${dir}/callers/demo.json`, JSON.stringify({ ...caller, policy: {} }));
    assert.deepEqual(readProxyConfig(dir).callers[0].policy, {});
    chmodSync(`${dir}/credentials.json`, 0o644);
    assert.throws(() => readProxyConfig(dir));
    chmodSync(`${dir}/credentials.json`, 0o600);
    writeFileSync(`${dir}/callers/demo.json`, '{broken');
    assert.throws(() => readProxyConfig(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all fixed upstreams use their own service credentials; another app token has only its own grants', async () => {
  const credentials = Object.fromEntries(['slack', 'github', 'linear', 'hubspot'].map(name => [name, `private-${name}-credential`]));
  const allPolicy = Object.fromEntries(Object.keys(credentials).map(name => [name, { methods: ['GET'], path_prefixes: ['/'] }]));
  const other = { app: 'other', token_hash: crypto.createHash('sha256').update(otherToken).digest('hex'), policy: {} };
  const h = harness(undefined, { config: () => ({ credentials, callers: [{ ...caller, policy: allPolicy }, other] }) });
  for (const [service, credential] of Object.entries(credentials)) {
    assert.equal((await h.request(`/${service}/test`)).statusCode, 200);
    assert.equal(h.calls.at(-1)[1].headers.Authorization, service === 'linear' ? credential : `Bearer ${credential}`);
    assert.equal((await h.request(`/${service}/test`, { auth: otherToken })).statusCode, 403);
  }
});


test('manifest validator and shared schema enforce the same explicit policy shape', async () => {
  const { validateManifest } = await import('../src/validate-manifest.js');
  const schema = JSON.parse(readFileSync(new URL('../../schemas/company-app.schema.json', import.meta.url)));
  const rule = schema.$defs.secretsProxyRule;
  const pathPattern = new RegExp(rule.properties.path_prefixes.items.pattern);
  for (const path of ['/', '/repos/acme', '/repos/acme/', '/chat.postMessage']) assert.ok(pathPattern.test(path));
  for (const path of ['//host', '/..', '/a/../b', '/a/.', '/a//b', '/%2f', '/repos/acme\n']) assert.ok(!pathPattern.test(path));
  for (const service of ['slack', 'github', 'linear', 'hubspot']) {
    assert.equal(schema.properties.secrets_proxy.properties[service].$ref, '#/$defs/secretsProxyRule');
  }
  for (const value of [policy, {}, null, [], { github: {} },
    { github: { methods: ['get'], path_prefixes: ['/'] } },
    { github: { methods: ['GET'], path_prefixes: ['/a/../b'] } },
    { github: { methods: ['GET'], path_prefixes: ['/repos/acme\n'] } },
    { github: { methods: ['GET'], path_prefixes: ['/'], url: 'https://evil.test' } }]) {
    const issues = validateManifest({ secrets_proxy: value }, { skipFileChecks: true }).issues;
    assert.equal(issues.some(issue => issue.path === 'secrets_proxy'), policyErrors(value).length > 0);
  }
});

test('deadline bounds a stalled upload and a stalled upstream response body', async () => {
  const upload = new Readable({ read() {} });
  Object.assign(upload, { url: '/github/repos/acme', method: 'GET', headers: { authorization: `Bearer ${token}` } });
  const res = Object.assign(new EventEmitter(), { writeHead(code) { this.statusCode = code; }, end() {} });
  const handler = createSecretsProxy({ config: () => state, audit: () => {}, timeoutMs: 5 });
  await handler(upload, res);
  upload.destroy();
  assert.equal(res.statusCode, 504);
  const response = harness(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 5 });
  assert.equal((await response.request()).statusCode, 504);
});
