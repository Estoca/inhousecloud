// Pessoas e grupos do Authentik, so leitura, para a pagina Pessoas (admin).
//
// O portal fala com a API do Authentik na rede interna (AUTHENTIK_INTERNAL_URL,
// http://authentik-server:9000 no cloud) com o token da conta de servico ihc-portal
// (AUTHENTIK_PORTAL_TOKEN), que o first-run cria com um papel que so tem
// view_user e view_group (docs/security.md). Este modulo faz so GET; um POST com o
// mesmo token leva 403 do proprio Authentik (smoke test 22).
//
// Sem token ou sem URL: configured=false e as rotas respondem 503.

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

function stripSlash(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export class AuthentikDirectoryError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'AuthentikDirectoryError';
    this.status = status;
  }
}

// Contas internas do Authentik (o outpost embutido) nao sao pessoas: ficam fora.
function isInternalAccount(user) {
  return user?.type === 'internal_service_account';
}

export function mapUser(user) {
  return {
    pk: user.pk,
    username: user.username,
    name: user.name || null,
    email: user.email || null,
    is_active: user.is_active !== false,
    is_superuser: Boolean(user.is_superuser),
    type: user.type || 'internal',
    last_login: user.last_login || null,
    groups: (user.groups_obj ?? []).map((group) => group.name).filter(Boolean).sort(),
  };
}

export function mapGroup(group) {
  const members = (group.users_obj ?? [])
    .filter((user) => !isInternalAccount(user))
    .map((user) => ({
      pk: user.pk,
      username: user.username,
      name: user.name || null,
      email: user.email || null,
      is_active: user.is_active !== false,
    }))
    .sort((a, b) => String(a.username).localeCompare(String(b.username)));
  return {
    pk: group.pk,
    name: group.name,
    is_superuser: Boolean(group.is_superuser),
    parent: group.parent_name || null,
    member_count: members.length,
    members,
  };
}

export function createAuthentikDirectory({
  baseUrl = process.env.AUTHENTIK_INTERNAL_URL || process.env.AUTHENTIK_URL,
  token = process.env.AUTHENTIK_PORTAL_TOKEN,
  fetchFn = globalThis.fetch,
  timeoutMs = Number(process.env.AUTHENTIK_API_TIMEOUT_MS) || 5000,
} = {}) {
  const api = stripSlash(baseUrl) ? `${stripSlash(baseUrl)}/api/v3` : '';
  const secret = String(token ?? '').trim();
  const configured = Boolean(api && secret);

  async function getJson(path) {
    let response;
    try {
      response = await fetchFn(`${api}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      throw new AuthentikDirectoryError(`Authentik unreachable: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      // Nunca repassa o corpo: pode ecoar o pedido.
      throw new AuthentikDirectoryError(`Authentik answered HTTP ${response.status} on ${path.split('?')[0]}`, { status: response.status });
    }
    return response.json();
  }

  async function listAll(path) {
    const results = [];
    for (let page = 1; page && page <= MAX_PAGES;) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await getJson(`${path}${sep}page=${page}&page_size=${PAGE_SIZE}`);
      results.push(...(body.results ?? []));
      page = Number(body.pagination?.next) || 0;
    }
    return results;
  }

  return {
    configured,
    async listUsers() {
      const users = await listAll('/core/users/?ordering=username&include_groups=true');
      return users.filter((user) => !isInternalAccount(user)).map(mapUser);
    },
    async listGroups() {
      const groups = await listAll('/core/groups/?ordering=name&include_users=true');
      return groups.map(mapGroup);
    },
  };
}
