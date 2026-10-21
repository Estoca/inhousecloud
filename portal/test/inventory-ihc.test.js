// Contrato do inventory.json com o ihc-app, lado do portal (o lado do cloud e
// scripts/tests/inventory-contract.sh, sobre a mesma fixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { adaptInventory, enrichDockerContainersWithInventory, readInventory, SUPPORTED_SCHEMA_VERSION } from '../src/inventory.js';
import { enrichAppsWithDocker } from '../src/docker-state.js';
import { listCatalogApps } from '../src/catalog-mcp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'ihc-inventory.json');
const manifest = path.join(here, '..', 'company-app.yaml');
const env = { INVENTORY_PATH: fixture, PORTAL_MANIFEST_PATH: manifest, BASE_DOMAIN: 'cloud.localhost', IHC_PROJECT: 'ihc' };

test('the fixture is the schema the portal reads', () => {
  const raw = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.equal(raw.schema_version, SUPPORTED_SCHEMA_VERSION);
  const inventory = readInventory(env);
  assert.equal(inventory.format, 'ihc');
  assert.equal(inventory.schema_version, 1);
  assert.equal(inventory.schema_supported, true);
  assert.equal(inventory.installation_id, 'ihc-fixture');
  assert.match(inventory.source, /ihc-app, schema 1/);
  assert.equal(inventory.updated_at, '2026-10-21T12:00:00Z');
});

test('each ihc-app record becomes a catalog app with route, repo, health and SSO from its manifest', () => {
  const apps = readInventory(env).apps;
  const pedidos = apps.find((app) => app.slug === 'pedidos');
  assert.equal(pedidos.domain, 'pedidos.cloud.localhost');
  assert.equal(pedidos.url, 'http://pedidos.cloud.localhost');
  assert.equal(pedidos.description, 'Pedidos internos.');
  assert.equal(pedidos.repo_url, 'http://git.cloud.localhost/company/pedidos');
  assert.equal(pedidos.docker_stack, 'pedidos');
  assert.equal(pedidos.docker_service, 'app');
  assert.deepEqual(pedidos.healthcheck, { path: '/health', expected_status: 200 });
  assert.equal(pedidos.healthcheck_path, '/health');
  assert.equal(pedidos.auth_required, true);
  assert.equal(pedidos.mcp.tools[0].name, 'pedidos_list');
  assert.equal(pedidos.category, 'internal_app');

  const aberto = apps.find((app) => app.slug === 'aberto');
  assert.equal(aberto.auth_required, false);
  assert.deepEqual(aberto.healthcheck, { path: '/healthz', expected_status: 204 });
  assert.equal(aberto.repo_url, null);
  assert.equal(aberto.mcp, null);

  const smoke = apps.find((app) => app.slug === 'smoke-app');
  assert.equal(smoke.category, 'system_test');
  assert.equal(smoke.kind, 'system-test');
});

test('the portal sees itself in the catalog as a core service, from its company-app.yaml', () => {
  const apps = readInventory(env).apps;
  const portal = apps.find((app) => app.kind === 'core');
  assert.ok(portal, 'portal entry');
  assert.equal(portal.slug, 'portal');
  assert.equal(portal.domain, 'portal.cloud.localhost');
  assert.equal(portal.healthcheck_path, '/health');
  assert.equal(portal.docker_stack, 'ihc');
  assert.equal(portal.docker_service, 'portal');
  assert.equal(portal.auth_required, true);

  // Only the portal's own container is linked to it, not every core container.
  const docker = {
    available: true,
    containers: [
      { name: 'ihc-portal-1', state: 'running', docker_stack: 'ihc', docker_service: 'portal' },
      { name: 'ihc-gitea-1', state: 'running', docker_stack: 'ihc', docker_service: 'gitea' },
      { name: 'pedidos-app-1', state: 'running', docker_stack: 'pedidos', docker_service: 'app' },
    ],
  };
  const [withDocker] = enrichAppsWithDocker([portal], docker);
  assert.equal(withDocker.runtime.container.name, 'ihc-portal-1');
  assert.deepEqual(withDocker.runtime.stack_containers, ['ihc-portal-1']);
  const linked = enrichDockerContainersWithInventory(docker, readInventory(env));
  assert.deepEqual(linked.containers.map((c) => c.app_slug), ['portal', null, 'pedidos']);
});

test('a newer schema is read for what the portal knows and flagged', () => {
  const inventory = adaptInventory({ schema_version: 2, apps: { x: { slug: 'x', url: 'http://x.cloud.localhost' } } }, { env: { PORTAL_MANIFEST_PATH: '/nonexistent.yaml' } });
  assert.equal(inventory.schema_supported, false);
  assert.equal(inventory.apps[0].slug, 'x');
  assert.equal(inventory.apps[0].healthcheck_path, '/');
});

test('an inventory replaced by rename is read again; a broken write keeps the last good read', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ihc-catalog-'));
  const file = path.join(dir, 'inventory.json');
  copyFileSync(fixture, file);
  const local = { ...env, INVENTORY_PATH: file };
  assert.ok(readInventory(local).apps.some((app) => app.slug === 'pedidos'));
  const next = JSON.parse(readFileSync(fixture, 'utf8'));
  delete next.apps.pedidos;
  writeFileSync(path.join(dir, '.inventory.tmp'), JSON.stringify(next));
  renameSync(path.join(dir, '.inventory.tmp'), file);
  assert.equal(readInventory(local).apps.some((app) => app.slug === 'pedidos'), false);
  writeFileSync(file, '{"apps": {');
  const stale = readInventory(local);
  assert.equal(stale.stale, true);
  assert.ok(stale.apps.some((app) => app.slug === 'aberto'));
});

test('the MCP catalog provider lists the tools declared in the manifest', () => {
  const listed = listCatalogApps(readInventory(env), { query: 'pedidos' });
  assert.equal(listed[0].slug, 'pedidos');
  assert.deepEqual(listed[0].capabilities, [{ name: 'pedidos_list', access: 'read' }]);
});
