import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fromRoot } from './paths.js';
import { readPlatformConfig } from './config.js';

const CATEGORY_RE = /^[a-z][a-z0-9_]{1,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Repositorios aceitos: GitHub ou o Gitea da plataforma.
export function isAllowedRepoUrl(value, config = readPlatformConfig()) {
  const pattern = new RegExp(`^https://(github\\.com|${escapeRegExp(config.giteaHost)})/.+`, 'i');
  return pattern.test(String(value ?? ''));
}
const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const LIFECYCLES = new Set(['active', 'review', 'disabled', 'archived']);

// O inventario real (inventory/apps.json) vive fora do repo e da imagem:
// INVENTORY_PATH aponta para ele. Sem arquivo, cai no apps.example.json do
// repo, marcado como exemplo.
export function getInventoryExamplePath() {
  return fromRoot('inventory', 'apps.example.json');
}

export function getInventoryPath(env = process.env) {
  const configured = typeof env.INVENTORY_PATH === 'string' && env.INVENTORY_PATH.trim()
    ? env.INVENTORY_PATH.trim()
    : fromRoot('inventory', 'apps.json');
  return configured;
}

export function resolveInventoryPath(env = process.env) {
  const configured = getInventoryPath(env);
  if (existsSync(configured)) return { path: configured, example: false };
  return { path: getInventoryExamplePath(), example: true };
}

export function readInventory(env = process.env) {
  const resolved = resolveInventoryPath(env);
  const inventory = JSON.parse(readFileSync(resolved.path, 'utf8'));
  return resolved.example
    ? { ...inventory, source: `${inventory.source ?? 'inventory/apps.example.json'} (exemplo; defina INVENTORY_PATH)`, example: true }
    : inventory;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function validateAppMetadata(input = {}) {
  const errors = [];
  const category = cleanString(input.category);
  const ownerEmail = cleanString(input.owner_email).toLowerCase();
  const repoUrl = cleanString(input.repo_url);
  const target = cleanString(input.target);
  const dockerStack = cleanString(input.docker_stack);
  const description = cleanString(input.description);
  const lifecycle = cleanString(input.lifecycle);

  if (category && !CATEGORY_RE.test(category)) {
    errors.push({ path: 'category', message: 'must be lowercase snake_case' });
  }

  if (ownerEmail && !EMAIL_RE.test(ownerEmail)) {
    errors.push({ path: 'owner_email', message: 'must be a valid email' });
  }

  if (repoUrl && !isAllowedRepoUrl(repoUrl)) {
    errors.push({ path: 'repo_url', message: `must be a GitHub or ${readPlatformConfig().giteaHost} URL` });
  }

  if (target && !DOCKER_NAME_RE.test(target)) {
    errors.push({ path: 'target', message: 'must be a Docker container name' });
  }

  if (dockerStack && !DOCKER_NAME_RE.test(dockerStack)) {
    errors.push({ path: 'docker_stack', message: 'must be a Docker Compose project/stack name' });
  }
  if (description.length > 280) {
    errors.push({ path: 'description', message: 'must be at most 280 characters' });
  }
  if (lifecycle && !LIFECYCLES.has(lifecycle)) {
    errors.push({ path: 'lifecycle', message: 'must be active, review, disabled, or archived' });
  }

  return {
    ok: errors.length === 0,
    errors,
    metadata: {
      ...(category ? { category } : {}),
      owner_email: ownerEmail || null,
      repo_url: repoUrl || null,
      target: target || null,
      docker_stack: dockerStack || null,
      ...(description ? { description } : {}),
      ...(lifecycle ? { lifecycle } : {}),
    },
  };
}

export function updateInventoryAppMetadata(slug, input, {
  inventoryPath = getInventoryPath(),
} = {}) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const appIndex = inventory.apps.findIndex((app) => app.slug === slug);
  if (appIndex === -1) {
    return {
      ok: false,
      error: 'app_not_found',
      app: null,
    };
  }

  const validation = validateAppMetadata(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'invalid_app_metadata',
      errors: validation.errors,
      app: null,
    };
  }

  const current = inventory.apps[appIndex];
  const next = {
    ...current,
    ...(validation.metadata.category ? { category: validation.metadata.category } : {}),
  };

  if (validation.metadata.owner_email) {
    next.owner_email = validation.metadata.owner_email;
  } else {
    delete next.owner_email;
  }

  if (validation.metadata.repo_url) {
    next.repo_url = validation.metadata.repo_url;
  } else {
    delete next.repo_url;
  }

  if (validation.metadata.target) {
    next.target = validation.metadata.target;
  } else {
    delete next.target;
  }

  if (validation.metadata.docker_stack) {
    next.docker_stack = validation.metadata.docker_stack;
  } else {
    delete next.docker_stack;
  }
  if (validation.metadata.description) next.description = validation.metadata.description;
  else delete next.description;
  if (validation.metadata.lifecycle) next.lifecycle = validation.metadata.lifecycle;
  else delete next.lifecycle;

  inventory.apps[appIndex] = next;
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  return {
    ok: true,
    app: next,
  };
}

export function upsertInventoryApp(slug, input, {
  inventoryPath = getInventoryPath(),
} = {}) {
  const cleanSlug = cleanString(slug);
  if (!SLUG_RE.test(cleanSlug)) {
    return {
      ok: false,
      error: 'invalid_app_slug',
      errors: [{ path: 'slug', message: 'must be lowercase kebab-case' }],
      app: null,
    };
  }

  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const validation = validateAppMetadata({
    category: input.category || 'internal_app',
    owner_email: input.owner_email,
    repo_url: input.repo_url,
    target: input.target,
    docker_stack: input.docker_stack,
    description: input.description,
    lifecycle: input.lifecycle,
  });
  const port = Number(input.port);
  if (!Number.isInteger(port) || port <= 0) {
    validation.ok = false;
    validation.errors.push({ path: 'port', message: 'must be a positive integer' });
  }
  const domain = cleanString(input.domain);
  if (!domain) {
    validation.ok = false;
    validation.errors.push({ path: 'domain', message: 'is required' });
  }

  if (!validation.ok) {
    return {
      ok: false,
      error: 'invalid_app_metadata',
      errors: validation.errors,
      app: null,
    };
  }

  const apps = Array.isArray(inventory.apps) ? inventory.apps : [];
  const appIndex = apps.findIndex((app) => app.slug === cleanSlug);
  const current = appIndex === -1 ? { slug: cleanSlug } : apps[appIndex];
  const next = {
    ...current,
    slug: cleanSlug,
    domain,
    category: validation.metadata.category || current.category || 'internal_app',
    port,
    status: input.status || current.status || ['OK', 'REDIRECT'],
  };

  for (const key of ['owner_email', 'repo_url', 'target', 'docker_stack', 'description', 'lifecycle']) {
    if (validation.metadata[key]) {
      next[key] = validation.metadata[key];
    } else {
      delete next[key];
    }
  }

  if (appIndex === -1) {
    apps.push(next);
  } else {
    apps[appIndex] = next;
  }
  inventory.apps = apps.sort((a, b) => a.slug.localeCompare(b.slug));
  inventory.updated_at = new Date().toISOString();
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  return {
    ok: true,
    app: next,
  };
}

export function updateInventoryDockerMetadata(name, input, {
  inventoryPath = getInventoryPath(),
} = {}) {
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const validation = validateAppMetadata(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'invalid_docker_metadata',
      errors: validation.errors,
      container: null,
    };
  }

  const containers = Array.isArray(inventory.docker_containers) ? inventory.docker_containers : [];
  const containerIndex = containers.findIndex((container) => container.name === name);
  const current = containerIndex === -1 ? { name } : containers[containerIndex];
  const next = {
    ...current,
    name,
    ...(validation.metadata.category ? { category: validation.metadata.category } : {}),
  };

  if (validation.metadata.owner_email) {
    next.owner_email = validation.metadata.owner_email;
  } else {
    delete next.owner_email;
  }

  if (containerIndex === -1) {
    containers.push(next);
  } else {
    containers[containerIndex] = next;
  }

  inventory.docker_containers = containers.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);

  return {
    ok: true,
    container: next,
  };
}

export function enrichDockerContainersWithInventory(dockerState, inventory = readInventory()) {
  const appByTarget = new Map((inventory.apps ?? [])
    .filter((app) => app.target)
    .map((app) => [app.target, app]));
  const appsByStack = new Map();
  const containerByName = new Map(dockerState.containers.map((container) => [container.name, container]));
  for (const app of inventory.apps ?? []) {
    const inferredStack = app.docker_stack || containerByName.get(app.target)?.docker_stack;
    if (!inferredStack) continue;
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

export function listApps() {
  return readInventory().apps;
}

export function findApp(slug) {
  return listApps().find((app) => app.slug === slug) ?? null;
}
