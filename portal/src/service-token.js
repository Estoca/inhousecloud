import crypto from 'node:crypto';

// Token de servico so leitura do portal (IHC_PORTAL_API_TOKEN, docs/portal-api.md do
// cloud). Um agente ou o instalador mandam `Authorization: Bearer <token>` e leem o
// estado da plataforma sem sessao do Authentik. O token abre so as rotas abaixo, em GET;
// com ele, qualquer outra rota responde 403. Token errado responde 401; sem token
// configurado no portal, as rotas do token respondem 503 (falha fechado).
//
// O proxy deixa passar sem a forward auth so GET /api/platform/status com Authorization
// (scripts/lib/portal-api.sh); /health ja e publico. Nas outras rotas o Authentik decide
// antes, e este 403 so aparece para quem fala com o portal direto, na rede do cloud.
export const SERVICE_TOKEN_PATHS = Object.freeze([
  '/api/platform/status',
  '/health',
  '/api/health',
]);

// O provider do mcp-gateway tem token proprio (CATALOG_MCP_TOKEN) e se valida sozinho.
const OWN_TOKEN_PREFIXES = Object.freeze(['/api/internal/mcp/v1/']);

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizePath(value) {
  return String(value ?? '').replace(/\/+$/, '') || '/';
}

export function isServiceTokenRoute(path, method = 'GET') {
  const verb = String(method).toUpperCase();
  return (verb === 'GET' || verb === 'HEAD') && SERVICE_TOKEN_PATHS.includes(normalizePath(path));
}

// Middleware global: roda antes de qualquer rota. Sem header Authorization, nao faz nada
// (o navegador segue pela sessao). Com ele, decide aqui e marca req.serviceToken.
export function createServiceTokenGate({ token = process.env.IHC_PORTAL_API_TOKEN } = {}) {
  const expected = typeof token === 'string' ? token.trim() : '';
  return function serviceTokenGate(req, res, next) {
    const authorization = req.get('authorization');
    if (!authorization) {
      next();
      return;
    }
    if (OWN_TOKEN_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      next();
      return;
    }
    const match = String(authorization).match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) {
      res.status(401).json({ error: 'unauthorized', detail: 'expected Authorization: Bearer <IHC_PORTAL_API_TOKEN>' });
      return;
    }
    if (!expected) {
      // Sem token no portal: as rotas do token dizem por que; as outras, so 401.
      if (isServiceTokenRoute(req.path, req.method)) res.status(503).json({ error: 'portal_api_token_not_configured' });
      else res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!constantTimeEqual(match[1], expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!isServiceTokenRoute(req.path, req.method)) {
      res.status(403).json({ error: 'forbidden', detail: 'the portal API token reads GET /api/platform/status only' });
      return;
    }
    req.serviceToken = true;
    next();
  };
}
