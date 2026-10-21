import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAppStatusMetrics,
  listDiskUsageSnapshots,
  getStorageUsage,
  recordDiskUsageSnapshot,
  recordStatusChanges,
  recordStatusPings,
} from '../src/event-store.js';

test('getStorageUsage sums relation sizes', async () => {
  const result = await getStorageUsage({
    pool: {
      query: async () => ({
        rowCount: 2,
        rows: [
          { relation: 'deploy_events', total_bytes: '100', table_bytes: '60', index_bytes: '40' },
          { relation: 'log_chunks', total_bytes: '50', table_bytes: '30', index_bytes: '20' },
        ],
      }),
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.total_bytes, 150);
  assert.equal(result.relations[0].total_bytes, 100);
});

test('recordDiskUsageSnapshot inserts snapshot rows', async () => {
  const result = await recordDiskUsageSnapshot([
    {
      app_slug: 'pedidos',
      docker_stack: 'proposal',
      container_name: 'proposal-app-1',
      docker_service: 'app',
      image: 'proposal:latest',
      state: 'running',
      size_writable_bytes: 10,
      size_virtual_bytes: 100,
      details: { size_raw: '10B (virtual 100B)' },
    },
  ], {
    pool: {
      query: async (sql, params) => {
        assert.match(sql, /INSERT INTO deploy_platform\.disk_usage_snapshots/);
        assert.equal(params[0], 'pedidos');
        assert.equal(params[2], 'proposal-app-1');
        return {
          rowCount: 1,
          rows: [{ id: 'snapshot-1', app_slug: 'pedidos' }],
        };
      },
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.recorded, 1);
});

test('listDiskUsageSnapshots summarizes latest snapshot rows', async () => {
  const result = await listDiskUsageSnapshots({
    pool: {
      query: async () => ({
        rows: [
          {
            id: '1',
            created_at: '2026-06-10T12:00:00.000Z',
            app_slug: 'pedidos',
            container_name: 'app-1',
            size_writable_bytes: '10',
            size_virtual_bytes: '100',
          },
          {
            id: '2',
            created_at: '2026-06-10T12:00:00.000Z',
            app_slug: 'pedidos',
            container_name: 'db-1',
            size_writable_bytes: '20',
            size_virtual_bytes: '200',
          },
        ],
      }),
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.summary.containers_count, 2);
  assert.equal(result.summary.size_writable_bytes, 30);
  assert.equal(result.summary.apps[0].app_slug, 'pedidos');
});

test('recordStatusChanges inserts only changed statuses', async () => {
  const calls = [];
  const result = await recordStatusChanges([
    {
      slug: 'pedidos',
      overall_status: 'healthy',
      runtime: { matched: true, container: { state: 'running' } },
      proxy: { matched: true, host: { enabled: true } },
      health: { checked: true, ok: true, status: 200, latency_ms: 10 },
    },
    {
      slug: 'apps',
      overall_status: 'warning',
      runtime: { matched: false },
      proxy: { matched: true },
      health: { checked: true, ok: true, status: 200, latency_ms: 10 },
    },
  ], {
    pool: {
      query: async (text, params) => {
        calls.push({ text, params });
        if (text.includes('SELECT DISTINCT ON')) {
          return {
            rowCount: 1,
            rows: [{ app_slug: 'pedidos', current_status: 'healthy' }],
          };
        }
        return {
          rowCount: 1,
          rows: [{
            id: 'event-1',
            app_slug: params[0],
            previous_status: params[1],
            current_status: params[2],
            source: 'apps-status',
          }],
        };
      },
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.recorded, 1);
  assert.equal(result.events[0].app_slug, 'apps');
  assert.equal(calls.length, 2);
});

test('recordStatusPings inserts compact ping rows', async () => {
  const result = await recordStatusPings([
    {
      slug: 'pedidos',
      overall_status: 'healthy',
      health: { checked: true, ok: true, status: 200, latency_ms: 10 },
    },
  ], {
    pool: {
      query: async (_text, params) => ({
        rowCount: 1,
        rows: [{
          id: 'ping-1',
          app_slug: params[0],
          overall_status: params[1],
          health_ok: params[2],
          health_status: params[3],
          latency_ms: params[4],
        }],
      }),
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.recorded, 1);
  assert.equal(result.pings[0].health_ok, true);
});

test('getAppStatusMetrics summarizes pings', async () => {
  const result = await getAppStatusMetrics('pedidos', {
    hours: 24,
    pool: {
      query: async () => ({
        rowCount: 2,
        rows: [
          { id: '2', created_at: '2026-06-10T10:00:00.000Z', app_slug: 'pedidos', overall_status: 'error', health_ok: false, health_status: 503, latency_ms: 50 },
          { id: '1', created_at: '2026-06-10T09:00:00.000Z', app_slug: 'pedidos', overall_status: 'healthy', health_ok: true, health_status: 200, latency_ms: 10 },
        ],
      }),
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.ok, 1);
  assert.equal(result.summary.failures, 1);
  assert.equal(result.summary.uptime_percent, 50);
  assert.equal(result.summary.avg_latency_ms, 30);
});
