import dns from 'node:dns/promises';
import net from 'node:net';
import { isPortalAdmin } from './admin-store.js';
import { readPlatformConfig } from './config.js';

function parseEmailList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseDomainList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

// X-authentik-groups: o outpost separa os grupos por `|`; aceita `,` tambem.
export function parseGroups(value) {
  return String(value ?? '')
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAddress(address) {
  const value = String(address ?? '');
  return value.startsWith('::ffff:') && net.isIPv4(value.slice(7)) ? value.slice(7) : value;
}

// Os headers X-authentik-* valem so quando vem do proxy: qualquer container da rede do
// cloud alcanca o portal na porta 8080 e poderia escreve-los. TRUSTED_PROXY_HOSTS lista
// os nomes (ou IPs) do proxy; vazio = confia em quem chegar (desenvolvimento, testes).
export function createProxyTrust({
  hosts = String(process.env.TRUSTED_PROXY_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  lookup = (host) => dns.lookup(host, { all: true }),
  ttlMs = 30_000,
} = {}) {
  let cached = null;
  async function addresses() {
    if (cached && cached.expiresAt > Date.now()) return cached.set;
    const set = new Set();
    for (const host of hosts) {
      if (net.isIP(host)) { set.add(host); continue; }
      try {
        for (const entry of await lookup(host)) set.add(normalizeAddress(entry.address));
      } catch {
        // nome que nao resolve agora: nenhum endereco dele e confiavel
      }
    }
    cached = { set, expiresAt: Date.now() + ttlMs };
    return set;
  }
  return {
    enabled: hosts.length > 0,
    async trusted(req) {
      if (hosts.length === 0) return true;
      return (await addresses()).has(normalizeAddress(req.socket?.remoteAddress));
    },
  };
}

function emailDomain(email) {
  const parts = String(email ?? '').toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : null;
}

// Logout da forward auth: o outpost do Authentik encerra a sessao no proxy.
const AUTHENTIK_SIGN_OUT_PATH = '/outpost.goauthentik.io/sign_out';

// Autenticacao do portal: o Authentik e o unico provider. O portal fica atras da
// forward auth do proxy e le quem e a pessoa dos headers X-authentik-*; nao ha
// login proprio, cookie de sessao nem OAuth no portal.
//
// Papel: super_admin por SUPER_ADMIN_EMAILS (rede de seguranca do primeiro acesso);
// admin pelo grupo ADMIN_GROUP (ihc-admins no cloud) ou pela tabela portal_admins;
// viewer pelo grupo USER_GROUP (ihc-users) ou, fora do cloud, pelo dominio do e-mail.
export function createAuth({
  superAdminEmails = process.env.SUPER_ADMIN_EMAILS,
  portalUserDomains = readPlatformConfig().orgEmailDomains.join(','),
  allowDomainUsers = process.env.PORTAL_ALLOW_DOMAIN_USERS !== 'false',
  adminGroup = readPlatformConfig().adminGroup,
  userGroup = readPlatformConfig().userGroup,
  isPortalAdminFn = isPortalAdmin,
  proxyTrust = createProxyTrust(),
} = {}) {
  const bootstrapAdmins = parseEmailList(superAdminEmails);
  const admins = new Set(bootstrapAdmins);
  const userDomains = parseDomainList(portalUserDomains);

  function domainUser(email) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const domain = emailDomain(normalizedEmail);
    if (!allowDomainUsers || !domain || !userDomains.includes(domain)) return null;
    return {
      email: normalizedEmail,
      name: null,
      role: 'viewer',
      source: 'domain',
    };
  }

  async function resolveAdmin(email) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail) return { allowed: false, admin: null };

    const result = await isPortalAdminFn(normalizedEmail, { bootstrapAdmins });
    if (!result.available) {
      return {
        allowed: admins.has(normalizedEmail),
        admin: admins.has(normalizedEmail)
          ? { email: normalizedEmail, role: 'super_admin', source: 'env' }
          : null,
      };
    }
    return result;
  }

  async function resolveAccess(email) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail) return { allowed: false, admin: null };

    const adminAccess = await resolveAdmin(normalizedEmail);
    if (adminAccess.allowed) return adminAccess;

    const user = domainUser(normalizedEmail);
    if (user) {
      return {
        available: adminAccess.available,
        allowed: true,
        admin: user,
      };
    }

    return adminAccess;
  }

  function isConfigured() {
    return admins.size > 0 || Boolean(adminGroup) || (allowDomainUsers && userDomains.length > 0);
  }

  function groupRole(groups) {
    if (adminGroup && groups.includes(adminGroup)) return 'admin';
    if (userGroup && groups.includes(userGroup)) return 'viewer';
    return null;
  }

  const RANK = { viewer: 1, admin: 2, super_admin: 3 };

  async function currentUser(req) {
    if (!(await proxyTrust.trusted(req))) return null;
    const email = String(req.get('x-authentik-email') ?? '').trim().toLowerCase();
    if (!email) return null;
    const groups = parseGroups(req.get('x-authentik-groups'));
    const byGroup = groupRole(groups);
    const access = await resolveAccess(email);
    if (!access.allowed && !byGroup) return null;
    const byAccess = access.allowed ? access.admin?.role || 'viewer' : null;
    const role = (RANK[byAccess] ?? 0) >= (RANK[byGroup] ?? 0) ? byAccess : byGroup;

    return {
      email,
      name: req.get('x-authentik-name') || access.admin?.name || req.get('x-authentik-username') || email,
      picture: null,
      role,
      groups,
      source: byGroup && role === byGroup ? 'authentik-group' : 'authentik',
    };
  }

  async function requireUiAuth(req, res, next) {
    const user = await currentUser(req);
    if (!user) {
      res.redirect('/login');
      return;
    }
    req.user = user;
    next();
  }

  async function requireApiAuth(req, res, next) {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    req.user = user;
    next();
  }

  async function requireAdmin(req, res, next) {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (user.role !== 'admin' && user.role !== 'super_admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    req.user = user;
    next();
  }

  async function requireSuperAdmin(req, res, next) {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (user.role !== 'super_admin') {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    req.user = user;
    next();
  }

  function attachRoutes(app) {
    app.post('/logout', (_req, res) => {
      res.redirect(303, AUTHENTIK_SIGN_OUT_PATH);
    });

    app.get('/api/me', async (req, res) => {
      const user = await currentUser(req);
      if (!user) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      res.json({ user });
    });
  }

  return {
    admins: [...admins],
    bootstrapAdmins,
    provider: 'authentik',
    userDomains,
    isConfigured,
    currentUser,
    requireUiAuth,
    requireApiAuth,
    requireAdmin,
    requireSuperAdmin,
    attachRoutes,
  };
}
