import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createAuth } from '../src/auth.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

// Sessao de admin via headers do Authentik, para as rotas que exigem login.
function adminAuth() {
  return createAuth({
    superAdminEmails: 'ana@example.com',
    portalUserDomains: 'example.com',
  });
}

const asAdmin = {
  headers: {
    'x-authentik-email': 'ana@example.com',
    'x-authentik-name': 'Ana',
  },
};

test('GET /api/health returns ok', async () => {
  const { server, baseUrl } = await listen(createApp());
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'inhousecloud-portal',
      commit_hash: process.env.COMMIT_SHA || process.env.GIT_SHA || 'unknown',
      migrations: { ok: null, skipped: true },
    });
    // /health at the root is the same answer (the proxy keeps location = /health public)
    const root = await fetch(`${baseUrl}/health`);
    assert.equal(root.status, 200);
    assert.equal((await root.json()).ok, true);
  } finally {
    server.close();
  }
});

test('GET / redirects unauthenticated users to login', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: createAuth({
      superAdminEmails: 'ana@example.com',
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  } finally {
    server.close();
  }
});

test('Authentik headers grant dashboard access for super admin and domain viewers', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: createAuth({
        superAdminEmails: 'ana@example.com',
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/`, {
      headers: {
        'x-authentik-email': 'ana@example.com',
        'x-authentik-name': 'Ana',
        'x-authentik-groups': 'admins',
      },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /InHouseCloud/);

    const me = await fetch(`${baseUrl}/api/me`, {
      headers: {
        'x-authentik-email': 'ana@example.com',
        'x-authentik-name': 'Ana',
        'x-authentik-groups': 'admins',
      },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.email, 'ana@example.com');

    const viewer = await fetch(`${baseUrl}/api/me`, {
      headers: {
        'x-authentik-email': 'bruno@example.com',
        'x-authentik-name': 'Bruno',
      },
    });
    assert.equal(viewer.status, 200);
    const viewerBody = await viewer.json();
    assert.equal(viewerBody.user.email, 'bruno@example.com');
    assert.equal(viewerBody.user.role, 'viewer');

    const unauthorized = await fetch(`${baseUrl}/`, {
      redirect: 'manual',
      headers: {
        'x-authentik-email': 'outra@other.example',
      },
    });
    assert.equal(unauthorized.status, 302);
    assert.equal(unauthorized.headers.get('location'), '/login');
  } finally {
    server.close();
  }
});

test('logout hands the session back to the Authentik outpost', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth() }));
  try {
    const response = await fetch(`${baseUrl}/logout`, { method: 'POST', redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/outpost.goauthentik.io/sign_out');

    const google = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
    assert.equal(google.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/admins requires super admin and returns bootstrap admins', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: createAuth({
        superAdminEmails: 'ana@example.com',
    }),
    listPortalAdminsFn: async ({ bootstrapAdmins }) => ({
      available: true,
      admins: bootstrapAdmins.map((email) => ({
        id: `env:${email}`,
        email,
        role: 'super_admin',
        active: true,
        source: 'env',
      })),
    }),
  }));
  try {
    const unauthorized = await fetch(`${baseUrl}/api/admins`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/api/admins`, {
      headers: {
        'x-authentik-email': 'ana@example.com',
      },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.admins[0].email, 'ana@example.com');
  } finally {
    server.close();
  }
});

test('POST /api/admins creates portal admins for super admins', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: createAuth({
        superAdminEmails: 'ana@example.com',
    }),
    upsertPortalAdminFn: async (body, options) => ({
      available: true,
      ok: true,
      admin: {
        email: body.email,
        role: body.role,
        active: true,
        source: 'portal',
        actor: options.actorEmail,
      },
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/api/admins`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-authentik-email': 'ana@example.com',
      },
      body: JSON.stringify({
        email: 'ana@example.com',
        role: 'admin',
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.admin.email, 'ana@example.com');
    assert.equal(body.admin.actor, 'ana@example.com');
  } finally {
    server.close();
  }
});

test('GET /api/apps returns inventory', async () => {
  // O inventario real vive fora do repo (INVENTORY_PATH); o teste usa uma fixture
  // para nao depender do arquivo em disco de quem roda a suite.
  const previousInventoryPath = process.env.INVENTORY_PATH;
  process.env.INVENTORY_PATH = new URL('./fixtures/inventory.json', import.meta.url).pathname;
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth() }));
  try {
    const response = await fetch(`${baseUrl}/api/apps`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, 'test/fixtures/inventory.json');
    assert.equal(body.example, undefined);
    assert.ok(body.count >= 20);
    assert.ok(body.apps.some((app) => app.slug === 'pedidos'));
  } finally {
    server.close();
    if (previousInventoryPath === undefined) delete process.env.INVENTORY_PATH;
    else process.env.INVENTORY_PATH = previousInventoryPath;
  }
});

test('GET /api/apps/:slug returns one app', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth() }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/pedidos`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.app.domain, 'pedidos.cloud.localhost');
    assert.equal(body.app.port, 8200);
    assert.deepEqual(body.app.status, ['OK']);
  } finally {
    server.close();
  }
});

test('GET /api/apps/:slug returns 404 for unknown app', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth() }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/desconhecido`, asAdmin);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'app_not_found',
    });
  } finally {
    server.close();
  }
});

function fakeGiteaState({ runs = [], available = true, error = null } = {}) {
  const calls = [];
  const result = {
    available,
    source: 'gitea-actions',
    repo: available ? 'company/inhousecloud-portal' : null,
    error,
    cached: false,
    fetched_at: '2026-10-16T12:00:00.000Z',
  };
  return {
    calls,
    async listAppDeploys(app, options) {
      calls.push({ fn: 'listAppDeploys', slug: app.slug, options });
      return { ...result, app_slug: app.slug, runs: runs.slice(0, options?.limit ?? 20) };
    },
    async latestAppDeploy(app) {
      calls.push({ fn: 'latestAppDeploy', slug: app.slug });
      return { ...result, app_slug: app.slug, runs: runs.slice(0, 1), latest: runs[0] ?? null };
    },
  };
}

const sampleRun = {
  id: 39243,
  run_number: 122,
  repo_full_name: 'company/inhousecloud-portal',
  workflow: 'validate.yml',
  title: 'Avoid sourcing app env in workflows',
  event: 'push',
  branch: 'main',
  status: 'success',
  outcome: 'success',
  commit_sha: '52d2be3371ee522d52892ed4024f0c6ff1da184a',
  short_sha: '52d2be3',
  actor: 'ana',
  started_at: '2026-09-23T14:22:24.000Z',
  finished_at: '2026-09-23T14:22:50.000Z',
  duration_ms: 26000,
  url: 'https://git.cloud.localhost/company/inhousecloud-portal/actions/runs/122',
  source: 'gitea-actions',
};

test('GET /api/apps/:slug/deploys returns Gitea Actions history for the app', async () => {
  const giteaState = fakeGiteaState({ runs: [sampleRun, { ...sampleRun, id: 39242, run_number: 121, outcome: 'failed', status: 'failure' }] });
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth(), giteaState }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/portal/deploys?limit=1`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.app_slug, 'portal');
    assert.equal(body.source, 'gitea-actions');
    assert.equal(body.repo, 'company/inhousecloud-portal');
    assert.equal(body.available, true);
    assert.equal(body.count, 1);
    assert.equal(body.deploys[0].outcome, 'success');
    assert.equal(body.deploys[0].url, sampleRun.url);
    assert.deepEqual(giteaState.calls[0], { fn: 'listAppDeploys', slug: 'portal', options: { limit: 1 } });

    const missing = await fetch(`${baseUrl}/api/apps/desconhecido/deploys`, asAdmin);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('GET /api/apps/:slug/latest-deploy returns the latest Gitea Actions run', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth(), giteaState: fakeGiteaState({ runs: [sampleRun] }) }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/portal/latest-deploy`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.app_slug, 'portal');
    assert.equal(body.app.slug, 'portal');
    assert.equal(body.source, 'gitea-actions');
    assert.equal(body.latest_deploy.outcome, 'success');
    assert.equal(body.latest_deploy.commit_sha, sampleRun.commit_sha);
    assert.equal(body.latest_deploy.actor, 'ana');
  } finally {
    server.close();
  }
});

test('GET /api/apps/:slug/latest-deploy returns null when the repo has no deploy runs or is not on Gitea', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth(), giteaState: fakeGiteaState({ available: false, error: 'repo_not_on_gitea' }) }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/portal/latest-deploy`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.latest_deploy, null);
    assert.equal(body.available, false);
    assert.equal(body.error, 'repo_not_on_gitea');
  } finally {
    server.close();
  }
});

test('GET /api/apps/:slug/latest-deploy rejects unknown apps', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth(), giteaState: fakeGiteaState() }));
  try {
    const response = await fetch(`${baseUrl}/api/apps/desconhecido/latest-deploy`, asAdmin);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'app_not_found',
    });
  } finally {
    server.close();
  }
});

test('GET /api/platform/config exposes the installation names without secrets', async () => {
  const { server, baseUrl } = await listen(createApp({ auth: adminAuth() }));
  try {
    const anonymous = await fetch(`${baseUrl}/api/platform/config`);
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${baseUrl}/api/platform/config`, {
      headers: { 'x-authentik-email': 'alguem@example.com' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.base_domain, 'cloud.localhost');
    assert.equal('agent_name' in body, false);
    assert.equal('gitops_repo' in body, false);
    assert.equal(body.read_only, true);
    assert.equal('deploy_root' in body, false);
    assert.equal(JSON.stringify(body).includes('TOKEN'), false);
  } finally {
    server.close();
  }
});

test('GET /api/platform/status returns the core services and links for admins only', async () => {
  let refreshes = 0;
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    platformStatus: {
      async status({ refresh }) {
        if (refresh) refreshes += 1;
        return {
          checked_at: '2026-10-16T12:00:00.000Z',
          overall: 'healthy',
          summary: { total: 1, healthy: 1, unhealthy: 0, unknown: 0 },
          services: [{ name: 'Gitea', kind: 'git', healthy: true, detail: 'versao 1.23.8', checked_at: '2026-10-16T12:00:00.000Z' }],
          links: { portainer: 'https://portainer.cloud.localhost', glances: 'https://monitor.cloud.localhost' },
          cached: false,
        };
      },
    },
  }));
  try {
    const anonymous = await fetch(`${baseUrl}/api/platform/status`);
    assert.equal(anonymous.status, 401);

    const viewer = await fetch(`${baseUrl}/api/platform/status?refresh=1`, {
      headers: { 'x-authentik-email': 'alguem@example.com' },
    });
    assert.equal(viewer.status, 403);
    assert.equal(refreshes, 0);

    const admin = await fetch(`${baseUrl}/api/platform/status?refresh=1`, asAdmin);
    assert.equal(admin.status, 200);
    const body = await admin.json();
    assert.equal(body.overall, 'healthy');
    assert.equal(body.services[0].name, 'Gitea');
    assert.equal(body.links.portainer, 'https://portainer.cloud.localhost');
    assert.equal(refreshes, 1);
  } finally {
    server.close();
  }
});

test('GET /api/storage-usage returns database usage', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    getStorageUsageFn: async () => ({
      available: true,
      total_bytes: 100,
      relations: [{ relation: 'deploy_events', total_bytes: 100 }],
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/api/storage-usage`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total_bytes, 100);
    assert.equal(body.relations[0].relation, 'deploy_events');
  } finally {
    server.close();
  }
});

test('GET and POST /api/disk-usage-snapshots manage disk snapshots for super admins', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: createAuth({
        superAdminEmails: 'admin@example.com',
    }),
    listDiskUsageSnapshotsFn: async () => ({
      available: true,
      rows: [{
        id: 'snapshot-1',
        app_slug: 'pedidos',
        container_name: 'proposal-app-1',
        size_writable_bytes: 10,
        size_virtual_bytes: 100,
      }],
      summary: {
        containers_count: 1,
        size_writable_bytes: 10,
        size_virtual_bytes: 100,
        apps: [{ app_slug: 'pedidos', containers_count: 1, size_writable_bytes: 10, size_virtual_bytes: 100 }],
      },
    }),
    collectDockerDiskUsageFn: () => ({
      available: true,
      rows: [{
        app_slug: 'pedidos',
        container_name: 'proposal-app-1',
        size_writable_bytes: 10,
        size_virtual_bytes: 100,
      }],
      summary: {
        containers_count: 1,
        size_writable_bytes: 10,
        size_virtual_bytes: 100,
        apps: [{ app_slug: 'pedidos', containers_count: 1, size_writable_bytes: 10, size_virtual_bytes: 100 }],
      },
    }),
    recordDiskUsageSnapshotFn: async (rows) => ({
      available: true,
      recorded: rows.length,
      rows,
    }),
  }));
  try {
    const unauthorized = await fetch(`${baseUrl}/api/disk-usage-snapshots`);
    assert.equal(unauthorized.status, 401);

    const listResponse = await fetch(`${baseUrl}/api/disk-usage-snapshots`, {
      headers: { 'x-authentik-email': 'admin@example.com' },
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.count, 1);
    assert.equal(listBody.summary.size_writable_bytes, 10);

    const scheduleResponse = await fetch(`${baseUrl}/api/disk-usage-schedule`, {
      headers: { 'x-authentik-email': 'admin@example.com' },
    });
    assert.equal(scheduleResponse.status, 200);
    const scheduleBody = await scheduleResponse.json();
    assert.equal(scheduleBody.schedule.enabled, false);

    const runResponse = await fetch(`${baseUrl}/api/disk-usage-snapshots/run`, {
      method: 'POST',
      headers: { 'x-authentik-email': 'admin@example.com' },
    });
    assert.equal(runResponse.status, 201);
    const runBody = await runResponse.json();
    assert.equal(runBody.recorded, 1);
    assert.equal(runBody.schedule.last_recorded, 1);
  } finally {
    server.close();
  }
});

test('GET /api/runtime/health returns http checks', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    listHttpHealthFn: async (apps) => ({
      available: true,
      checked_at: '2026-06-08T00:00:00.000Z',
      timeout_ms: 100,
      checks: apps.map((app) => ({
        slug: app.slug,
        checked: true,
        ok: true,
        url: `https://${app.domain.split(',')[0]}`,
        status: 200,
        latency_ms: 1,
        error: null,
      })),
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/api/runtime/health`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.available, true);
    assert.ok(body.count === undefined);
    assert.ok(Array.isArray(body.checks));
    assert.ok(body.checks.some((check) => check.slug === 'pedidos'));
  } finally {
    server.close();
  }
});

test('GET /api/apps-status includes health and overall status', async () => {
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    recordStatusEvents: true,
    listDockerContainersFn: () => ({
      available: true,
      containers: [{
        name: 'pedidos-app-1',
        image: 'proposal:latest',
        state: 'running',
        status: 'Up 1 hour',
        ports: '0.0.0.0:8200->8000/tcp',
      }],
    }),
    listHttpHealthFn: async (apps) => ({
      available: true,
      checked_at: '2026-06-08T00:00:00.000Z',
      timeout_ms: 100,
      checks: apps.map((app) => ({
        slug: app.slug,
        checked: true,
        ok: app.slug === 'pedidos',
        url: `https://${app.domain.split(',')[0]}`,
        status: app.slug === 'pedidos' ? 200 : 503,
        latency_ms: 1,
        error: app.slug === 'pedidos' ? null : 'unavailable',
        sso_checked: true,
        route_ok: true,
      })),
    }),
    recordStatusChangesFn: async (apps) => ({
      available: true,
      recorded: apps.filter((app) => app.overall_status === 'healthy').length,
      events: [],
    }),
  }));
  try {
    const response = await fetch(`${baseUrl}/api/apps-status`, asAdmin);
    assert.equal(response.status, 200);
    const body = await response.json();
    const pedidos = body.apps.find((app) => app.slug === 'pedidos');
    assert.equal(body.health_available, true);
    assert.equal(body.status_events_available, true);
    assert.ok(body.status_events_recorded >= 1);
    assert.equal(pedidos.runtime.matched, true);
    assert.equal(pedidos.proxy.matched, true);
    assert.equal(pedidos.health.ok, true);
    assert.equal(pedidos.overall_status, 'healthy');
  } finally {
    server.close();
  }
});

test('GET /api/apps-status caches the consolidated dashboard payload', async () => {
  let healthCalls = 0;
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    listDockerContainersFn: () => ({
      available: true,
      containers: [],
    }),
    listHttpHealthFn: async (apps) => {
      healthCalls += 1;
      return {
        available: true,
        checked_at: '2026-06-08T00:00:00.000Z',
        timeout_ms: 100,
        checks: apps.map((app) => ({
          slug: app.slug,
          checked: true,
          ok: true,
          url: `https://${app.domain.split(',')[0]}`,
          status: 200,
          latency_ms: healthCalls,
          error: null,
        })),
      };
    },
  }));
  try {
    const first = await fetch(`${baseUrl}/api/apps-status`, asAdmin);
    const second = await fetch(`${baseUrl}/api/apps-status`, asAdmin);
    const refreshed = await fetch(`${baseUrl}/api/apps-status?refresh=1`, asAdmin);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(refreshed.status, 200);

    const firstBody = await first.json();
    const secondBody = await second.json();
    const refreshedBody = await refreshed.json();

    assert.equal(healthCalls, 2);
    assert.equal(firstBody.cached, false);
    assert.equal(secondBody.cached, true);
    assert.equal(refreshedBody.cached, false);
    assert.equal(firstBody.cache_expires_at, secondBody.cache_expires_at);
    assert.equal(firstBody.apps.find((app) => app.slug === 'pedidos').health.latency_ms, 1);
    assert.equal(secondBody.apps.find((app) => app.slug === 'pedidos').health.latency_ms, 1);
    assert.equal(refreshedBody.apps.find((app) => app.slug === 'pedidos').health.latency_ms, 2);
  } finally {
    server.close();
  }
});

// --- Cache das telas de status (stale-while-revalidate) -----------------------

function statusFixtures() {
  return {
    listDockerContainersFn: () => ({ available: true, containers: [] }),
    listHttpHealthFn: async (apps) => ({
      available: true,
      checked_at: '2026-06-08T00:00:00.000Z',
      timeout_ms: 100,
      checks: apps.map((app) => ({
        slug: app.slug,
        checked: true,
        ok: true,
        url: `https://${app.domain.split(',')[0]}`,
        status: 200,
        latency_ms: 1,
        error: null,
      })),
    }),
  };
}

test('GET /api/apps-status writes status pings only when a refresh actually runs', async () => {
  let pingWrites = 0;
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    ...statusFixtures(),
    recordStatusPingsFn: async (apps) => {
      pingWrites += 1;
      return { available: true, recorded: apps.length };
    },
  }));
  try {
    const first = await (await fetch(`${baseUrl}/api/apps-status`, asAdmin)).json();
    await fetch(`${baseUrl}/api/apps-status`, asAdmin);
    const third = await (await fetch(`${baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(pingWrites, 1, 'tres pedidos dentro do TTL, uma gravacao');
    assert.equal(first.cached, false);
    assert.equal(first.age_seconds, 0);
    assert.ok(first.generated_at);
    assert.equal(third.cached, true);
    assert.equal(third.stale, false);
    assert.equal(third.generated_at, first.generated_at);
    assert.equal(typeof third.age_seconds, 'number');
    assert.ok(third.status_pings_recorded >= 1);

    // Viewer nao pode forcar; admin pode, e so entao grava de novo.
    const forbidden = await fetch(`${baseUrl}/api/apps-status/refresh`, {
      method: 'POST',
      headers: { 'x-authentik-email': 'alguem@example.com' },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(pingWrites, 1);

    const refreshed = await fetch(`${baseUrl}/api/apps-status/refresh`, {
      method: 'POST',
      headers: { ...asAdmin.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'all' }),
    });
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json();
    assert.equal(refreshedBody.cached, false);
    assert.equal(refreshedBody.category, 'all');
    assert.equal(pingWrites, 2);

    const after = await (await fetch(`${baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(after.cached, true);
    assert.equal(pingWrites, 2);
  } finally {
    server.close();
  }
});

test('GET /api/apps-status serves stale data at once and refreshes once in the background', async () => {
  let builds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fixtures = statusFixtures();
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    ...fixtures,
    listHttpHealthFn: async (apps) => {
      builds += 1;
      if (builds > 1) await gate;
      return fixtures.listHttpHealthFn(apps);
    },
    statusCacheConfig: { redisUrl: null, appsTtlSeconds: 1, platformTtlSeconds: 1, redisTimeoutMs: 100 },
  }));
  try {
    const first = await (await fetch(`${baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(first.cache_ttl_seconds, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const started = Date.now();
    const stale = await Promise.all([
      fetch(`${baseUrl}/api/apps-status`, asAdmin).then((r) => r.json()),
      fetch(`${baseUrl}/api/apps-status`, asAdmin).then((r) => r.json()),
      fetch(`${baseUrl}/api/apps-status`, asAdmin).then((r) => r.json()),
    ]);
    assert.ok(Date.now() - started < 900, 'nao esperou a reconstrucao');
    assert.ok(stale.every((body) => body.cached === true && body.stale === true));
    assert.ok(stale.every((body) => body.generated_at === first.generated_at));
    assert.equal(builds, 2, 'uma unica atualizacao em segundo plano');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await (await fetch(`${baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(fresh.stale, false);
    assert.notEqual(fresh.generated_at, first.generated_at);
    assert.equal(builds, 2);
  } finally {
    server.close();
  }
});

test('runtime and platform views are cached with age metadata and admin refresh', async () => {
  let dockerCalls = 0;
  let healthCalls = 0;
  let platformCollects = 0;
  const fixtures = statusFixtures();
  const { server, baseUrl } = await listen(createApp({
    auth: adminAuth(),
    listDockerContainersFn: () => { dockerCalls += 1; return fixtures.listDockerContainersFn(); },
    listHttpHealthFn: async (apps) => { healthCalls += 1; return fixtures.listHttpHealthFn(apps); },
    platformStatus: {
      async collect() {
        platformCollects += 1;
        return {
          checked_at: '2026-10-16T12:00:00.000Z',
          overall: 'healthy',
          summary: { total: 1, healthy: 1, unhealthy: 0, unknown: 0 },
          services: [{ name: 'Gitea', kind: 'git', healthy: true, detail: 'ok', checked_at: '2026-10-16T12:00:00.000Z' }],
          links: {},
        };
      },
    },
  }));
  try {
    for (const path of ['/api/runtime/docker', '/api/apps-runtime', '/api/runtime/health', '/api/platform/status']) {
      const first = await (await fetch(`${baseUrl}${path}`, asAdmin)).json();
      const second = await (await fetch(`${baseUrl}${path}`, asAdmin)).json();
      assert.equal(first.cached, false, path);
      assert.equal(second.cached, true, path);
      assert.equal(second.stale, false, path);
      assert.equal(second.generated_at, first.generated_at, path);
      assert.equal(typeof second.age_seconds, 'number', path);
    }
    assert.equal(dockerCalls, 2, 'runtime/docker e apps-runtime, uma leitura cada');
    assert.equal(healthCalls, 1);
    assert.equal(platformCollects, 1);

    const viewer = await fetch(`${baseUrl}/api/platform/status/refresh`, {
      method: 'POST',
      headers: { 'x-authentik-email': 'alguem@example.com' },
    });
    assert.equal(viewer.status, 403);
    const refreshed = await fetch(`${baseUrl}/api/platform/status/refresh`, { method: 'POST', ...asAdmin });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).cached, false);
    assert.equal(platformCollects, 2);

    const forced = await (await fetch(`${baseUrl}/api/runtime/health?refresh=1`, asAdmin)).json();
    assert.equal(forced.cached, false);
    assert.equal(healthCalls, 2);
  } finally {
    server.close();
  }
});

test('status views survive a broken Redis and share entries through a working one', async () => {
  const { createStatusCache } = await import('../src/status-cache.js');
  const store = new Map();
  const redis = {
    failing: false,
    async get(key) { if (this.failing) throw new Error('ECONNREFUSED'); return store.get(key) ?? null; },
    async set(key, value) { if (this.failing) throw new Error('ECONNREFUSED'); store.set(key, value); return 'OK'; },
    async del(...keys) { if (this.failing) throw new Error('ECONNREFUSED'); for (const key of keys) store.delete(key); return keys.length; },
    close() {},
  };
  const broken = createStatusCache({ redisClient: { ...redis, failing: true }, logger: { warn() {} } });
  const brokenApp = await listen(createApp({ auth: adminAuth(), ...statusFixtures(), statusCache: broken }));
  try {
    const first = await fetch(`${brokenApp.baseUrl}/api/apps-status`, asAdmin);
    assert.equal(first.status, 200);
    const second = await (await fetch(`${brokenApp.baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(second.cached, true, 'cai para memoria');
    assert.equal(broken.health().redis_available, false);
  } finally {
    brokenApp.server.close();
  }

  const shared = createStatusCache({ redisClient: redis, logger: { warn() {} } });
  const appA = await listen(createApp({ auth: adminAuth(), ...statusFixtures(), statusCache: shared }));
  const appB = await listen(createApp({ auth: adminAuth(), ...statusFixtures(), statusCache: createStatusCache({ redisClient: redis, logger: { warn() {} } }) }));
  try {
    const fromA = await (await fetch(`${appA.baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(fromA.cached, false);
    assert.ok([...store.keys()].some((key) => key === 'ihc-portal:apps-status:all:*'));
    const fromB = await (await fetch(`${appB.baseUrl}/api/apps-status`, asAdmin)).json();
    assert.equal(fromB.cached, true, 'outro processo le o mesmo Redis');
    assert.equal(fromB.generated_at, fromA.generated_at);
  } finally {
    appA.server.close();
    appB.server.close();
  }
});
