// Visao da plataforma: saude dos servicos centrais do cloud, lida de onde cada um vive.
// Nada aqui escreve; cada checagem e uma leitura curta com timeout.
//
// Servicos (na ordem em que aparecem):
//   proxy        GET {NPM_HEALTH_URL} (http://proxy:81/api/, sem login: so health; o portal
//                nao recebe a senha de admin do proxy)
//   authentik    GET {AUTHENTIK_INTERNAL_URL}/-/health/ready/
//   gitea        GET {GITEA_URL}/api/v1/version com o token so leitura
//   runners      containers gitea-runner e gitea-deployer do projeto do cloud
//   docker-ro    a API Docker so leitura respondeu (lista de containers)
//   postgres     SELECT 1 e tamanho dos bancos via PLATFORM_PG_READONLY_URL, ou o banco do
//                proprio portal (DATABASE_URL)
//   redis        PING em REDIS_URL (RESP cru, sem biblioteca)
//   backup       latest-status.json e latest-success.json em BACKUP_REPORTS_DIR (docs/backup.md
//                do cloud): status da ultima execucao e idade do ultimo sucesso
//   por perfil   garage (storage), portainer/glances/filebrowser/wetty (ops), agent (agent),
//                tunnel conforme TUNNEL_PROVIDER (cloudflared; tailscale e tailnet-dns)
//
// Cada item sai como { name, kind, healthy, detail, checked_at, ... }. O mesmo
// JSON serve para a pagina "Plataforma" e para um agente ler o estado da maquina.

import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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
    project: platform.project,
    profiles: platform.profiles,
    tunnelProvider: platform.tunnelProvider,
    giteaUrl: platform.giteaUrl,
    giteaToken: cleanText(env.GITEA_TOKEN),
    authentikUrl: platform.authentikInternalUrl,
    proxyHealthUrl: stripSlash(env.NPM_HEALTH_URL) ? `${stripSlash(env.NPM_HEALTH_URL)}/` : null,
    pgReadonlyUrl: cleanText(env.PLATFORM_PG_READONLY_URL),
    databaseUrl: cleanText(env.DATABASE_URL),
    redisUrl: cleanText(env.REDIS_URL) || cleanText(env.SHARED_REDIS_URL),
    garageHealthUrl: stripSlash(env.GARAGE_HEALTH_URL),
    backupEnabled: cleanText(env.BACKUP_ENABLED) ? env.BACKUP_ENABLED === 'true' : null,
    backupReportsDir: stripSlash(env.BACKUP_REPORTS_DIR),
    backupMaxAgeHours: Number(env.BACKUP_MAX_AGE_HOURS) > 0 ? Number(env.BACKUP_MAX_AGE_HOURS) : 26,
    portainerUrl: stripSlash(env.PORTAINER_URL) || `${platform.scheme}://portainer.${baseDomain}`,
    glancesUrl: stripSlash(env.GLANCES_URL) || `${platform.scheme}://glances.${baseDomain}`,
    filesUrl: `${platform.scheme}://files.${baseDomain}`,
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

export async function checkProxy(config, { fetchImpl }) {
  if (!config.proxyHealthUrl) return notConfigured('Proxy (Nginx Proxy Manager)', 'proxy', 'NPM_HEALTH_URL nao configurado');
  const probe = await httpProbe(fetchImpl, config.proxyHealthUrl, { timeoutMs: config.timeoutMs });
  return result('Proxy (Nginx Proxy Manager)', 'proxy', probe.ok, probe.ok ? 'respondendo' : (probe.error ? `sem resposta: ${probe.error}` : `HTTP ${probe.status}`), {
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

// Tamanho so dos bancos que o papel pode abrir: pg_database_size pede CONNECT, e o
// instalador tira o CONNECT publico de cada banco.
const DATABASES_SQL = `SELECT datname,
  CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname) END AS size_bytes
  FROM pg_database WHERE NOT datistemplate ORDER BY datname`;

export async function checkPostgres(config, { pgQueryFn }) {
  const url = config.pgReadonlyUrl || config.databaseUrl;
  if (!url) return notConfigured('Postgres compartilhado', 'database', 'PLATFORM_PG_READONLY_URL e DATABASE_URL nao configurados');
  const started = Date.now();
  try {
    await withTimeout(pgQueryFn(url, 'SELECT 1 AS ok', { timeoutMs: config.timeoutMs }), config.timeoutMs);
    const rows = await withTimeout(pgQueryFn(url, DATABASES_SQL, { timeoutMs: config.timeoutMs }), config.timeoutMs);
    const databases = rows.map((row) => ({
      name: row.datname,
      size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
      size: row.size_bytes == null ? null : formatBytes(row.size_bytes),
    }));
    const total = databases.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
    const measured = databases.filter((item) => item.size_bytes != null).length;
    return result('Postgres compartilhado', 'database', true, `${databases.length} bancos${measured ? `, ${formatBytes(total)} nos ${measured} que este papel abre` : ''}`, {
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

export async function checkGarage(config, { fetchImpl }) {
  if (!config.garageHealthUrl) return notConfigured('Garage (S3)', 'storage', 'GARAGE_HEALTH_URL nao configurado');
  const probe = await httpProbe(fetchImpl, config.garageHealthUrl, { timeoutMs: config.timeoutMs });
  return result('Garage (S3)', 'storage', probe.ok, probe.ok ? 'operacional' : (probe.error ? `sem resposta: ${probe.error}` : `HTTP ${probe.status}`), {
    latency_ms: probe.latency_ms,
  });
}

// Um servico do cloud pelo label do Compose (projeto + servico); sem labels, pelo nome.
function findContainer(dockerState, name, project = null) {
  const wanted = String(name).toLowerCase();
  return dockerState.containers.find((container) => container.docker_service === name && (!project || container.docker_stack === project))
    ?? dockerState.containers.find((container) => String(container.name).toLowerCase() === wanted)
    ?? dockerState.containers.find((container) => String(container.name).toLowerCase().startsWith(`${wanted}-`))
    ?? null;
}

export function checkContainer(label, kind, containerName, dockerState, project = null) {
  if (!dockerState.available) {
    return result(label, kind, null, `Docker indisponivel: ${dockerState.error || 'erro desconhecido'}`, { container: containerName, configured: true });
  }
  const container = findContainer(dockerState, containerName, project);
  if (!container) {
    return result(label, kind, false, `container ${containerName} nao encontrado`, { container: containerName });
  }
  const running = container.state === 'running' && !/\(unhealthy\)/.test(String(container.status));
  return result(label, kind, running, running ? (container.status || 'rodando') : `container ${container.name} em estado ${container.state}${/unhealthy/.test(String(container.status)) ? ' (unhealthy)' : ''}`, {
    container: container.name,
    state: container.state,
    status: container.status,
    image: container.image ?? null,
  });
}

function readJson(file, readFile = readFileSync) {
  try {
    return { value: JSON.parse(readFile(file, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.code === 'ENOENT' ? 'missing' : error.message };
  }
}

function ageText(ms) {
  const hours = ms / 3_600_000;
  return hours < 1 ? `${Math.round(ms / 60_000)} min` : `${hours.toFixed(1)} h`;
}

// O contrato do job de backup do cloud (docs/backup.md): latest-status.json diz como foi
// a ultima execucao; latest-success.json, copia do ultimo sucesso, da a idade que importa.
export function checkBackup(config, { now = () => Date.now(), readFile } = {}) {
  if (config.backupEnabled === false) return notConfigured('Backup', 'backup', 'backup desligado (backup.enabled: false)');
  if (!config.backupReportsDir) return notConfigured('Backup', 'backup', 'BACKUP_REPORTS_DIR nao configurado');
  const latest = readJson(path.join(config.backupReportsDir, 'latest-status.json'), readFile);
  const success = readJson(path.join(config.backupReportsDir, 'latest-success.json'), readFile);
  if (!latest.value && !success.value) {
    return result('Backup', 'backup', false, latest.error === 'missing' ? 'nenhum backup rodou ainda' : `status ilegivel: ${latest.error}`, { reports_dir: config.backupReportsDir });
  }
  const maxAgeHours = Number(success.value?.max_age_hours ?? latest.value?.max_age_hours) || config.backupMaxAgeHours;
  const finished = Date.parse(success.value?.finished_at ?? '');
  const ageMs = Number.isFinite(finished) ? Math.max(0, now() - finished) : null;
  const lastStatus = latest.value?.status ?? null;
  const fresh = ageMs !== null && ageMs <= maxAgeHours * 3_600_000;
  const healthy = fresh && lastStatus !== 'failed';
  let detail;
  if (ageMs === null) detail = `nenhum backup com sucesso; ultima execucao: ${lastStatus ?? 'desconhecida'}`;
  else if (lastStatus === 'failed') detail = `ultima execucao falhou (${latest.value?.error ?? 'sem detalhe'}); ultimo sucesso ha ${ageText(ageMs)}`;
  else if (!fresh) detail = `backup atrasado: ultimo sucesso ha ${ageText(ageMs)} (limite ${maxAgeHours} h)`;
  else detail = `ultimo backup ha ${ageText(ageMs)}${lastStatus === 'running' ? '; um backup esta rodando agora' : ''}`;
  return result('Backup', 'backup', healthy, detail, {
    last_status: lastStatus,
    last_run_id: latest.value?.run_id ?? null,
    last_error: latest.value?.error ?? null,
    newest_at: success.value?.finished_at ?? null,
    snapshot_id: success.value?.snapshot_id ?? null,
    age_hours: ageMs === null ? null : Math.round((ageMs / 3_600_000) * 10) / 10,
    max_age_hours: maxAgeHours,
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
  readFile,
} = {}) {
  let cached = null;

  async function collect() {
    const config = platformConfigFromEnv(env);
    const dockerState = await listDockerContainersFn();
    const has = (profile) => config.profiles.includes(profile);
    const container = (label, kind, service) => Promise.resolve(checkContainer(label, kind, service, dockerState, config.project));
    const checks = [
      checkProxy(config, { fetchImpl }),
      checkAuthentik(config, { fetchImpl }),
      checkGitea(config, { fetchImpl }),
      container('Runner de CI (gitea-runner)', 'ci', 'gitea-runner'),
      container('Runner de deploy (gitea-deployer)', 'ci', 'gitea-deployer'),
      Promise.resolve(dockerState.available
        ? result('API Docker so leitura (docker-ro)', 'docker', true, `${dockerState.containers.length} containers visiveis`)
        : result('API Docker so leitura (docker-ro)', 'docker', false, `sem resposta: ${dockerState.error || 'erro desconhecido'}`)),
      checkPostgres(config, { pgQueryFn }),
      checkRedis(config, { redisPingFn }),
      Promise.resolve(checkBackup(config, { now, readFile })),
    ];
    if (has('storage')) checks.push(checkGarage(config, { fetchImpl }));
    if (has('ops')) {
      checks.push(container('Portainer', 'ops', 'portainer'), container('Glances', 'ops', 'glances'), container('FileBrowser', 'ops', 'filebrowser'));
      if (dockerState.containers.some((item) => item.docker_service === 'wetty')) checks.push(container('Terminal web (Wetty)', 'ops', 'wetty'));
    }
    if (has('agent')) checks.push(container('Agente operador', 'agent', 'agent'));
    if (config.tunnelProvider === 'cloudflared') checks.push(container('Cloudflare Tunnel', 'tunnel', 'cloudflared'));
    if (config.tunnelProvider === 'tailscale') {
      checks.push(container('Tailscale', 'tunnel', 'tailscale'), container('DNS do tailnet', 'tunnel', 'tailnet-dns'));
    }
    const services = await Promise.all(checks);
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
        portainer: config.profiles.includes('ops') ? config.portainerUrl : null,
        glances: config.profiles.includes('ops') ? config.glancesUrl : null,
        files: config.profiles.includes('ops') ? config.filesUrl : null,
        gitea: config.platform.giteaPublicUrl,
        authentik: config.platform.authentikUrl,
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
