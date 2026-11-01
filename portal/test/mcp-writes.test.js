import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createActorSigner, decodeJwt, loadOrCreateSigningKey, signJwt } from '../src/jwt.js';
import { createAccessTokenVerifier } from '../src/mcp-auth.js';
import { ProviderError, createProviderGateway, providerFromApp } from '../src/mcp-providers.js';
import { createGatewayApp } from '../src/mcp-gateway.js';
import { createPlatformTools } from '../src/mcp-platform-tools.js';
import {
  ConfirmationError,
  createConfirmerResolver,
  effectiveAccess,
  normalizeToolPolicies,
  splitConfirmedBy,
  toolGranted,
  withConfirmedBy,
} from '../src/mcp-policy.js';
import { validateManifest } from '../src/validate-manifest.js';

// LAB-64: escritas com confirmed_by, audit log gravado pelo gateway e grants por tool.

const ISSUER = 'https://auth.cloud.test/application/o/ihc-mcp/';
const GATEWAY = 'https://mcp.cloud.test';
const viewer = { email: 'ana@example.com', name: 'Ana', username: 'ana', groups: ['ihc-users'], admin: false, clientId: 'ihc-mcp' };
const editor = { email: 'bia@example.com', name: 'Bia', username: 'bia', groups: ['ihc-users', 'editors'], admin: false, clientId: 'ihc-mcp' };

const PEOPLE = [
  { username: 'ana', email: 'ana@example.com', name: 'Ana', is_active: true, groups: ['ihc-users'] },
  { username: 'bia', email: 'Bia@Example.com', name: 'Bia', is_active: true, groups: ['editors', 'ihc-users'] },
  { username: 'old', email: 'old@example.com', name: 'Old', is_active: false, groups: ['ihc-users'] },
  { username: 'guest', email: 'guest@example.com', name: 'Guest', is_active: true, groups: ['guests'] },
];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notesApp(mcp = {}) {
  return {
    slug: 'notes',
    name: 'Notes',
    kind: 'app',
    port: 8080,
    mcp: { audience: 'notes.mcp', scopes: { 'notes.read': ['ihc-users'] }, ...mcp },
  };
}

function fakeDirectory(people = PEOPLE) {
  const directory = { configured: true, calls: 0, async listUsers() { directory.calls += 1; return [...people]; }, async listGroups() { return []; } };
  return directory;
}

// Audit em memoria com a mesma interface de src/mcp-audit.js.
function memoryAudit({ failOn = null, events = [] } = {}) {
  const rows = [];
  return {
    configured: true,
    rows,
    async record(entry) {
      events.push(`audit:${entry.phase}`);
      if (failOn === entry.phase) return { ok: false, error: 'connection refused' };
      rows.push(entry);
      return { ok: true, id: String(rows.length) };
    },
    async list() { return { available: true, entries: rows.map((row) => ({ request_id: row.requestId, tool: row.tool, status: row.status ?? row.phase })) }; },
  };
}

describe('tool policies from the manifest', () => {
  test('mcp.tools as a map or a list; read, write or undeclared; groups and people', () => {
    const map = normalizeToolPolicies({ create_note: { access: 'write', groups: ['editors'], people: ['Ana@Example.com'] }, list_notes: { access: 'read' }, ping: null });
    assert.deepEqual(map.problems, []);
    assert.deepEqual(map.policies.get('create_note'), { access: 'write', groups: ['editors'], people: ['ana@example.com'] });
    assert.deepEqual(map.policies.get('list_notes'), { access: 'read', groups: null, people: null });
    assert.deepEqual(map.policies.get('ping'), { access: null, groups: null, people: null });
    const list = normalizeToolPolicies([{ name: 'pedidos_list', access: 'read' }]);
    assert.deepEqual([...list.policies.keys()], ['pedidos_list']);
    assert.deepEqual(normalizeToolPolicies(undefined), { policies: new Map(), problems: [] });
  });

  test('a badly written rule is a problem, never a wider grant', () => {
    for (const tools of [
      { x: { access: 'admin' } },
      { x: { people: ['not-an-email'] } },
      { x: { groups: [1] } },
      { 'bad name': {} },
      [{ access: 'write' }],
      { x: ['editors'] },
      'create_note',
    ]) {
      assert.ok(normalizeToolPolicies(tools).problems.length > 0, JSON.stringify(tools));
    }
    const provider = providerFromApp(notesApp({ tools: { x: { access: 'maybe' } } }));
    assert.match(provider.problems.join(';'), /tools\.x\.access/);
  });

  test('a tool is read only when someone says read and nobody says write; undeclared is a write', () => {
    assert.equal(effectiveAccess(null, null), 'write');
    assert.equal(effectiveAccess(null, 'read'), 'read');
    assert.equal(effectiveAccess('read', null), 'read');
    assert.equal(effectiveAccess('read', 'write'), 'write');
    assert.equal(effectiveAccess('write', 'read'), 'write');
    assert.equal(effectiveAccess('read', 'read'), 'read');
  });

  test('a tool grant: by group or by person; no rule keeps the scope alone', () => {
    assert.equal(toolGranted(undefined, viewer), true);
    assert.equal(toolGranted({ access: 'write', groups: null, people: null }, viewer), true);
    assert.equal(toolGranted({ groups: ['editors'], people: null }, viewer), false);
    assert.equal(toolGranted({ groups: ['editors'], people: null }, editor), true);
    assert.equal(toolGranted({ groups: null, people: ['ana@example.com'] }, { ...viewer, email: 'Ana@Example.com' }), true);
    assert.equal(toolGranted({ groups: ['editors-old'], people: [] }, editor), false, 'exact group names only');
  });

  test('the write schema adds confirmed_by as required without touching the app\'s object', () => {
    const original = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
    const schema = withConfirmedBy(original);
    assert.deepEqual(schema.required, ['text', 'confirmed_by']);
    assert.equal(schema.properties.confirmed_by.type, 'string');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(original.required, ['text']);
    assert.equal(original.properties.confirmed_by, undefined);
    assert.deepEqual(splitConfirmedBy({ text: 'x', confirmed_by: ' ana ' }), { confirmedBy: 'ana', args: { text: 'x' } });
  });
});

describe('confirmed_by is checked in the directory', () => {
  test('an active member, by email or username, any case; the email of the directory comes back', async () => {
    const resolver = createConfirmerResolver({ directory: fakeDirectory() });
    assert.deepEqual(await resolver.resolve('BIA'), { email: 'bia@example.com', username: 'bia', name: 'Bia' });
    assert.equal((await resolver.resolve('ana@example.com')).email, 'ana@example.com');
  });

  test('nobody, deactivated, outside ihc-users, empty: refused with a code', async () => {
    const resolver = createConfirmerResolver({ directory: fakeDirectory() });
    const code = async (text) => resolver.resolve(text).then(() => 'accepted', (error) => (error instanceof ConfirmationError ? error.code : error.message));
    assert.equal(await code(''), 'confirmation_required');
    assert.equal(await code(null), 'confirmation_required');
    assert.equal(await code('Ana Souza'), 'confirmed_by_unknown');
    assert.equal(await code('me'), 'confirmed_by_unknown');
    assert.equal(await code('old@example.com'), 'confirmed_by_inactive');
    assert.equal(await code('guest'), 'confirmed_by_not_member');
  });

  test('no directory, or the directory down: writes are refused (fail closed)', async () => {
    await assert.rejects(createConfirmerResolver({ directory: { configured: false } }).resolve('ana'), { code: 'directory_unavailable' });
    await assert.rejects(createConfirmerResolver({ directory: { configured: true, listUsers: async () => { throw new Error('down'); } } }).resolve('ana'), { code: 'directory_unavailable' });
  });

  test('the list is cached; a miss reads it again at most every 10 s (someone who just joined)', async () => {
    let clock = 0;
    const people = [...PEOPLE];
    const directory = fakeDirectory(people);
    const resolver = createConfirmerResolver({ directory, now: () => clock });
    await resolver.resolve('ana');
    await resolver.resolve('bia');
    assert.equal(directory.calls, 1);
    await assert.rejects(resolver.resolve('dora'), { code: 'confirmed_by_unknown' });
    assert.equal(directory.calls, 1, 'no second read within 10 s');
    clock = 15_000;
    people.push({ username: 'dora', email: 'dora@example.com', is_active: true, groups: ['ihc-users'] });
    assert.equal((await resolver.resolve('dora')).email, 'dora@example.com');
    assert.equal(directory.calls, 2);
  });
});

describe('providers: read or write, and grants per tool', () => {
  const signer = createActorSigner({ ...loadOrCreateSigningKey(null), issuer: GATEWAY });

  function gatewayWith(app, tools, handler = null, options = {}) {
    const calls = [];
    const provider = providerFromApp(app);
    const gateway = createProviderGateway({
      signer,
      fetchFn: async (url, init) => {
        const claims = decodeJwt(init.headers.Authorization.slice(7)).claims;
        calls.push({ url, method: init.method, claims, body: init.body ? JSON.parse(init.body) : null });
        if (handler) return handler(url, init);
        return init.method === 'GET' ? jsonResponse(200, { tools }) : jsonResponse(200, { result: { done: true }, audit: { previous: 1, new: 2 } });
      },
      ...options,
    });
    return { gateway, calls, provider };
  }

  test('a tool nobody declares is a write: readOnlyHint false, confirmed_by required, said in the description', async () => {
    const { gateway, provider } = gatewayWith(notesApp(), [
      { name: 'add', description: 'Adds a note', input_schema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'list', description: 'Lists', access: 'read' },
      { name: 'sneaky', access: 'write', annotations: { readOnlyHint: true } },
    ]);
    const { tools } = await gateway.listTools(viewer, [provider]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.notes__add.annotations.readOnlyHint, false);
    assert.deepEqual(byName.notes__add.inputSchema.required, ['confirmed_by']);
    assert.match(byName.notes__add.description, /^\[Notes\] Adds a note \(Writes: needs confirmed_by/);
    assert.equal(byName.notes__list.annotations.readOnlyHint, true);
    assert.equal(byName.notes__list.inputSchema.properties.confirmed_by, undefined);
    assert.equal(byName.notes__sneaky.annotations.readOnlyHint, false, 'an app cannot call a write read only');
  });

  test('the manifest saying write wins over the app saying read; the manifest saying read covers an undeclared tool', async () => {
    const { gateway, provider } = gatewayWith(notesApp({ tools: { list: { access: 'write' }, legacy: { access: 'read' } } }), [
      { name: 'list', access: 'read' },
      { name: 'legacy' },
    ]);
    const { tools } = await gateway.listTools(viewer, [provider]);
    assert.deepEqual(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]), [['notes__list', false], ['notes__legacy', true]]);
  });

  test('a tool granted to a group or a person is hidden from everyone else and refused without calling the app', async () => {
    const app = notesApp({ tools: { publish: { access: 'write', groups: ['editors'] }, mine: { access: 'read', people: ['ana@example.com'] } } });
    const { gateway, calls, provider } = gatewayWith(app, [{ name: 'publish' }, { name: 'mine' }, { name: 'ping', access: 'read' }]);
    assert.deepEqual((await gateway.listTools(viewer, [provider])).tools.map((tool) => tool.name), ['notes__mine', 'notes__ping']);
    assert.deepEqual((await gateway.listTools(editor, [provider])).tools.map((tool) => tool.name), ['notes__publish', 'notes__ping']);
    calls.length = 0;
    await assert.rejects(gateway.prepareCall(viewer, [provider], 'notes__publish'), (error) => error instanceof ProviderError && error.code === 'tool_not_granted' && /groups editors/.test(error.message));
    await assert.rejects(gateway.prepareCall(editor, [provider], 'notes__mine'), { code: 'tool_not_granted' });
    assert.equal(calls.length, 0, 'the app was never asked');
    assert.equal((await gateway.prepareCall(editor, [provider], 'notes__publish')).access, 'write');
  });

  test('without mcp.tools, only the scope decides (installs from before keep working)', async () => {
    const { gateway, provider } = gatewayWith(notesApp(), [{ name: 'ping', access: 'read' }]);
    assert.deepEqual((await gateway.listTools(viewer, [provider])).tools.map((tool) => tool.name), ['notes__ping']);
    assert.deepEqual(await gateway.callTool(viewer, [provider], 'notes__ping', {}), { provider: 'notes', result: { done: true } });
  });

  test('the access of a call comes from a recent list; the manifest saying write needs no list; an app down counts as write', async () => {
    let clock = 0;
    let down = false;
    const { gateway, calls, provider } = gatewayWith(notesApp({ tools: { add: { access: 'write' } } }), null, (_url, init) => {
      if (down) return jsonResponse(503, {});
      return init.method === 'GET' ? jsonResponse(200, { tools: [{ name: 'ping', access: 'read' }, { name: 'add' }] }) : jsonResponse(200, { result: 1 });
    }, { now: () => clock, accessTtlMs: 60_000 });
    assert.equal((await gateway.prepareCall(viewer, [provider], 'notes__add')).access, 'write');
    assert.equal(calls.length, 0, 'the manifest decided');
    assert.equal((await gateway.prepareCall(viewer, [provider], 'notes__ping')).access, 'read');
    assert.equal((await gateway.prepareCall(viewer, [provider], 'notes__ping')).access, 'read');
    assert.equal(calls.filter((call) => call.method === 'GET').length, 1, 'read the list once');
    clock = 120_000;
    down = true;
    assert.equal((await gateway.prepareCall(viewer, [provider], 'notes__ping')).access, 'write');
  });

  test('callTool refuses a write without confirmedBy; with it, the actor JWT carries confirmed_by and the args go as they are', async () => {
    const { gateway, calls, provider } = gatewayWith(notesApp(), [{ name: 'add' }]);
    await assert.rejects(gateway.callTool(viewer, [provider], 'notes__add', { text: 'x' }), { code: 'confirmation_required' });
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
    const out = await gateway.callTool(viewer, [provider], 'notes__add', { text: 'x' }, { confirmedBy: 'bia@example.com' });
    assert.deepEqual(out, { provider: 'notes', result: { done: true } });
    const post = calls.find((call) => call.method === 'POST');
    assert.equal(post.claims.confirmed_by, 'bia@example.com');
    assert.deepEqual(post.body, { arguments: { text: 'x' } });
  });
});

describe('the gateway writes through confirmed_by and its own audit log', () => {
  const ak = loadOrCreateSigningKey(null);
  const config = { publicUrl: GATEWAY, authentikUrl: 'https://auth.cloud.test', clientId: 'ihc-mcp', issuer: ISSUER, userGroup: 'ihc-users', adminGroup: 'ihc-admins' };
  const events = [];
  const appCalls = [];
  let mode = 'ok';
  let audit;
  let server;
  let base;

  const jwks = () => createActorSigner({ ...ak, issuer: ISSUER }).jwks();

  function token(claims = {}) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ iss: ISSUER, aud: 'ihc-mcp', sub: 'h', iat: now, exp: now + 300, email: 'ana@example.com', groups: ['ihc-users'], ...claims }, ak);
  }

  function start(auditLog) {
    audit = auditLog;
    const signer = createActorSigner({ ...loadOrCreateSigningKey(null), issuer: GATEWAY });
    const providers = createProviderGateway({
      signer,
      fetchFn: async (url, init) => {
        const claims = decodeJwt(init.headers.Authorization.slice(7)).claims;
        if (init.method === 'GET') {
          return jsonResponse(200, { tools: [{ name: 'set_price', input_schema: { type: 'object', properties: { sku: { type: 'string' }, price: { type: 'number' } } } }, { name: 'ping', access: 'read' }] });
        }
        events.push('app:execute');
        appCalls.push({ url, claims, body: JSON.parse(init.body) });
        if (mode === 'denied') return jsonResponse(403, { error: { code: 'tool_access_denied', message: 'not your store' } });
        if (url.endsWith('/ping/execute')) return jsonResponse(200, { result: { pong: true } });
        return jsonResponse(200, { result: { ok: true, sku: 'A1' }, audit: { previous: { price: 10 }, new: { price: 12 }, target: 'sku A1' } });
      },
    });
    const directory = fakeDirectory();
    const app = createGatewayApp({
      config,
      signer,
      verifier: createAccessTokenVerifier({ issuer: ISSUER, audience: 'ihc-mcp', jwksUrl: 'x', fetchFn: async () => jsonResponse(200, jwks()) }),
      providerGateway: providers,
      directory,
      audit: auditLog,
      platformTools: createPlatformTools({ listAppsFn: () => [], listHttpHealthFn: async () => ({ available: true, checks: [] }), directory, audit: auditLog }),
      listAppsFn: () => [notesApp()],
      log: () => {},
    });
    server = http.createServer(app);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }));
  }

  const call = async (name, args, claims) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token(claims)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()).result;
  };
  const reset = () => { events.length = 0; appCalls.length = 0; mode = 'ok'; audit.rows.length = 0; };

  before(() => start(memoryAudit({ events })));
  after(() => server.close());

  test('tools/list shows the write with confirmed_by required', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await response.json()).result.tools;
    const write = tools.find((tool) => tool.name === 'notes__set_price');
    assert.deepEqual(write.inputSchema.required, ['confirmed_by']);
    assert.equal(write.annotations.readOnlyHint, false);
  });

  test('a write without confirmed_by is refused, recorded as refused, and the app is never called', async () => {
    reset();
    const out = await call('notes__set_price', { sku: 'A1', price: 12 });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /pass confirmed_by/);
    assert.deepEqual(events, ['audit:refused']);
    assert.equal(audit.rows[0].status, 'confirmation_required');
    assert.equal(appCalls.length, 0);
  });

  test('a confirmed_by that is nobody (free text) is refused', async () => {
    reset();
    const out = await call('notes__set_price', { sku: 'A1', price: 12, confirmed_by: 'the boss said yes' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /nobody in the company directory/);
    assert.equal(audit.rows[0].status, 'confirmed_by_unknown');
    assert.equal(audit.rows[0].confirmedByInput, 'the boss said yes');
    assert.equal(appCalls.length, 0);
  });

  test('a confirmed write: requested before the app, the app gets the directory email in the JWT, completed with previous and new', async () => {
    reset();
    const out = await call('notes__set_price', { sku: 'A1', price: 12, api_key: 'sk-live', confirmed_by: 'BIA' });
    assert.equal(out.isError, false);
    assert.deepEqual(out.structuredContent, { ok: true, sku: 'A1' }, 'the audit block stays in the gateway');
    assert.deepEqual(events, ['audit:requested', 'app:execute', 'audit:completed']);
    assert.equal(appCalls[0].claims.confirmed_by, 'bia@example.com');
    assert.deepEqual(appCalls[0].body.arguments, { sku: 'A1', price: 12, api_key: 'sk-live' }, 'confirmed_by is not an app argument');
    const [requested, completed] = audit.rows;
    assert.equal(requested.requestId, completed.requestId);
    assert.equal(requested.actor.email, 'ana@example.com');
    assert.equal(requested.confirmedBy, 'bia@example.com');
    assert.equal(requested.tool, 'notes__set_price');
    assert.equal(requested.provider, 'notes');
    assert.equal(requested.arguments.confirmed_by, undefined);
    assert.equal(requested.details.confirmed_by_is_actor, false);
    assert.equal(completed.status, 'ok');
    assert.deepEqual(completed.previousValue, { price: 10 });
    assert.deepEqual(completed.newValue, { price: 12 });
    assert.equal(completed.target, 'sku A1');
  });

  test('the app refusing a write is recorded as completed with its error code', async () => {
    reset();
    mode = 'denied';
    const out = await call('notes__set_price', { sku: 'A1', price: 12, confirmed_by: 'ana@example.com' });
    assert.equal(out.isError, true);
    assert.deepEqual(events, ['audit:requested', 'app:execute', 'audit:completed']);
    assert.equal(audit.rows[1].status, 'tool_access_denied');
    assert.equal(audit.rows[1].error, 'not your store');
  });

  test('a read is unchanged: no confirmed_by, no audit row', async () => {
    reset();
    const out = await call('notes__ping', {});
    assert.equal(out.isError, false);
    assert.deepEqual(events, ['app:execute']);
    assert.equal(appCalls[0].claims.confirmed_by, undefined);
  });

  test('admins read the audit log through ihc_audit_log; others cannot', async () => {
    reset();
    await call('notes__set_price', { sku: 'A1', price: 12, confirmed_by: 'ana' });
    const denied = await call('ihc_audit_log', {});
    assert.equal(denied.isError, true);
    const read = await call('ihc_audit_log', { limit: 10 }, { email: 'root@example.com', groups: ['ihc-users', 'ihc-admins'] });
    assert.equal(read.isError, false);
    assert.equal(read.structuredContent.count, 2);
  });

  test('no audit row, no write: a failed insert or an unconfigured audit log stops the call before the app', async () => {
    server.close();
    events.length = 0;
    await start(memoryAudit({ failOn: 'requested', events }));
    appCalls.length = 0;
    let out = await call('notes__set_price', { sku: 'A1', price: 12, confirmed_by: 'ana' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /could not write its audit log/);
    assert.equal(appCalls.length, 0);

    server.close();
    await start({ configured: false, rows: [], async record() { throw new Error('must not be called'); }, async list() { return { available: false, error: 'not_configured', entries: [] }; } });
    out = await call('notes__set_price', { sku: 'A1', price: 12, confirmed_by: 'ana' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /writes are disabled on this cloud/);
    assert.equal(appCalls.length, 0);
    assert.equal((await call('notes__ping', {})).isError, false, 'reads still work');
  });
});

describe('the manifest section mcp.tools', () => {
  const base = {
    schema_version: 1,
    app: { slug: 'notes', name: 'Notes', owner_email: 'a@example.com' },
    runtime: { type: 'docker-compose', compose_file: 'docker-compose.yml', service: 'app', healthcheck: { type: 'http', path: '/health', expected_status: 200 } },
    deploy: { enabled: true, domain: 'notes.cloud.localhost', port: 'auto', env_file: '.env', env_example: '.env.example' },
    auth: { required: true, provider: 'forward-auth' },
  };
  const issuesFor = (tools) => validateManifest({ ...base, mcp: { scopes: { 'notes.read': ['ihc-users'] }, tools } }, { skipFileChecks: true }).issues.filter((item) => item.path.startsWith('mcp'));

  test('access, groups and people are valid as a map and as a list; anything else is not', () => {
    assert.deepEqual(issuesFor({ add: { access: 'write', groups: ['editors'], people: ['ana@example.com'] }, list: { access: 'read' } }), []);
    assert.deepEqual(issuesFor([{ name: 'add', access: 'write' }]), []);
    assert.ok(issuesFor({ add: { access: 'delete' } }).length > 0);
    assert.ok(issuesFor({ add: { people: ['ana'] } }).length > 0);
    assert.ok(issuesFor({ add: { groups: [''] } }).length > 0);
  });
});
