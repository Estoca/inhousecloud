import { enrichDockerContainersWithInventory, readInventory } from './inventory.js';
import { dockerGet, normalizeApiContainer } from './docker-api.js';

// Tamanho de cada container (camada gravavel e imagem), de `GET /containers/json?all=1&size=1`
// na API do Docker (no cloud, o docker-ro).
export async function collectDockerDiskUsage({
  inventory = readInventory(),
  env = process.env,
} = {}) {
  let containers;
  try {
    containers = (await dockerGet('/containers/json?all=1&size=1', { env, timeoutMs: 30_000 })).map(normalizeApiContainer);
  } catch (error) {
    return {
      available: false,
      error: error.code === 'ENOENT' ? 'docker_not_found' : error.message,
      rows: [],
      summary: null,
    };
  }

  const enriched = enrichDockerContainersWithInventory({
    available: true,
    containers,
  }, inventory);
  const rows = enriched.containers.map((container) => ({
    app_slug: container.app_slug ?? null,
    docker_stack: container.docker_stack ?? null,
    container_name: container.name,
    docker_service: container.docker_service ?? null,
    image: container.image ?? null,
    state: container.state ?? null,
    size_writable_bytes: container.size_writable_bytes,
    size_virtual_bytes: container.size_virtual_bytes,
    details: {
      status: container.status ?? null,
      ports: container.ports ?? null,
      app_link_type: container.app_link_type ?? null,
    },
  }));

  return {
    available: true,
    rows,
    summary: summarizeDiskUsageRows(rows),
  };
}

export function summarizeDiskUsageRows(rows = []) {
  const byApp = new Map();
  for (const row of rows) {
    const key = row.app_slug || 'unmapped';
    const current = byApp.get(key) ?? {
      app_slug: row.app_slug,
      containers_count: 0,
      size_writable_bytes: 0,
      size_virtual_bytes: 0,
    };
    current.containers_count += 1;
    current.size_writable_bytes += row.size_writable_bytes ?? 0;
    current.size_virtual_bytes += row.size_virtual_bytes ?? 0;
    byApp.set(key, current);
  }

  const apps = Array.from(byApp.values()).sort((a, b) => b.size_writable_bytes - a.size_writable_bytes);

  return {
    containers_count: rows.length,
    size_writable_bytes: rows.reduce((total, row) => total + (row.size_writable_bytes ?? 0), 0),
    size_virtual_bytes: rows.reduce((total, row) => total + (row.size_virtual_bytes ?? 0), 0),
    apps,
  };
}
