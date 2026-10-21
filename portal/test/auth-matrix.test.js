import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLIC_API_PATHS, createApp, isPublicApiPath, resolveListenHost } from '../src/server.js';
import { createAuth } from '../src/auth.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

// Lista toda rota /api registrada no Express, com metodo e caminho concreto.
function apiRoutes(app) {
  const routes = [];
  for (const layer of app.router.stack) {
    if (!layer.route || typeof layer.route.path !== 'string') continue;
    if (!layer.route.path.startsWith('/api/')) continue;
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

function authentikApp(overrides = {}) {
  return createApp({
    auth: createAuth({
      superAdminEmails: 'ana@example.com',
      portalUserDomains: 'example.com',
    }),
    catalogMcpToken: 'catalog-token',
    listDockerContainersFn: () => ({ available: true, containers: [] }),
    listNpmProxyHostsFn: async () => ({ available: true, proxy_hosts: [] }),
    listHttpHealthFn: async (apps) => ({
      available: true,
      checked_at: '2026-10-16T00:00:00.000Z',
      timeout_ms: 1,
      checks: apps.map((app) => ({ slug: app.slug, checked: false, ok: false, url: null, status: null, latency_ms: null, error: 'skipped' })),
    }),
    recordStatusPingsFn: async () => ({ available: true, recorded: 0, pings: [] }),
    giteaState: {
      async listAppDeploys(app) {
        return { available: true, source: 'gitea-actions', repo: 'company/x', error: null, cached: false, fetched_at: null, app_slug: app.slug, runs: [] };
      },
      async latestAppDeploy(app) {
        return { available: true, source: 'gitea-actions', repo: 'company/x', error: null, app_slug: app.slug, runs: [], latest: null };
      },
    },
    ...overrides,
  });
}

// O provider do mcp-gateway nao usa sessao: tem token proprio e e testado abaixo.
function isCatalogMcpRoute(path) {
  return path.startsWith('/api/internal/mcp/v1/');
}

test('every /api route answers 401 without a session, except health', async () => {
  const app = authentikApp();
  const routes = apiRoutes(app).filter((route) => !isCatalogMcpRoute(route.pattern));
  assert.ok(routes.length > 20, `expected the full route table, got ${routes.length}`);

  const { server, baseUrl } = await listen(app);
  try {
    for (const route of routes) {
      const response = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === 'GET' ? {} : { 'content-type': 'application/json' },
        body: route.method === 'GET' ? undefined : '{}',
        redirect: 'manual',
      });
      const publicPath = isPublicApiPath(route.pattern.replace(/^\/api/, ''), route.method);
      if (publicPath) {
        assert.equal(response.status, 200, `${route.method} ${route.path} should be public`);
      } else {
        assert.equal(response.status, 401, `${route.method} ${route.path} answered ${response.status} anonymously`);
      }
    }
  } finally {
    server.close();
  }
});

test('the only public /api path is the health endpoint', () => {
  assert.deepEqual([...PUBLIC_API_PATHS], ['/health']);
  assert.equal(isPublicApiPath('/health'), true);
  assert.equal(isPublicApiPath('/health', 'POST'), false);
  assert.equal(isPublicApiPath('/apps'), false);
  assert.equal(isPublicApiPath('/apps-status'), false);
  assert.equal(isPublicApiPath('/platform/status'), false);
});

test('the deploy request, GitOps and Claude Code routes are gone', async () => {
  const app = authentikApp();
  const patterns = apiRoutes(app).map((route) => route.pattern);
  for (const prefix of ['/api/claude-code', '/api/gitops', '/api/deploy-requests', '/api/repo-discovery', '/api/access-usage', '/api/platform-docs']) {
    assert.equal(patterns.some((pattern) => pattern.startsWith(prefix)), false, `${prefix} is still registered`);
  }
  assert.equal(patterns.includes('/api/apps/:slug/events'), false);
});

test('domain viewers can read every read-only route but not admin routes', async () => {
  const app = authentikApp();
  const { server, baseUrl } = await listen(app);
  const viewer = { 'x-authentik-email': 'bruno@example.com', 'x-authentik-name': 'Bruno' };
  try {
    for (const path of ['/api/apps', '/api/apps/pedidos', '/api/apps-status', '/api/runtime/docker', '/api/apps-runtime', '/api/runtime/npm', '/api/apps-npm', '/api/runtime/health', '/api/apps/pedidos/deploys', '/api/apps/pedidos/latest-deploy', '/api/platform/config', '/api/me']) {
      const response = await fetch(`${baseUrl}${path}`, { headers: viewer });
      assert.equal(response.status, 200, `${path} answered ${response.status} for a viewer`);
    }

    for (const [method, path] of [
      ['GET', '/api/admins'],
      ['GET', '/api/disk-usage-snapshots'],
      ['PATCH', '/api/apps/pedidos/metadata'],
      ['PATCH', '/api/runtime/docker/proposal-app-1/metadata'],
      ['POST', '/api/platform/status/refresh'],
      ['POST', '/api/apps-status/refresh'],
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { ...viewer, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      assert.equal(response.status, 403, `${method} ${path} answered ${response.status} for a viewer`);
    }
  } finally {
    server.close();
  }
});

test('a bearer token never replaces the Authentik session, and the catalog token opens only the MCP provider', async () => {
  const app = authentikApp();
  const { server, baseUrl } = await listen(app);
  try {
    for (const token of ['nope', 'catalog-token']) {
      const response = await fetch(`${baseUrl}/api/apps`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401, `Bearer ${token} opened /api/apps`);
    }

    const mcp = await fetch(`${baseUrl}/api/internal/mcp/v1/tools`, { headers: { authorization: 'Bearer catalog-token' } });
    assert.equal(mcp.status, 200);

    const sessionOnMcp = await fetch(`${baseUrl}/api/internal/mcp/v1/tools`, {
      headers: { 'x-authentik-email': 'ana@example.com' },
    });
    assert.equal(sessionOnMcp.status, 401);
  } finally {
    server.close();
  }
});

test('Authentik is the only provider: no Google settings, no session cookie', async () => {
  const auth = createAuth({ superAdminEmails: 'ana@example.com', portalUserDomains: 'example.com' });
  assert.equal(auth.provider, 'authentik');
  assert.equal('hostedDomain' in auth, false);
  assert.equal(auth.isConfigured(), true);
  assert.equal(createAuth({ superAdminEmails: '', portalUserDomains: '' }).isConfigured(), false);

  const { server, baseUrl } = await listen(createApp({ auth }));
  try {
    for (const path of ['/auth/google', '/auth/google/callback']) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 404, `${path} answered ${response.status}`);
    }

    const forged = await fetch(`${baseUrl}/api/me`, { headers: { cookie: 'edp_session=forged.value' } });
    assert.equal(forged.status, 401);

    const viaHeaders = await fetch(`${baseUrl}/api/me`, { headers: { 'x-authentik-email': 'ana@example.com' } });
    assert.equal(viaHeaders.status, 200);
    assert.equal((await viaHeaders.json()).user.source, 'authentik');
  } finally {
    server.close();
  }
});

test('the server binds to loopback unless HOST says otherwise', () => {
  assert.equal(resolveListenHost({}), '127.0.0.1');
  assert.equal(resolveListenHost({ HOST: '' }), '127.0.0.1');
  assert.equal(resolveListenHost({ HOST: '0.0.0.0' }), '0.0.0.0');
});
