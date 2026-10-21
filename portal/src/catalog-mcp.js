function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function catalogApp(app = {}) {
  return {
    slug: app.slug,
    name: app.name || app.slug,
    description: app.description || null,
    owner_email: app.owner_email || null,
    domain: app.domain || null,
    category: app.category || 'uncategorized',
    lifecycle: app.lifecycle || 'active',
    capabilities: app.agent_interface?.mcp?.tools?.map((tool) => ({
      name: tool.name,
      access: tool.access || 'read',
    })) || [],
  };
}

export const catalogMcpTools = [
  {
    name: 'ihc_catalog_list_apps',
    description: 'Lista aplicativos do catálogo interno da empresa, com dono, descrição, domínio, categoria e ciclo de vida.',
    access: 'read',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto opcional para buscar por nome, slug, descrição, domínio ou dono.' },
        category: { type: 'string', description: 'Categoria opcional, por exemplo internal_app ou infra.' },
        lifecycle: { type: 'string', description: 'Ciclo de vida opcional: active, review, disabled ou archived.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ihc_catalog_get_app',
    description: 'Retorna os dados de descoberta de um aplicativo do catálogo interno da empresa.',
    access: 'read',
    input_schema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

export function listCatalogApps(inventory, input = {}) {
  const query = cleanText(input.query).toLowerCase();
  const category = cleanText(input.category);
  const lifecycle = cleanText(input.lifecycle);
  const apps = Array.isArray(inventory?.apps) ? inventory.apps : [];

  return apps
    .map(catalogApp)
    .filter((app) => {
      if (category && app.category !== category) return false;
      if (lifecycle && app.lifecycle !== lifecycle) return false;
      if (!query) return true;
      return [app.slug, app.name, app.description, app.owner_email, app.domain, app.category, app.lifecycle]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export function executeCatalogMcpTool(inventory, toolName, input = {}) {
  if (toolName === 'ihc_catalog_list_apps') {
    const apps = listCatalogApps(inventory, input);
    return { ok: true, result: { count: apps.length, apps } };
  }

  if (toolName === 'ihc_catalog_get_app') {
    const slug = cleanText(input.slug).toLowerCase();
    const app = listCatalogApps(inventory).find((candidate) => candidate.slug === slug);
    if (!app) return { ok: false, error: 'app_not_found' };
    return { ok: true, result: { app } };
  }

  return { ok: false, error: 'tool_not_found' };
}
