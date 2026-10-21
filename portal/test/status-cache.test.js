import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  KEY_PREFIX,
  createRedisClient,
  createStatusCache,
  createSwrResource,
  parseRedisUrl,
  parseRespReply,
  statusCacheConfigFromEnv,
} from '../src/status-cache.js';

// Redis falso em memoria com a mesma interface do cliente real.
function fakeRedis({ failing = false } = {}) {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    failing,
    async get(key) {
      calls.push(['GET', key]);
      if (this.failing) throw new Error('ECONNREFUSED');
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      calls.push(['SET', key, ttlSeconds]);
      if (this.failing) throw new Error('ECONNREFUSED');
      store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
      return 'OK';
    },
    async del(...keys) {
      calls.push(['DEL', ...keys]);
      if (this.failing) throw new Error('ECONNREFUSED');
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    },
    close() {},
  };
}

function clock(start = Date.parse('2026-10-19T12:00:00.000Z')) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => { current += ms; };
  return now;
}

const silent = { warn() {} };

test('statusCacheConfigFromEnv reads TTLs, Redis URL and the legacy ms variable', () => {
  const defaults = statusCacheConfigFromEnv({});
  assert.equal(defaults.redisUrl, null);
  assert.equal(defaults.appsTtlSeconds, 300);
  assert.equal(defaults.platformTtlSeconds, 60);

  const custom = statusCacheConfigFromEnv({
    STATUS_CACHE_REDIS_URL: 'redis://cache:6379/2',
    REDIS_URL: 'redis://other:6379',
    STATUS_CACHE_TTL_SECONDS: '120',
    PLATFORM_STATUS_TTL_SECONDS: '15',
  });
  assert.equal(custom.redisUrl, 'redis://cache:6379/2');
  assert.equal(custom.appsTtlSeconds, 120);
  assert.equal(custom.platformTtlSeconds, 15);

  const fallback = statusCacheConfigFromEnv({ REDIS_URL: ' redis://shared:6379 ', APPS_STATUS_CACHE_TTL_MS: '90000' });
  assert.equal(fallback.redisUrl, 'redis://shared:6379');
  assert.equal(fallback.appsTtlSeconds, 90);

  assert.equal(statusCacheConfigFromEnv({ STATUS_CACHE_TTL_SECONDS: 'abc' }).appsTtlSeconds, 300);
  assert.equal(statusCacheConfigFromEnv({ STATUS_CACHE_TTL_SECONDS: '-5' }).appsTtlSeconds, 300);
});

test('parseRedisUrl and parseRespReply handle the subset the cache uses', () => {
  assert.deepEqual(parseRedisUrl('rediss://user:p%40ss@redis.local:6380/3'), {
    host: 'redis.local', port: 6380, password: 'p@ss', username: 'user', tls: true, db: 3,
  });
  assert.equal(parseRedisUrl('redis://localhost').db, 0);

  assert.deepEqual(parseRespReply(Buffer.from('+OK\r\n')), { value: 'OK', rest: Buffer.alloc(0) });
  assert.equal(parseRespReply(Buffer.from(':3\r\n')).value, 3);
  assert.equal(parseRespReply(Buffer.from('$-1\r\n')).value, null);
  assert.equal(parseRespReply(Buffer.from('$5\r\nhello\r\n')).value, 'hello');
  assert.equal(parseRespReply(Buffer.from('$5\r\nhel')), null, 'bulk incompleto espera mais dados');
  assert.equal(parseRespReply(Buffer.from('-ERR nope\r\n')).error.message, 'ERR nope');
  assert.deepEqual(parseRespReply(Buffer.from('*2\r\n$1\r\na\r\n:2\r\n')).value, ['a', 2]);
});

test('memory cache stores entries with generated_at and honors the hold window', async () => {
  const now = clock();
  const cache = createStatusCache({ now, logger: silent });
  assert.equal(cache.backend, 'memory');
  assert.equal(await cache.get('apps'), null);

  const entry = await cache.set('apps', { count: 2 }, { holdSeconds: 60 });
  assert.equal(entry.generated_at, '2026-10-19T12:00:00.000Z');
  assert.deepEqual((await cache.get('apps')).value, { count: 2 });

  now.advance(61_000);
  assert.equal(await cache.get('apps'), null, 'passou o hold: some');

  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.del('a', 'b');
  assert.equal(await cache.get('a'), null);
  assert.deepEqual(cache.keys(), []);
});

test('redis-backed cache writes prefixed keys with EX and reads them back', async () => {
  const redis = fakeRedis();
  const now = clock();
  const cache = createStatusCache({ redisClient: redis, now, logger: silent });
  assert.equal(cache.backend, 'redis');

  await cache.set('apps-status:all:*', { apps: [1] }, { holdSeconds: 3600 });
  assert.deepEqual(redis.calls.at(-1), ['SET', `${KEY_PREFIX}apps-status:all:*`, 3600]);
  const stored = JSON.parse(redis.store.get(`${KEY_PREFIX}apps-status:all:*`).value);
  assert.equal(stored.generated_at, '2026-10-19T12:00:00.000Z');
  assert.deepEqual(stored.value, { apps: [1] });

  // Outro processo com o mesmo Redis enxerga a entrada.
  const other = createStatusCache({ redisClient: redis, now, logger: silent });
  const entry = await other.get('apps-status:all:*');
  assert.deepEqual(entry.value, { apps: [1] });
  assert.equal(entry.generated_at, '2026-10-19T12:00:00.000Z');

  // Redis sem a chave manda: a copia local nao ressuscita a entrada.
  redis.store.clear();
  assert.equal(await cache.get('apps-status:all:*'), null);
  assert.equal(cache.health().redis_available, true);
});

test('redis failures degrade to memory and never throw', async () => {
  const redis = fakeRedis({ failing: true });
  const now = clock();
  const warnings = [];
  const cache = createStatusCache({ redisClient: redis, now, quarantineMs: 30_000, logger: { warn: (m) => warnings.push(m) } });

  await cache.set('platform', { overall: 'healthy' }, { holdSeconds: 600 });
  const entry = await cache.get('platform');
  assert.deepEqual(entry.value, { overall: 'healthy' });
  assert.equal(warnings.length, 1, 'a segunda operacao ja acha o Redis em quarentena e nem tenta');
  assert.equal(cache.health().redis_available, false);
  assert.match(cache.health().last_error, /ECONNREFUSED/);

  // Passada a quarentena, volta a tentar o Redis.
  redis.failing = false;
  now.advance(31_000);
  await cache.set('platform', { overall: 'degraded' }, { holdSeconds: 600 });
  assert.ok(redis.store.has(`${KEY_PREFIX}platform`));
  assert.equal(cache.health().redis_available, true);
});

test('createRedisClient speaks RESP against a real socket (AUTH, SELECT, SET EX, GET, DEL)', async () => {
  const received = [];
  const store = new Map();
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const parsed = parseRespReply(Buffer.from(buffer));
        if (!parsed) return;
        buffer = Buffer.from(parsed.rest).toString('utf8');
        const [command, ...args] = parsed.value;
        received.push([command, ...args]);
        if (command === 'AUTH' || command === 'SELECT') socket.write('+OK\r\n');
        else if (command === 'SET') { store.set(args[0], args[1]); socket.write('+OK\r\n'); }
        else if (command === 'GET') {
          const value = store.get(args[0]);
          socket.write(value == null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`);
        } else if (command === 'DEL') {
          let removed = 0;
          for (const key of args) if (store.delete(key)) removed += 1;
          socket.write(`:${removed}\r\n`);
        } else socket.write('-ERR unknown\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = createRedisClient(`redis://:secret@127.0.0.1:${port}/1`, { timeoutMs: 1000 });
  try {
    assert.equal(await client.set('k', '{"a":1}', 30), 'OK');
    assert.equal(await client.get('k'), '{"a":1}');
    assert.equal(await client.get('missing'), null);
    assert.equal(await client.del('k', 'missing'), 1);
    assert.deepEqual(received[0], ['AUTH', 'secret']);
    assert.deepEqual(received[1], ['SELECT', '1']);
    assert.deepEqual(received[2], ['SET', 'k', '{"a":1}', 'EX', '30']);
    await assert.rejects(client.ping(), /unknown/);
  } finally {
    client.close();
    server.close();
  }
});

test('createRedisClient rejects instead of hanging when nothing listens', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const client = createRedisClient(`redis://127.0.0.1:${port}`, { timeoutMs: 500 });
  await assert.rejects(client.get('x'));
});

test('swr resource serves the cache and only rebuilds in the background after the TTL', async () => {
  const now = clock();
  const cache = createStatusCache({ now, logger: silent });
  let builds = 0;
  let pings = 0;
  const resource = createSwrResource({
    cache,
    name: 'apps-status',
    ttlSeconds: 300,
    now,
    logger: silent,
    keyFor: ({ category = 'all' }) => category,
    build: async ({ category = 'all' }) => {
      builds += 1;
      pings += 1; // simula a gravacao de pings no Postgres, que so acontece no build
      return { category, build: builds };
    },
  });

  const first = await resource.get({ category: 'all' });
  assert.equal(first.cached, false);
  assert.equal(first.stale, false);
  assert.equal(first.age_seconds, 0);
  assert.equal(first.generated_at, '2026-10-19T12:00:00.000Z');
  assert.equal(first.cache_expires_at, '2026-10-19T12:05:00.000Z');
  assert.equal(first.cache_ttl_seconds, 300);
  assert.equal(builds, 1);

  now.advance(120_000);
  const second = await resource.get({ category: 'all' });
  assert.equal(second.cached, true);
  assert.equal(second.stale, false);
  assert.equal(second.age_seconds, 120);
  assert.equal(second.build, 1);
  assert.equal(builds, 1, 'dentro do TTL nao reconstroi');
  assert.equal(pings, 1, 'pedido HTTP sem refresh nao grava ping');

  now.advance(200_000); // 320s desde a construcao: passou do TTL
  const third = await resource.get({ category: 'all' });
  assert.equal(third.cached, true);
  assert.equal(third.stale, true, 'serve o antigo na hora');
  assert.equal(third.build, 1);
  assert.equal(third.age_seconds, 320);
  // A atualizacao rodou em segundo plano.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 2);
  const fourth = await resource.get({ category: 'all' });
  assert.equal(fourth.cached, true);
  assert.equal(fourth.stale, false);
  assert.equal(fourth.build, 2);
  assert.equal(pings, 2);

  // Outra chave e outro build.
  const internal = await resource.get({ category: 'internal_app' });
  assert.equal(internal.category, 'internal_app');
  assert.equal(builds, 3);
  assert.deepEqual(resource.knownKeys().sort(), ['apps-status:all', 'apps-status:internal_app']);
});

test('swr resource is single-flight: concurrent requests share one build', async () => {
  const now = clock();
  const cache = createStatusCache({ now, logger: silent });
  let builds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const resource = createSwrResource({
    cache,
    name: 'platform',
    ttlSeconds: 60,
    now,
    logger: silent,
    build: async () => {
      builds += 1;
      await gate;
      return { overall: 'healthy', build: builds };
    },
  });

  // Sem cache: todo mundo espera a mesma construcao.
  const cold = [resource.get(), resource.get(), resource.get()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(builds, 1, 'tres pedidos frios, uma construcao');
  assert.equal(resource.inflightCount(), 1);
  release();
  const results = await Promise.all(cold);
  assert.equal(builds, 1);
  assert.ok(results.every((result) => result.build === 1 && result.cached === false));

  // Stale: tres pedidos chegam juntos e disparam UMA atualizacao em segundo plano.
  now.advance(61_000);
  const stale = await Promise.all([resource.get(), resource.get(), resource.get()]);
  assert.ok(stale.every((result) => result.stale === true && result.build === 1));
  assert.equal(builds, 2);
  assert.equal(resource.inflightCount(), 1);
  // refresh forcado durante a atualizacao em curso junta-se a ela.
  const forced = await resource.get({}, { refresh: true });
  assert.equal(forced.cached, false);
  assert.equal(forced.build, 2);
  assert.equal(builds, 2);
});

test('swr resource keeps serving stale data when the background refresh fails', async () => {
  const now = clock();
  const cache = createStatusCache({ now, logger: silent });
  const errors = [];
  let fail = false;
  const resource = createSwrResource({
    cache,
    name: 'apps-npm',
    ttlSeconds: 10,
    now,
    logger: silent,
    onRefreshError: (error) => errors.push(error.message),
    build: async () => {
      if (fail) throw new Error('npm offline');
      return { npm_available: true };
    },
  });
  await resource.get();
  fail = true;
  now.advance(11_000);
  const served = await resource.get();
  assert.equal(served.stale, true);
  assert.equal(served.npm_available, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['npm offline']);
  // O pedido forcado propaga o erro, para o chamador saber.
  await assert.rejects(resource.get({}, { refresh: true }), /npm offline/);
  // E o cache continua la.
  assert.equal((await resource.get()).npm_available, true);
});

test('swr resource invalidation and refreshAll', async () => {
  const now = clock();
  const redis = fakeRedis();
  const cache = createStatusCache({ redisClient: redis, now, logger: silent });
  let builds = 0;
  const resource = createSwrResource({
    cache,
    name: 'apps-status',
    ttlSeconds: 300,
    now,
    logger: silent,
    keyFor: ({ category = 'all', ownerEmail = null }) => `${category}:${ownerEmail || '*'}`,
    build: async (params) => {
      builds += 1;
      return { ...params, build: builds };
    },
  });
  await resource.get({ category: 'all' });
  await resource.get({ category: 'internal_app', ownerEmail: 'a@example.com' });
  assert.equal(builds, 2);

  await resource.invalidateAll();
  assert.equal(redis.store.size, 0);
  assert.deepEqual(resource.knownKeys(), []);
  const rebuilt = await resource.get({ category: 'all' });
  assert.equal(rebuilt.cached, false);
  assert.equal(builds, 3);

  const refreshed = await resource.refreshAll();
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].cached, false);
  assert.equal(builds, 4);

  await resource.invalidate({ category: 'all' });
  assert.equal(await cache.get('apps-status:all:*'), null);
});
