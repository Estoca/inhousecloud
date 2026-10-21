import { dockerGet, normalizeApiContainer, normalizeApiStats } from './docker-api.js';

// Containers e consumo pelo HTTP da API do Docker (src/docker-api.js). No cloud, a API
// so leitura do docker-ro: `GET /containers/json?all=1` e, para os que rodam,
// `GET /containers/ID/stats?stream=0`.

function aggregateContainerResources(containers) {
  const resourceContainers = containers.filter((container) => container.resources);
  const topMemoryContainer = [...resourceContainers].sort((a, b) => (
    (b.resources?.memory_usage_bytes ?? 0) - (a.resources?.memory_usage_bytes ?? 0)
  ))[0] ?? null;
  const topCpuContainer = [...resourceContainers].sort((a, b) => (
    (b.resources?.cpu_percent ?? 0) - (a.resources?.cpu_percent ?? 0)
  ))[0] ?? null;

  return {
    containers_count: containers.length,
    measured_containers_count: resourceContainers.length,
    cpu_percent: resourceContainers.reduce((total, container) => total + (container.resources?.cpu_percent ?? 0), 0),
    memory_usage_bytes: resourceContainers.reduce((total, container) => total + (container.resources?.memory_usage_bytes ?? 0), 0),
    memory_limit_bytes: resourceContainers.reduce((total, container) => total + (container.resources?.memory_limit_bytes ?? 0), 0),
    pids: resourceContainers.reduce((total, container) => total + (container.resources?.pids ?? 0), 0),
    top_memory_container: topMemoryContainer ? {
      name: topMemoryContainer.name,
      docker_service: topMemoryContainer.docker_service ?? null,
      memory_usage_bytes: topMemoryContainer.resources?.memory_usage_bytes ?? null,
    } : null,
    top_cpu_container: topCpuContainer ? {
      name: topCpuContainer.name,
      docker_service: topCpuContainer.docker_service ?? null,
      cpu_percent: topCpuContainer.resources?.cpu_percent ?? null,
    } : null,
  };
}

async function listDockerStats(containers, options) {
  const running = containers.filter((container) => container.state === 'running' && container.id);
  const results = await Promise.allSettled(running.map(async (container) => (
    normalizeApiStats(container.name, await dockerGet(`/containers/${encodeURIComponent(container.id)}/stats?stream=0`, options))
  )));
  const failed = results.filter((item) => item.status === 'rejected');
  return {
    available: running.length === 0 || failed.length < running.length,
    error: failed[0]?.reason?.message ?? null,
    stats: results.filter((item) => item.status === 'fulfilled').map((item) => item.value),
  };
}

export async function listDockerContainers({ env = process.env, timeoutMs = 10_000 } = {}) {
  let rows;
  try {
    rows = await dockerGet('/containers/json?all=1', { env, timeoutMs });
  } catch (error) {
    return {
      available: false,
      error: error.code === 'ENOENT' ? 'docker_not_found' : error.message,
      containers: [],
    };
  }

  const containers = rows.map(normalizeApiContainer);
  const statsState = await listDockerStats(containers, { env, timeoutMs });
  const statsByName = new Map(statsState.stats.map((stats) => [stats.name, stats]));

  return {
    available: true,
    resources_available: statsState.available,
    resources_error: statsState.available ? null : statsState.error,
    containers: containers.map((container) => ({
      ...container,
      resources: statsByName.get(container.name) ?? null,
    })),
  };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stackMatchesApp(stackName, app) {
  const stackSlug = slugify(stackName);
  const appSlug = slugify(app?.slug);
  if (!stackSlug || !appSlug || appSlug.length < 4) return false;
  return stackSlug === appSlug
    || stackSlug.endsWith(`-${appSlug}`)
    || stackSlug.startsWith(`${appSlug}-`);
}

export function enrichAppsWithDocker(apps, dockerState) {
  const byName = new Map(dockerState.containers.map((container) => [container.name, container]));
  const byStack = new Map();
  for (const container of dockerState.containers) {
    if (!container.docker_stack) continue;
    const current = byStack.get(container.docker_stack) ?? [];
    current.push(container);
    byStack.set(container.docker_stack, current);
  }
  const stackNames = Array.from(byStack.keys()).sort((a, b) => a.length - b.length);

  return apps.map((app) => {
    const targetContainer = byName.get(app.target);
    const inferredStackName = !app.docker_stack && !targetContainer
      ? stackNames.find((stack) => stackMatchesApp(stack, app))
      : null;
    const stackName = app.docker_stack || targetContainer?.docker_stack || inferredStackName || null;
    // Um servico core (o portal) vive no projeto do cloud: so os containers do seu servico.
    const stackContainers = (stackName ? byStack.get(stackName) ?? [] : [])
      .filter((item) => app.kind !== 'core' || !app.docker_service || item.docker_service === app.docker_service);
    const container = targetContainer
      ?? (app.docker_service ? stackContainers.find((item) => item.docker_service === app.docker_service) : null)
      ?? stackContainers.find((item) => ['app', 'frontend', 'web', 'server'].includes(item.docker_service))
      ?? stackContainers[0]
      ?? null;
    return {
      ...app,
      runtime: {
        source: 'docker',
        available: dockerState.available,
        matched: Boolean(container),
        container: container ?? null,
        stack: stackName || container?.docker_stack || null,
        stack_containers: stackContainers.map((item) => item.name),
        stack_container_details: stackContainers.map((item) => ({
          name: item.name,
          image: item.image,
          state: item.state,
          status: item.status,
          ports: item.ports,
          docker_service: item.docker_service,
          resources: item.resources ?? null,
        })),
        resources: aggregateContainerResources(stackContainers.length > 0 ? stackContainers : (container ? [container] : [])),
        link_type: targetContainer ? 'container' : inferredStackName ? 'stack_inferred' : stackContainers.length > 0 ? 'stack' : null,
        error: dockerState.available ? null : dockerState.error,
      },
    };
  });
}
