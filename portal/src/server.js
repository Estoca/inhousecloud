#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import {
  enrichDockerContainersWithInventory,
  findApp,
  inferAppsFromDockerMetadata,
  listApps,
  readInventory,
} from './inventory.js';
import { enrichAppsWithDocker, listDockerContainers } from './docker-state.js';
import { enrichAppsWithHealth, listHttpHealth } from './health-state.js';
import { runMigrations } from './migrate.js';
import { getGiteaState } from './gitea-state.js';
import { getPlatformStatus } from './platform-status.js';
import { createStatusCache, createSwrResource, statusCacheConfigFromEnv } from './status-cache.js';
import { publicPlatformConfig, readPlatformConfig } from './config.js';
import {
  getAppStatusMetrics,
  listDiskUsageSnapshots,
  getStorageUsage,
  recordStatusChanges,
  recordStatusPings,
  recordDiskUsageSnapshot,
} from './event-store.js';
import { collectDockerDiskUsage } from './disk-usage.js';
import { createDiskUsageScheduler } from './disk-usage-scheduler.js';
import { deactivatePortalAdmin, listPortalAdmins, upsertPortalAdmin } from './admin-store.js';
import { createAuth } from './auth.js';
import { renderLogin } from './ui.js';
import { catalogMcpTools, executeCatalogMcpTool } from './catalog-mcp.js';
import { createServiceTokenGate } from './service-token.js';
import { createAuthentikDirectory } from './authentik-directory.js';
import { attachPeopleRoutes } from './people-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '..', 'dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');

function hasClientBuild() {
  return existsSync(clientIndexPath);
}

function renderClient() {
  return readFileSync(clientIndexPath, 'utf8');
}

// Rotas /api que respondem sem autenticacao: so o healthcheck (/api/health, apelido
// do /health da raiz), que nao le estado da plataforma nem aceita escrita.
export const PUBLIC_API_PATHS = Object.freeze([
  '/health',
]);

// Estado das migracoes do boot, para o /health e para o instalador (stage portal).
export const bootState = { migrations: { ok: null, skipped: true } };

export function isPublicApiPath(path, method = 'GET') {
  if (String(method).toUpperCase() !== 'GET') return false;
  return PUBLIC_API_PATHS.includes(String(path ?? '').replace(/\/+$/, '') || '/');
}

// O servidor escuta so em loopback por padrao: quem fala com ele e o proxy
// (Nginx Proxy Manager com forward auth do Authentik). Em container, HOST=0.0.0.0
// e a porta publicada e que deve ficar restrita ao proxy.
export function resolveListenHost(env = process.env) {
  const value = typeof env.HOST === 'string' ? env.HOST.trim() : '';
  return value || '127.0.0.1';
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createApp({
  listDockerContainersFn = listDockerContainers,
  listHttpHealthFn = listHttpHealth,
  giteaState = getGiteaState(),
  platformStatus = getPlatformStatus(),
  getAppStatusMetricsFn = getAppStatusMetrics,
  getStorageUsageFn = getStorageUsage,
  recordStatusChangesFn = recordStatusChanges,
  recordStatusPingsFn = recordStatusPings,
  listPortalAdminsFn = listPortalAdmins,
  upsertPortalAdminFn = upsertPortalAdmin,
  deactivatePortalAdminFn = deactivatePortalAdmin,
  collectDockerDiskUsageFn = collectDockerDiskUsage,
  listDiskUsageSnapshotsFn = listDiskUsageSnapshots,
  recordDiskUsageSnapshotFn = recordDiskUsageSnapshot,
  diskUsageScheduler = null,
  catalogMcpToken = process.env.CATALOG_MCP_TOKEN,
  portalApiToken = process.env.IHC_PORTAL_API_TOKEN,
  recordStatusEvents = process.env.RECORD_STATUS_EVENTS === 'true',
  statusCache = null,
  statusCacheConfig = statusCacheConfigFromEnv(),
  auth = createAuth(),
  authentikDirectory = createAuthentikDirectory(),
} = {}) {
  const app = express();

  // Telas de status servidas do cache (Redis compartilhado quando ha URL,
  // memoria caso contrario), com stale-while-revalidate: o pedido devolve o que
  // esta no cache e, passado o TTL, uma unica atualizacao roda em segundo plano.
  // Ver src/status-cache.js e a secao "Cache das telas de status" do README.
  const cache = statusCache ?? createStatusCache({
    redisUrl: statusCacheConfig.redisUrl,
    timeoutMs: statusCacheConfig.redisTimeoutMs,
  });
  app.locals.statusCache = cache;
  const refreshRequested = (req) => req.query.refresh === '1' || req.query.refresh === 'true';
  const swr = (name, build, { ttlSeconds = statusCacheConfig.appsTtlSeconds, keyFor } = {}) => (
    createSwrResource({ cache, name, ttlSeconds, build, keyFor })
  );
  const appsStatusResource = swr('apps-status', (params) => buildAppsStatus(params), {
    keyFor: ({ category = 'all', ownerEmail = null } = {}) => `${category || 'all'}:${ownerEmail || '*'}`,
  });
  const appsRuntimeResource = swr('apps-runtime', async () => {
    const inventory = readInventory();
    const dockerState = await listDockerContainersFn();
    const apps = enrichAppsWithDocker(listApps(), dockerState);
    return {
      source: inventory.source,
      updated_at: inventory.updated_at,
      count: apps.length,
      runtime_available: dockerState.available,
      apps,
    };
  });
  const runtimeDockerResource = swr('runtime-docker', async () => (
    enrichDockerContainersWithInventory(await listDockerContainersFn(), readInventory())
  ));
  const runtimeHealthResource = swr('runtime-health', async () => listHttpHealthFn(listApps()));
  const platformStatusResource = swr('platform-status', async () => (
    typeof platformStatus.collect === 'function'
      ? platformStatus.collect()
      : platformStatus.status({ refresh: true })
  ), { ttlSeconds: statusCacheConfig.platformTtlSeconds });
  // Tudo que deriva do inventario: descartado pelo Atualizar do dashboard.
  const inventoryResources = [
    appsStatusResource,
    appsRuntimeResource,
    runtimeDockerResource,
    runtimeHealthResource,
  ];
  async function invalidateStatusCaches() {
    await Promise.all(inventoryResources.map((resource) => resource.invalidateAll()));
  }
  const diskScheduler = diskUsageScheduler ?? createDiskUsageScheduler({
    collectDockerDiskUsageFn,
    recordDiskUsageSnapshotFn,
  });
  app.locals.diskUsageScheduler = diskScheduler;
  app.use(express.json({ limit: '256kb' }));
  // Token de servico so leitura (src/service-token.js): decide antes de qualquer rota
  // quando ha header Authorization; sem ele, nada muda.
  app.use(createServiceTokenGate({ token: portalApiToken }));
  auth.attachRoutes(app, {
    renderLogin,
  });

  // Provider de leitura para o mcp-gateway. Usa credencial dedicada; sem
  // configuracao, falha fechado.
  function requireCatalogMcpToken(req, res, next) {
    const authorization = String(req.get('authorization') ?? '');
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!catalogMcpToken) {
      res.status(503).json({ error: 'catalog_mcp_not_configured' });
      return;
    }
    if (!constantTimeEqual(match[1], catalogMcpToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  }

  // Healthcheck do container e do proxy (location = /health e publica na forward
  // auth): sem segredo na resposta. Diz se as migracoes do boot passaram.
  const health = (_req, res) => {
    res.json({
      ok: true,
      service: 'inhousecloud-portal',
      commit_hash: String(process.env.COMMIT_SHA || process.env.GIT_SHA || 'unknown').trim() || 'unknown',
      migrations: bootState.migrations,
    });
  };
  app.get('/health', health);

  // Toda rota /api exige a sessao do Authentik (headers da forward auth), menos
  // /api/health (o mesmo /health) e o provider do mcp-gateway, que tem token proprio.
  app.use('/api', async (req, res, next) => {
    if (req.path.startsWith('/internal/mcp/v1/')) {
      next();
      return;
    }
    if (isPublicApiPath(req.path, req.method) || req.serviceToken) {
      next();
      return;
    }

    await auth.requireApiAuth(req, res, next);
  });

  app.get('/api/health', health);

  // Configuracao publica da instalacao (sem segredo): dominios, Gitea, Authentik.
  app.get('/api/platform/config', (_req, res) => {
    res.json(publicPlatformConfig(readPlatformConfig()));
  });

  app.get('/api/apps', (_req, res) => {
    const inventory = readInventory();
    const apps = listApps();
    res.json({
      source: inventory.source,
      updated_at: inventory.updated_at,
      count: apps.length,
      apps,
    });
  });

  app.get('/api/apps/:slug', (req, res) => {
    const appRecord = findApp(req.params.slug);
    if (!appRecord) {
      res.status(404).json({
        error: 'app_not_found',
      });
      return;
    }
    res.json({ app: appRecord });
  });

  // So leitura: descricao, dono e categoria vivem no company-app.yaml do app e mudam por
  // push; o inventario e do ihc-app. As rotas de edicao antigas respondem isso.
  const readOnly = (_req, res) => {
    res.status(405).json({ error: 'read_only', detail: 'edit company-app.yaml in the app repository and push to main' });
  };
  app.patch('/api/apps/:slug/metadata', readOnly);
  app.patch('/api/runtime/docker/:name/metadata', readOnly);

  // Historico de deploys do app, lido do Gitea Actions (runs de push em main).
  app.get('/api/apps/:slug/deploys', async (req, res) => {
    const appRecord = findApp(req.params.slug);
    if (!appRecord) {
      res.status(404).json({
        error: 'app_not_found',
      });
      return;
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const result = await giteaState.listAppDeploys(appRecord, { limit });
    res.json({
      app_slug: appRecord.slug,
      source: result.source,
      repo: result.repo,
      available: result.available,
      error: result.error,
      cached: result.cached ?? false,
      fetched_at: result.fetched_at,
      count: result.runs.length,
      deploys: result.runs,
    });
  });

  app.get('/api/apps/:slug/latest-deploy', async (req, res) => {
    const appRecord = findApp(req.params.slug);
    if (!appRecord) {
      res.status(404).json({
        error: 'app_not_found',
      });
      return;
    }

    const result = await giteaState.latestAppDeploy(appRecord);
    res.json({
      app_slug: appRecord.slug,
      app: appRecord,
      source: result.source,
      repo: result.repo,
      available: result.available,
      error: result.error,
      latest_deploy: result.latest,
    });
  });

  app.get('/api/apps/:slug/status-metrics', auth.requireApiAuth, async (req, res) => {
    const appRecord = findApp(req.params.slug);
    if (!appRecord) {
      res.status(404).json({
        error: 'app_not_found',
      });
      return;
    }

    const result = await getAppStatusMetricsFn(req.params.slug, {
      hours: req.query.hours,
      limit: req.query.limit,
    });

    if (!result.available) {
      res.status(503).json({
        error: 'status_metrics_unavailable',
        detail: result.error,
      });
      return;
    }

    res.json({
      app_slug: req.params.slug,
      app: appRecord,
      ...result,
    });
  });

  // Visoes de runtime e da plataforma: servidas do cache (stale-while-revalidate).
  // `?refresh=1` forca a reconstrucao e espera por ela.
  app.get('/api/runtime/docker', async (req, res) => {
    res.json(await runtimeDockerResource.get({}, { refresh: refreshRequested(req) }));
  });

  app.get('/api/apps-runtime', async (req, res) => {
    res.json(await appsRuntimeResource.get({}, { refresh: refreshRequested(req) }));
  });

  app.get('/api/runtime/health', async (req, res) => {
    res.json(await runtimeHealthResource.get({}, { refresh: refreshRequested(req) }));
  });

  // Saude dos servicos centrais do cloud (proxy, Authentik, Gitea, runners, Postgres,
  // Redis, backup e, por perfil, Garage, ops, agente e tunnel). Mesmo JSON para a pagina
  // e para agentes: com sessao de admin, ou com o token de servico IHC_PORTAL_API_TOKEN
  // (docs/portal-api.md do cloud), que so abre esta rota. ihc-users (viewer) leva 403:
  // ve catalogo, saude e deploys dos apps, nao o detalhe da maquina.
  const adminOrServiceToken = (req, res, next) => (req.serviceToken ? next() : auth.requireAdmin(req, res, next));
  app.get('/api/platform/status', adminOrServiceToken, async (req, res) => {
    res.json(await platformStatusResource.get({}, { refresh: refreshRequested(req) }));
  });

  // Botao Atualizar da pagina Plataforma (admin): sonda tudo agora e espera.
  app.post('/api/platform/status/refresh', auth.requireAdmin, async (_req, res) => {
    res.json(await platformStatusResource.refresh());
  });

  app.get('/api/storage-usage', auth.requireAdmin, async (_req, res) => {
    const result = await getStorageUsageFn();
    if (!result.available) {
      res.status(503).json({
        error: 'storage_unavailable',
        detail: result.error,
      });
      return;
    }
    res.json(result);
  });

  app.get('/api/disk-usage-snapshots', auth.requireSuperAdmin, async (req, res) => {
    const result = await listDiskUsageSnapshotsFn({ limit: req.query.limit });
    if (!result.available) {
      res.status(503).json({
        error: 'disk_usage_snapshots_unavailable',
        detail: result.error,
      });
      return;
    }
    res.json({
      count: result.rows.length,
      rows: result.rows,
      summary: result.summary,
    });
  });

  app.get('/api/disk-usage-schedule', auth.requireSuperAdmin, (_req, res) => {
    res.json({
      schedule: diskScheduler.status(),
    });
  });

  app.post('/api/disk-usage-snapshots/run', auth.requireSuperAdmin, async (_req, res) => {
    const result = await diskScheduler.run({ reason: 'manual' });
    if (result.error) {
      res.status(503).json({
        error: 'disk_usage_snapshot_unavailable',
        detail: result.error,
      });
      return;
    }

    res.status(201).json({
      recorded: result.recorded,
      summary: result.summary,
      schedule: diskScheduler.status(),
    });
  });

  app.get('/api/admins', auth.requireSuperAdmin, async (_req, res) => {
    const result = await listPortalAdminsFn({ bootstrapAdmins: auth.bootstrapAdmins });
    if (!result.available) {
      res.status(503).json({
        error: 'admins_unavailable',
        detail: result.error,
        admins: result.admins,
      });
      return;
    }
    res.json({
      count: result.admins.length,
      admins: result.admins,
    });
  });

  app.post('/api/admins', auth.requireSuperAdmin, async (req, res) => {
    const result = await upsertPortalAdminFn(req.body, { actorEmail: req.user.email });
    if (!result.available) {
      res.status(503).json({
        error: 'admins_unavailable',
        detail: result.error,
      });
      return;
    }
    if (!result.ok) {
      res.status(400).json({
        error: 'invalid_admin',
        details: result.errors,
      });
      return;
    }
    res.status(201).json({ admin: result.admin });
  });

  app.post('/api/admins/:email/deactivate', auth.requireSuperAdmin, async (req, res) => {
    const result = await deactivatePortalAdminFn(req.params.email, {
      actorEmail: req.user.email,
      bootstrapAdmins: auth.bootstrapAdmins,
    });
    if (!result.available) {
      res.status(503).json({
        error: 'admins_unavailable',
        detail: result.error,
      });
      return;
    }
    if (!result.ok) {
      res.status(400).json({
        error: 'invalid_admin_deactivation',
        details: result.errors,
      });
      return;
    }
    res.json({ admin: result.admin });
  });

  function appsForCategory(apps, category, ownerEmail) {
    return apps.filter((appRecord) => {
      if (category && category !== 'all' && (appRecord.category || 'uncategorized') !== category) return false;
      if (ownerEmail && String(appRecord.owner_email ?? '').toLowerCase() !== String(ownerEmail).toLowerCase()) return false;
      return true;
    });
  }

  async function buildAppsStatus({ category = 'all', ownerEmail = null } = {}) {
    const inventory = readInventory();
    const dockerState = await listDockerContainersFn();
    const inferredApps = inferAppsFromDockerMetadata({ inventory, dockerState });
    const inventoryApps = appsForCategory([...(inventory.apps ?? []), ...inferredApps], category, ownerEmail);
    const withDocker = enrichAppsWithDocker(inventoryApps, dockerState);
    const healthState = await listHttpHealthFn(withDocker);
    const apps = enrichAppsWithHealth(withDocker, healthState);
    const statusEvents = recordStatusEvents
      ? await recordStatusChangesFn(apps)
      : { available: true, recorded: 0, events: [] };
    const statusPings = await recordStatusPingsFn(apps);
    return {
      source: inventory.source,
      updated_at: inventory.updated_at,
      schema_version: inventory.schema_version ?? null,
      inventory_error: inventory.error ?? null,
      count: apps.length,
      category,
      runtime_available: dockerState.available,
      health_available: healthState.available,
      status_events_available: statusEvents.available,
      status_events_recorded: statusEvents.recorded,
      status_pings_available: statusPings.available,
      status_pings_recorded: statusPings.recorded,
      apps,
    };
  }

  // O catálogo é uma visão de descoberta: qualquer pessoa autenticada enxerga
  // todos os apps internos. Apenas administradores podem ampliar o recorte por
  // categoria ou dono e acessar as visões operacionais.
  async function appsStatusParams(req, overrides = {}) {
    const user = await auth.currentUser(req);
    const viewerOnly = user?.role === 'viewer';
    const category = overrides.category ?? req.query.category;
    const owner = overrides.owner ?? req.query.owner;
    return {
      category: viewerOnly ? 'internal_app' : String(category || 'all'),
      ownerEmail: viewerOnly ? null : (owner ? String(owner) : null),
    };
  }

  app.get('/api/apps-status', async (req, res) => {
    const params = await appsStatusParams(req);
    res.json(await appsStatusResource.get(params, { refresh: refreshRequested(req) }));
  });

  // Botao Atualizar do dashboard (admin): descarta o cache dos apps, reconstroi
  // a visao pedida agora (e so agora grava os pings de status) e devolve o
  // payload novo. Aceita { category, owner } no corpo.
  app.post('/api/apps-status/refresh', auth.requireAdmin, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const params = await appsStatusParams(req, { category: body.category, owner: body.owner });
    await invalidateStatusCaches();
    res.json(await appsStatusResource.refresh(params));
  });

  app.get('/api/internal/mcp/v1/tools', requireCatalogMcpToken, (_req, res) => {
    res.json({ provider: 'inhousecloud-portal', tools: catalogMcpTools });
  });

  app.post('/api/internal/mcp/v1/tools/:tool/execute', requireCatalogMcpToken, (req, res) => {
    const result = executeCatalogMcpTool(readInventory(), req.params.tool, req.body?.input ?? req.body ?? {});
    if (!result.ok) {
      res.status(result.error === 'app_not_found' ? 404 : 400).json({ error: result.error });
      return;
    }
    res.json(result.result);
  });

  // Pessoas e grupos do Authentik (admin): src/people-routes.js.
  attachPeopleRoutes(app, { auth, directory: authentikDirectory, swr });

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: 'not_found',
    });
  });

  if (hasClientBuild()) {
    app.use(express.static(clientDistPath, { index: false }));

    app.get('/login', (_req, res) => {
      res.type('html').send(renderClient());
    });

    app.get(/^(?!\/auth\/).*/, auth.requireUiAuth, (_req, res) => {
      res.type('html').send(renderClient());
    });
  } else {
    app.get('/login', (_req, res) => {
      res.status(503).send(renderLogin({
        configured: auth.isConfigured(),
      }));
    });

    app.get('/', auth.requireUiAuth, (_req, res) => {
      res.status(503).send('Client build is missing. Run npm run build.');
    });
  }

  return app;
}

// No boot: as migracoes do banco do portal (quando ha DATABASE_URL), depois o listen.
// Migracao que falha nao impede o portal de subir: o /health diz qual, e o instalador
// para no stage portal com a mensagem.
export async function startServer({
  port = process.env.PORT || 8080,
  host = resolveListenHost(),
  migrate = process.env.DATABASE_URL && process.env.MIGRATE_ON_BOOT !== 'false',
} = {}) {
  if (migrate) {
    bootState.migrations = await runMigrations({ log: (line) => console.log(line) });
    if (!bootState.migrations.ok) console.error(`migrations failed: ${bootState.migrations.error}`);
  }
  const app = createApp();
  const server = app.listen(Number(port), host, () => {
    console.log(`inhousecloud-portal listening on ${host}:${port}`);
  });
  app.locals.diskUsageScheduler?.start?.();
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
