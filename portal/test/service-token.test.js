import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createAuth } from '../src/auth.js';
import { SERVICE_TOKEN_PATHS, isServiceTokenRoute } from '../src/service-token.js';

const TOKEN = 'portal-api-token-for-tests';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function apiRoutes(app) {
  const routes = [];
  for (const layer of app.router.stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue;
    if (!layer.route.path.startsWith('/api/') && layer.route.path !== '/logout') continue;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({
        method: method.toUpperCase(),
        pattern: layer.route.path,
        path: layer.route.path
          .replace(':slug', 'pedidos')
          .replace(':name', 'proposal-app-1')
          .replace(':email', 'alguem%40example.com'),
      });
    }
  }
  return routes;
}

const platformStatus = {
  async collect() {
    return {
      checked_at: '2026-10-22T00:00:00.000Z',
      overall: 'healthy',
      summary: { total: 1, healthy: 1, unhealthy: 0, unknown: 0 },
      services: [{ name: 'Redis compartilhado', kind: 'cache', healthy: true, detail: 'PONG', checked_at: '2026-10-22T00:00:00.000Z' }],
      links: {},
      topology: {},
    };
  },
};

function tokenApp(overrides = {}) {
  return createApp({
    auth: createAuth({ superAdminEmails: 'ana@example.com', portalUserDomains: 'example.com' }),
    catalogMcpToken: 'catalog-token',
    portalApiToken: TOKEN,
    platformStatus,
    listDockerContainersFn: () => ({ available: true, containers: [] }),
    listHttpHealthFn: async () => ({ available: true, checks: [] }),
    recordStatusPingsFn: async () => ({ available: true, recorded: 0, pings: [] }),
    giteaState: {
      async listAppDeploys() { return { available: true, runs: [] }; },
      async latestAppDeploy() { return { available: true, runs: [], latest: null }; },
    },
    ...overrides,
  });
}

const bearer = (value) => ({ authorization: `Bearer ${value}` });

test('the token opens GET /api/platform/status and health only', () => {
  assert.deepEqual([...SERVICE_TOKEN_PATHS].sort(), ['/api/health', '/api/platform/status', '/health']);
  assert.equal(isServiceTokenRoute('/api/platform/status', 'GET'), true);
  assert.equal(isServiceTokenRoute('/api/platform/status/', 'HEAD'), true);
  assert.equal(isServiceTokenRoute('/api/platform/status', 'POST'), false);
  assert.equal(isServiceTokenRoute('/api/platform/status/refresh', 'POST'), false);
  assert.equal(isServiceTokenRoute('/api/platform/config', 'GET'), false);
});

test('GET /api/platform/status with the token answers the status JSON without a session', async () => {
  const { server, baseUrl } = await listen(tokenApp());
  try {
    const response = await fetch(`${baseUrl}/api/platform/status`, { headers: bearer(TOKEN) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.overall, 'healthy');
    assert.equal(body.summary.total, 1);
    assert.equal(body.services[0].name, 'Redis compartilhado');

    const health = await fetch(`${baseUrl}/health`, { headers: bearer(TOKEN) });
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});

test('a wrong token, or another scheme, answers 401', async () => {
  const { server, baseUrl } = await listen(tokenApp());
  try {
    for (const authorization of ['Bearer wrong-token', `Bearer ${TOKEN}x`, `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}`, 'Bearer']) {
      for (const path of ['/api/platform/status', '/api/apps', '/']) {
        const response = await fetch(`${baseUrl}${path}`, { headers: { authorization }, redirect: 'manual' });
        assert.equal(response.status, 401, `${authorization.split(' ')[0]} ${path}`);
      }
    }
  } finally {
    server.close();
  }
});

test('the right token on every other route answers 403, even with forged identity headers', async () => {
  const app = tokenApp();
  const routes = apiRoutes(app).filter((route) => !route.pattern.startsWith('/api/internal/mcp/v1/'))
    .filter((route) => !isServiceTokenRoute(route.pattern, route.method));
  assert.ok(routes.length > 20, `expected the full route table, got ${routes.length}`);
  routes.push({ method: 'GET', path: '/' }, { method: 'GET', path: '/plataforma' }, { method: 'POST', path: '/api/platform/status' });

  const { server, baseUrl } = await listen(app);
  try {
    for (const route of routes) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: {
          ...bearer(TOKEN),
          'x-authentik-email': 'ana@example.com',
          'x-authentik-groups': 'ihc-admins',
          ...(route.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        body: route.method === 'GET' ? undefined : '{}',
        redirect: 'manual',
      });
      assert.equal(response.status, 403, `${route.method} ${route.path}`);
      assert.equal((await response.json()).error, 'forbidden');
    }
  } finally {
    server.close();
  }
});

test('a portal without IHC_PORTAL_API_TOKEN fails closed with 503', async () => {
  const { server, baseUrl } = await listen(tokenApp({ portalApiToken: '' }));
  try {
    const response = await fetch(`${baseUrl}/api/platform/status`, { headers: bearer(TOKEN) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'portal_api_token_not_configured');
    assert.equal((await fetch(`${baseUrl}/api/apps`, { headers: bearer(TOKEN) })).status, 401);
    const anonymous = await fetch(`${baseUrl}/api/platform/status`);
    assert.equal(anonymous.status, 401);
  } finally {
    server.close();
  }
});

test('without Authorization nothing changes: no session is 401, the session still works', async () => {
  const { server, baseUrl } = await listen(tokenApp());
  try {
    assert.equal((await fetch(`${baseUrl}/api/platform/status`)).status, 401);
    const withSession = await fetch(`${baseUrl}/api/platform/status`, { headers: { 'x-authentik-email': 'ana@example.com' } });
    assert.equal(withSession.status, 200);
  } finally {
    server.close();
  }
});

test('the catalog MCP provider keeps its own token; the portal token does not open it', async () => {
  const { server, baseUrl } = await listen(tokenApp());
  try {
    assert.equal((await fetch(`${baseUrl}/api/internal/mcp/v1/tools`, { headers: bearer('catalog-token') })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/internal/mcp/v1/tools`, { headers: bearer(TOKEN) })).status, 401);
  } finally {
    server.close();
  }
});
