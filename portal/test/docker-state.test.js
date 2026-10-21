import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichAppsWithDocker,
  normalizeContainerStats,
  parseDockerLabels,
  parseDockerPsJsonLines,
  parseDockerStatsJsonLines,
} from '../src/docker-state.js';

test('parseDockerPsJsonLines parses docker ps output', () => {
  const rows = parseDockerPsJsonLines([
    '{"Names":"app-1","Image":"example:latest","State":"running","Status":"Up 1 hour","Ports":"0.0.0.0:8000->8000/tcp"}',
    '{"Names":"db-1","Image":"postgres:16","State":"exited","Status":"Exited (0)","Ports":""}',
    '',
  ].join('\n'));

  assert.equal(rows.length, 2);
  assert.equal(rows[0].Names, 'app-1');
  assert.equal(rows[1].State, 'exited');
});

test('parseDockerLabels parses compose labels', () => {
  const labels = parseDockerLabels('com.docker.compose.project=pedidos,com.docker.compose.service=app,empty');

  assert.equal(labels['com.docker.compose.project'], 'pedidos');
  assert.equal(labels['com.docker.compose.service'], 'app');
  assert.equal(labels.empty, '');
});

test('parseDockerStatsJsonLines parses docker stats output', () => {
  const rows = parseDockerStatsJsonLines([
    '{"Container":"abc123","Name":"app-1","CPUPerc":"1.25%","MemUsage":"42.5MiB / 7.7GiB","MemPerc":"0.54%","NetIO":"1.2MB / 3.4MB","BlockIO":"5.6MB / 7.8MB","PIDs":"12"}',
    '',
  ].join('\n'));

  assert.equal(rows.length, 1);

  const stats = normalizeContainerStats(rows[0]);
  assert.equal(stats.name, 'app-1');
  assert.equal(stats.cpu_percent, 1.25);
  assert.equal(stats.memory_usage_bytes, 44564480);
  assert.equal(stats.memory_limit_bytes, 8267812045);
  assert.equal(stats.memory_percent, 0.54);
  assert.equal(stats.block_io, '5.6MB / 7.8MB');
  assert.equal(stats.pids, 12);
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
