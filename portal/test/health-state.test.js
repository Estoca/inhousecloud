import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appHealthPath, checkHttpHealth, checkSsoProtection, enrichAppsWithHealth, isAuthRedirect, listHttpHealth, proxyGet } from '../src/health-state.js';

test('checkHttpHealth goes through the proxy with the Host of the first app domain', async () => {
  const result = await checkHttpHealth({
    slug: 'arquivos-sftp',
    domain: 'arquivos.cloud.localhost, sftp.cloud.localhost',
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://proxy:80/');
      assert.equal(options.headers.host, 'arquivos.cloud.localhost');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      return { status: 200, headers: new Headers() };
    },
  });

  assert.equal(result.slug, 'arquivos-sftp');
  assert.equal(result.url, 'http://arquivos.cloud.localhost');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.error, null);
});

test('checkHttpHealth reports fetch errors without throwing', async () => {
  const result = await checkHttpHealth({
    slug: 'pedidos',
    domain: 'pedidos.cloud.localhost',
  }, {
    fetchImpl: async () => {
      throw new Error('connect failed');
    },
  });

  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'connect failed');
});

test('checkHttpHealth skips apps without a domain', async () => {
  const result = await checkHttpHealth({
    slug: 'backend-only',
    domain: null,
  }, {
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });

  assert.equal(result.checked, false);
  assert.equal(result.url, null);
  assert.equal(result.error, 'missing_domain');
});

test('checkHttpHealth skips blank domains', async () => {
  const result = await checkHttpHealth({
    slug: 'blank',
    domain: '',
  });

  assert.equal(result.checked, false);
  assert.equal(result.url, null);
  assert.equal(result.error, 'missing_domain');
});

test('listHttpHealth checks every app', async () => {
  const result = await listHttpHealth([
    { slug: 'a', domain: 'a.cloud.localhost' },
    { slug: 'b', domain: 'b.cloud.localhost' },
  ], {
    timeoutMs: 100,
    fetchImpl: async () => ({ status: 204, headers: new Headers() }),
  });

  assert.equal(result.available, true);
  assert.equal(result.timeout_ms, 100);
  assert.equal(result.checks.length, 2);
  assert.ok(result.checked_at);
});

test('enrichAppsWithHealth adds health and overall status', () => {
  const [healthy, warning, error] = enrichAppsWithHealth([
    {
      slug: 'ok',
      runtime: { matched: true },
      proxy: { matched: true },
    },
    {
      slug: 'missing-runtime',
      runtime: { matched: false },
      proxy: { matched: true },
    },
    {
      slug: 'down',
      runtime: { matched: true },
      proxy: { matched: true },
    },
  ], {
    available: true,
    checks: [
      { slug: 'ok', checked: true, ok: true, url: 'https://ok.cloud.localhost', status: 200, latency_ms: 10 },
      { slug: 'missing-runtime', checked: true, ok: true, url: 'https://missing.cloud.localhost', status: 200, latency_ms: 10 },
      { slug: 'down', checked: true, ok: false, url: 'https://down.cloud.localhost', status: 503, latency_ms: 10 },
    ],
  });

  assert.equal(healthy.overall_status, 'healthy');
  assert.equal(warning.overall_status, 'warning');
  assert.equal(error.overall_status, 'error');
  assert.equal(healthy.health.status, 200);
});

test('checkHttpHealth probes the healthcheck path declared for the app', async () => {
  const urls = [];
  const probe = (app) => checkHttpHealth(app, {
    fetchImpl: async (url) => {
      urls.push(url);
      return { status: 200, headers: new Headers() };
    },
  });

  await probe({ slug: 'a', domain: 'a.cloud.localhost', healthcheck_path: '/api/health' });
  await probe({ slug: 'b', domain: 'b.cloud.localhost', healthcheck: { path: 'health' } });
  await probe({ slug: 'c', domain: 'c.cloud.localhost', runtime: { healthcheck: { path: '/healthz' } } });
  await probe({ slug: 'd', domain: 'd.cloud.localhost' });

  assert.deepEqual(urls, [
    'http://proxy:80/api/health',
    'http://proxy:80/health',
    'http://proxy:80/healthz',
    'http://proxy:80/',
  ]);
  assert.equal(appHealthPath({ healthcheck_path: ' /x ' }), '/x');
  assert.equal(appHealthPath({}), '/');
});

test('checkHttpHealth treats a redirect to Authentik as unknown, not healthy', async () => {
  const result = await checkHttpHealth({
    slug: 'protegido',
    domain: 'protegido.cloud.localhost',
    healthcheck_path: '/health',
  }, {
    authHost: 'auth.cloud.localhost',
    fetchImpl: async () => ({
      status: 302,
      headers: new Headers({ location: 'https://protegido.cloud.localhost/outpost.goauthentik.io/start?rd=https://protegido.cloud.localhost/health' }),
    }),
  });

  assert.equal(result.checked, true);
  assert.equal(result.ok, false);
  assert.equal(result.redirected_to_auth, true);
  assert.equal(result.error, 'auth_redirect');
  assert.equal(result.status, 302);

  const [app] = enrichAppsWithHealth([
    { slug: 'protegido', runtime: { matched: true }, proxy: { matched: true } },
  ], { available: true, checks: [result] });
  assert.equal(app.overall_status, 'unknown');
  assert.equal(app.health.redirected_to_auth, true);

  const [warning] = enrichAppsWithHealth([
    { slug: 'protegido', runtime: { matched: false }, proxy: { matched: true } },
  ], { available: true, checks: [result] });
  assert.equal(warning.overall_status, 'warning');
});

test('checkSsoProtection reports the effective Authentik redirect at the app root', async () => {
  const protectedApp = await checkSsoProtection({ slug: 'protegido', domain: 'protegido.cloud.localhost' }, {
    authHost: 'auth.cloud.localhost',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://proxy:80/');
      assert.equal(options.headers.host, 'protegido.cloud.localhost');
      return { status: 302, headers: new Headers({ location: 'http://auth.cloud.localhost/outpost.goauthentik.io/start' }) };
    },
  });
  const publicApp = await checkSsoProtection({ slug: 'publico', domain: 'publico.cloud.localhost' }, {
    fetchImpl: async () => ({ status: 200, headers: new Headers() }),
  });

  assert.deepEqual(protectedApp, { checked: true, protected: true, status: 302 });
  assert.deepEqual(publicApp, { checked: true, protected: false, status: 200 });
});

test('the expected status of the manifest decides health; SSO is effective only as the manifest asks', async () => {
  const outpost = { status: 302, headers: new Headers({ location: 'http://app.cloud.localhost/outpost.goauthentik.io/start?rd=x' }) };
  const fetchImpl = async (url) => (url.endsWith('/health') ? { status: 204, headers: new Headers() } : outpost);
  const { checks } = await listHttpHealth([
    { slug: 'app', domain: 'app.cloud.localhost', healthcheck: { path: '/health', expected_status: 204 }, auth_required: true },
    { slug: 'strict', domain: 'strict.cloud.localhost', healthcheck: { path: '/health', expected_status: 200 }, auth_required: true },
    { slug: 'open', domain: 'open.cloud.localhost', healthcheck: { path: '/health' }, auth_required: false },
  ], { fetchImpl });
  const [app, strict, open] = checks;
  assert.equal(app.ok, true);
  assert.equal(app.sso_effective, true);
  assert.equal(app.route_ok, true);
  assert.equal(strict.ok, false);
  assert.equal(strict.expected_status, 200);
  // public by its manifest, but the proxy still sends visitors to the sign-in
  assert.equal(open.sso_expected, false);
  assert.equal(open.sso_effective, false);
});

test('a route the proxy does not know answers 404 at the root: proxy.matched is false', async () => {
  const fetchImpl = async () => ({ status: 404, headers: new Headers() });
  const health = await listHttpHealth([{ slug: 'gone', domain: 'gone.cloud.localhost', runtime: { matched: true } }], { fetchImpl });
  const [app] = enrichAppsWithHealth([{ slug: 'gone', runtime: { matched: true } }], health);
  assert.equal(app.proxy.matched, false);
  assert.equal(app.proxy.source, 'proxy-probe');
  assert.equal(app.overall_status, 'error');
});

test('proxyGet sends the Host header and does not follow redirects', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url });
    res.writeHead(302, { location: '/outpost.goauthentik.io/start' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await proxyGet(`http://127.0.0.1:${server.address().port}/health`, { headers: { host: 'app.cloud.localhost' } });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/outpost.goauthentik.io/start');
    assert.deepEqual(seen, [{ host: 'app.cloud.localhost', url: '/health' }]);
  } finally {
    server.close();
  }
});

test('isAuthRedirect distinguishes auth redirects from same-host redirects', () => {
  const url = 'https://app.cloud.localhost/health';
  assert.equal(isAuthRedirect(url, { status: 302, headers: new Headers({ location: 'http://auth.cloud.localhost/if/flow/x' }) }, { authHost: 'auth.cloud.localhost' }), true);
  assert.equal(isAuthRedirect(url, { status: 302, headers: new Headers({ location: 'https://outro.com/' }) }, { authHost: 'auth.cloud.localhost' }), true);
  assert.equal(isAuthRedirect(url, { status: 301, headers: new Headers({ location: '/login' }) }, { authHost: 'auth.cloud.localhost' }), false);
  assert.equal(isAuthRedirect(url, { status: 200, headers: new Headers() }), false);
});

test('same-host redirects still count as healthy responses', async () => {
  const result = await checkHttpHealth({ slug: 'x', domain: 'x.cloud.localhost' }, {
    authHost: 'auth.cloud.localhost',
    fetchImpl: async () => ({ status: 301, headers: new Headers({ location: 'https://x.cloud.localhost/app' }) }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.redirected_to_auth, false);
});
