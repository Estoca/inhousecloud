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
// IHT_ISSUER also accepts the iht's instance_access tokens: their own JWKS, aud = publicUrl,
// lifetime <= 300 s, verified e-mail and the local allowlist; role maps to these same groups.

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
  ihtIssuer = '',
  publicUrl = '',
  allowedDomains = [],
  allowedPeople = [],
  instanceToken = false,
  userGroup = 'ihc-users',
  adminGroup = 'ihc-admins',
  fetchFn = globalThis.fetch,
  timeoutMs = 5000,
  now = () => Date.now(),
}) {
  const iht = ihtIssuer ? createAccessTokenVerifier({
    issuer: ihtIssuer, audience: publicUrl, jwksUrl: `${ihtIssuer}/.well-known/jwks.json`,
    userGroup, adminGroup, fetchFn, timeoutMs, now, allowedDomains, allowedPeople, instanceToken: true,
  }) : null;
  let jwks = null; // { keys, fetchedAt }
  let inflight = null;
  const userinfoCache = new Map();

  async function fetchJson(url, headers = {}) {
    const response = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.split('?')[0]}`);
    return response.json();
  }

  // An unknown kid may be a key rotation: refetch at once the first time each kid shows up, then only after the
  // minimum interval, so tokens with made-up kids cannot make the gateway hammer the authorization server.
  const triedKids = new Map(); // kid -> when it last forced a refetch
  async function keys({ force = false, kid = null } = {}) {
    const age = jwks ? now() - jwks.fetchedAt : Infinity;
    const newKid = force && kid && !(now() - (triedKids.get(kid) ?? -Infinity) < JWKS_MIN_REFRESH_MS);
    if (newKid) {
      if (triedKids.size > 256) triedKids.clear();
      triedKids.set(kid, now());
    }
    if (jwks && age < JWKS_TTL_MS && !(force && (newKid || age > JWKS_MIN_REFRESH_MS))) return jwks.keys;
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
      const { header, claims: unverified } = decodeJwt(token);
      // Issuer only selects a verifier; that verifier still checks signature and every claim.
      if (iht && unverified.iss === ihtIssuer) return iht.verify(token);
      let list = await keys();
      if (header.kid && !list.some((key) => key.kid === header.kid)) list = await keys({ force: true, kid: header.kid });
      claims = verifyJwt(token, { keys: list, issuer, audience, now: now(), ...(instanceToken ? { leewaySeconds: 0 } : {}) });
      if (instanceToken && (claims.iss !== issuer || claims.aud !== audience
          || claims.iht_kind !== 'instance_access' || claims.email_verified !== true
          || !['admin', 'member'].includes(claims.role) || !Number.isInteger(claims.iat)
          || claims.iat > Math.floor(now() / 1000) || claims.exp <= claims.iat
          || claims.exp - claims.iat > 300 || claims.exp <= Math.floor(now() / 1000))) {
        throw new JwtError('invalid iht instance claims');
      }
    } catch (error) {
      if (error instanceof JwtError) return { ok: false, status: 401, error: 'invalid_token', detail: error.message };
      return { ok: false, status: 503, error: 'authorization_server_unavailable', detail: 'cannot read the keys of the authorization server' };
    }
    let email = typeof claims.email === 'string' ? claims.email : null;
    let groups = instanceToken ? [userGroup, ...(claims.role === 'admin' ? [adminGroup] : [])] : groupsFrom(claims.groups);
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
    if (instanceToken && !/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, status: 401, error: 'invalid_token', detail: 'invalid email' };
    if (!email.includes('@')) return { ok: false, status: 401, error: 'invalid_token', detail: 'the token carries no email' };
    if (instanceToken && !allowedPeople.includes(email) && !allowedDomains.includes(email.split('@')[1])) {
      return { ok: false, status: 403, error: 'insufficient_scope', detail: 'person is outside the company allowlist' };
    }
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
