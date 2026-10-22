import { enrichAppsWithHealth, listHttpHealth } from './health-state.js';
import { listApps } from './inventory.js';
import { AuthentikDirectoryError, createAuthentikDirectory } from './authentik-directory.js';
import { TOOL_SEPARATOR, grantedScopes, providerFromApp } from './mcp-providers.js';

// Tools da propria plataforma, servidas pelo gateway MCP, todas so leitura:
//   ihc_list_apps         todos de USER_GROUP: catalogo com descricao, saude, SSO e MCP
//   ihc_platform_status   admin: o mesmo JSON de GET /api/platform/status do portal (PR do
//                         status API, docs/portal-api.md), lido com IHC_PORTAL_API_TOKEN
//   ihc_list_people       admin: pessoas do Authentik (conta de servico ihc-portal)
//   ihc_list_groups       admin: grupos do Authentik e seus membros
// A mesma regra do portal: quem e so de ihc-users ve catalogo e saude dos apps, nao o
// detalhe da maquina nem a lista de pessoas (docs/security.md).

export class PlatformToolError extends Error {
  constructor(message, code = 'tool_failed') {
    super(message);
    this.name = 'PlatformToolError';
    this.code = code;
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false };

export const PLATFORM_TOOLS = Object.freeze([
  {
    name: 'ihc_list_apps',
    admin: false,
    description: 'Lists the apps of the company cloud: name, description, owner, URL, health (the health path answers), SSO (required and effective) and the MCP tools prefix when the app has an MCP provider you can use.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional text to match against slug, name, description or owner.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'ihc_platform_status',
    admin: true,
    description: 'Health of the core services of the cloud (proxy, Authentik, Gitea, runners, Postgres, Redis, backup and the services of each profile). Admins only.',
    inputSchema: EMPTY_INPUT,
  },
  {
    name: 'ihc_list_people',
    admin: true,
    description: 'People of the company sign-in (Authentik): username, name, email, active, groups. Admins only.',
    inputSchema: EMPTY_INPUT,
  },
  {
    name: 'ihc_list_groups',
    admin: true,
    description: 'Groups of the company sign-in (Authentik) and their members. Admins only.',
    inputSchema: EMPTY_INPUT,
  },
].map((tool) => Object.freeze({ ...tool, annotations: READ_ONLY })));

export function platformToolsFor(user) {
  return PLATFORM_TOOLS.filter((tool) => !tool.admin || user.admin)
    .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
}

export function isPlatformTool(name) {
  return PLATFORM_TOOLS.some((tool) => tool.name === name);
}

function appSummary(app, user, { userGroup }) {
  const provider = providerFromApp(app, { userGroup });
  const health = app.health ?? {};
  return {
    slug: app.slug,
    name: app.name,
    description: app.description ?? null,
    owner_email: app.owner_email ?? null,
    url: app.url ?? null,
    kind: app.kind ?? 'app',
    health: {
      ok: Boolean(health.ok),
      checked: Boolean(health.checked),
      path: health.path ?? app.healthcheck_path ?? null,
      status: health.status ?? null,
      error: health.error ?? null,
    },
    sso: {
      required: app.auth_required !== false,
      effective: health.sso_effective ?? null,
    },
    mcp: provider
      ? { provider: true, tools_prefix: `${app.slug}${TOOL_SEPARATOR}`, you_have_access: grantedScopes(provider, user.groups).length > 0 }
      : { provider: false },
  };
}

export function createPlatformTools({
  env = process.env,
  listAppsFn = () => listApps(env),
  listHttpHealthFn = listHttpHealth,
  fetchFn = globalThis.fetch,
  directory = createAuthentikDirectory(),
  portalUrl = env.PORTAL_INTERNAL_URL || 'http://portal:8080',
  portalApiToken = env.IHC_PORTAL_API_TOKEN,
  userGroup = env.USER_GROUP || 'ihc-users',
  timeoutMs = 15_000,
} = {}) {
  async function listAppsTool(user, input = {}) {
    const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
    let apps = listAppsFn().filter((app) => user.admin || app.kind !== 'system-test');
    if (query) {
      apps = apps.filter((app) => [app.slug, app.name, app.description, app.owner_email].filter(Boolean).join(' ').toLowerCase().includes(query));
    }
    const health = await listHttpHealthFn(apps);
    const enriched = enrichAppsWithHealth(apps, health);
    return {
      count: enriched.length,
      checked_at: health.checked_at,
      apps: enriched.map((app) => appSummary(app, user, { userGroup })),
    };
  }

  async function platformStatus() {
    const token = String(portalApiToken ?? '').trim();
    if (!token) throw new PlatformToolError('IHC_PORTAL_API_TOKEN is not set for the gateway: run install.sh --apply --from foundation', 'not_configured');
    let response;
    try {
      response = await fetchFn(`${portalUrl.replace(/\/+$/, '')}/api/platform/status`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      throw new PlatformToolError(`the portal did not answer: ${error?.message ?? error}`, 'portal_unavailable');
    }
    if (!response.ok) throw new PlatformToolError(`the portal answered HTTP ${response.status}`, 'portal_unavailable');
    return response.json();
  }

  async function directoryCall(what) {
    if (!directory.configured) throw new PlatformToolError('AUTHENTIK_PORTAL_TOKEN is not set for the gateway: run install.sh --apply --from foundation', 'not_configured');
    try {
      if (what === 'people') {
        const users = await directory.listUsers();
        return { source: 'authentik', count: users.length, users };
      }
      const groups = await directory.listGroups();
      return { source: 'authentik', count: groups.length, groups };
    } catch (error) {
      throw new PlatformToolError(error instanceof AuthentikDirectoryError ? error.message : 'Authentik request failed', 'authentik_unavailable');
    }
  }

  // Levanta PlatformToolError (forbidden, not_configured, ...).
  async function call(user, name, input = {}) {
    const tool = PLATFORM_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) throw new PlatformToolError(`no tool named ${name}`, 'tool_not_found');
    if (tool.admin && !user.admin) throw new PlatformToolError(`access denied: ${name} is for the admin group only`, 'forbidden');
    if (name === 'ihc_list_apps') return listAppsTool(user, input);
    if (name === 'ihc_platform_status') return platformStatus();
    if (name === 'ihc_list_people') return directoryCall('people');
    return directoryCall('groups');
  }

  return { call };
}
