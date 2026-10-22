import crypto from 'node:crypto';
import { JwtError, decodeJwt, verifyJwt } from './jwt.js';
import { parseGroups } from './roles.js';

// Quem fala com o gateway MCP: o access token que o Authentik emitiu ao cliente MCP
// (Claude Code, claude.ai) pelo provider OAuth2 ihc-mcp (authorization code com PKCE,
// criado por scripts/first-run.sh). O gateway valida:
//   assinatura   contra o JWKS do provider (MCP_OIDC_JWKS_URL, lido por dentro da rede)
//   iss          MCP_OIDC_ISSUER (https://auth.<BASE_DOMAIN>/application/o/ihc-mcp/)
//   aud          MCP_OIDC_CLIENT_ID (ihc-mcp)
//   exp          com 30 s de folga
// e reduz a pessoa a { email, name, username, groups }. Quando o token nao traz e-mail
// ou grupos, pergunta ao userinfo do Authentik (cache ate o exp do token).
// Entra quem esta em USER_GROUP (ihc-users); admin e quem esta em ADMIN_GROUP.

const JWKS_TTL_MS = 5 * 60_000;
const JWKS_MIN_REFRESH_MS = 30_000;
const USERINFO_CACHE_MAX = 500;

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function groupsFrom(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  if (typeof value === 'string') return parseGroups(value);
  return null;
}

export function createAccessTokenVerifier({
  issuer,
  audience,
  jwksUrl,
  userinfoUrl = null,
  userGroup = 'ihc-users',
  adminGroup = 'ihc-admins',
  fetchFn = globalThis.fetch,
  timeoutMs = 5000,
  now = () => Date.now(),
}) {
  let jwks = null; // { keys, fetchedAt }
  let inflight = null;
  const userinfoCache = new Map();

  async function fetchJson(url, headers = {}) {
    const response = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.split('?')[0]}`);
    return response.json();
  }

  async function keys({ force = false } = {}) {
    const age = jwks ? now() - jwks.fetchedAt : Infinity;
    if (jwks && age < JWKS_TTL_MS && !(force && age > JWKS_MIN_REFRESH_MS)) return jwks.keys;
    inflight ??= fetchJson(jwksUrl)
      .then((body) => {
        jwks = { keys: Array.isArray(body?.keys) ? body.keys : [], fetchedAt: now() };
        return jwks.keys;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  async function userinfo(token, exp) {
    const key = hash(token);
    const cached = userinfoCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = await fetchJson(userinfoUrl, { Authorization: `Bearer ${token}` });
    if (userinfoCache.size >= USERINFO_CACHE_MAX) userinfoCache.delete(userinfoCache.keys().next().value);
    userinfoCache.set(key, { value, expiresAt: Math.min(exp * 1000, now() + 10 * 60_000) });
    return value;
  }

  // { ok: true, user } | { ok: false, status, error, detail }
  async function verify(token) {
    if (!token) return { ok: false, status: 401, error: 'invalid_token', detail: 'missing bearer token' };
    let claims;
    try {
      const { header } = decodeJwt(token);
      let list = await keys();
      if (header.kid && !list.some((key) => key.kid === header.kid)) list = await keys({ force: true });
      claims = verifyJwt(token, { keys: list, issuer, audience, now: now() });
    } catch (error) {
      if (error instanceof JwtError) return { ok: false, status: 401, error: 'invalid_token', detail: error.message };
      return { ok: false, status: 503, error: 'authorization_server_unavailable', detail: 'cannot read the keys of the authorization server' };
    }
    let email = typeof claims.email === 'string' ? claims.email : null;
    let groups = groupsFrom(claims.groups);
    let name = claims.name ?? null;
    let username = claims.preferred_username ?? null;
    if ((!email || !groups) && userinfoUrl) {
      try {
        const info = await userinfo(token, claims.exp);
        email ??= typeof info.email === 'string' ? info.email : null;
        groups ??= groupsFrom(info.groups);
        name ??= info.name ?? null;
        username ??= info.preferred_username ?? null;
      } catch {
        return { ok: false, status: 503, error: 'authorization_server_unavailable', detail: 'userinfo did not answer' };
      }
    }
    email = String(email ?? '').trim().toLowerCase();
    groups = groups ?? [];
    if (!email.includes('@')) return { ok: false, status: 401, error: 'invalid_token', detail: 'the token carries no email' };
    if (!groups.includes(userGroup)) {
      return { ok: false, status: 403, error: 'insufficient_scope', detail: `${email} is not in ${userGroup}` };
    }
    return {
      ok: true,
      user: {
        email,
        name,
        username,
        groups,
        admin: Boolean(adminGroup) && groups.includes(adminGroup),
        clientId: claims.azp ?? claims.client_id ?? audience,
        expiresAt: claims.exp,
      },
    };
  }

  return { verify };
}
