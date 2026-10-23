import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActorSigner, decodeJwt, loadOrCreateSigningKey, signJwt, verifyJwt } from '../src/jwt.js';
import { createAccessTokenVerifier } from '../src/mcp-auth.js';
import {
  ProviderError,
  createProviderGateway,
  grantedScopes,
  normalizeScopes,
  providerFromApp,
  splitToolName,
} from '../src/mcp-providers.js';
import { authorizationServerMetadata, createGatewayApp, gatewayConfigFromEnv, protectedResourceMetadata } from '../src/mcp-gateway.js';
import { createPlatformTools, freshnessOf, platformToolsFor } from '../src/mcp-platform-tools.js';
import { validateManifest } from '../src/validate-manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ISSUER = 'https://auth.cloud.test/application/o/ihc-mcp/';
const GATEWAY = 'https://mcp.cloud.test';

function key() {
  return loadOrCreateSigningKey(null);
}

function jwksOf(signingKey) {
  const jwk = crypto.createPublicKey(signingKey.privateKey).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: signingKey.kid, alg: 'RS256', use: 'sig' }] };
}

function accessToken(signingKey, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: ISSUER, aud: 'ihc-mcp', sub: 'hashed', iat: now, exp: now + 300, email: 'ana@example.com', groups: ['ihc-users'], ...claims }, signingKey);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const viewer = { email: 'ana@example.com', name: 'Ana', groups: ['ihc-users'], admin: false, clientId: 'ihc-mcp' };
const admin = { email: 'root@example.com', name: 'Root', groups: ['ihc-users', 'ihc-admins'], admin: true, clientId: 'ihc-mcp' };

function notesApp(mcp = {}) {
  return {
    slug: 'notes',
    name: 'Notes',
    kind: 'app',
    port: 8080,
    mcp: { audience: 'notes.mcp', tools_path: '/mcp/tools', execute_path: '/mcp/tools/{tool}/execute', scopes: { 'notes.read': ['ihc-users'] }, ...mcp },
  };
}

describe('actor JWT', () => {
  test('issues a short RS256 token with aud, scope and the person, verifiable against the JWKS', () => {
    const signer = createActorSigner({ ...key(), issuer: GATEWAY, ttlSeconds: 300 });
    const token = signer.issue({ audience: 'notes.mcp', scopes: ['notes.read'], user: viewer, requestId: 'r1' });
    const claims = verifyJwt(token, { keys: signer.jwks().keys, issuer: GATEWAY, audience: 'notes.mcp' });
    assert.equal(claims.sub, 'ana@example.com');
    assert.deepEqual(claims.groups, ['ihc-users']);
    assert.equal(claims.scope, 'notes.read');
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(decodeJwt(token).header.kid, signer.kid);
  });

  test('the lifetime is clamped to minutes', () => {
    assert.equal(createActorSigner({ ...key(), issuer: GATEWAY, ttlSeconds: 86400 }).ttlSeconds, 900);
    assert.equal(createActorSigner({ ...key(), issuer: GATEWAY, ttlSeconds: 1 }).ttlSeconds, 30);
  });

  test('refuses another audience, another issuer, an expired token, another key and alg none', () => {
    const k = key();
    const signer = createActorSigner({ ...k, issuer: GATEWAY });
    const keys = signer.jwks().keys;
    const token = signer.issue({ audience: 'notes.mcp', scopes: ['notes.read'], user: viewer });
    assert.throws(() => verifyJwt(token, { keys, issuer: GATEWAY, audience: 'billing.mcp' }), /wrong audience/);
    assert.throws(() => verifyJwt(token, { keys, issuer: 'https://evil.test', audience: 'notes.mcp' }), /wrong issuer/);
    assert.throws(() => verifyJwt(token, { keys, issuer: GATEWAY, audience: 'notes.mcp', now: Date.now() + 3600_000 }), /expired/);
    const other = createActorSigner({ ...key(), issuer: GATEWAY });
    assert.throws(() => verifyJwt(other.issue({ audience: 'notes.mcp', user: viewer }), { keys, issuer: GATEWAY, audience: 'notes.mcp' }), /no key for kid/);
    const [, payload] = token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: k.kid })).toString('base64url')}.${payload}.`;
    assert.throws(() => verifyJwt(none, { keys, issuer: GATEWAY, audience: 'notes.mcp' }));
    const forged = `${token.split('.').slice(0, 2).join('.')}.${Buffer.from('x'.repeat(256)).toString('base64url')}`;
    assert.throws(() => verifyJwt(forged, { keys, issuer: GATEWAY, audience: 'notes.mcp' }), /bad signature/);
  });

  test('the signing key is created once, 0600, and read back with the same kid', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ihc-mcp-key-'));
    try {
      const file = path.join(dir, 'keys', 'actor-key.pem');
      const first = loadOrCreateSigningKey(file);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(loadOrCreateSigningKey(file).kid, first.kid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('access token of the Authentik provider', () => {
  const ak = key();
  const jwks = jwksOf(ak);
  function verifier({ fetchFn, ...rest } = {}) {
    return createAccessTokenVerifier({
      issuer: ISSUER,
      audience: 'ihc-mcp',
      jwksUrl: 'http://authentik/jwks/',
      userinfoUrl: 'http://authentik/userinfo/',
      fetchFn: fetchFn ?? (async () => jsonResponse(200, jwks)),
      ...rest,
    });
  }

  test('someone in ihc-users enters; ihc-admins makes them admin', async () => {
    const v = verifier();
    const user = await v.verify(accessToken(ak));
    assert.equal(user.ok, true);
    assert.equal(user.user.email, 'ana@example.com');
    assert.equal(user.user.admin, false);
    const root = await v.verify(accessToken(ak, { groups: ['ihc-users', 'ihc-admins'] }));
    assert.equal(root.user.admin, true);
  });

  test('someone outside ihc-users is refused with 403, even an admin-only member', async () => {
    const v = verifier();
    for (const groups of [[], ['ihc-admins'], ['ihc-users-old']]) {
      const outcome = await v.verify(accessToken(ak, { groups }));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.status, 403);
    }
  });

  test('a token of another client, another issuer, expired or forged is 401', async () => {
    const v = verifier();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ aud: 'gitea' }, { iss: 'https://auth.cloud.test/application/o/gitea/' }, { exp: now - 600 }]) {
      const outcome = await v.verify(accessToken(ak, claims));
      assert.equal(outcome.status, 401, JSON.stringify(claims));
    }
    assert.equal((await v.verify(accessToken(key()))).status, 401);
    assert.equal((await v.verify('not-a-jwt')).status, 401);
    assert.equal((await v.verify('')).status, 401);
  });

  test('without email or groups in the token, asks the userinfo endpoint once', async () => {
    let userinfoCalls = 0;
    const v = verifier({
      fetchFn: async (url) => {
        if (url.includes('userinfo')) {
          userinfoCalls += 1;
          return jsonResponse(200, { email: 'Bia@Example.com', groups: ['ihc-users'], name: 'Bia' });
        }
        return jsonResponse(200, jwks);
      },
    });
    const token = accessToken(ak, { email: undefined, groups: undefined });
    assert.equal((await v.verify(token)).user.email, 'bia@example.com');
    await v.verify(token);
    assert.equal(userinfoCalls, 1);
  });

  test('a new kid makes it read the JWKS again; Authentik down is 503, not 401', async () => {
    let current = jwksOf(ak);
    let clock = Date.now();
    const v = verifier({ fetchFn: async () => jsonResponse(200, current), now: () => clock });
    assert.equal((await v.verify(accessToken(ak))).ok, true);
    const rotated = key();
    current = jwksOf(rotated);
    clock += 60_000;
    assert.equal((await v.verify(accessToken(rotated))).ok, true);
    const down = verifier({ fetchFn: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal((await down.verify(accessToken(ak))).status, 503);
  });
});

describe('providers from the manifests', () => {
  test('an app without mcp, a disabled one and the core portal are not providers', () => {
    assert.equal(providerFromApp({ slug: 'plain', port: 8080, mcp: null }), null);
    assert.equal(providerFromApp(notesApp({ enabled: false })), null);
    assert.equal(providerFromApp({ ...notesApp(), kind: 'core' }), null);
    const provider = providerFromApp(notesApp());
    assert.equal(provider.baseUrl, 'http://notes:8080');
    assert.deepEqual(provider.problems, []);
  });

  test('scopes: map, list of objects, and plain names granted to ihc-users', () => {
    assert.deepEqual(normalizeScopes({ 'notes.read': ['ihc-users'], 'notes.admin': ['ihc-admins'] }), [
      { name: 'notes.read', groups: ['ihc-users'] },
      { name: 'notes.admin', groups: ['ihc-admins'] },
    ]);
    assert.deepEqual(normalizeScopes([{ name: 'notes.read', groups: ['team'] }, 'notes.list']), [
      { name: 'notes.read', groups: ['team'] },
      { name: 'notes.list', groups: ['ihc-users'] },
    ]);
    const provider = providerFromApp(notesApp({ scopes: { 'notes.read': ['ihc-users'], 'notes.admin': ['ihc-admins'] } }));
    assert.deepEqual(grantedScopes(provider, viewer.groups), ['notes.read']);
    assert.deepEqual(grantedScopes(provider, admin.groups), ['notes.read', 'notes.admin']);
  });

  test('a path to another host or with .. makes the provider invalid', () => {
    assert.ok(providerFromApp(notesApp({ tools_path: 'http://evil/x' })).problems.length > 0);
    assert.ok(providerFromApp(notesApp({ execute_path: '/mcp/../admin' })).problems.length > 0);
    assert.ok(providerFromApp(notesApp({ execute_path: '/mcp/run' })).problems.length > 0);
    assert.ok(providerFromApp(notesApp({ scopes: {} })).problems.length > 0);
  });

  test('tool names carry the slug: notes__ping', () => {
    assert.deepEqual(splitToolName('notes__ping'), { slug: 'notes', tool: 'ping' });
    assert.deepEqual(splitToolName('my-app__get__x'), { slug: 'my-app', tool: 'get__x' });
    assert.equal(splitToolName('ihc_list_apps'), null);
  });
});

describe('listing and routing', () => {
  const signer = createActorSigner({ ...key(), issuer: GATEWAY });
  const notes = providerFromApp(notesApp());
  const locked = providerFromApp({ ...notesApp({ audience: 'locked.mcp', scopes: { 'locked.read': ['ihc-admins'] } }), slug: 'locked', name: 'Locked' });

  function gatewayWith(handler, options = {}) {
    const calls = [];
    const gateway = createProviderGateway({
      signer,
      fetchFn: async (url, init) => {
        const claims = decodeJwt(init.headers.Authorization.slice(7)).claims;
        calls.push({ url, method: init.method, claims, body: init.body ? JSON.parse(init.body) : null });
        return handler(url, init, claims);
      },
      ...options,
    });
    return { gateway, calls };
  }

  test('lists in parallel, prefixes the tools, signs one actor JWT per provider with its aud and granted scope', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse(200, { tools: [{ name: 'ping', description: 'Ping', input_schema: { type: 'object', properties: {} } }] }));
    const listed = await gateway.listTools(admin, [notes, locked]);
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['notes__ping', 'locked__ping']);
    assert.equal(listed.tools[0].description, '[Notes] Ping');
    assert.deepEqual(calls.map((call) => [call.url, call.claims.aud, call.claims.scope]), [
      ['http://notes:8080/mcp/tools', 'notes.mcp', 'notes.read'],
      ['http://locked:8080/mcp/tools', 'locked.mcp', 'locked.read'],
    ]);
  });

  test('an app that grants nothing to the person is not even asked, and its tools are refused', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse(200, { tools: [{ name: 'ping' }] }));
    const listed = await gateway.listTools(viewer, [notes, locked]);
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['notes__ping']);
    assert.equal(listed.providers.find((p) => p.slug === 'locked').error, 'scope_not_granted');
    await assert.rejects(gateway.callTool(viewer, [notes, locked], 'locked__ping', {}), (error) => error instanceof ProviderError && error.code === 'scope_not_granted' && /ihc-admins/.test(error.message));
    assert.ok(calls.every((call) => !call.url.startsWith('http://locked')));
  });

  test('a call goes to the provider of the prefix, with { arguments }, and returns its result', async () => {
    const { gateway, calls } = gatewayWith(async () => jsonResponse(200, { result: { pong: true } }));
    const out = await gateway.callTool(viewer, [notes, locked], 'notes__ping', { a: 1 });
    assert.deepEqual(out, { provider: 'notes', result: { pong: true } });
    assert.equal(calls[0].url, 'http://notes:8080/mcp/tools/ping/execute');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, { arguments: { a: 1 } });
    await assert.rejects(gateway.callTool(viewer, [notes], 'ghost__ping', {}), { code: 'tool_not_found' });
  });

  test('a provider down or slow keeps its last good catalog; a 403 never uses it', async () => {
    let mode = 'ok';
    let clock = 0;
    const { gateway } = gatewayWith(async (_url, init) => {
      if (mode === 'down') return jsonResponse(503, { error: 'busy' });
      if (mode === 'slow') {
        // AbortSignal.timeout does not hold the event loop; a real socket would.
        const hold = setTimeout(() => {}, 5000);
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { clearTimeout(hold); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }));
      }
      if (mode === 'denied') return jsonResponse(403, { error: { code: 'tool_access_denied', message: 'no' } });
      return jsonResponse(200, { tools: [{ name: 'ping' }] });
    }, { listTimeoutMs: 50, fallbackMs: 1000, now: () => clock });
    assert.equal((await gateway.listTools(viewer, [notes])).tools.length, 1);
    mode = 'down';
    let listed = await gateway.listTools(viewer, [notes]);
    assert.deepEqual([listed.tools.length, listed.providers[0].source], [1, 'fallback']);
    mode = 'slow';
    listed = await gateway.listTools(viewer, [notes]);
    assert.deepEqual([listed.tools.length, listed.providers[0].source, listed.providers[0].error], [1, 'fallback', 'provider_timeout']);
    clock = 2000; // past the fallback window
    mode = 'down';
    assert.equal((await gateway.listTools(viewer, [notes])).tools.length, 0);
    clock = 0;
    mode = 'ok';
    await gateway.listTools(viewer, [notes]);
    mode = 'denied';
    listed = await gateway.listTools(viewer, [notes]);
    assert.deepEqual([listed.tools.length, listed.providers[0].source], [0, 'failed']);
    mode = 'down';
    assert.equal((await gateway.listTools(viewer, [notes])).tools.length, 0, 'the 403 dropped the cached catalog');
  });

  test('a 403 on a call is an access error, not a fallback', async () => {
    const { gateway } = gatewayWith(async () => jsonResponse(403, { error: { code: 'tool_access_denied', message: 'ping needs notes.read' } }));
    await assert.rejects(gateway.callTool(viewer, [notes], 'notes__ping', {}), { code: 'tool_access_denied', message: 'ping needs notes.read' });
  });
});

describe('platform tools', () => {
  test('viewers see the catalog only; admins also the status, people and groups', () => {
    assert.deepEqual(platformToolsFor(viewer).map((tool) => tool.name), ['ihc_list_apps']);
    assert.deepEqual(platformToolsFor(admin).map((tool) => tool.name), ['ihc_list_apps', 'ihc_platform_status', 'ihc_list_people', 'ihc_list_groups']);
  });

  test('ihc_list_apps returns description, health, SSO and the MCP prefix; system tests only for admins', async () => {
    const tools = createPlatformTools({
      listAppsFn: () => [notesApp(), { slug: 'plain', name: 'Plain', kind: 'app', auth_required: true, mcp: null }, { slug: 'smoke-app', name: 'Smoke', kind: 'system-test' }],
      listHttpHealthFn: async (apps) => ({ available: true, checked_at: 'now', checks: apps.map((app) => ({ slug: app.slug, checked: true, ok: true, status: 200, sso_effective: true })) }),
      directory: { configured: false },
    });
    const out = await tools.call(viewer, 'ihc_list_apps', {});
    assert.deepEqual(out.apps.map((app) => app.slug), ['notes', 'plain']);
    assert.deepEqual(out.apps[0].mcp, { provider: true, tools_prefix: 'notes__', you_have_access: true });
    assert.deepEqual(out.apps[1].mcp, { provider: false });
    assert.equal(out.apps[0].health.ok, true);
    assert.equal(out.apps[0].sso.effective, true);
    assert.equal((await tools.call(admin, 'ihc_list_apps', {})).count, 3);
  });

  test('admin tools refuse a viewer; the status reads the portal API with its token', async () => {
    let seen = null;
    const tools = createPlatformTools({
      portalUrl: 'http://portal:8080',
      portalApiToken: 'tok',
      fetchFn: async (url, init) => { seen = { url, auth: init.headers.Authorization }; return jsonResponse(200, { overall: 'healthy', services: [] }); },
      directory: { configured: true, listUsers: async () => [{ username: 'ana' }], listGroups: async () => [] },
    });
    await assert.rejects(tools.call(viewer, 'ihc_platform_status'), { code: 'forbidden' });
    await assert.rejects(tools.call(viewer, 'ihc_list_people'), { code: 'forbidden' });
    assert.equal((await tools.call(admin, 'ihc_platform_status')).overall, 'healthy');
    assert.deepEqual(seen, { url: 'http://portal:8080/api/platform/status', auth: 'Bearer tok' });
    assert.equal((await tools.call(admin, 'ihc_list_people')).count, 1);
  });

  const reading = (extra) => ({ overall: 'healthy', services: [], cached: true, stale: false, generated_at: '2026-10-23T12:00:00.000Z', age_seconds: 12, cache_ttl_seconds: 60, ...extra });

  test('ihc_platform_status: a fresh cached reading is served as is, with its age in a sentence', async () => {
    const urls = [];
    const tools = createPlatformTools({
      portalApiToken: 'tok',
      fetchFn: async (url) => { urls.push(url); return jsonResponse(200, reading()); },
      directory: { configured: false },
    });
    const out = await tools.call(admin, 'ihc_platform_status');
    assert.deepEqual(urls, ['http://portal:8080/api/platform/status']);
    assert.equal(out.stale, false);
    assert.equal(Object.keys(out)[0], 'freshness', 'the sentence comes first in the text the agent reads');
    assert.match(out.freshness, /^Probed 12 s ago \(2026-10-23T12:00:00\.000Z\); current within the portal's cache lifetime of 60 s\.$/);
  });

  test('ihc_platform_status: a stale reading is never the answer when the portal can probe', async () => {
    const urls = [];
    const tools = createPlatformTools({
      portalApiToken: 'tok',
      fetchFn: async (url) => {
        urls.push(url);
        return jsonResponse(200, url.endsWith('?refresh=1')
          ? reading({ cached: false, age_seconds: 0, generated_at: '2026-10-23T13:00:00.000Z' })
          : reading({ stale: true, age_seconds: 3400, overall: 'degraded' }));
      },
      directory: { configured: false },
    });
    const out = await tools.call(admin, 'ihc_platform_status');
    assert.deepEqual(urls, ['http://portal:8080/api/platform/status', 'http://portal:8080/api/platform/status?refresh=1']);
    assert.deepEqual([out.stale, out.cached, out.overall, out.age_seconds], [false, false, 'healthy', 0]);
    assert.match(out.freshness, /^Probed 0 s ago \(2026-10-23T13:00:00\.000Z\)/);
  });

  test('ihc_platform_status: when the fresh probe fails, the stale reading comes back saying so', async () => {
    const tools = createPlatformTools({
      portalApiToken: 'tok',
      fetchFn: async (url) => (url.endsWith('?refresh=1') ? jsonResponse(502, { error: 'bad gateway' }) : jsonResponse(200, reading({ stale: true, age_seconds: 3400 }))),
      directory: { configured: false },
    });
    const out = await tools.call(admin, 'ihc_platform_status');
    assert.equal(out.stale, true);
    assert.match(out.freshness, /^STALE: this reading was probed 3400 s ago .*a fresh probe failed \(the portal answered HTTP 502\)\. Do not treat it as the current state\.$/);
  });

  test('freshnessOf copes with a reading that has no cache fields (an older portal)', () => {
    assert.equal(freshnessOf({ checked_at: '2026-10-23T12:00:00.000Z' }), "Probed at 2026-10-23T12:00:00.000Z; current within the portal's cache lifetime of ? s.");
  });
});

describe('the gateway over HTTP', () => {
  const ak = key();
  const config = {
    publicUrl: GATEWAY,
    authentikUrl: 'https://auth.cloud.test',
    clientId: 'ihc-mcp',
    issuer: ISSUER,
    userGroup: 'ihc-users',
    adminGroup: 'ihc-admins',
  };
  let server;
  let base;
  let providerCalls = 0;

  before(async () => {
    const app = createGatewayApp({
      config,
      signer: createActorSigner({ ...key(), issuer: GATEWAY }),
      verifier: createAccessTokenVerifier({ issuer: ISSUER, audience: 'ihc-mcp', jwksUrl: 'x', fetchFn: async () => jsonResponse(200, jwksOf(ak)) }),
      providerGateway: {
        async listTools() { providerCalls += 1; return { tools: [{ name: 'notes__ping', description: '[Notes] Ping', inputSchema: { type: 'object' } }], providers: [] }; },
        async callTool(_user, _providers, name) {
          if (name === 'notes__ping') return { provider: 'notes', result: { pong: true } };
          if (!name.includes('__')) throw new ProviderError(`no tool named ${name}`, { code: 'tool_not_found' });
          throw new ProviderError('access denied: locked grants its MCP scopes to ihc-admins', { code: 'scope_not_granted' });
        },
      },
      platformTools: createPlatformTools({ listAppsFn: () => [], listHttpHealthFn: async () => ({ available: true, checks: [] }), directory: { configured: false } }),
      listAppsFn: () => [notesApp()],
      log: () => {},
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const rpc = (body, token) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  test('without a token: 401 with the protected resource metadata, which names the Authentik provider', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/mcp\.cloud\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.deepEqual(metadata, protectedResourceMetadata(config));
    assert.deepEqual(metadata.authorization_servers, [ISSUER]);
    assert.equal(metadata.resource, `${GATEWAY}/mcp`);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  });

  test('one issuer everywhere (SEP-2352): resource metadata, the legacy metadata and the token check name the same string', () => {
    // The client keys its stored credentials by the issuer of Authentik's own discovery
    // document, after checking it echoes the URL taken from authorization_servers
    // (RFC 8414 3.3, exact string). So the gateway must publish Authentik's issuer
    // verbatim, trailing slash included, and verify tokens against that same string.
    const derived = gatewayConfigFromEnv({ BASE_DOMAIN: 'cloud.test' });
    assert.equal(derived.issuer, ISSUER);
    assert.equal(gatewayConfigFromEnv({ BASE_DOMAIN: 'cloud.localhost' }).issuer, 'http://auth.cloud.localhost/application/o/ihc-mcp/');
    assert.deepEqual(protectedResourceMetadata(derived).authorization_servers, [derived.issuer]);
    assert.equal(authorizationServerMetadata(derived).issuer, derived.issuer);
    assert.equal(authorizationServerMetadata(derived).jwks_uri, `${ISSUER}jwks/`);
    assert.equal(protectedResourceMetadata(derived).resource, `${GATEWAY}/mcp`);
  });

  test('someone outside ihc-users: 403', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, accessToken(ak, { groups: ['other'] }));
    assert.equal(response.status, 403);
    assert.match(response.headers.get('www-authenticate'), /insufficient_scope/);
  });

  test('initialize, notifications, tools/list and tools/call for a viewer', async () => {
    const token = accessToken(ak);
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, token)).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token)).json();
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['ihc_list_apps', 'notes__ping']);
    const ping = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notes__ping', arguments: {} } }, token)).json();
    assert.equal(ping.result.isError, false);
    assert.deepEqual(ping.result.structuredContent, { pong: true });
    const denied = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'locked__ping', arguments: {} } }, token)).json();
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /access denied/);
    const people = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ihc_list_people', arguments: {} } }, token)).json();
    assert.equal(people.result.isError, true);
    const unknown = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }, token)).json();
    assert.equal(unknown.error.code, -32602);
    const missing = await (await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/read' }, token)).json();
    assert.equal(missing.error.code, -32601);
  });

  test('admins see the admin tools; GET /mcp is 405; /health and the JWKS are public', async () => {
    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, accessToken(ak, { groups: ['ihc-users', 'ihc-admins'] }))).json();
    assert.ok(list.result.tools.some((tool) => tool.name === 'ihc_list_people'));
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
    const jwks = await (await fetch(`${base}/.well-known/jwks.json`)).json();
    assert.equal(jwks.keys[0].alg, 'RS256');
    assert.equal(jwks.keys[0].d, undefined, 'never the private part');
  });

  test('invalid JSON is a JSON-RPC parse error', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken(ak)}` }, body: '{' });
    assert.equal((await response.json()).error.code, -32700);
  });
});

// O app do template (templates/app/server.js) contra um actor JWT de verdade: a camada 1
// do contrato, sem Docker. O JWKS do gateway vem de um servidor local.
describe('the template app validates the actor JWT', () => {
  const signer = createActorSigner({ ...key(), issuer: GATEWAY });
  let jwksServer;
  let child;
  let base;

  before(async () => {
    jwksServer = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(signer.jwks())); });
    await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const port = 20000 + Math.floor(Math.random() * 20000);
    child = spawn(process.execPath, [path.resolve(here, '..', '..', 'templates', 'app', 'server.js')], {
      env: { ...process.env, PORT: String(port), APP_SLUG: 'notes', IHC_MCP_ISSUER: GATEWAY, IHC_MCP_JWKS_URL: `http://127.0.0.1:${jwksServer.address().port}/`, IHC_MCP_AUDIENCE: 'notes.mcp' },
      stdio: 'ignore',
    });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('template app did not start');
  });
  after(() => { child?.kill(); jwksServer?.close(); });

  const call = (token, method = 'POST', route = '/mcp/tools/ping/execute') => fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify({ arguments: {} }) : undefined,
  });

  test('ping with notes.read: 200 and who asked', async () => {
    const response = await call(signer.issue({ audience: 'notes.mcp', scopes: ['notes.read'], user: viewer }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.pong, true);
    assert.equal(body.result.email, 'ana@example.com');
    const tools = await (await call(signer.issue({ audience: 'notes.mcp', scopes: ['notes.read'], user: viewer }), 'GET', '/mcp/tools')).json();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ['ping']);
  });

  test('without the scope: 403; no token, another audience, another key: 401', async () => {
    assert.equal((await call(signer.issue({ audience: 'notes.mcp', scopes: ['notes.other'], user: viewer }))).status, 403);
    assert.equal((await call(null)).status, 401);
    assert.equal((await call(signer.issue({ audience: 'billing.mcp', scopes: ['notes.read'], user: viewer }))).status, 401);
    const stranger = createActorSigner({ ...key(), issuer: GATEWAY });
    assert.equal((await call(stranger.issue({ audience: 'notes.mcp', scopes: ['notes.read'], user: viewer }))).status, 401);
  });
});

describe('the manifest section mcp', () => {
  const base = {
    schema_version: 1,
    app: { slug: 'notes', name: 'Notes', owner_email: 'a@example.com' },
    runtime: { type: 'docker-compose', compose_file: 'docker-compose.yml', service: 'app', healthcheck: { type: 'http', path: '/health', expected_status: 200 } },
    deploy: { enabled: true, domain: 'notes.cloud.localhost', port: 'auto', env_file: '.env', env_example: '.env.example' },
    auth: { required: true, provider: 'forward-auth' },
  };
  const issuesFor = (mcp) => validateManifest({ ...base, mcp }, { skipFileChecks: true }).issues.filter((item) => item.path.startsWith('mcp'));

  test('the template form is valid; a foreign audience or scope, a bad path or no grant is not', () => {
    assert.deepEqual(issuesFor({ audience: 'notes.mcp', tools_path: '/mcp/tools', execute_path: '/mcp/tools/{tool}/execute', scopes: { 'notes.read': ['ihc-users'] } }), []);
    assert.ok(issuesFor({ audience: 'billing.mcp', scopes: { 'notes.read': ['ihc-users'] } }).some((item) => item.path === 'mcp.audience'));
    assert.ok(issuesFor({ scopes: { 'billing.read': ['ihc-users'] } }).length > 0);
    assert.ok(issuesFor({ scopes: { 'notes.read': [] } }).length > 0);
    assert.ok(issuesFor({ scopes: {} }).length > 0);
    assert.ok(issuesFor({ execute_path: '/mcp/run', scopes: { 'notes.read': ['ihc-users'] } }).length > 0);
  });
});
