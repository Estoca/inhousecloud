import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogMcpTools, executeCatalogMcpTool, listCatalogApps } from '../src/catalog-mcp.js';

const inventory = {
  apps: [
    {
      slug: 'pedidos',
      name: 'Proposta',
      description: 'Gera propostas comerciais.',
      owner_email: 'comercial@example.com',
      domain: 'pedidos.cloud.localhost',
      category: 'internal_app',
      lifecycle: 'active',
    },
    {
      slug: 'legado',
      name: 'Legado',
      category: 'disabled',
      lifecycle: 'archived',
    },
  ],
};

test('catalog MCP exposes read-only discovery tools', () => {
  assert.deepEqual(catalogMcpTools.map((tool) => tool.name), [
    'ihc_catalog_list_apps',
    'ihc_catalog_get_app',
  ]);
  assert.ok(catalogMcpTools.every((tool) => tool.access === 'read'));
});

test('catalog MCP lists and filters app metadata without runtime details', () => {
  const apps = listCatalogApps(inventory, { query: 'comercial', category: 'internal_app' });
  assert.equal(apps.length, 1);
  assert.equal(apps[0].slug, 'pedidos');
  assert.equal('runtime' in apps[0], false);
});

test('catalog MCP gets one app and rejects unknown tools/apps', () => {
  const found = executeCatalogMcpTool(inventory, 'ihc_catalog_get_app', { slug: 'pedidos' });
  assert.equal(found.ok, true);
  assert.equal(found.result.app.domain, 'pedidos.cloud.localhost');
  assert.equal(executeCatalogMcpTool(inventory, 'ihc_catalog_get_app', { slug: 'missing' }).error, 'app_not_found');
  assert.equal(executeCatalogMcpTool(inventory, 'wrong_tool').error, 'tool_not_found');
});
