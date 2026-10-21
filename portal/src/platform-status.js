// Visao da plataforma: saude dos servicos centrais da maquina, lida de onde
// cada um vive. Nada aqui escreve; cada checagem e uma leitura curta com timeout.
//
// Servicos (na ordem em que aparecem):
//   gitea       GET {GITEA_URL}/api/v1/version
//   authentik   GET {AUTHENTIK_URL}/-/health/ready/
//   npm         POST {NPM_URL}/api/tokens com NPM_EMAIL/NPM_PASSWORD (login funciona)
//   postgres    SELECT 1 e tamanho dos bancos via PLATFORM_PG_READONLY_URL
//   redis       PING em REDIS_URL (RESP cru, sem biblioteca)
//   minio       GET {MINIO_ENDPOINT}/minio/health/live
//   cloudflared container CLOUDFLARED_CONTAINER rodando
//   gitea-runner container GITEA_RUNNER_CONTAINER rodando
//   backup      idade do arquivo mais novo que casa com BACKUP_MANIFEST_GLOB
//
// Cada item sai como { name, kind, healthy, detail, checked_at, ... }. O mesmo
// JSON serve para a pagina "Plataforma" e para um LLM ler o estado da maquina.

import net from 'node:net';
import path from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import pg from 'pg';
import { listDockerContainers } from './docker-state.js';
import { publicPlatformConfig, readPlatformConfig } from './config.js';

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 30_000;

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripSlash(value) {
  return cleanText(value)?.replace(/\/+$/, '') ?? null;
}

export function platformConfigFromEnv(env = process.env) {
  const platform = readPlatformConfig(env);
  const baseDomain = platform.baseDomain;
  return {
    platform,
    baseDomain,
    giteaUrl: platform.giteaUrl,
    giteaToken: cleanText(env.GITEA_TOKEN),
    authentikUrl: platform.authentikUrl,
    npmUrl: stripSlash(env.NPM_URL),
    npmEmail: cleanText(env.NPM_EMAIL),
    npmPassword: cleanText(env.NPM_PASSWORD),
    pgReadonlyUrl: cleanText(env.PLATFORM_PG_READONLY_URL),
    redisUrl: cleanText(env.REDIS_URL) || cleanText(env.SHARED_REDIS_URL),
    minioEndpoint: stripSlash(env.MINIO_ENDPOINT),
    cloudflaredContainer: cleanText(env.CLOUDFLARED_CONTAINER) || 'cloudflared',
    giteaRunnerContainer: cleanText(env.GITEA_RUNNER_CONTAINER) || 'gitea-runner',
    backupManifestGlob: cleanText(env.BACKUP_MANIFEST_GLOB),
    backupMaxAgeHours: Number(env.BACKUP_MAX_AGE_HOURS) > 0 ? Number(env.BACKUP_MAX_AGE_HOURS) : 26,
    portainerUrl: stripSlash(env.PORTAINER_URL) || `https://portainer.${baseDomain}`,
    glancesUrl: stripSlash(env.GLANCES_URL) || `https://monitor.${baseDomain}`,
    timeoutMs: Number(env.PLATFORM_STATUS_TIMEOUT_MS) > 0 ? Number(env.PLATFORM_STATUS_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
  };
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function result(name, kind, healthy, detail, extra = {}) {
  return {
    name,
    kind,
    healthy,
    detail,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

function notConfigured(name, kind, detail) {
  return result(name, kind, null, detail, { configured: false });
}

async function httpProbe(fetchImpl, url, { timeoutMs, method = 'GET', headers, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });
    return { ok: response.ok, status: response.status, latency_ms: Date.now() - started, response };
  } catch (error) {
    return { ok: false, status: null, latency_ms: Date.now() - started, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkGitea(config, { fetchImpl }) {
  if (!config.giteaUrl) return notConfigured('Gitea', 'git', 'GITEA_URL nao configurado');
  const url = `${config.giteaUrl}/api/v1/version`;
  // Gitea com REQUIRE_SIGNIN_VIEW responde 403 sem token; o mesmo token
  // somente leitura usado pelo historico de deploys serve aqui.
  const headers = config.giteaToken ? { authorization: `token ${config.giteaToken}` } : undefined;
  const probe = await httpProbe(fetchImpl, url, { timeoutMs: config.timeoutMs, headers });
  if (!probe.ok) {
    return result('Gitea', 'git', false, probe.error ? `sem resposta: ${probe.error}` : `HTTP ${probe.status}`, { url, latency_ms: probe.latency_ms });
  }
  let version = null;
  try {
    version = (await probe.response.json())?.version ?? null;
  } catch {
    version = null;
  }
  return result('Gitea', 'git', true, version ? `versao ${version}` : 'respondendo', { url, version, latency_ms: probe.latency_ms });
}

export async function checkAuthentik(config, { fetchImpl }) {
  if (!config.authentikUrl) return notConfigured('Authentik', 'auth', 'AUTHENTIK_URL nao configurado');
  const url = `${config.authentikUrl}/-/health/ready/`;
  const probe = await httpProbe(fetchImpl, url, { timeoutMs: config.timeoutMs });
  const healthy = probe.ok || probe.status === 204;
  return result('Authentik', 'auth', healthy, healthy ? 'ready' : (probe.error ? `sem resposta: ${probe.error}` : `HTTP ${probe.status}`), {
    url,
    latency_ms: probe.latency_ms,
  });
}

export async function checkNpm(config, { fetchImpl }) {
  if (!config.npmUrl) return notConfigured('Nginx Proxy Manager', 'proxy', 'NPM_URL nao configurado');
  if (!config.npmEmail || !config.npmPassword) {
    return notConfigured('Nginx Proxy Manager', 'proxy', 'NPM_EMAIL/NPM_PASSWORD nao configurados; login nao testado');
  }
  const url = `${config.npmUrl}/api/tokens`;
  const probe = await httpProbe(fetchImpl, url, {
    timeoutMs: config.timeoutMs,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity: config.npmEmail, secret: config.npmPassword }),
  });
  return result('Nginx Proxy Manager', 'proxy', probe.ok, probe.ok ? 'login da API funciona' : (probe.error ? `sem resposta: ${probe.error}` : `login falhou: HTTP ${probe.status}`), {
    url: config.npmUrl,
    latency_ms: probe.latency_ms,
  });
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let amount = value;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export async function defaultPgQuery(connectionString, sql, { timeoutMs }) {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs });
  try {
    const outcome = await pool.query(sql);
    return outcome.rows;
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function checkPostgres(config, { pgQueryFn }) {
  if (!config.pgReadonlyUrl) return notConfigured('Postgres compartilhado', 'database', 'PLATFORM_PG_READONLY_URL nao configurado');
  const started = Date.now();
  try {
    await withTimeout(pgQueryFn(config.pgReadonlyUrl, 'SELECT 1 AS ok', { timeoutMs: config.timeoutMs }), config.timeoutMs);
    const rows = await withTimeout(pgQueryFn(
      config.pgReadonlyUrl,
      'SELECT datname, pg_database_size(datname) AS size_bytes FROM pg_database WHERE NOT datistemplate ORDER BY pg_database_size(datname) DESC',
      { timeoutMs: config.timeoutMs },
    ), config.timeoutMs);
    const databases = rows.map((row) => ({ name: row.datname, size_bytes: Number(row.size_bytes), size: formatBytes(row.size_bytes) }));
    const total = databases.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
    return result('Postgres compartilhado', 'database', true, `${databases.length} bancos, ${formatBytes(total)}`, {
      latency_ms: Date.now() - started,
      databases,
      total_bytes: total,
    });
  } catch (error) {
    return result('Postgres compartilhado', 'database', false, `falhou: ${error.message}`, { latency_ms: Date.now() - started });
  }
}

export function parseRedisUrl(value) {
  const url = new URL(value);
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port) || 6379,
    password: url.password ? decodeURIComponent(url.password) : null,
    username: url.username ? decodeURIComponent(url.username) : null,
    tls: url.protocol === 'rediss:',
  };
}

function respCommand(parts) {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join('')}`;
}

export function defaultRedisPing(redisUrl, { timeoutMs }) {
  const target = parseRedisUrl(redisUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let buffer = '';
    let authed = !target.password;
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('timeout')));
    socket.on('error', (error) => finish(error));
    socket.on('connect', () => {
      if (target.password) {
        socket.write(respCommand(target.username ? ['AUTH', target.username, target.password] : ['AUTH', target.password]));
      } else {
        socket.write(respCommand(['PING']));
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lineEnd = buffer.indexOf('\r\n');
      if (lineEnd === -1) return;
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (line.startsWith('-')) {
        finish(new Error(line.slice(1)));
        return;
      }
      if (!authed) {
        authed = true;
        socket.write(respCommand(['PING']));
        return;
      }
      finish(null, line.replace(/^\+/, ''));
    });
  });
}

export async function checkRedis(config, { redisPingFn }) {
  if (!config.redisUrl) return notConfigured('Redis compartilhado', 'cache', 'REDIS_URL nao configurado');
  const started = Date.now();
  try {
    const reply = await redisPingFn(config.redisUrl, { timeoutMs: config.timeoutMs });
    const healthy = String(reply).toUpperCase() === 'PONG';
    return result('Redis compartilhado', 'cache', healthy, healthy ? 'PONG' : `resposta inesperada: ${reply}`, { latency_ms: Date.now() - started });
  } catch (error) {
    return result('Redis compartilhado', 'cache', false, `falhou: ${error.message}`, { latency_ms: Date.now() - started });
  }
}

export async function checkMinio(config, { fetchImpl }) {
  if (!config.minioEndpoint) return notConfigured('MinIO', 'storage', 'MINIO_ENDPOINT nao configurado');
  const url = `${config.minioEndpoint}/minio/health/live`;
  const probe = await httpProbe(fetchImpl, url, { timeoutMs: config.timeoutMs });
  return result('MinIO', 'storage', probe.ok, probe.ok ? 'live' : (probe.error ? `sem resposta: ${probe.error}` : `HTTP ${probe.status}`), {
    url,
    latency_ms: probe.latency_ms,
  });
}

function findContainer(dockerState, name) {
  const wanted = String(name).toLowerCase();
  return dockerState.containers.find((container) => String(container.name).toLowerCase() === wanted)
    ?? dockerState.containers.find((container) => String(container.name).toLowerCase().startsWith(`${wanted}-`))
    ?? null;
}

export function checkContainer(label, kind, containerName, dockerState) {
  if (!dockerState.available) {
    return result(label, kind, null, `Docker indisponivel: ${dockerState.error || 'erro desconhecido'}`, { container: containerName, configured: true });
  }
  const container = findContainer(dockerState, containerName);
  if (!container) {
    return result(label, kind, false, `container ${containerName} nao encontrado`, { container: containerName });
  }
  const running = container.state === 'running';
  return result(label, kind, running, running ? (container.status || 'rodando') : `container ${container.name} em estado ${container.state}`, {
    container: container.name,
    state: container.state,
    status: container.status,
    image: container.image ?? null,
  });
}

// Glob minimo: o diretorio e literal e o nome do arquivo aceita `*` e `?`.
export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function newestFileMatching(globPattern, { readdir = readdirSync, stat = statSync } = {}) {
  const directory = path.dirname(globPattern);
  const filePattern = globToRegExp(path.basename(globPattern));
  let entries;
  try {
    entries = readdir(directory);
  } catch (error) {
    return { error: error.code === 'ENOENT' ? `diretorio nao existe: ${directory}` : error.message, file: null };
  }
  let newest = null;
  for (const entry of entries) {
    if (!filePattern.test(entry)) continue;
    let info;
    try {
      info = stat(path.join(directory, entry));
    } catch {
      continue;
    }
    if (!info.isFile?.() && info.isFile !== undefined) continue;
    if (!newest || info.mtimeMs > newest.mtimeMs) {
      newest = { path: path.join(directory, entry), mtimeMs: info.mtimeMs, size: info.size };
    }
  }
  return { error: null, file: newest, directory };
}

export function checkBackup(config, { now = () => Date.now(), readdir, stat } = {}) {
  if (!config.backupManifestGlob) return notConfigured('Backup', 'backup', 'no backup configured');
  const found = newestFileMatching(config.backupManifestGlob, { readdir, stat });
  if (found.error) return result('Backup', 'backup', false, found.error, { glob: config.backupManifestGlob });
  if (!found.file) return result('Backup', 'backup', false, `nenhum arquivo casa com ${config.backupManifestGlob}`, { glob: config.backupManifestGlob });
  const ageMs = Math.max(0, now() - found.file.mtimeMs);
  const ageHours = ageMs / 3_600_000;
  const healthy = ageHours <= config.backupMaxAgeHours;
  return result('Backup', 'backup', healthy, `${healthy ? 'ultimo backup' : 'backup atrasado'} ha ${ageHours < 1 ? `${Math.round(ageMs / 60_000)} min` : `${ageHours.toFixed(1)} h`}`, {
    glob: config.backupManifestGlob,
    newest_file: found.file.path,
    newest_at: new Date(found.file.mtimeMs).toISOString(),
    age_hours: Math.round(ageHours * 10) / 10,
    max_age_hours: config.backupMaxAgeHours,
    size_bytes: found.file.size,
  });
}

export function createPlatformStatus({
  env = process.env,
  fetchImpl = fetch,
  pgQueryFn = defaultPgQuery,
  redisPingFn = defaultRedisPing,
  listDockerContainersFn = listDockerContainers,
  now = () => Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  readdir,
  stat,
} = {}) {
  let cached = null;

  async function collect() {
    const config = platformConfigFromEnv(env);
    const dockerState = listDockerContainersFn();
    const services = await Promise.all([
      checkGitea(config, { fetchImpl }),
      checkAuthentik(config, { fetchImpl }),
      checkNpm(config, { fetchImpl }),
      checkPostgres(config, { pgQueryFn }),
      checkRedis(config, { redisPingFn }),
      checkMinio(config, { fetchImpl }),
      Promise.resolve(checkContainer('Cloudflare Tunnel', 'tunnel', config.cloudflaredContainer, dockerState)),
      Promise.resolve(checkContainer('Gitea runner', 'ci', config.giteaRunnerContainer, dockerState)),
      Promise.resolve(checkBackup(config, { now, readdir, stat })),
    ]);
    const unhealthy = services.filter((service) => service.healthy === false).length;
    const unknown = services.filter((service) => service.healthy === null).length;
    return {
      checked_at: new Date(now()).toISOString(),
      overall: unhealthy > 0 ? 'degraded' : 'healthy',
      summary: {
        total: services.length,
        healthy: services.filter((service) => service.healthy === true).length,
        unhealthy,
        unknown,
      },
      services,
      links: {
        portainer: config.portainerUrl,
        glances: config.glancesUrl,
        gitea: config.platform.giteaPublicUrl,
        authentik: config.authentikUrl,
      },
      // Topologia da instalacao, para quem le o JSON saber onde cada coisa esta.
      topology: publicPlatformConfig(config.platform),
    };
  }

  async function status({ refresh = false } = {}) {
    const current = now();
    if (!refresh && cached && cached.expiresAt > current) {
      return { ...cached.value, cached: true };
    }
    const value = await collect();
    cached = { value, expiresAt: now() + cacheTtlMs };
    return { ...value, cached: false };
  }

  return { status, collect, clearCache: () => { cached = null; } };
}

let sharedStatus = null;

export function getPlatformStatus() {
  if (!sharedStatus) sharedStatus = createPlatformStatus();
  return sharedStatus;
}
