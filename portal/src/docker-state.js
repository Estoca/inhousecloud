import { spawnSync } from 'node:child_process';

export function parseDockerPsJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parsePercent(value) {
  if (value == null) return null;
  const parsed = Number(String(value).replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBytes(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^([\d.]+)\s*([kmgtp]?i?b|b)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    pb: 1000 ** 5,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
  };

  return Math.round(amount * (multipliers[unit] ?? 1));
}

export function parseDockerStatsJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseDockerLabels(labels) {
  if (typeof labels !== 'string' || labels.trim() === '') return {};
  return Object.fromEntries(labels
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .map((label) => {
      const separator = label.indexOf('=');
      if (separator === -1) return [label, ''];
      return [label.slice(0, separator), label.slice(separator + 1)];
    }));
}

export function normalizeContainer(row) {
  const labels = parseDockerLabels(row.Labels);
  return {
    name: row.Names,
    image: row.Image,
    state: row.State,
    status: row.Status,
    ports: row.Ports,
    labels,
    docker_stack: labels['com.docker.compose.project'] || null,
    docker_service: labels['com.docker.compose.service'] || null,
  };
}

export function normalizeContainerStats(row) {
  const [memUsedRaw, memLimitRaw] = String(row.MemUsage || '').split('/').map((part) => part.trim());
  return {
    id: row.ID || row.Container || null,
    name: row.Name || null,
    cpu_percent: parsePercent(row.CPUPerc),
    memory_usage_bytes: parseBytes(memUsedRaw),
    memory_limit_bytes: parseBytes(memLimitRaw),
    memory_percent: parsePercent(row.MemPerc),
    net_io: row.NetIO || null,
    block_io: row.BlockIO || null,
    pids: row.PIDs == null || row.PIDs === '' ? null : Number(row.PIDs),
  };
}

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

function listDockerStats() {
  const result = spawnSync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
    encoding: 'utf8',
    timeout: 10000,
  });

  if (result.error?.code === 'ENOENT') {
    return {
      available: false,
      error: 'docker_not_found',
      stats: [],
    };
  }

  if (result.error) {
    return {
      available: false,
      error: result.error.message,
      stats: [],
    };
  }

  if (result.status !== 0) {
    return {
      available: false,
      error: [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || `docker stats exited with ${result.status}`,
      stats: [],
    };
  }

  return {
    available: true,
    stats: parseDockerStatsJsonLines(result.stdout).map(normalizeContainerStats),
  };
}

export function listDockerContainers() {
  const result = spawnSync('docker', ['ps', '-a', '--format', '{{json .}}'], {
    encoding: 'utf8',
    timeout: 10000,
  });

  if (result.error?.code === 'ENOENT') {
    return {
      available: false,
      error: 'docker_not_found',
      containers: [],
    };
  }

  if (result.error) {
    return {
      available: false,
      error: result.error.message,
      containers: [],
    };
  }

  if (result.status !== 0) {
    return {
      available: false,
      error: [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || `docker exited with ${result.status}`,
      containers: [],
    };
  }

  const statsState = listDockerStats();
  const statsByName = new Map(statsState.stats.map((stats) => [stats.name, stats]));

  return {
    available: true,
    resources_available: statsState.available,
    resources_error: statsState.available ? null : statsState.error,
    containers: parseDockerPsJsonLines(result.stdout).map((row) => {
      const container = normalizeContainer(row);
      return {
        ...container,
        resources: statsByName.get(container.name) ?? null,
      };
    }),
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
    const stackContainers = stackName ? byStack.get(stackName) ?? [] : [];
    const container = targetContainer
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
