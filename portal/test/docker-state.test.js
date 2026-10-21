import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { enrichAppsWithDocker, listDockerContainers } from '../src/docker-state.js';
import { dockerEndpoint, formatPorts, normalizeApiContainer, normalizeApiStats } from '../src/docker-api.js';

test('dockerEndpoint reads DOCKER_HOST: tcp for docker-ro, the socket otherwise', () => {
  assert.deepEqual(dockerEndpoint({ DOCKER_HOST: 'tcp://docker-ro:2375' }), { host: 'docker-ro', port: 2375 });
  assert.deepEqual(dockerEndpoint({}), { socketPath: '/var/run/docker.sock' });
  assert.deepEqual(dockerEndpoint({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }), { socketPath: '/run/user/1000/docker.sock' });
});

test('normalizeApiContainer gives the docker ps shape with compose labels', () => {
  const row = normalizeApiContainer({
    Id: 'abc',
    Names: ['/pedidos-app-1'],
    Image: 'pedidos-app',
    State: 'running',
    Status: 'Up 1 hour (healthy)',
    Ports: [{ PrivatePort: 8080, Type: 'tcp' }, { IP: '0.0.0.0', PrivatePort: 8000, PublicPort: 8200, Type: 'tcp' }],
    Labels: { 'com.docker.compose.project': 'pedidos', 'com.docker.compose.service': 'app' },
    SizeRw: 1500000,
    SizeRootFs: 200000000,
  });
  assert.equal(row.name, 'pedidos-app-1');
  assert.equal(row.ports, '0.0.0.0:8200->8000/tcp, 8080/tcp');
  assert.equal(row.docker_stack, 'pedidos');
  assert.equal(row.docker_service, 'app');
  assert.equal(row.size_writable_bytes, 1500000);
  assert.equal(formatPorts([{ IP: '::', PrivatePort: 80, PublicPort: 80, Type: 'tcp' }]), '[::]:80->80/tcp');
});

test('normalizeApiStats computes what docker stats shows', () => {
  const stats = normalizeApiStats('app-1', {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 100_000_000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 0 },
    memory_stats: { usage: 50_000_000, limit: 1_000_000_000, stats: { inactive_file: 5_000_000 } },
    networks: { eth0: { rx_bytes: 1200, tx_bytes: 3400 } },
    blkio_stats: { io_service_bytes_recursive: [{ op: 'read', value: 5_600_000 }, { op: 'write', value: 7_800_000 }] },
    pids_stats: { current: 12 },
  });
  assert.equal(stats.cpu_percent, 2);
  assert.equal(stats.memory_usage_bytes, 45_000_000);
  assert.equal(stats.memory_percent, 4.5);
  assert.equal(stats.net_io, '1.2kB / 3.4kB');
  assert.equal(stats.block_io, '5.6MB / 7.8MB');
  assert.equal(stats.pids, 12);
});

test('listDockerContainers reads only the list and one-shot stats, never events', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/containers/json?all=1') {
      res.end(JSON.stringify([
        { Id: 'a1', Names: ['/ihc-portal-1'], State: 'running', Status: 'Up', Labels: { 'com.docker.compose.project': 'ihc', 'com.docker.compose.service': 'portal' } },
        { Id: 'b2', Names: ['/old-1'], State: 'exited', Status: 'Exited (0)', Labels: {} },
      ]));
    } else if (req.url === '/containers/a1/stats?stream=0') {
      res.end(JSON.stringify({ memory_stats: { usage: 10, limit: 100 }, pids_stats: { current: 3 } }));
    } else {
      res.statusCode = 403;
      res.end(JSON.stringify({ message: 'refused' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const state = await listDockerContainers({ env: { DOCKER_HOST: `tcp://127.0.0.1:${server.address().port}` } });
    assert.equal(state.available, true);
    assert.equal(state.resources_available, true);
    assert.deepEqual(state.containers.map((c) => [c.name, c.docker_service, c.resources?.pids ?? null]), [['ihc-portal-1', 'portal', 3], ['old-1', null, null]]);
    assert.deepEqual(seen, ['/containers/json?all=1', '/containers/a1/stats?stream=0']);
  } finally {
    server.close();
  }
  const down = await listDockerContainers({ env: { DOCKER_HOST: 'tcp://127.0.0.1:1' }, timeoutMs: 500 });
  assert.equal(down.available, false);
});

test('enrichAppsWithDocker matches apps by target container name', () => {
  const apps = [
    {
      slug: 'pedidos',
      target: 'compras-app-1',
    },
    {
      slug: 'missing',
      target: 'missing-container',
    },
  ];

  const enriched = enrichAppsWithDocker(apps, {
    available: true,
    containers: [
      {
        name: 'compras-app-1',
        image: 'compras:latest',
        state: 'running',
        status: 'Up 2 weeks',
        ports: '0.0.0.0:8200->8000/tcp',
        docker_stack: 'proposal',
        docker_service: 'app',
        resources: {
          cpu_percent: 1.5,
          memory_usage_bytes: 100,
          memory_limit_bytes: 1000,
          pids: 5,
        },
      },
      {
        name: 'compras-db-1',
        image: 'postgres:16',
        state: 'running',
        docker_stack: 'proposal',
        docker_service: 'db',
        resources: {
          cpu_percent: 0.5,
          memory_usage_bytes: 300,
          memory_limit_bytes: 1000,
          pids: 10,
        },
      },
    ],
  });

  assert.equal(enriched[0].runtime.matched, true);
  assert.equal(enriched[0].runtime.container.state, 'running');
  assert.equal(enriched[0].runtime.stack, 'proposal');
  assert.deepEqual(enriched[0].runtime.stack_containers, ['compras-app-1', 'compras-db-1']);
  assert.equal(enriched[0].runtime.resources.cpu_percent, 2);
  assert.equal(enriched[0].runtime.resources.memory_usage_bytes, 400);
  assert.equal(enriched[0].runtime.resources.pids, 15);
  assert.equal(enriched[0].runtime.resources.top_memory_container.name, 'compras-db-1');
  assert.equal(enriched[1].runtime.matched, false);
  assert.equal(enriched[1].runtime.container, null);
});

test('enrichAppsWithDocker matches apps by docker stack when target is not set', () => {
  const [app] = enrichAppsWithDocker([{
    slug: 'pedidos',
    docker_stack: 'proposal-stack',
  }], {
    available: true,
    containers: [
      {
        name: 'proposal-stack-db-1',
        docker_stack: 'proposal-stack',
        docker_service: 'db',
        state: 'running',
      },
      {
        name: 'proposal-stack-app-1',
        docker_stack: 'proposal-stack',
        docker_service: 'app',
        state: 'running',
      },
    ],
  });

  assert.equal(app.runtime.matched, true);
  assert.equal(app.runtime.container.name, 'proposal-stack-app-1');
  assert.equal(app.runtime.stack, 'proposal-stack');
  assert.deepEqual(app.runtime.stack_containers, ['proposal-stack-db-1', 'proposal-stack-app-1']);
  assert.equal(app.runtime.link_type, 'stack');
});

test('enrichAppsWithDocker infers compatible stack by app slug when target is stale', () => {
  const [app] = enrichAppsWithDocker([{
    slug: 'vendas-b2c',
    target: 'old-container',
  }], {
    available: true,
    containers: [
      {
        name: 'relatorios-vendas-b2c-backend-1',
        docker_stack: 'relatorios-vendas-b2c',
        docker_service: 'backend',
        state: 'running',
      },
      {
        name: 'relatorios-vendas-b2c-frontend-1',
        docker_stack: 'relatorios-vendas-b2c',
        docker_service: 'frontend',
        state: 'running',
      },
    ],
  });

  assert.equal(app.runtime.matched, true);
  assert.equal(app.runtime.container.name, 'relatorios-vendas-b2c-frontend-1');
  assert.equal(app.runtime.stack, 'relatorios-vendas-b2c');
  assert.equal(app.runtime.link_type, 'stack_inferred');
});

test('enrichAppsWithDocker carries unavailable docker error', () => {
  const [app] = enrichAppsWithDocker([{ slug: 'pedidos', target: 'x' }], {
    available: false,
    error: 'docker_not_found',
    containers: [],
  });

  assert.equal(app.runtime.available, false);
  assert.equal(app.runtime.error, 'docker_not_found');
});
