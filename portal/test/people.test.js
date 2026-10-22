import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createAuth } from '../src/auth.js';
import { createAuthentikDirectory } from '../src/authentik-directory.js';
import { createStatusCache } from '../src/status-cache.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// A fake Authentik API: two pages of users, one of groups. Records every request.
function fakeAuthentik() {
  const calls = [];
  const users = [
    { pk: 1, username: 'akadmin', name: 'authentik Default Admin', email: 'admin@example.com', is_active: true, is_superuser: true, type: 'internal', groups_obj: [{ name: 'ihc-users' }, { name: 'ihc-admins' }] },
    { pk: 2, username: 'ak-outpost-embedded', name: 'Outpost', email: '', is_active: true, type: 'internal_service_account', groups_obj: [] },
    { pk: 3, username: 'bia', name: 'Bia', email: 'bia@example.com', is_active: false, type: 'internal', groups_obj: [{ name: 'ihc-users' }] },
  ];
  const groups = [
    { pk: 'g1', name: 'ihc-admins', is_superuser: false, users_obj: [users[0]] },
    { pk: 'g2', name: 'ihc-users', is_superuser: false, users_obj: [users[2], users[0], users[1]] },
  ];
  async function fetchFn(url, init) {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    let body;
    if (u.pathname === '/api/v3/core/users/') {
      body = page === 1
        ? { pagination: { next: 2 }, results: users.slice(0, 2) }
        : { pagination: { next: 0 }, results: users.slice(2) };
    } else if (u.pathname === '/api/v3/core/groups/') {
      body = { pagination: { next: 0 }, results: groups };
    } else {
      return new Response('{}', { status: 404 });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return { calls, fetchFn };
}

test('the directory reads every page with the token, by GET only, and leaves internal accounts out', async () => {
  const fake = fakeAuthentik();
  const directory = createAuthentikDirectory({ baseUrl: 'http://authentik-server:9000/', token: 'tok', fetchFn: fake.fetchFn });
  assert.equal(directory.configured, true);
  const users = await directory.listUsers();
  assert.deepEqual(users.map((u) => u.username), ['akadmin', 'bia']);
  assert.deepEqual(users[0].groups, ['ihc-admins', 'ihc-users']);
  assert.equal(users[1].is_active, false);
  const groups = await directory.listGroups();
  assert.deepEqual(groups.map((g) => [g.name, g.member_count]), [['ihc-admins', 1], ['ihc-users', 2]]);
  assert.deepEqual(groups[1].members.map((m) => m.username), ['akadmin', 'bia']);
  assert.ok(fake.calls.length === 3);
  for (const call of fake.calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.auth, 'Bearer tok');
    assert.ok(call.url.startsWith('http://authentik-server:9000/api/v3/core/'), call.url);
  }
});

test('without a token the directory is not configured', () => {
  assert.equal(createAuthentikDirectory({ baseUrl: 'http://a', token: '' }).configured, false);
  assert.equal(createAuthentikDirectory({ baseUrl: '', token: 'x' }).configured, false);
});

function peopleApp(directory) {
  return createApp({
    auth: createAuth({ superAdminEmails: '', portalUserDomains: '', allowDomainUsers: false, isPortalAdminFn: async () => ({ available: true, allowed: false, admin: null }) }),
    listDockerContainersFn: () => ({ available: true, containers: [] }),
    statusCache: createStatusCache({ redisUrl: '' }),
    authentikDirectory: directory,
  });
}

const admin = { 'x-authentik-email': 'admin@example.com', 'x-authentik-groups': 'ihc-users|ihc-admins' };
const user = { 'x-authentik-email': 'bia@example.com', 'x-authentik-groups': 'ihc-users' };

test('GET /api/people and /api/groups: admin 200 from the cache, ihc-users 403, anonymous 401', async () => {
  const fake = fakeAuthentik();
  const app = peopleApp(createAuthentikDirectory({ baseUrl: 'http://authentik-server:9000', token: 'tok', fetchFn: fake.fetchFn }));
  const { server, baseUrl } = await listen(app);
  try {
    const people = await fetch(`${baseUrl}/api/people`, { headers: admin });
    assert.equal(people.status, 200);
    const body = await people.json();
    assert.equal(body.source, 'authentik');
    assert.equal(body.count, 2);
    assert.equal(body.cached, false);
    assert.equal(JSON.stringify(body).includes('tok'), false, 'the token never reaches the answer');

    const again = await (await fetch(`${baseUrl}/api/people`, { headers: admin })).json();
    assert.equal(again.cached, true);
    assert.equal(fake.calls.filter((c) => c.url.includes('/core/users/')).length, 2, 'served from the cache the second time');

    const groups = await (await fetch(`${baseUrl}/api/groups`, { headers: admin })).json();
    assert.deepEqual(groups.groups.map((g) => g.name), ['ihc-admins', 'ihc-users']);

    for (const path of ['/api/people', '/api/groups']) {
      assert.equal((await fetch(`${baseUrl}${path}`, { headers: user })).status, 403);
      assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
    }
  } finally {
    server.close();
  }
});

test('no token: 503 that says what to run; Authentik failing: 502 without its body', async () => {
  let { server, baseUrl } = await listen(peopleApp(createAuthentikDirectory({ baseUrl: 'http://authentik-server:9000', token: '' })));
  try {
    const response = await fetch(`${baseUrl}/api/people`, { headers: admin });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'authentik_directory_not_configured');
  } finally {
    server.close();
  }
  const failing = async () => new Response('{"detail":"echo of secret"}', { status: 403 });
  ({ server, baseUrl } = await listen(peopleApp(createAuthentikDirectory({ baseUrl: 'http://authentik-server:9000', token: 'tok', fetchFn: failing }))));
  try {
    const response = await fetch(`${baseUrl}/api/groups`, { headers: admin });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'authentik_unavailable');
    assert.match(body.detail, /HTTP 403/);
    assert.equal(JSON.stringify(body).includes('secret'), false);
  } finally {
    server.close();
  }
});
