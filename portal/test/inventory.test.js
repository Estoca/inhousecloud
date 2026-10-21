import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  enrichDockerContainersWithInventory,
  inferAppsFromDockerMetadata,
  updateInventoryAppMetadata,
  updateInventoryDockerMetadata,
  upsertInventoryApp,
  validateAppMetadata,
} from '../src/inventory.js';

test('validateAppMetadata accepts category and owner email', () => {
  const result = validateAppMetadata({
    category: 'internal_app',
    owner_email: 'Dono@Example.com',
    repo_url: 'https://github.com/example-org/app',
    target: 'app-1',
    docker_stack: 'app-stack',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.metadata, {
    category: 'internal_app',
    owner_email: 'dono@example.com',
    repo_url: 'https://github.com/example-org/app',
    target: 'app-1',
    docker_stack: 'app-stack',
  });
});

test('validateAppMetadata rejects invalid category and owner email', () => {
  const result = validateAppMetadata({
    category: 'Infra App',
    owner_email: 'sem-email',
    repo_url: 'https://example.com/app',
    target: 'bad name',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.path), ['category', 'owner_email', 'repo_url', 'target']);
});

test('updateInventoryAppMetadata persists app category and owner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ihc-inventory-'));
  const inventoryPath = path.join(dir, 'apps.json');
  writeFileSync(inventoryPath, JSON.stringify({
    source: 'test',
    updated_at: '2026-06-10',
    apps: [{
      slug: 'pedidos',
      domain: 'pedidos.cloud.localhost',
      category: 'internal_app',
    }],
  }, null, 2));

  const result = updateInventoryAppMetadata('pedidos', {
    category: 'infra',
    owner_email: 'platform@example.com',
    repo_url: 'https://git.cloud.localhost/company/pedidos',
    target: 'pedidos-app-1',
    docker_stack: 'pedidos',
  }, { inventoryPath });

  assert.equal(result.ok, true);
  assert.equal(result.app.category, 'infra');
  assert.equal(result.app.owner_email, 'platform@example.com');
  assert.equal(result.app.repo_url, 'https://git.cloud.localhost/company/pedidos');
  assert.equal(result.app.target, 'pedidos-app-1');
  assert.equal(result.app.docker_stack, 'pedidos');

  const persisted = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(persisted.apps[0].category, 'infra');
  assert.equal(persisted.apps[0].owner_email, 'platform@example.com');
  assert.equal(persisted.apps[0].repo_url, 'https://git.cloud.localhost/company/pedidos');
  assert.equal(persisted.apps[0].target, 'pedidos-app-1');
  assert.equal(persisted.apps[0].docker_stack, 'pedidos');
});

test('updateInventoryDockerMetadata persists container category and owner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ihc-inventory-'));
  const inventoryPath = path.join(dir, 'apps.json');
  writeFileSync(inventoryPath, JSON.stringify({
    source: 'test',
    updated_at: '2026-06-10',
    apps: [],
  }, null, 2));

  const result = updateInventoryDockerMetadata('nginx-app-1', {
    category: 'infra',
    owner_email: 'infra@example.com',
  }, { inventoryPath });

  assert.equal(result.ok, true);
  assert.equal(result.container.category, 'infra');

  const persisted = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(persisted.docker_containers[0].name, 'nginx-app-1');
  assert.equal(persisted.docker_containers[0].owner_email, 'infra@example.com');
});

test('upsertInventoryApp creates and updates app entries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ihc-inventory-'));
  const inventoryPath = path.join(dir, 'apps.json');
  writeFileSync(inventoryPath, JSON.stringify({
    source: 'test',
    updated_at: '2026-06-10',
    apps: [],
  }, null, 2));

  const created = upsertInventoryApp('novo-app', {
    domain: 'novo-app.cloud.localhost',
    category: 'internal_app',
    owner_email: 'dono@example.com',
    repo_url: 'https://git.cloud.localhost/company/novo-app',
    target: 'novo-app-app-1',
    docker_stack: 'novo-app',
    port: 8123,
    status: ['OK', 'REDIRECT'],
  }, { inventoryPath });

  assert.equal(created.ok, true);
  assert.equal(created.app.slug, 'novo-app');
  assert.equal(created.app.port, 8123);

  const updated = upsertInventoryApp('novo-app', {
    domain: 'novo.cloud.localhost',
    category: 'internal_app',
    owner_email: 'dono@example.com',
    repo_url: 'https://git.cloud.localhost/company/novo-app',
    target: 'novo-app-app-1',
    docker_stack: 'novo-app',
    port: 8124,
    status: ['OK'],
  }, { inventoryPath });

  assert.equal(updated.ok, true);
  const persisted = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  assert.equal(persisted.apps.length, 1);
  assert.equal(persisted.apps[0].domain, 'novo.cloud.localhost');
  assert.equal(persisted.apps[0].port, 8124);
});

test('enrichDockerContainersWithInventory links containers by docker stack', () => {
  const result = enrichDockerContainersWithInventory({
    available: true,
    containers: [
      { name: 'stack-app-1', image: 'app:latest', state: 'running', docker_stack: 'stack', docker_service: 'app' },
      { name: 'stack-db-1', image: 'postgres:latest', state: 'running', docker_stack: 'stack', docker_service: 'db' },
    ],
  }, {
    apps: [{
      slug: 'stacked-app',
      docker_stack: 'stack',
      category: 'internal_app',
      owner_email: 'app@example.com',
    }],
  });

  assert.equal(result.containers[0].app_slug, 'stacked-app');
  assert.equal(result.containers[0].app_link_type, 'stack');
  assert.equal(result.containers[1].app_slug, 'stacked-app');
  assert.equal(result.containers[1].owner_email, 'app@example.com');
});

test('enrichDockerContainersWithInventory applies app metadata and container overrides', () => {
  const result = enrichDockerContainersWithInventory({
    available: true,
    containers: [
      { name: 'app-1', image: 'app:latest', state: 'running', docker_stack: 'pedidos', docker_service: 'app' },
      { name: 'db-1', image: 'postgres:latest', state: 'running', docker_stack: 'pedidos', docker_service: 'db' },
      { name: 'nginx-app-1', image: 'npm:latest', state: 'running' },
    ],
  }, {
    apps: [{
      slug: 'pedidos',
      target: 'app-1',
      category: 'internal_app',
      owner_email: 'app@example.com',
    }],
    docker_containers: [{
      name: 'nginx-app-1',
      category: 'infra',
      owner_email: 'infra@example.com',
    }],
  });

  assert.equal(result.containers[0].app_slug, 'pedidos');
  assert.equal(result.containers[0].owner_email, 'app@example.com');
  assert.equal(result.containers[1].app_slug, 'pedidos');
  assert.equal(result.containers[1].app_link_type, 'stack');
  assert.equal(result.containers[2].category, 'infra');
  assert.equal(result.containers[2].owner_email, 'infra@example.com');
});

test('inferAppsFromDockerMetadata promotes classified containers with matching NPM routes', () => {
  const apps = inferAppsFromDockerMetadata({
    inventory: {
      apps: [],
      docker_containers: [{
        name: 'metas-prod-app-1',
        category: 'internal_app',
        owner_email: 'carla@example.com',
      }],
    },
    dockerState: {
      containers: [{
        name: 'metas-prod-app-1',
        state: 'running',
        ports: '0.0.0.0:3120->80/tcp, [::]:3120->80/tcp',
        docker_stack: 'metas-prod',
        docker_service: 'app',
      }],
    },
    npmState: {
      proxy_hosts: [{
        id: 40,
        domain_names: ['metas.cloud.localhost'],
        forward_port: 3120,
      }],
    },
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'metas');
  assert.equal(apps[0].domain, 'metas.cloud.localhost');
  assert.equal(apps[0].target, 'metas-prod-app-1');
  assert.equal(apps[0].docker_stack, 'metas-prod');
  assert.equal(apps[0].owner_email, 'carla@example.com');
});

test('inferAppsFromDockerMetadata skips containers from a stack already linked by app target', () => {
  const apps = inferAppsFromDockerMetadata({
    inventory: {
      apps: [{
        slug: 'auditoria',
        target: 'auditoria-frontend-1',
      }],
      docker_containers: [{
        name: 'auditoria-backend-1',
        category: 'internal_app',
        owner_email: 'eva@example.com',
      }],
    },
    dockerState: {
      containers: [{
        name: 'auditoria-frontend-1',
        state: 'running',
        ports: '0.0.0.0:3110->80/tcp',
        docker_stack: 'auditoria',
        docker_service: 'frontend',
      }, {
        name: 'auditoria-backend-1',
        state: 'running',
        ports: '0.0.0.0:8110->8000/tcp',
        docker_stack: 'auditoria',
        docker_service: 'backend',
      }],
    },
    npmState: {
      proxy_hosts: [{
        id: 29,
        domain_names: ['auditoria.cloud.localhost'],
        forward_port: 3110,
      }],
    },
  });

  assert.equal(apps.length, 0);
});

test('inferAppsFromDockerMetadata emits only one app per new stack and prefers NPM route', () => {
  const apps = inferAppsFromDockerMetadata({
    inventory: {
      apps: [],
      docker_containers: [{
        name: 'dashboard-backend-1',
        category: 'internal_app',
        owner_email: 'diego@example.com',
      }, {
        name: 'dashboard-frontend-1',
        category: 'internal_app',
        owner_email: 'diego@example.com',
      }],
    },
    dockerState: {
      containers: [{
        name: 'dashboard-backend-1',
        state: 'running',
        ports: '0.0.0.0:8109->8000/tcp',
        docker_stack: 'relatorios-vendas',
        docker_service: 'backend',
      }, {
        name: 'dashboard-frontend-1',
        state: 'running',
        ports: '0.0.0.0:3109->80/tcp',
        docker_stack: 'relatorios-vendas',
        docker_service: 'frontend',
      }],
    },
    npmState: {
      proxy_hosts: [{
        id: 28,
        domain_names: ['dashboard.cloud.localhost'],
        forward_port: 3109,
      }],
    },
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'dashboard');
  assert.equal(apps[0].target, 'dashboard-frontend-1');
  assert.equal(apps[0].docker_stack, 'relatorios-vendas');
});

test('inferAppsFromDockerMetadata skips stack compatible with an existing app slug', () => {
  const apps = inferAppsFromDockerMetadata({
    inventory: {
      apps: [{
        slug: 'vendas-b2c',
        target: 'old-container',
      }],
      docker_containers: [{
        name: 'relatorios-vendas-b2c-backend-1',
        category: 'internal_app',
      }, {
        name: 'relatorios-vendas-b2c-frontend-1',
        category: 'internal_app',
      }],
    },
    dockerState: {
      containers: [{
        name: 'relatorios-vendas-b2c-backend-1',
        state: 'running',
        ports: '0.0.0.0:8109->8000/tcp',
        docker_stack: 'relatorios-vendas-b2c',
        docker_service: 'backend',
      }, {
        name: 'relatorios-vendas-b2c-frontend-1',
        state: 'running',
        ports: '0.0.0.0:3109->80/tcp',
        docker_stack: 'relatorios-vendas-b2c',
        docker_service: 'frontend',
      }],
    },
    npmState: {
      proxy_hosts: [{
        id: 28,
        domain_names: ['dashboard.cloud.localhost'],
        forward_port: 3109,
      }],
    },
  });

  assert.equal(apps.length, 0);
});

test('readInventory falls back to the example inventory when INVENTORY_PATH is missing', async () => {
  const { getInventoryPath, readInventory, resolveInventoryPath } = await import('../src/inventory.js');
  const missing = path.join(tmpdir(), `inventario-inexistente-${Date.now()}.json`);
  const resolved = resolveInventoryPath({ INVENTORY_PATH: missing });
  assert.equal(resolved.example, true);
  assert.match(resolved.path, /inventory\/apps\.example\.json$/);
  assert.equal(getInventoryPath({ INVENTORY_PATH: missing }), missing);

  const inventory = readInventory({ INVENTORY_PATH: missing });
  assert.equal(inventory.example, true);
  assert.match(inventory.source, /exemplo; defina INVENTORY_PATH/);
  assert.ok(inventory.apps.some((app) => app.slug === 'pedidos'));

  const real = path.join(tmpdir(), `inventario-real-${Date.now()}.json`);
  writeFileSync(real, JSON.stringify({ source: 'teste', apps: [{ slug: 'so-aqui' }] }));
  const fromEnv = readInventory({ INVENTORY_PATH: real });
  assert.equal(fromEnv.example, undefined);
  assert.equal(fromEnv.apps[0].slug, 'so-aqui');
});

test('isAllowedRepoUrl accepts GitHub and the configured Gitea host only', async () => {
  const { isAllowedRepoUrl } = await import('../src/inventory.js');
  assert.equal(isAllowedRepoUrl('https://github.com/example-org/x'), true);
  assert.equal(isAllowedRepoUrl('https://git.cloud.localhost/company/x'), true);
  assert.equal(isAllowedRepoUrl('https://gitlab.com/company/x'), false);
  assert.equal(isAllowedRepoUrl('https://code.acme.cloud/Acme/x', { giteaHost: 'code.acme.cloud' }), true);
});
