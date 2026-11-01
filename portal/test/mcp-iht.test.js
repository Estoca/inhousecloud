import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessTokenVerifier } from '../src/mcp-auth.js';
import { createActorSigner, loadOrCreateSigningKey, signJwt, verifyJwt } from '../src/jwt.js';
import { createGatewayApp, gatewayConfigFromEnv } from '../src/mcp-gateway.js';

const issuer = 'https://inhouse.technology';
const gateway = 'https://mcp.cloud.test';
const instant = 1800000000;
function setup() {
  const key = loadOrCreateSigningKey(null);
  let current = key, requests = [];
  const verifier = createAccessTokenVerifier({ issuer: 'https://auth.test', audience: 'ihc-mcp', jwksUrl: 'https://auth.test/jwks',
    ihtIssuer: issuer, publicUrl: gateway, allowedDomains: ['acme.test'], allowedPeople: ['guest@other.test'], now: () => instant * 1000,
    fetchFn: async url => {
      requests.push(url);
      return new Response(JSON.stringify({ keys: [{ ...crypto.createPublicKey(current.privateKey).export({ format: 'jwk' }), kid: current.kid }] }));
    } });
  const token = overrides => signJwt({ iss: issuer, aud: gateway, email: 'ana@acme.test', email_verified: true,
    iht_kind: 'instance_access', role: 'admin', iat: instant, exp: instant + 300, ...overrides }, current);
  return { verifier, token, requests, rotate: () => { current = loadOrCreateSigningKey(null); } };
}
test('iht roles, allowlists, cache and immediate key rotation; same actor identity downstream', async () => {
  const s = setup();
  const admin = await s.verifier.verify(s.token());
  assert.equal(admin.ok, true);
  assert.deepEqual(admin.user.groups, ['ihc-users', 'ihc-admins']);
  const member = await s.verifier.verify(s.token({ role: 'member', groups: ['ihc-admins'] }));
  assert.equal(member.user.admin, false);
  assert.deepEqual(member.user.groups, ['ihc-users']);
  assert.equal((await s.verifier.verify(s.token({ email: 'guest@other.test' }))).ok, true);
  assert.equal((await s.verifier.verify(s.token({ email: 'eve@other.test' }))).status, 403);
  assert.deepEqual(s.requests, [issuer + '/.well-known/jwks.json']);
  s.rotate();
  assert.equal((await s.verifier.verify(s.token())).ok, true);
  assert.equal(s.requests.length, 2);
  const actor = createActorSigner({ ...loadOrCreateSigningKey(null), issuer: gateway });
  const downstream = verifyJwt(actor.issue({ audience: 'app', user: admin.user, confirmedBy: 'bia@acme.test' }),
    { keys: actor.jwks().keys, audience: 'app', issuer: gateway });
  assert.equal(downstream.email, 'ana@acme.test');
  assert.equal(downstream.confirmed_by, 'bia@acme.test');
  assert.deepEqual(downstream.groups, admin.user.groups);
});
test('iht tokens require exact audience/issuer, kind, verified email, bounded lifetime and known role', async () => {
  const s = setup();
  for (const claims of [{ aud: gateway + '/' }, { aud: gateway + '/mcp' }, { aud: 'ihc-mcp' }, { iss: issuer + '/' },
    { iht_kind: 'id_token' }, { email_verified: false }, { email_verified: 'true' }, { role: 'owner' },
    { exp: instant + 301 }, { iat: instant + 1 }, { iat: null }, { exp: instant }, { email: '' }, { email: 'evil@acme.test@other.test' }]) {
    assert.equal((await s.verifier.verify(s.token(claims))).status, 401, JSON.stringify(claims));
  }
  const forged = s.token().split('.'); forged[2] = Buffer.from('bad').toString('base64url');
  assert.equal((await s.verifier.verify(forged.join('.'))).status, 401);
});
test('iht opt in and key outages fail closed; config uses installer emails as company boundary', async () => {
  const config = gatewayConfigFromEnv({ IHT_ISSUER: issuer + '/', SUPER_ADMIN_EMAILS: 'Ana@acme.test' });
  assert.equal(config.ihtIssuer, issuer);
  assert.deepEqual(config.allowedDomains, ['acme.test']);
  const s = setup();
  const disabled = createAccessTokenVerifier({ issuer: 'auth', audience: 'ihc-mcp', fetchFn: async () => { throw Error(); } });
  assert.equal((await disabled.verify(s.token())).ok, false);
  const unavailable = createAccessTokenVerifier({ ihtIssuer: issuer, publicUrl: gateway, fetchFn: async () => { throw Error(); } });
  assert.equal((await unavailable.verify(s.token())).status, 503);
});

test('both issuers reach the same gateway policy, confirmation and audit path', async () => {
  const s = setup();
  const recorded = [], approvals = [];
  const config = gatewayConfigFromEnv({ IHT_ISSUER: issuer, SUPER_ADMIN_EMAILS: 'ana@acme.test' });
  const app = createGatewayApp({ config, verifier: s.verifier, signer: {}, log: () => {},
    listAppsFn: () => [],
    providerGateway: {
      listTools: async () => ({ tools: [] }),
      prepareCall: async () => ({ access: 'write', name: 'notes__write', provider: { slug: 'notes' } }),
      execute: async (user, plan, args, options) => {
        assert.equal(user.email, 'ana@acme.test');
        assert.equal(options.confirmedBy, 'bia@acme.test');
        assert.deepEqual(args, { text: 'approved change' });
        return { result: { saved: true } };
      },
    },
    confirmers: { resolve: async value => { approvals.push(value); return { email: value }; } },
    audit: { configured: true, record: async row => { recorded.push(row); return { ok: true }; } },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const post = async (token, method, params) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    for (const [token, isAdmin] of [[s.token(), true], [s.token({ role: 'member' }), false],
      [s.token({ iss: 'https://auth.test', aud: 'ihc-mcp', groups: ['ihc-users'] }), false]]) {
      const result = await post(token, 'tools/list');
      assert.equal(result.tools.some(t => t.name === 'ihc_platform_status'), isAdmin);
    }
    const result = await post(s.token(), 'tools/call', { name: 'notes__write',
      arguments: { text: 'approved change', confirmed_by: 'bia@acme.test' } });
    assert.equal(result.isError, false);
    assert.deepEqual(approvals, ['bia@acme.test']);
    assert.deepEqual(recorded.map(r => [r.actor.email, r.confirmedBy, r.phase]),
      [['ana@acme.test', 'bia@acme.test', 'requested'], ['ana@acme.test', 'bia@acme.test', 'completed']]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('a made-up kid forces one JWKS refetch, then waits the minimum interval', async () => {
  const s = setup();
  assert.equal((await s.verifier.verify(s.token())).ok, true);
  const forged = s.token().split('.');
  const header = JSON.parse(Buffer.from(forged[0], 'base64url').toString());
  forged[0] = Buffer.from(JSON.stringify({ ...header, kid: 'made-up' })).toString('base64url');
  for (let i = 0; i < 5; i += 1) assert.equal((await s.verifier.verify(forged.join('.'))).ok, false);
  assert.equal(s.requests.length, 2); // the first fetch plus one for the unknown kid, not one per request
});
