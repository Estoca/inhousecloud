import { spawnSync } from 'node:child_process';
import { enrichDockerContainersWithInventory, readInventory } from './inventory.js';
import { parseDockerLabels, parseDockerPsJsonLines } from './docker-state.js';

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
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };

  return Math.round(amount * (multipliers[unit] ?? 1));
}

export function parseDockerSize(size) {
  const value = String(size || '').trim();
  if (!value) {
    return {
      writable_bytes: null,
      virtual_bytes: null,
    };
  }

  const virtualMatch = value.match(/\(virtual\s+([^)]+)\)/i);
  const writableRaw = value.replace(/\s*\(virtual\s+[^)]+\)\s*/i, '').trim();

  return {
    writable_bytes: parseBytes(writableRaw),
    virtual_bytes: parseBytes(virtualMatch?.[1]),
  };
}

export function normalizeDockerSizeRow(row) {
  const labels = parseDockerLabels(row.Labels);
  const size = parseDockerSize(row.Size);
  return {
    name: row.Names,
    image: row.Image,
    state: row.State,
    status: row.Status,
    ports: row.Ports,
    labels,
    docker_stack: labels['com.docker.compose.project'] || null,
    docker_service: labels['com.docker.compose.service'] || null,
    size_writable_bytes: size.writable_bytes,
    size_virtual_bytes: size.virtual_bytes,
    size_raw: row.Size || null,
  };
}

export function collectDockerDiskUsage({
  inventory = readInventory(),
} = {}) {
  const result = spawnSync('docker', ['ps', '-a', '--size', '--format', '{{json .}}'], {
    encoding: 'utf8',
    timeout: 15000,
  });

  if (result.error?.code === 'ENOENT') {
    return {
      available: false,
      error: 'docker_not_found',
      rows: [],
      summary: null,
    };
  }

  if (result.error) {
    return {
      available: false,
      error: result.error.message,
      rows: [],
      summary: null,
    };
  }

  if (result.status !== 0) {
    return {
      available: false,
      error: [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || `docker exited with ${result.status}`,
      rows: [],
      summary: null,
    };
  }

  const containers = parseDockerPsJsonLines(result.stdout).map(normalizeDockerSizeRow);
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
      size_raw: container.size_raw ?? null,
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
