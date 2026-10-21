import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBackup,
  checkContainer,
  checkGitea,
  createPlatformStatus,
  globToRegExp,
  newestFileMatching,
  parseRedisUrl,
  platformConfigFromEnv,
} from '../src/platform-status.js';

const env = {
  BASE_DOMAIN: 'exemplo.cloud',
  GITEA_URL: 'http://gitea.local:3007',
  AUTHENTIK_URL: 'https://auth.exemplo.cloud',
  NPM_URL: 'http://npm.local:81',
  NPM_EMAIL: 'admin@exemplo.cloud',
  NPM_PASSWORD: 'secret',
  PLATFORM_PG_READONLY_URL: 'postgresql://viewer:x@db.local:5432/postgres',
  REDIS_URL: 'redis://:pw@redis.local:6379/0',
  MINIO_ENDPOINT: 'https://s3.exemplo.cloud',
  BACKUP_MANIFEST_GLOB: '/backups/manifest-*.json',
};

function okFetch(calls) {
  return async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.endsWith('/api/v1/version')) return { ok: true, status: 200, json: async () => ({ version: '1.23.8' }) };
    if (url.endsWith('/-/health/ready/')) return { ok: true, status: 204, json: async () => ({}) };
    if (url.endsWith('/api/tokens')) return { ok: true, status: 200, json: async () => ({ token: 't' }) };
    if (url.endsWith('/minio/health/live')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const dockerState = {
  available: true,
  containers: [
    { name: 'cloudflared', state: 'running', status: 'Up 3 days', image: 'cloudflare/cloudflared' },
    { name: 'gitea-runner', state: 'exited', status: 'Exited (1) 2 hours ago', image: 'gitea/act_runner' },
  ],
};

function fsStubs(files) {
  return {
    readdir: () => Object.keys(files),
    stat: (filePath) => {
      const name = filePath.split('/').pop();
      return { mtimeMs: files[name], size: 10, isFile: () => true };
    },
  };
}

test('platformConfigFromEnv derives defaults from BASE_DOMAIN', () => {
  const config = platformConfigFromEnv({ BASE_DOMAIN: 'exemplo.cloud', AUTHENTIK_HOST: 'auth.exemplo.cloud' });
  assert.equal(config.authentikUrl, 'https://auth.exemplo.cloud');
  assert.equal(config.portainerUrl, 'https://portainer.exemplo.cloud');
  assert.equal(config.glancesUrl, 'https://monitor.exemplo.cloud');
  assert.equal(config.cloudflaredContainer, 'cloudflared');
  assert.equal(config.giteaRunnerContainer, 'gitea-runner');
  assert.equal(config.backupMaxAgeHours, 26);
  assert.equal(platformConfigFromEnv({}).authentikUrl, 'http://auth.cloud.localhost');
});

test('checkGitea sends the read-only token so REQUIRE_SIGNIN_VIEW does not answer 403', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    seen.push({ url, headers: options.headers });
    const authorized = options.headers?.authorization === 'token abc';
    return authorized
      ? { ok: true, status: 200, json: async () => ({ version: '1.23.8' }) }
      : { ok: false, status: 403, json: async () => ({}) };
  };
  const withToken = await checkGitea(platformConfigFromEnv({ ...env, GITEA_TOKEN: 'abc' }), { fetchImpl });
  assert.equal(withToken.healthy, true);
  assert.equal(withToken.detail, 'versao 1.23.8');
  assert.equal(seen[0].headers.authorization, 'token abc');

  const withoutToken = await checkGitea(platformConfigFromEnv(env), { fetchImpl });
  assert.equal(withoutToken.healthy, false);
  assert.equal(withoutToken.detail, 'HTTP 403');
  assert.equal(seen[1].headers, undefined);
});

test('status checks every core service and reports the shape per service', async () => {
  const calls = [];
  const now = Date.parse('2026-10-16T12:00:00Z');
  const platform = createPlatformStatus({
    env,
    fetchImpl: okFetch(calls),
    pgQueryFn: async (_url, sql) => (sql.startsWith('SELECT 1')
      ? [{ ok: 1 }]
      : [{ datname: 'postgres', size_bytes: '8388608' }, { datname: 'financeiro', size_bytes: '1073741824' }]),
    redisPingFn: async () => 'PONG',
    listDockerContainersFn: () => dockerState,
    now: () => now,
    ...fsStubs({ 'manifest-2026-10-16.json': now - 2 * 3_600_000, 'manifest-2026-10-15.json': now - 26 * 3_600_000, 'other.txt': now }),
  });

  const status = await platform.status();

  assert.equal(status.cached, false);
  assert.equal(status.services.length, 9);
  for (const service of status.services) {
    assert.ok(typeof service.name === 'string');
    assert.ok(typeof service.kind === 'string');
    assert.ok([true, false, null].includes(service.healthy));
    assert.ok(typeof service.detail === 'string');
    assert.ok(service.checked_at);
  }
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.equal(byName.Gitea.healthy, true);
  assert.equal(byName.Gitea.version, '1.23.8');
  assert.equal(byName.Authentik.healthy, true);
  assert.equal(byName['Nginx Proxy Manager'].healthy, true);
  assert.equal(byName['Postgres compartilhado'].healthy, true);
  assert.equal(byName['Postgres compartilhado'].databases[1].size, '1.0 GB');
  assert.equal(byName['Redis compartilhado'].healthy, true);
  assert.equal(byName.MinIO.healthy, true);
  assert.equal(byName['Cloudflare Tunnel'].healthy, true);
  assert.equal(byName['Gitea runner'].healthy, false);
  assert.match(byName['Gitea runner'].detail, /exited/);
  assert.equal(byName.Backup.healthy, true);
  assert.equal(byName.Backup.age_hours, 2);
  assert.equal(byName.Backup.newest_file, '/backups/manifest-2026-10-16.json');
  assert.equal(status.overall, 'degraded');
  assert.deepEqual(status.summary, { total: 9, healthy: 8, unhealthy: 1, unknown: 0 });
  assert.equal(status.links.portainer, 'https://portainer.exemplo.cloud');
  assert.equal(status.links.glances, 'https://monitor.exemplo.cloud');
  assert.ok(calls.some((call) => call.url === 'http://npm.local:81/api/tokens' && call.method === 'POST'));

  const again = await platform.status();
  assert.equal(again.cached, true);
});

test('unconfigured services are reported as unknown, not unhealthy', async () => {
  const platform = createPlatformStatus({
    env: {},
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    listDockerContainersFn: () => ({ available: false, error: 'docker_not_found', containers: [] }),
    pgQueryFn: async () => { throw new Error('should not query'); },
    redisPingFn: async () => { throw new Error('should not ping'); },
    readdir: () => { throw new Error('should not read'); },
  });
  const status = await platform.status();
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.equal(byName.Gitea.healthy, null);
  assert.equal(byName.Gitea.configured, false);
  assert.equal(byName['Postgres compartilhado'].healthy, null);
  assert.equal(byName['Redis compartilhado'].healthy, null);
  assert.equal(byName.MinIO.healthy, null);
  assert.equal(byName.Backup.healthy, null);
  assert.equal(byName.Backup.detail, 'no backup configured');
  assert.equal(byName['Cloudflare Tunnel'].healthy, null);
  assert.match(byName['Cloudflare Tunnel'].detail, /Docker indisponivel/);
  // Authentik has a default URL derived from BASE_DOMAIN, so it is probed and fails here.
  assert.equal(byName.Authentik.healthy, false);
  assert.equal(status.summary.unknown, 8);
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
    ...fsStubs({}),
  });
  const status = await platform.status();
  const byName = Object.fromEntries(status.services.map((service) => [service.name, service]));
  assert.equal(byName.Gitea.healthy, false);
  assert.match(byName.Gitea.detail, /timeout/);
  assert.equal(byName.Authentik.healthy, false);
  assert.match(byName.Authentik.detail, /HTTP 502/);
  assert.equal(byName['Nginx Proxy Manager'].healthy, false);
  assert.match(byName['Postgres compartilhado'].detail, /connection refused/);
  assert.match(byName['Redis compartilhado'].detail, /NOAUTH/);
  assert.match(byName['Cloudflare Tunnel'].detail, /nao encontrado/);
  assert.match(byName.Backup.detail, /nenhum arquivo casa/);
  assert.equal(status.overall, 'degraded');
});

test('checkBackup flags stale backups against BACKUP_MAX_AGE_HOURS', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const config = platformConfigFromEnv({ BACKUP_MANIFEST_GLOB: '/backups/snapshot-*.json', BACKUP_MAX_AGE_HOURS: '12' });
  const stale = checkBackup(config, { now: () => now, ...fsStubs({ 'snapshot-a.json': now - 30 * 3_600_000 }) });
  assert.equal(stale.healthy, false);
  assert.match(stale.detail, /atrasado/);
  assert.equal(stale.max_age_hours, 12);

  const missingDir = checkBackup(config, { now: () => now, readdir: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.equal(missingDir.healthy, false);
  assert.match(missingDir.detail, /diretorio nao existe/);
});

test('glob and file helpers', () => {
  assert.equal(globToRegExp('manifest-*.json').test('manifest-2026.json'), true);
  assert.equal(globToRegExp('manifest-*.json').test('manifest-2026.json.bak'), false);
  assert.equal(globToRegExp('snap-????.tar').test('snap-2026.tar'), true);
  const found = newestFileMatching('/b/m-*.json', fsStubs({ 'm-1.json': 10, 'm-2.json': 20, 'x.json': 99 }));
  assert.equal(found.file.path, '/b/m-2.json');
});

test('checkContainer matches compose-style suffixes', () => {
  const state = { available: true, containers: [{ name: 'gitea-runner-1', state: 'running', status: 'Up' }] };
  assert.equal(checkContainer('Gitea runner', 'ci', 'gitea-runner', state).healthy, true);
  assert.equal(checkContainer('Cloudflare Tunnel', 'tunnel', 'cloudflared', state).healthy, false);
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
