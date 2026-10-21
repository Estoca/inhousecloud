import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDockerSizeRow, parseDockerSize, summarizeDiskUsageRows } from '../src/disk-usage.js';

test('parseDockerSize parses writable and virtual sizes', () => {
  assert.deepEqual(parseDockerSize('32.8kB (virtual 346MB)'), {
    writable_bytes: 32800,
    virtual_bytes: 346000000,
  });
  assert.deepEqual(parseDockerSize('0B (virtual 1.2GB)'), {
    writable_bytes: 0,
    virtual_bytes: 1200000000,
  });
});

test('normalizeDockerSizeRow extracts compose metadata and sizes', () => {
  const row = normalizeDockerSizeRow({
    Names: 'app-1',
    Image: 'app:latest',
    State: 'running',
    Status: 'Up 1 hour',
    Ports: '0.0.0.0:8000->8000/tcp',
    Size: '1.5MB (virtual 200MB)',
    Labels: 'com.docker.compose.project=stack,com.docker.compose.service=app',
  });

  assert.equal(row.name, 'app-1');
  assert.equal(row.docker_stack, 'stack');
  assert.equal(row.docker_service, 'app');
  assert.equal(row.size_writable_bytes, 1500000);
  assert.equal(row.size_virtual_bytes, 200000000);
});

test('summarizeDiskUsageRows aggregates by app', () => {
  const summary = summarizeDiskUsageRows([
    { app_slug: 'pedidos', container_name: 'app-1', size_writable_bytes: 10, size_virtual_bytes: 100 },
    { app_slug: 'pedidos', container_name: 'db-1', size_writable_bytes: 20, size_virtual_bytes: 200 },
    { app_slug: null, container_name: 'infra-1', size_writable_bytes: 5, size_virtual_bytes: 50 },
  ]);

  assert.equal(summary.containers_count, 3);
  assert.equal(summary.size_writable_bytes, 35);
  assert.equal(summary.apps[0].app_slug, 'pedidos');
  assert.equal(summary.apps[0].containers_count, 2);
});
