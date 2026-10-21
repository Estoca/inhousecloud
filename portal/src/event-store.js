import { query } from './db.js';

function limitValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

export async function getStorageUsage(options = {}) {
  const result = await query(`
    SELECT
      relname AS relation,
      pg_total_relation_size(c.oid) AS total_bytes,
      pg_relation_size(c.oid) AS table_bytes,
      pg_total_relation_size(c.oid) - pg_relation_size(c.oid) AS index_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'deploy_platform'
      AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC
  `, [], options);

  if (!result.available) {
    return {
      available: false,
      error: result.error,
      total_bytes: 0,
      relations: [],
    };
  }

  const relations = result.rows.map((row) => ({
    relation: row.relation,
    total_bytes: Number(row.total_bytes),
    table_bytes: Number(row.table_bytes),
    index_bytes: Number(row.index_bytes),
  }));

  return {
    available: true,
    total_bytes: relations.reduce((sum, row) => sum + row.total_bytes, 0),
    relations,
  };
}

export async function recordDiskUsageSnapshot(rows, options = {}) {
  const candidates = Array.isArray(rows) ? rows.filter((row) => row.container_name) : [];
  if (candidates.length === 0) {
    return {
      available: true,
      recorded: 0,
      rows: [],
    };
  }

  const values = [];
  const params = [];
  candidates.forEach((row, index) => {
    const offset = index * 10;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}::jsonb)`);
    params.push(
      row.app_slug ?? null,
      row.docker_stack ?? null,
      row.container_name,
      row.docker_service ?? null,
      row.image ?? null,
      row.state ?? null,
      row.size_writable_bytes ?? null,
      row.size_virtual_bytes ?? null,
      row.source ?? 'docker_ps_size',
      JSON.stringify(row.details ?? {}),
    );
  });

  const result = await query(`
    INSERT INTO deploy_platform.disk_usage_snapshots (
      app_slug,
      docker_stack,
      container_name,
      docker_service,
      image,
      state,
      size_writable_bytes,
      size_virtual_bytes,
      source,
      details
    )
    VALUES ${values.join(',\n')}
    RETURNING *
  `, params, options);

  if (!result.available) {
    return {
      available: false,
      recorded: 0,
      error: result.error,
      rows: [],
    };
  }

  return {
    available: true,
    recorded: result.rowCount,
    rows: result.rows,
  };
}

export async function listDiskUsageSnapshots({ limit = 200, ...options } = {}) {
  const result = await query(`
    SELECT *
    FROM deploy_platform.disk_usage_snapshots
    ORDER BY created_at DESC
    LIMIT $1
  `, [limitValue(limit)], options);

  if (!result.available) {
    return {
      available: false,
      error: result.error,
      rows: [],
      summary: null,
    };
  }

  const rows = result.rows.map((row) => ({
    ...row,
    size_writable_bytes: row.size_writable_bytes == null ? null : Number(row.size_writable_bytes),
    size_virtual_bytes: row.size_virtual_bytes == null ? null : Number(row.size_virtual_bytes),
  }));

  return {
    available: true,
    rows,
    summary: summarizeDiskSnapshotRows(rows),
  };
}

function summarizeDiskSnapshotRows(rows) {
  const latestAt = rows[0]?.created_at ?? null;
  const latestRows = latestAt ? rows.filter((row) => String(row.created_at) === String(latestAt)) : [];
  const byApp = new Map();
  for (const row of latestRows) {
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

  return {
    latest_at: latestAt,
    containers_count: latestRows.length,
    size_writable_bytes: latestRows.reduce((total, row) => total + (row.size_writable_bytes ?? 0), 0),
    size_virtual_bytes: latestRows.reduce((total, row) => total + (row.size_virtual_bytes ?? 0), 0),
    apps: Array.from(byApp.values()).sort((a, b) => b.size_writable_bytes - a.size_writable_bytes),
  };
}

function statusDetails(app) {
  return {
    runtime: {
      matched: app.runtime?.matched ?? null,
      state: app.runtime?.container?.state ?? null,
    },
    proxy: {
      matched: app.proxy?.matched ?? null,
      enabled: app.proxy?.host?.enabled ?? null,
    },
    health: {
      checked: app.health?.checked ?? null,
      ok: app.health?.ok ?? null,
      status: app.health?.status ?? null,
      latency_ms: app.health?.latency_ms ?? null,
      error: app.health?.error ?? null,
    },
  };
}

export async function recordStatusChanges(apps, options = {}) {
  const candidates = apps
    .filter((app) => app.slug && app.overall_status)
    .map((app) => ({
      app_slug: app.slug,
      current_status: app.overall_status,
      details: statusDetails(app),
    }));

  if (candidates.length === 0) {
    return {
      available: true,
      recorded: 0,
      events: [],
    };
  }

  const latestResult = await query(`
    SELECT DISTINCT ON (app_slug)
      app_slug,
      current_status
    FROM deploy_platform.app_status_events
    WHERE app_slug = ANY($1)
      AND deleted_at IS NULL
    ORDER BY app_slug, created_at DESC
  `, [candidates.map((item) => item.app_slug)], options);

  if (!latestResult.available) {
    return {
      available: false,
      error: latestResult.error,
      recorded: 0,
      events: [],
    };
  }

  const latestBySlug = new Map(latestResult.rows.map((row) => [row.app_slug, row.current_status]));
  const changes = candidates
    .map((item) => ({
      ...item,
      previous_status: latestBySlug.get(item.app_slug) ?? null,
    }))
    .filter((item) => item.previous_status !== item.current_status);

  const events = [];
  for (const change of changes) {
    const insertResult = await query(`
      INSERT INTO deploy_platform.app_status_events (
        app_slug,
        previous_status,
        current_status,
        source,
        message,
        details
      )
      VALUES ($1, $2, $3, 'apps-status', $4, $5::jsonb)
      RETURNING id, created_at, app_slug, previous_status, current_status, source, message, details
    `, [
      change.app_slug,
      change.previous_status,
      change.current_status,
      change.previous_status
        ? `Status changed from ${change.previous_status} to ${change.current_status}`
        : `Initial status recorded as ${change.current_status}`,
      JSON.stringify(change.details),
    ], options);

    if (!insertResult.available) {
      return {
        available: false,
        error: insertResult.error,
        recorded: events.length,
        events,
      };
    }
    events.push(insertResult.rows[0]);
  }

  return {
    available: true,
    recorded: events.length,
    events,
  };
}

export async function recordStatusPings(apps, options = {}) {
  const candidates = apps
    .filter((app) => app.slug && app.overall_status)
    .map((app) => ({
      app_slug: app.slug,
      overall_status: app.overall_status,
      health_ok: app.health?.checked ? Boolean(app.health?.ok) : null,
      health_status: app.health?.status ?? null,
      latency_ms: app.health?.latency_ms ?? null,
      details: statusDetails(app),
    }));

  const pings = [];
  for (const item of candidates) {
    const result = await query(`
      INSERT INTO deploy_platform.app_status_pings (
        app_slug,
        overall_status,
        health_ok,
        health_status,
        latency_ms,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, created_at, app_slug, overall_status, health_ok, health_status, latency_ms, details
    `, [
      item.app_slug,
      item.overall_status,
      item.health_ok,
      item.health_status,
      item.latency_ms,
      JSON.stringify(item.details),
    ], options);

    if (!result.available) {
      return {
        available: false,
        error: result.error,
        recorded: pings.length,
        pings,
      };
    }
    pings.push(result.rows[0]);
  }

  return {
    available: true,
    recorded: pings.length,
    pings,
  };
}

function hoursWindow(value) {
  const hours = Number(value);
  if (hours === 24 || hours === 168) return hours;
  return 24;
}

export async function getAppStatusMetrics(appSlug, { hours = 24, limit = 120, ...options } = {}) {
  const windowHours = hoursWindow(hours);
  const result = await query(`
    SELECT id, created_at, app_slug, overall_status, health_ok, health_status, latency_ms, details
    FROM deploy_platform.app_status_pings
    WHERE app_slug = $1
      AND created_at >= now() - ($2::text || ' hours')::interval
    ORDER BY created_at DESC
    LIMIT $3
  `, [appSlug, windowHours, Number(limit) || 120], options);

  if (!result.available) {
    return {
      available: false,
      error: result.error,
      window_hours: windowHours,
      summary: null,
      pings: [],
    };
  }

  const pings = result.rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    app_slug: row.app_slug,
    overall_status: row.overall_status,
    health_ok: row.health_ok,
    health_status: row.health_status,
    latency_ms: row.latency_ms,
    details: row.details,
  }));

  const total = pings.length;
  const ok = pings.filter((ping) => ping.health_ok === true).length;
  const failures = pings.filter((ping) => ping.health_ok === false || ping.overall_status === 'error').length;
  const latencies = pings.map((ping) => Number(ping.latency_ms)).filter((item) => Number.isFinite(item));

  return {
    available: true,
    window_hours: windowHours,
    summary: {
      total,
      ok,
      failures,
      uptime_percent: total > 0 ? Math.round((ok / total) * 10000) / 100 : null,
      avg_latency_ms: latencies.length > 0
        ? Math.round(latencies.reduce((sum, item) => sum + item, 0) / latencies.length)
        : null,
      latest_status: pings[0]?.overall_status ?? null,
      latest_at: pings[0]?.created_at ?? null,
    },
    pings,
  };
}
