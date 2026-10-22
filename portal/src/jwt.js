import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// JWT RS256 sem biblioteca (node:crypto), para o gateway MCP (src/mcp-gateway.js):
//   - verifyJwt valida o access token do Authentik contra o JWKS dele;
//   - createActorSigner assina o actor JWT curto que o gateway manda a cada app,
//     com `aud` e `scope` do provider, e publica a chave em /.well-known/jwks.json.
// So RS256: `alg: none`, HS256 e qualquer outro algoritmo sao recusados.

export class JwtError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeJson(part, what) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new JwtError(`${what} is not base64url JSON`);
  }
}

// Cabecalho e claims sem validar nada: so para escolher a chave (kid).
export function decodeJwt(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new JwtError('not a JWT');
  return { header: decodeJson(parts[0], 'header'), claims: decodeJson(parts[1], 'payload'), parts };
}

function audienceMatches(aud, expected) {
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((item) => typeof item === 'string' && item === expected);
}

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

// Valida assinatura, iss, aud, exp e nbf. `keys` e o array `keys` de um JWKS.
// Devolve as claims; qualquer falha levanta JwtError.
export function verifyJwt(token, { keys, issuer, audience, leewaySeconds = 30, now = Date.now() } = {}) {
  const { header, claims, parts } = decodeJwt(token);
  if (header.alg !== 'RS256') throw new JwtError(`alg ${header.alg} not accepted`);
  const candidates = (Array.isArray(keys) ? keys : []).filter((key) => key && key.kty === 'RSA' && (!header.kid || key.kid === header.kid));
  if (candidates.length === 0) throw new JwtError(`no key for kid ${header.kid ?? '(none)'}`, 'unknown_key');
  const signature = Buffer.from(parts[2], 'base64url');
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const valid = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
      return crypto.verify('RSA-SHA256', signed, key, signature);
    } catch {
      return false;
    }
  });
  if (!valid) throw new JwtError('bad signature');
  const seconds = Math.floor(now / 1000);
  if (issuer !== undefined && trimSlash(claims.iss) !== trimSlash(issuer)) throw new JwtError('wrong issuer');
  if (audience !== undefined && !audienceMatches(claims.aud, audience)) throw new JwtError('wrong audience');
  if (!Number.isInteger(claims.exp)) throw new JwtError('no exp');
  if (claims.exp + leewaySeconds < seconds) throw new JwtError('expired', 'expired');
  if (Number.isInteger(claims.nbf) && claims.nbf - leewaySeconds > seconds) throw new JwtError('not yet valid');
  return claims;
}

// Chave de assinatura do gateway: PEM RSA 2048 em MCP_ACTOR_KEY_PATH (volume proprio do
// servico mcp, nunca no Git nem no .env). Gerada no primeiro boot; trocar a chave e
// apagar o arquivo e reiniciar: os apps buscam o JWKS de novo quando o kid muda.
export function loadOrCreateSigningKey(keyPath) {
  let pem = null;
  if (keyPath && existsSync(keyPath)) {
    pem = readFileSync(keyPath, 'utf8');
  } else {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    if (keyPath) {
      mkdirSync(path.dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, pem, { mode: 0o600 });
    }
  }
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyDetails?.modulusLength < 2048) {
    throw new Error('the actor signing key must be RSA, 2048 bits or more');
  }
  const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const kid = crypto.createHash('sha256').update(der).digest('base64url').slice(0, 16);
  return { privateKey, kid };
}

export function signJwt(claims, { privateKey, kid }) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey);
  return `${input}.${signature.toString('base64url')}`;
}

// Actor JWT (docs/mcp-gateway.md, "Actor JWT"): quem pediu (sub = e-mail), para qual app
// (aud) e com que escopos (scope, separados por espaco), valido por poucos minutos.
export function createActorSigner({ privateKey, kid, issuer, ttlSeconds = 300, now = () => Date.now() }) {
  const ttl = Math.min(900, Math.max(30, Number(ttlSeconds) || 300));
  const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const jwk = { kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid, alg: 'RS256', use: 'sig' };
  return {
    kid,
    issuer,
    ttlSeconds: ttl,
    jwks: () => ({ keys: [{ ...jwk }] }),
    issue({ audience, scopes = [], user, requestId = crypto.randomUUID(), clientId = null }) {
      const iat = Math.floor(now() / 1000);
      return signJwt({
        iss: issuer,
        aud: audience,
        sub: user.email,
        email: user.email,
        name: user.name ?? null,
        username: user.username ?? null,
        groups: [...(user.groups ?? [])],
        scope: scopes.join(' '),
        client_id: clientId,
        request_id: requestId,
        jti: requestId,
        iat,
        nbf: iat,
        exp: iat + ttl,
      }, { privateKey, kid });
    },
  };
}
