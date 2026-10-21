import { readFileSync, statSync } from 'node:fs';
import YAML from 'yaml';
import { fromRoot } from './paths.js';
import { readPlatformConfig } from './config.js';

// Inventario dos apps, so leitura.
//
// No InHouseCloud a fonte e <install-dir>/inventory.json, que so `ihc-app provision`
// escreve (scripts/lib/inventory.py tem o contrato, schema_version 1): um objeto `apps`
// indexado por slug. O portal monta o diretorio catalog/ so leitura e le esse arquivo
// por um adaptador (readInventory), que devolve a forma que o resto do portal usa:
// `apps` como lista, com domain, repo_url, docker_stack, healthcheck e auth. O proprio
// portal entra no catalogo como servico core, a partir do seu company-app.yaml
// (PORTAL_MANIFEST_PATH). O formato antigo (lista de apps, inventory/apps.example.json)
// continua lido, para desenvolvimento sem o cloud.
//
// Nada aqui escreve: descricao, dono e categoria mudam no company-app.yaml do app, por push.

export const SUPPORTED_SCHEMA_VERSION = 1;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Repositorios aceitos: GitHub ou o Gitea da plataforma.
export function isAllowedRepoUrl(value, config = readPlatformConfig()) {
  const pattern = new RegExp(`^https://(github\\.com|${escapeRegExp(config.giteaHost)})/.+`, 'i');
  return pattern.test(String(value ?? ''));
}

// O inventario real vive fora do repo e da imagem: INVENTORY_PATH aponta para ele (no
// cloud, /ihc/catalog/inventory.json). Sem INVENTORY_PATH, cai no apps.example.json do
// repo, marcado como exemplo. Com INVENTORY_PATH e sem arquivo, o catalogo fica vazio
// com o erro, nunca com o exemplo.
export function getInventoryExamplePath() {
  return fromRoot('inventory', 'apps.example.json');
}

export function getInventoryPath(env = process.env) {
  return typeof env.INVENTORY_PATH === 'string' && env.INVENTORY_PATH.trim() ? env.INVENTORY_PATH.trim() : null;
}

export function resolveInventoryPath(env = process.env) {
  const configured = getInventoryPath(env);
  if (configured) return { path: configured, example: false };
  return { path: getInventoryExamplePath(), example: true };
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hostOfUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function isIhcInventory(raw) {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw.apps)
    && (raw.schema_version !== undefined || (raw.apps && typeof raw.apps === 'object'));
}

// Um registro do ihc-app (apps.<slug> do inventory.json) na forma do portal.
export function adaptIhcApp(slug, record = {}, config = readPlatformConfig()) {
  const healthPath = cleanText(record.healthcheck?.path) || cleanText(record.runtime?.health_path) || '/';
  const healthStatus = Number(record.healthcheck?.status ?? record.runtime?.health_status) || 200;
  const authRequired = typeof record.auth?.required === 'boolean'
    ? record.auth.required
    : record.runtime?.auth_required !== false;
  const repository = cleanText(record.repository);
  const mcp = record.mcp && typeof record.mcp === 'object' ? record.mcp : null;
  const systemTest = record.kind === 'system-test';
  return {
    slug: record.slug || slug,
    name: cleanText(record.name) || slug,
    description: cleanText(record.description) ?? undefined,
    owner_email: cleanText(record.owner_email),
    url: cleanText(record.url),
    domain: hostOfUrl(record.url) || `${slug}.${config.baseDomain}`,
    category: systemTest ? 'system_test' : 'internal_app',
    lifecycle: 'active',
    kind: record.kind || 'app',
    source: 'ihc-app',
    repository,
    repo_url: repository ? `${config.giteaPublicUrl}/${repository}` : null,
    last_commit: cleanText(record.last_commit),
    created_at: cleanText(record.created_at),
    provisioned_at: cleanText(record.provisioned_at),
    // O projeto Compose de um app e o slug (docs/operator-contract.md).
    docker_stack: slug,
    docker_service: cleanText(record.runtime?.service),
    port: Number(record.runtime?.port) || null,
    healthcheck_path: healthPath,
    healthcheck: { path: healthPath, expected_status: healthStatus },
    auth_required: authRequired,
    mcp,
    agent_interface: mcp ? { mcp } : undefined,
  };
}

// O portal se ve no catalogo: servico core (sobe com o install, antes do Gitea), nao
// app do ihc-app. Os dados vem do seu company-app.yaml.
export function portalCoreApp(env = process.env, config = readPlatformConfig(env)) {
  const manifestPath = cleanText(env.PORTAL_MANIFEST_PATH) || fromRoot('company-app.yaml');
  let manifest = {};
  try {
    manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) || {};
  } catch {
    return null;
  }
  const healthPath = cleanText(manifest.runtime?.healthcheck?.path) || '/health';
  const mcp = manifest.agent_interface?.mcp && typeof manifest.agent_interface.mcp === 'object' ? manifest.agent_interface.mcp : null;
  return {
    slug: cleanText(manifest.app?.slug) || 'portal',
    name: cleanText(manifest.app?.name) || 'Portal',
    description: cleanText(manifest.app?.description) ?? undefined,
    owner_email: null,
    url: config.portalUrl,
    domain: config.portalHost,
    category: 'internal_app',
    lifecycle: 'active',
    kind: 'core',
    source: 'core',
    repository: null,
    repo_url: null,
    docker_stack: config.project,
    docker_service: cleanText(manifest.runtime?.service) || 'portal',
    port: Number(manifest.runtime?.port) || 8080,
    healthcheck_path: healthPath,
    healthcheck: { path: healthPath, expected_status: Number(manifest.runtime?.healthcheck?.expected_status) || 200 },
    auth_required: manifest.auth?.required !== false,
    mcp,
    agent_interface: mcp ? { mcp } : undefined,
  };
}

export function adaptInventory(raw, { env = process.env, config = readPlatformConfig(env), sourcePath = null, mtime = null } = {}) {
  if (!isIhcInventory(raw)) return { ...raw, format: 'list', apps: Array.isArray(raw?.apps) ? raw.apps : [] };
  const schemaVersion = raw.schema_version ?? null;
  const apps = Object.entries(raw.apps || {})
    .filter(([, record]) => record && typeof record === 'object')
    .map(([slug, record]) => adaptIhcApp(slug, record, config))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const core = portalCoreApp(env, config);
  const provisioned = apps.map((app) => app.provisioned_at).filter(Boolean).sort();
  return {
    format: 'ihc',
    schema_version: schemaVersion,
    // Um schema mais novo que o que o portal entende: le o que reconhece e avisa.
    schema_supported: schemaVersion === null || schemaVersion <= SUPPORTED_SCHEMA_VERSION,
    source: `${sourcePath || 'inventory.json'} (ihc-app, schema ${schemaVersion ?? 'none'})`,
    updated_at: provisioned.at(-1) || mtime,
    installation_id: raw.installation_id ?? null,
    apps: core && !apps.some((app) => app.slug === core.slug) ? [core, ...apps] : apps,
    docker_containers: [],
  };
}

// Ultima leitura boa, por caminho: um arquivo trocado no meio da leitura nao derruba o
// catalogo.
const lastGood = new Map();

export function readInventory(env = process.env) {
  const resolved = resolveInventoryPath(env);
  let raw;
  let mtime = null;
  try {
    raw = JSON.parse(readFileSync(resolved.path, 'utf8'));
    mtime = statSync(resolved.path).mtime.toISOString();
  } catch (error) {
    const previous = lastGood.get(resolved.path);
    if (previous) return { ...previous, stale: true, error: error.code || error.message };
    const empty = adaptInventory({ schema_version: SUPPORTED_SCHEMA_VERSION, apps: {} }, { env, sourcePath: resolved.path });
    return { ...empty, error: error.code === 'ENOENT' ? 'inventory_missing' : error.message };
  }
  const inventory = adaptInventory(raw, { env, sourcePath: resolved.path, mtime });
  const result = resolved.example
    ? { ...inventory, source: `${inventory.source ?? 'inventory/apps.example.json'} (exemplo; defina INVENTORY_PATH)`, example: true }
    : inventory;
  lastGood.set(resolved.path, result);
  return result;
}
export function enrichDockerContainersWithInventory(dockerState, inventory = readInventory()) {
  const appByTarget = new Map((inventory.apps ?? [])
    .filter((app) => app.target)
    .map((app) => [app.target, app]));
  const appsByStack = new Map();
  // Um app que e um servico dentro de um projeto maior (o portal no projeto do cloud)
  // so leva os containers desse servico.
  const appsByService = new Map();
  const containerByName = new Map(dockerState.containers.map((container) => [container.name, container]));
  for (const app of inventory.apps ?? []) {
    const inferredStack = app.docker_stack || containerByName.get(app.target)?.docker_stack;
    if (!inferredStack) continue;
    if (app.kind === 'core') {
      appsByService.set(`${inferredStack}/${app.docker_service}`, app);
      continue;
    }
    const current = appsByStack.get(inferredStack) ?? [];
    current.push(app);
    appsByStack.set(inferredStack, current);
  }
  const metadataByName = new Map((inventory.docker_containers ?? [])
    .map((container) => [container.name, container]));

  return {
    ...dockerState,
    containers: dockerState.containers.map((container) => {
      const app = appByTarget.get(container.name)
        ?? appsByService.get(`${container.docker_stack}/${container.docker_service}`)
        ?? appsByStack.get(container.docker_stack)?.[0]
        ?? null;
      const metadata = metadataByName.get(container.name) ?? null;
      return {
        ...container,
        app_slug: app?.slug ?? null,
        app_link_type: appByTarget.get(container.name) ? 'container' : app ? 'stack' : null,
        category: metadata?.category || app?.category || (app ? 'internal_app' : 'uncategorized'),
        owner_email: metadata?.owner_email || app?.owner_email || null,
      };
    }),
  };
}

function hostPorts(container) {
  const ports = String(container?.ports || '');
  return Array.from(ports.matchAll(/(?:0\.0\.0\.0|\[::\]):(\d+)->/g))
    .map((match) => Number(match[1]))
    .filter((port) => Number.isInteger(port));
}

function slugFromValue(value) {
  const baseDomain = readPlatformConfig().baseDomain;
  return String(value || '')
    .replace(new RegExp(`\\.${escapeRegExp(baseDomain)}$`, 'i'), '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function stackMatchesApp(stackName, app) {
  const stackSlug = slugFromValue(stackName);
  const appSlug = slugFromValue(app?.slug);
  if (!stackSlug || !appSlug || appSlug.length < 4) return false;
  return stackSlug === appSlug
    || stackSlug.endsWith(`-${appSlug}`)
    || stackSlug.startsWith(`${appSlug}-`);
}

export function inferAppsFromDockerMetadata({
  inventory = readInventory(),
  dockerState,
  npmState = { proxy_hosts: [] },
} = {}) {
  const apps = inventory.apps ?? [];
  const existingTargets = new Set(apps.map((app) => app.target).filter(Boolean));
  const containersByName = new Map((dockerState?.containers ?? []).map((container) => [container.name, container]));
  const dockerStacks = Array.from(new Set((dockerState?.containers ?? [])
    .map((container) => container.docker_stack)
    .filter(Boolean)));
  const existingStacks = new Set(apps
    .flatMap((app) => {
      const directStack = app.docker_stack || containersByName.get(app.target)?.docker_stack;
      const inferredStack = directStack ? null : dockerStacks.find((stack) => stackMatchesApp(stack, app));
      return [directStack, inferredStack].filter(Boolean);
    }));
  const seenStacks = new Set(existingStacks);
  const seenSlugs = new Set(apps.map((app) => app.slug).filter(Boolean));

  const servicePriority = (container) => {
    const service = String(container?.docker_service || '').toLowerCase();
    if (service === 'frontend') return 0;
    if (service === 'app' || service === 'web') return 1;
    if (service === 'backend') return 2;
    return 3;
  };

  const candidates = (inventory.docker_containers ?? [])
    .filter((metadata) => metadata.category === 'internal_app')
    .map((metadata) => {
      const container = containersByName.get(metadata.name);
      if (!container) return null;
      if (existingTargets.has(container.name)) return null;
      if (container.docker_stack && existingStacks.has(container.docker_stack)) return null;

      const ports = hostPorts(container);
      const proxy = (npmState.proxy_hosts ?? []).find((host) => ports.includes(Number(host.forward_port)));
      const domain = proxy?.domain_names?.[0] ?? null;

      return {
        metadata,
        container,
        ports,
        proxy,
        domain,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (Boolean(a.proxy) !== Boolean(b.proxy)) return a.proxy ? -1 : 1;
      if ((a.container.docker_stack || '') !== (b.container.docker_stack || '')) {
        return String(a.container.docker_stack || '').localeCompare(String(b.container.docker_stack || ''));
      }
      return servicePriority(a.container) - servicePriority(b.container);
    });

  const inferred = [];
  for (const candidate of candidates) {
    if (candidate.container.docker_stack && seenStacks.has(candidate.container.docker_stack)) continue;

    const slug = slugFromValue(candidate.domain)
      || slugFromValue(candidate.container.docker_stack)
      || slugFromValue(candidate.container.name);
    if (!slug || seenSlugs.has(slug)) continue;

    inferred.push({
      slug,
      name: candidate.domain ? slug : candidate.container.name,
      domain: candidate.domain,
      port: candidate.proxy?.forward_port ?? candidate.ports[0] ?? null,
      category: candidate.metadata.category,
      owner_email: candidate.metadata.owner_email ?? null,
      target: candidate.container.name,
      docker_stack: candidate.container.docker_stack ?? null,
      inferred_from_container: true,
    });
    seenSlugs.add(slug);
    if (candidate.container.docker_stack) seenStacks.add(candidate.container.docker_stack);
  }

  return inferred;
}

export function listApps(env = process.env) {
  return readInventory(env).apps;
}

export function findApp(slug, env = process.env) {
  return listApps(env).find((app) => app.slug === slug) ?? null;
}
