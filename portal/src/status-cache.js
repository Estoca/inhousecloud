// Cache das telas de status (apps, runtime, plataforma).
//
// Duas camadas:
// - createStatusCache: get/set/del com TTL, em Redis quando ha URL configurada
//   (STATUS_CACHE_REDIS_URL ou REDIS_URL) e sempre em memoria. O Redis e o
//   compartilhado da maquina, por isso toda chave leva o prefixo
//   `ihc-portal:`. Falha de Redis nunca derruba o pedido: a leitura cai
//   para a memoria e o Redis fica em quarentena por alguns segundos.
// - createSwrResource: stale-while-revalidate. O pedido devolve o que esta no
//   cache na hora (com cached, generated_at e age_seconds) e, se a entrada
//   passou do TTL, dispara UMA atualizacao em segundo plano (single-flight:
//   pedidos concorrentes nao disparam atualizacoes concorrentes). So a
//   atualizacao chama o `build`, entao o que o build grava (pings no Postgres)
//   acontece so quando uma atualizacao roda de verdade.
import net from 'node:net';
import tls from 'node:tls';

export const KEY_PREFIX = 'ihc-portal:';
export const DEFAULT_APPS_STATUS_TTL_SECONDS = 300;
export const DEFAULT_PLATFORM_STATUS_TTL_SECONDS = 60;
const DEFAULT_REDIS_TIMEOUT_MS = 1500;
const DEFAULT_REDIS_QUARANTINE_MS = 30_000;

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Le os TTLs do ambiente. APPS_STATUS_CACHE_TTL_MS (nome antigo, em ms) ainda
// vale quando STATUS_CACHE_TTL_SECONDS nao esta definido.
export function statusCacheConfigFromEnv(env = process.env) {
  const legacyMs = positiveInt(env.APPS_STATUS_CACHE_TTL_MS, null);
  const appsTtlSeconds = positiveInt(
    env.STATUS_CACHE_TTL_SECONDS,
    legacyMs ? Math.max(1, Math.round(legacyMs / 1000)) : DEFAULT_APPS_STATUS_TTL_SECONDS,
  );
  return {
    redisUrl: cleanText(env.STATUS_CACHE_REDIS_URL) || cleanText(env.REDIS_URL) || null,
    appsTtlSeconds,
    platformTtlSeconds: positiveInt(env.PLATFORM_STATUS_TTL_SECONDS, DEFAULT_PLATFORM_STATUS_TTL_SECONDS),
    redisTimeoutMs: positiveInt(env.STATUS_CACHE_REDIS_TIMEOUT_MS, DEFAULT_REDIS_TIMEOUT_MS),
  };
}

// --- Cliente Redis minimo (RESP2, sem biblioteca) ---------------------------
// Uma conexao, comandos em fila, respostas na ordem. Suficiente para GET, SET
// EX e DEL. Qualquer erro fecha a conexao; a proxima chamada reconecta.

export function parseRedisUrl(value) {
  const url = new URL(value);
  const db = Number((url.pathname || '').replace(/^\//, ''));
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port) || 6379,
    password: url.password ? decodeURIComponent(url.password) : null,
    username: url.username ? decodeURIComponent(url.username) : null,
    tls: url.protocol === 'rediss:',
    db: Number.isInteger(db) && db > 0 ? db : 0,
  };
}

function respCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => {
    const text = String(part);
    return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
  }).join('')}`;
}

// Tenta ler uma resposta RESP completa do inicio do buffer.
// Devolve { value, rest } ou null se ainda falta dado.
export function parseRespReply(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  const lineEnd = buffer.indexOf('\r\n');
  if (lineEnd === -1) return null;
  const line = buffer.subarray(0, lineEnd).toString('utf8');
  const rest = buffer.subarray(lineEnd + 2);
  const type = line[0];
  const payload = line.slice(1);
  if (type === '+') return { value: payload, rest };
  if (type === ':') return { value: Number(payload), rest };
  if (type === '-') return { error: new Error(payload), rest };
  if (type === '$') {
    const length = Number(payload);
    if (length < 0) return { value: null, rest };
    if (rest.length < length + 2) return null;
    return { value: rest.subarray(0, length).toString('utf8'), rest: rest.subarray(length + 2) };
  }
  if (type === '*') {
    const count = Number(payload);
    if (count < 0) return { value: null, rest };
    const items = [];
    let cursor = rest;
    for (let index = 0; index < count; index += 1) {
      const item = parseRespReply(cursor);
      if (!item) return null;
      if (item.error) return { error: item.error, rest: item.rest };
      items.push(item.value);
      cursor = item.rest;
    }
    return { value: items, rest: cursor };
  }
  return { error: new Error(`resposta RESP inesperada: ${line}`), rest };
}

export function createRedisClient(redisUrl, { timeoutMs = DEFAULT_REDIS_TIMEOUT_MS } = {}) {
  const target = parseRedisUrl(redisUrl);
  let socket = null;
  let ready = null;
  let rejectReady = null;
  let buffer = Buffer.alloc(0);
  const pending = [];

  function failAll(error) {
    while (pending.length) pending.shift().reject(error);
  }

  function teardown(error) {
    const current = socket;
    const failure = error ?? new Error('redis: conexao encerrada');
    const pendingReady = rejectReady;
    socket = null;
    ready = null;
    rejectReady = null;
    buffer = Buffer.alloc(0);
    if (current) current.destroy();
    if (pendingReady) pendingReady(failure);
    failAll(failure);
  }

  function onData(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const reply = parseRespReply(buffer);
      if (!reply) return;
      buffer = reply.rest;
      const waiter = pending.shift();
      if (!waiter) continue;
      if (reply.error) waiter.reject(reply.error);
      else waiter.resolve(reply.value);
    }
  }

  function send(parts) {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(new Error('redis: sem conexao'));
        return;
      }
      pending.push({ resolve, reject });
      socket.write(respCommand(parts));
    });
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      const options = { host: target.host, port: target.port };
      const next = target.tls
        ? tls.connect({ ...options, servername: target.host })
        : net.createConnection(options);
      socket = next;
      next.setTimeout(timeoutMs, () => teardown(new Error('redis: timeout')));
      next.on('error', (error) => teardown(error));
      next.on('close', () => teardown(new Error('redis: conexao fechada')));
      next.on('data', onData);
      next.once(target.tls ? 'secureConnect' : 'connect', async () => {
        try {
          if (target.password) {
            await send(target.username ? ['AUTH', target.username, target.password] : ['AUTH', target.password]);
          }
          if (target.db) await send(['SELECT', String(target.db)]);
          rejectReady = null;
          resolve();
        } catch (error) {
          teardown(error);
        }
      });
    });
    ready.catch(() => {});
    return ready;
  }

  async function command(parts) {
    await connect();
    return send(parts);
  }

  return {
    async get(key) {
      return command(['GET', key]);
    },
    async set(key, value, ttlSeconds) {
      const parts = ['SET', key, value];
      if (ttlSeconds > 0) parts.push('EX', String(ttlSeconds));
      return command(parts);
    },
    async del(...keys) {
      if (!keys.length) return 0;
      return command(['DEL', ...keys]);
    },
    async ping() {
      return command(['PING']);
    },
    close() {
      teardown(new Error('redis: fechado'));
    },
  };
}

// --- Cache com TTL: Redis quando ha, memoria sempre --------------------------

export function createStatusCache({
  redisUrl = null,
  redisClient = null,
  prefix = KEY_PREFIX,
  now = () => Date.now(),
  timeoutMs = DEFAULT_REDIS_TIMEOUT_MS,
  quarantineMs = DEFAULT_REDIS_QUARANTINE_MS,
  logger = console,
} = {}) {
  const memory = new Map();
  const client = redisClient ?? (redisUrl ? createRedisClient(redisUrl, { timeoutMs }) : null);
  let redisDownUntil = 0;
  let lastRedisError = null;

  function fullKey(key) {
    return `${prefix}${key}`;
  }

  function withTimeout(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis: timeout')), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function redis(operation) {
    if (!client || now() < redisDownUntil) return { ok: false, skipped: true };
    try {
      const value = await withTimeout(operation(client));
      return { ok: true, value };
    } catch (error) {
      lastRedisError = error?.message ?? String(error);
      redisDownUntil = now() + quarantineMs;
      logger?.warn?.(`status-cache: Redis indisponivel, usando memoria por ${Math.round(quarantineMs / 1000)}s (${lastRedisError})`);
      return { ok: false, error };
    }
  }

  function readMemory(key) {
    const entry = memory.get(key);
    if (!entry) return null;
    if (entry.holdUntil && entry.holdUntil <= now()) {
      memory.delete(key);
      return null;
    }
    return entry;
  }

  return {
    backend: client ? 'redis' : 'memory',
    // Devolve { value, generated_at } ou null.
    async get(key) {
      const result = await redis((redisClient) => redisClient.get(fullKey(key)));
      if (result.ok) {
        if (result.value == null) {
          // Redis responde, e nao tem a chave: a copia em memoria e de outra
          // vida (expirou ou foi invalidada por outro processo).
          memory.delete(key);
          return null;
        }
        try {
          const parsed = JSON.parse(result.value);
          const entry = { value: parsed.value, generated_at: parsed.generated_at };
          memory.set(key, { ...entry, holdUntil: memory.get(key)?.holdUntil ?? 0 });
          return entry;
        } catch {
          return readMemory(key);
        }
      }
      return readMemory(key);
    },
    // holdSeconds e por quanto tempo a entrada fica disponivel para servir
    // stale; o TTL logico (quando ela passa a ser stale) e do SwrResource.
    async set(key, value, { holdSeconds, generatedAt = new Date(now()).toISOString() } = {}) {
      const hold = positiveInt(holdSeconds, 0);
      memory.set(key, {
        value,
        generated_at: generatedAt,
        holdUntil: hold ? now() + hold * 1000 : 0,
      });
      await redis((redisClient) => redisClient.set(fullKey(key), JSON.stringify({ generated_at: generatedAt, value }), hold));
      return { value, generated_at: generatedAt };
    },
    async del(...keys) {
      for (const key of keys) memory.delete(key);
      if (keys.length) await redis((redisClient) => redisClient.del(...keys.map(fullKey)));
    },
    keys() {
      return [...memory.keys()];
    },
    health() {
      return {
        backend: client ? 'redis' : 'memory',
        redis_available: client ? now() >= redisDownUntil : null,
        last_error: lastRedisError,
      };
    },
    close() {
      client?.close?.();
    },
  };
}

// --- Stale-while-revalidate ---------------------------------------------------

function ageSeconds(generatedAt, nowMs) {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return null;
  return Math.max(0, Math.round((nowMs - generated) / 1000));
}

export function createSwrResource({
  cache,
  name,
  ttlSeconds,
  build,
  keyFor = () => 'default',
  // Por quanto tempo uma entrada stale ainda e servida enquanto nao ha
  // atualizacao bem-sucedida. Padrao: 12x o TTL, no minimo 1 hora.
  holdSeconds = Math.max(ttlSeconds * 12, 3600),
  now = () => Date.now(),
  logger = console,
  onRefreshError = null,
}) {
  if (!cache) throw new Error('createSwrResource: cache obrigatorio');
  if (!name) throw new Error('createSwrResource: name obrigatorio');
  if (typeof build !== 'function') throw new Error('createSwrResource: build obrigatorio');
  const inflight = new Map();
  // chave -> params que a geraram, para invalidar e reconstruir tudo.
  const paramsByKey = new Map();

  function cacheKey(params) {
    return `${name}:${keyFor(params ?? {})}`;
  }

  function decorate(entry, { cached, stale }) {
    const nowMs = now();
    const generated = Date.parse(entry.generated_at);
    const expiresAt = Number.isFinite(generated) ? new Date(generated + ttlSeconds * 1000).toISOString() : null;
    return {
      ...entry.value,
      cached,
      stale,
      generated_at: entry.generated_at,
      age_seconds: ageSeconds(entry.generated_at, nowMs),
      cache_ttl_seconds: ttlSeconds,
      cache_expires_at: expiresAt,
    };
  }

  // Single-flight por chave: quem chegar enquanto uma atualizacao roda espera
  // a mesma promessa.
  function refresh(params = {}) {
    const key = cacheKey(params);
    if (inflight.has(key)) return inflight.get(key);
    const run = (async () => {
      const value = await build(params);
      const entry = await cache.set(key, value, { holdSeconds });
      paramsByKey.set(key, params);
      return entry;
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, run);
    return run;
  }

  function refreshInBackground(params) {
    const key = cacheKey(params);
    if (inflight.has(key)) return;
    refresh(params).catch((error) => {
      logger?.warn?.(`status-cache: atualizacao de ${key} falhou (${error?.message ?? error})`);
      onRefreshError?.(error, { key, params });
    });
  }

  return {
    name,
    ttlSeconds,
    async get(params = {}, { refresh: force = false } = {}) {
      const key = cacheKey(params);
      if (force) {
        return decorate(await refresh(params), { cached: false, stale: false });
      }
      const entry = await cache.get(key);
      if (!entry) {
        // Primeiro pedido: nao ha o que servir, espera a construcao.
        return decorate(await refresh(params), { cached: false, stale: false });
      }
      paramsByKey.set(key, params);
      const age = ageSeconds(entry.generated_at, now());
      const stale = age == null || age >= ttlSeconds;
      if (stale) refreshInBackground(params);
      return decorate(entry, { cached: true, stale });
    },
    async refresh(params = {}) {
      return decorate(await refresh(params), { cached: false, stale: false });
    },
    async invalidate(params = {}) {
      const key = cacheKey(params);
      paramsByKey.delete(key);
      await cache.del(key);
    },
    async invalidateAll() {
      const keys = new Set([...paramsByKey.keys(), ...cache.keys().filter((key) => key.startsWith(`${name}:`))]);
      paramsByKey.clear();
      await cache.del(...keys);
    },
    // Reconstroi tudo que ja foi pedido neste processo (botao Atualizar).
    async refreshAll() {
      const results = [];
      for (const params of [...paramsByKey.values()]) {
        results.push(decorate(await refresh(params), { cached: false, stale: false }));
      }
      return results;
    },
    inflightCount() {
      return inflight.size;
    },
    knownKeys() {
      return [...paramsByKey.keys()];
    },
  };
}
