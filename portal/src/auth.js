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

function emailDomain(email) {
  const parts = String(email ?? '').toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : null;
}

// Logout da forward auth: o outpost do Authentik encerra a sessao no proxy.
const AUTHENTIK_SIGN_OUT_PATH = '/outpost.goauthentik.io/sign_out';

// Autenticacao do portal: o Authentik e o unico provider. O portal fica atras da
// forward auth do proxy e le quem e a pessoa dos headers X-authentik-*; nao ha
// login proprio, cookie de sessao nem OAuth no portal.
export function createAuth({
  superAdminEmails = process.env.SUPER_ADMIN_EMAILS,
  portalUserDomains = readPlatformConfig().orgEmailDomains.join(','),
  allowDomainUsers = process.env.PORTAL_ALLOW_DOMAIN_USERS !== 'false',
  isPortalAdminFn = isPortalAdmin,
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
    return admins.size > 0 || (allowDomainUsers && userDomains.length > 0);
  }

  async function currentUser(req) {
    const email = String(req.get('x-authentik-email') ?? '').trim().toLowerCase();
    const access = await resolveAccess(email);
    if (!email || !access.allowed) return null;

    return {
      email,
      name: req.get('x-authentik-name') || access.admin?.name || req.get('x-authentik-username') || email,
      picture: null,
      role: access.admin?.role || 'viewer',
      groups: parseEmailList(req.get('x-authentik-groups')),
      source: 'authentik',
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
