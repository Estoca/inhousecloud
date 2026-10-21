import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichAppsWithNpm,
  listNpmProxyHosts,
  normalizeProxyHost,
  normalizeRedirectionHost,
} from '../src/npm-state.js';

test('normalizeProxyHost keeps read-only route fields', () => {
  const host = normalizeProxyHost({
    id: 10,
    domain_names: ['pedidos.cloud.localhost'],
    enabled: true,
    forward_scheme: 'http',
    forward_host: '127.0.0.1',
    forward_port: '8200',
    ssl_forced: true,
    certificate_id: 1,
  });

  assert.deepEqual(host, {
    id: 10,
    domain_names: ['pedidos.cloud.localhost'],
    enabled: true,
    forward_scheme: 'http',
    forward_host: '127.0.0.1',
    forward_port: 8200,
    ssl_forced: true,
    certificate_id: 1,
  });
});

test('normalizeRedirectionHost keeps redirect route fields', () => {
  const host = normalizeRedirectionHost({
    id: 11,
    domain_names: ['painel.cloud.localhost'],
    enabled: true,
    forward_http_code: '301',
    forward_scheme: 'https',
    forward_domain_name: 'intranet.cloud.localhost',
    preserve_path: true,
    ssl_forced: false,
    certificate_id: 0,
  });

  assert.deepEqual(host, {
    id: 11,
    domain_names: ['painel.cloud.localhost'],
    enabled: true,
    forward_http_code: 301,
    forward_scheme: 'https',
    forward_domain_name: 'intranet.cloud.localhost',
    preserve_path: true,
    ssl_forced: false,
    certificate_id: 0,
  });
});

test('listNpmProxyHosts returns unavailable when config is missing', async () => {
  const result = await listNpmProxyHosts({ env: {}, fetchImpl: async () => {
    throw new Error('should not call fetch');
  } });

  assert.equal(result.available, false);
  assert.equal(result.error, 'missing_config:url,email,password');
  assert.deepEqual(result.proxy_hosts, []);
});

test('listNpmProxyHosts authenticates and lists proxy hosts', async () => {
  const calls = [];
  const result = await listNpmProxyHosts({
    env: {
      NPM_URL: 'http://npm.local/',
      NPM_EMAIL: 'admin@example.com',
      NPM_PASSWORD: 'secret',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === 'http://npm.local/api/tokens') {
        return {
          ok: true,
          json: async () => ({ token: 'token-123' }),
        };
      }
      if (url === 'http://npm.local/api/nginx/proxy-hosts') {
        return {
          ok: true,
          json: async () => ([{
            id: 1,
            domain_names: ['pedidos.cloud.localhost'],
            enabled: true,
            forward_scheme: 'http',
            forward_host: '127.0.0.1',
            forward_port: 8200,
          }]),
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.proxy_hosts.length, 1);
  assert.equal(result.proxy_hosts[0].forward_port, 8200);
  assert.equal(calls[1].options.headers.authorization, 'Bearer token-123');
});

test('enrichAppsWithNpm matches app domains', () => {
  const [app] = enrichAppsWithNpm([
    {
      slug: 'pedidos',
      domain: 'pedidos.cloud.localhost',
    },
  ], {
    available: true,
    proxy_hosts: [{
      id: 1,
      domain_names: ['pedidos.cloud.localhost'],
      forward_port: 8200,
    }],
  });

  assert.equal(app.proxy.available, true);
  assert.equal(app.proxy.matched, true);
  assert.equal(app.proxy.host.forward_port, 8200);
});

test('enrichAppsWithNpm does not match disabled proxy hosts as active routes', () => {
  const [app] = enrichAppsWithNpm([
    {
      slug: 'pedidos',
      domain: 'pedidos.cloud.localhost',
    },
  ], {
    available: true,
    proxy_hosts: [{
      id: 1,
      domain_names: ['pedidos.cloud.localhost'],
      enabled: false,
      forward_port: 8200,
    }],
  });

  assert.equal(app.proxy.matched, false);
  assert.equal(app.proxy.disabled, true);
  assert.equal(app.proxy.host, null);
  assert.equal(app.proxy.disabled_host.forward_port, 8200);
});

test('enrichAppsWithNpm handles comma-separated domains', () => {
  const [app] = enrichAppsWithNpm([
    {
      slug: 'arquivos-sftp',
      domain: 'arquivos.cloud.localhost, sftp.cloud.localhost',
    },
  ], {
    available: true,
    proxy_hosts: [{
      id: 2,
      domain_names: ['sftp.cloud.localhost'],
      forward_port: 8090,
    }],
  });

  assert.equal(app.proxy.matched, true);
  assert.equal(app.proxy.host.id, 2);
});

test('enrichAppsWithNpm inherits active proxy for domainless apps in the same stack', () => {
  const [frontend, backend] = enrichAppsWithNpm([
    {
      slug: 'metas',
      domain: 'metas.cloud.localhost',
      runtime: { stack: 'metas-stack' },
    },
    {
      slug: 'metas-backend',
      runtime: { stack: 'metas-stack' },
    },
  ], {
    available: true,
    proxy_hosts: [{
      id: 3,
      domain_names: ['metas.cloud.localhost'],
      forward_port: 8300,
    }],
  });

  assert.equal(frontend.proxy.matched, true);
  assert.equal(frontend.proxy.inherited, false);
  assert.equal(backend.proxy.matched, true);
  assert.equal(backend.proxy.inherited, true);
  assert.equal(backend.proxy.inherited_from_app_slug, 'metas');
  assert.equal(backend.proxy.inherited_from_domain, 'metas.cloud.localhost');
  assert.equal(backend.proxy.host.id, 3);
});

test('enrichAppsWithNpm does not inherit stack proxy when app declares its own missing domain', () => {
  const [, backend] = enrichAppsWithNpm([
    {
      slug: 'metas',
      domain: 'metas.cloud.localhost',
      runtime: { stack: 'metas-stack' },
    },
    {
      slug: 'metas-backend',
      domain: 'api-metas.cloud.localhost',
      runtime: { stack: 'metas-stack' },
    },
  ], {
    available: true,
    proxy_hosts: [{
      id: 3,
      domain_names: ['metas.cloud.localhost'],
      forward_port: 8300,
    }],
  });

  assert.equal(backend.proxy.matched, false);
  assert.equal(backend.proxy.inherited, false);
});
