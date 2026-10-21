import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { collectDockerDiskUsage, summarizeDiskUsageRows } from '../src/disk-usage.js';

test('collectDockerDiskUsage reads sizes from the Docker API list with size=1', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ Id: 'a', Names: ['/pedidos-app-1'], State: 'running', SizeRw: 1500000, SizeRootFs: 200000000,
      Labels: { 'com.docker.compose.project': 'pedidos', 'com.docker.compose.service': 'app' } }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await collectDockerDiskUsage({
      env: { DOCKER_HOST: `tcp://127.0.0.1:${server.address().port}` },
      inventory: { apps: [{ slug: 'pedidos', docker_stack: 'pedidos' }] },
    });
    assert.equal(result.available, true);
    assert.deepEqual(seen, ['/containers/json?all=1&size=1']);
    assert.equal(result.rows[0].app_slug, 'pedidos');
    assert.equal(result.rows[0].size_writable_bytes, 1500000);
    assert.equal(result.summary.size_virtual_bytes, 200000000);
  } finally {
    server.close();
  }
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
