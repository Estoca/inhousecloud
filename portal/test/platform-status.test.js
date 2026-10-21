import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBackup,
  checkContainer,
  checkGitea,
  createPlatformStatus,
  parseRedisUrl,
  platformConfigFromEnv,
} from '../src/platform-status.js';

// What the cloud's compose service passes (docker/compose.yml, service portal).
const env = {
  BASE_DOMAIN: 'exemplo.cloud',
  IHC_PROJECT: 'ihc',
  COMPOSE_PROFILES: 'storage,backup',
  TUNNEL_PROVIDER: 'none',
  GITEA_URL: 'http://gitea:3000',
  GITEA_TOKEN: 'readonly',
  AUTHENTIK_URL: 'https://auth.exemplo.cloud',
  AUTHENTIK_INTERNAL_URL: 'http://authentik-server:9000',
  NPM_HEALTH_URL: 'http://proxy:81/api/',
  DATABASE_URL: 'postgres://ihc_platform:x@postgres:5432/ihc_platform',
  REDIS_URL: 'redis://redis:6379/0',
  GARAGE_HEALTH_URL: 'http://garage:3903/health',
  BACKUP_ENABLED: 'true',
  BACKUP_REPORTS_DIR: '/ihc/backup-reports',
};

function okFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers });
    if (url.endsWith('/api/v1/version')) return { ok: true, status: 200, json: async () => ({ version: '1.25.0' }) };
    if (url.endsWith('/-/health/ready/')) return { ok: true, status: 200, json: async () => ({}) };
    if (url === 'http://proxy:81/api/') return { ok: true, status: 200, json: async () => ({ status: 'OK' }) };
    if (url === 'http://garage:3903/health') return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const svc = (service, state = 'running', status = 'Up 3 days (healthy)') => ({
  name: `ihc-${service}-1`, state, status, docker_stack: 'ihc', docker_service: service, image: 'x',
});

const dockerState = {
  available: true,
  containers: [svc('gitea-runner'), svc('gitea-deployer', 'exited', 'Exited (1) 2 hours ago'), svc('portal'),
    // an app with a service named like a core one must not be taken for it
    { name: 'demo-gitea-runner-1', state: 'running', status: 'Up', docker_stack: 'demo', docker_service: 'gitea-runner' }],
};

function reports(files) {
  return {
    readFile: (file) => {
      const name = file.split('/').pop();
      if (!(name in files)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return JSON.stringify(files[name]);
    },
  };
}

const NOW = Date.parse('2026-10-16T12:00:00Z');
const goodReports = reports({
  'latest-status.json': { schema_version: 1, status: 'success', run_id: 'r2', finished_at: '2026-10-16T10:00:00Z', max_age_hours: 26 },
  'latest-success.json': { schema_version: 1, status: 'success', run_id: 'r2', finished_at: '2026-10-16T10:00:00Z', snapshot_id: 'abc', max_age_hours: 26 },
});

test('platformConfigFromEnv reads the cloud compose service', () => {
  const config = platformConfigFromEnv(env);
  assert.equal(config.authentikUrl, 'http://authentik-server:9000');
  assert.equal(config.proxyHealthUrl, 'http://proxy:81/api/');
  assert.deepEqual(config.profiles, ['storage', 'backup']);
  assert.equal(config.backupEnabled, true);
  assert.equal(config.portainerUrl, 'https://portainer.exemplo.cloud');
  assert.equal(config.glancesUrl, 'https://glances.exemplo.cloud');
  assert.equal(platformConfigFromEnv({}).authentikUrl, 'http://auth.cloud.localhost');
  assert.equal('npmPassword' in config, false, 'no proxy admin password');
});

test('checkGitea sends the read-only token so REQUIRE_SIGNIN_VIEW does not answer 403', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, headers: options.headers });
    const authorized = options.headers?.authorization === 'token abc';
    return authorized
      ? { ok: true, status: 200, json: async () => ({ version: '1.25.0' }) }
      : { ok: false, status: 403, json: async () => ({}) };
  };
  const withToken = await checkGitea(platformConfigFromEnv({ ...env, GITEA_TOKEN: 'abc' }), { fetchImpl });
  assert.equal(withToken.healthy, true);
  assert.equal(withToken.detail, 'versao 1.25.0');
  assert.equal(seen[0].headers.authorization, 'token abc');

  const withoutToken = await checkGitea(platformConfigFromEnv({ ...env, GITEA_TOKEN: '' }), { fetchImpl });
  assert.equal(withoutToken.healthy, false);
  assert.equal(withoutToken.detail, 'HTTP 403');
  assert.equal(seen[1].headers, undefined);
});

test('status lists the core services, the runners by their cloud names and the profiles that are on', async () => {
  const calls = [];
  const platform = createPlatformStatus({
    env,
    fetchImpl: okFetch(calls),
    pgQueryFn: async (_url, sql) => (sql.startsWith('SELECT 1')
      ? [{ ok: 1 }]
      : [{ datname: 'gitea', size_bytes: null }, { datname: 'ihc_platform', size_bytes: '8388608' }]),
    redisPingFn: async () => 'PONG',
    listDockerContainersFn: () => dockerState,
    now: () => NOW,
    ...goodReports,
  });

  const status = await platform.status();
  assert.equal(status.cached, false);
  const names = status.services.map((service) => service.name);
  assert.deepEqual(names, [
    'Proxy (Nginx Proxy Manager)', 'Authentik', 'Gitea', 'Runner de CI (gitea-runner)', 'Runner de deploy (gitea-deployer)',
    'API Docker so leitura (docker-ro)', 'Postgres compartilhado', 'Redis compartilhado', 'Backup', 'Garage (S3)',
  ]);
  for (const service of status.services) {
    assert.ok(typeof service.kind === 'string');
    assert.ok([true, false, null].includes(service.healthy));
    assert.ok(typeof service.detail === 'string');
    assert.ok(service.checked_at);
  }
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.equal(byName.Gitea.version, '1.25.0');
  assert.equal(byName['Runner de CI (gitea-runner)'].healthy, true);
  assert.equal(byName['Runner de CI (gitea-runner)'].container, 'ihc-gitea-runner-1');
  assert.equal(byName['Runner de deploy (gitea-deployer)'].healthy, false);
  assert.match(byName['Runner de deploy (gitea-deployer)'].detail, /exited/);
  assert.equal(byName['Postgres compartilhado'].databases[1].size, '8.0 MB');
  assert.equal(byName['Postgres compartilhado'].databases[0].size, null, 'no CONNECT: no size');
  assert.equal(byName.Backup.healthy, true);
  assert.equal(byName.Backup.age_hours, 2);
  assert.equal(byName.Backup.snapshot_id, 'abc');
  assert.equal(status.overall, 'degraded');
  assert.equal(status.links.portainer, null, 'ops profile off: no links to the ops tools');
  // The proxy is a health GET, never a login with the admin password.
  assert.ok(calls.some((call) => call.url === 'http://proxy:81/api/' && call.method === 'GET'));
  assert.equal(calls.some((call) => call.url.endsWith('/api/tokens')), false);
  assert.equal(JSON.stringify(status).includes('readonly'), false, 'the Gitea token is not in the answer');
  assert.equal(JSON.stringify(status.topology).includes('deploy_root'), false);

  const again = await platform.status();
  assert.equal(again.cached, true);
});

test('ops, agent and tunnel entries follow COMPOSE_PROFILES and TUNNEL_PROVIDER', async () => {
  const containers = ['portainer', 'glances', 'filebrowser', 'agent', 'tailscale', 'tailnet-dns'].map((s) => svc(s));
  const platform = createPlatformStatus({
    env: { ...env, COMPOSE_PROFILES: 'ops,agent,tailscale', TUNNEL_PROVIDER: 'tailscale' },
    fetchImpl: okFetch([]),
    pgQueryFn: async () => [{ ok: 1 }],
    redisPingFn: async () => 'PONG',
    listDockerContainersFn: () => ({ available: true, containers }),
    now: () => NOW,
    ...goodReports,
  });
  const status = await platform.status();
  const names = status.services.map((service) => service.name);
  for (const name of ['Portainer', 'Glances', 'FileBrowser', 'Agente operador', 'Tailscale', 'DNS do tailnet']) assert.ok(names.includes(name), name);
  assert.equal(names.includes('Garage (S3)'), false);
  assert.equal(names.includes('Terminal web (Wetty)'), false, 'no wetty container: not listed');
  assert.equal(status.links.files, 'https://files.exemplo.cloud');
});

test('unconfigured services are unknown, not unhealthy; backup off says so', async () => {
  const platform = createPlatformStatus({
    env: { BACKUP_ENABLED: 'false' },
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    listDockerContainersFn: () => ({ available: false, error: 'docker_not_found', containers: [] }),
    pgQueryFn: async () => { throw new Error('should not query'); },
    redisPingFn: async () => { throw new Error('should not ping'); },
    readFile: () => { throw new Error('should not read'); },
  });
  const status = await platform.status();
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.equal(byName.Gitea.healthy, null);
  assert.equal(byName['Proxy (Nginx Proxy Manager)'].healthy, null);
  assert.equal(byName['Postgres compartilhado'].healthy, null);
  assert.equal(byName['Redis compartilhado'].healthy, null);
  assert.equal(byName.Backup.healthy, null);
  assert.match(byName.Backup.detail, /desligado/);
  assert.equal(byName['Runner de CI (gitea-runner)'].healthy, null);
  assert.match(byName['Runner de CI (gitea-runner)'].detail, /Docker indisponivel/);
  assert.equal(byName['API Docker so leitura (docker-ro)'].healthy, false);
  // Authentik has a default URL derived from BASE_DOMAIN, so it is probed and fails here.
  assert.equal(byName.Authentik.healthy, false);
});

test('failing probes are reported with detail and never throw', async () => {
  const platform = createPlatformStatus({
    env,
    fetchImpl: async (url) => {
      if (url.endsWith('/api/v1/version')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { ok: false, status: 502, json: async () => ({}) };
    },
    pgQueryFn: async () => { throw new Error('connection refused'); },
    redisPingFn: async () => { throw new Error('NOAUTH Authentication required'); },
    listDockerContainersFn: () => ({ available: true, containers: [] }),
    ...reports({}),
  });
  const status = await platform.status();
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.match(byName.Gitea.detail, /timeout/);
  assert.match(byName.Authentik.detail, /HTTP 502/);
  assert.equal(byName['Proxy (Nginx Proxy Manager)'].healthy, false);
  assert.match(byName['Postgres compartilhado'].detail, /connection refused/);
  assert.match(byName['Redis compartilhado'].detail, /NOAUTH/);
  assert.match(byName['Runner de deploy (gitea-deployer)'].detail, /nao encontrado/);
  assert.match(byName.Backup.detail, /nenhum backup rodou/);
  assert.equal(byName['Garage (S3)'].healthy, false);
  assert.equal(status.overall, 'degraded');
});

test('checkBackup reads latest-status.json and the age of latest-success.json', () => {
  const config = platformConfigFromEnv({ BACKUP_ENABLED: 'true', BACKUP_REPORTS_DIR: '/r', BACKUP_MAX_AGE_HOURS: '12' });
  const success = { finished_at: '2026-10-15T06:00:00Z', snapshot_id: 's1' };
  const stale = checkBackup(config, { now: () => NOW, ...reports({ 'latest-status.json': { status: 'success' }, 'latest-success.json': success }) });
  assert.equal(stale.healthy, false);
  assert.match(stale.detail, /atrasado/);
  assert.equal(stale.max_age_hours, 12);

  const failed = checkBackup(config, { now: () => NOW, ...reports({
    'latest-status.json': { status: 'failed', error: 'pg_dump of gitea failed' },
    'latest-success.json': { ...success, finished_at: '2026-10-16T11:00:00Z' },
  }) });
  assert.equal(failed.healthy, false);
  assert.match(failed.detail, /falhou \(pg_dump of gitea failed\)/);
  assert.equal(failed.last_status, 'failed');

  const running = checkBackup(config, { now: () => NOW, ...reports({
    'latest-status.json': { status: 'running' },
    'latest-success.json': { ...success, finished_at: '2026-10-16T11:30:00Z' },
  }) });
  assert.equal(running.healthy, true);
  assert.match(running.detail, /rodando agora/);

  const never = checkBackup(config, { now: () => NOW, ...reports({ 'latest-status.json': { status: 'failed', error: 'x' } }) });
  assert.equal(never.healthy, false);
  assert.match(never.detail, /nenhum backup com sucesso/);
});

test('checkContainer prefers the compose service of the project, then the name', () => {
  assert.equal(checkContainer('CI', 'ci', 'gitea-runner', dockerState, 'ihc').container, 'ihc-gitea-runner-1');
  const byName = { available: true, containers: [{ name: 'gitea-runner-1', state: 'running', status: 'Up' }] };
  assert.equal(checkContainer('CI', 'ci', 'gitea-runner', byName).healthy, true);
  const unhealthy = { available: true, containers: [svc('gitea-runner', 'running', 'Up 2 minutes (unhealthy)')] };
  assert.equal(checkContainer('CI', 'ci', 'gitea-runner', unhealthy, 'ihc').healthy, false);
  assert.equal(checkContainer('Tunnel', 'tunnel', 'cloudflared', byName).healthy, false);
});

test('parseRedisUrl extracts host, port and password', () => {
  assert.deepEqual(parseRedisUrl('redis://:s3cret@redis.local:6380/0'), {
    host: 'redis.local',
    port: 6380,
    password: 's3cret',
    username: null,
    tls: false,
  });
  assert.equal(parseRedisUrl('redis://localhost').port, 6379);
});
