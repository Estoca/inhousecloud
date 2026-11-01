#!/usr/bin/env node
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readInventory } from './inventory.js';
import { createActorSigner, loadOrCreateSigningKey } from './jwt.js';
import { createAccessTokenVerifier } from './mcp-auth.js';
import { createAuditLog } from './mcp-audit.js';
import { createAuthentikDirectory } from './authentik-directory.js';
import { ConfirmationError, createConfirmerResolver, splitConfirmedBy } from './mcp-policy.js';
import { ProviderError, createProviderGateway, providersFromApps } from './mcp-providers.js';
import { PlatformToolError, createPlatformTools, isPlatformTool, platformToolsFor } from './mcp-platform-tools.js';

// Gateway MCP do cloud (docs/mcp-gateway.md): segundo entrypoint da imagem do portal,
// servico `mcp` de docker/compose.yml, em mcp.<BASE_DOMAIN>.
//
//   POST /mcp                                    MCP streamable HTTP, sem estado, JSON
//   GET  /.well-known/oauth-protected-resource   RFC 9728: o Authentik e o servidor de
//                                                autorizacao (provider ihc-mcp)
//   GET  /.well-known/jwks.json                  chave publica do actor JWT (os apps validam)
//   GET  /health                                 publico, sem segredo
//
// Toda chamada a /mcp leva `Authorization: Bearer <access token do Authentik>`; sem ele,
// 401 com WWW-Authenticate apontando o metadata, que e como o cliente descobre onde
// entrar. Quem nao esta em USER_GROUP leva 403.
//
// Escritas (docs/security.md, "Writes need a human"): uma tool de app que nao se declara
// leitura e escrita (src/mcp-policy.js). Para ela o gateway exige confirmed_by, confere a
// pessoa no diretorio do Authentik, grava `requested` no audit log do banco do portal
// (src/mcp-audit.js) antes de chamar o app (sem audit, sem chamada) e `completed` depois,
// com o valor anterior e o novo quando o app devolve. O app nunca escreve no audit.

export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'inhousecloud-mcp-gateway', title: 'InHouseCloud', version: '0.1.0' };
const INSTRUCTIONS = 'Tools of the company cloud. ihc_* tools read the platform (apps, health, and for admins the platform status, people, groups and the audit log of writes). '
  + 'Tools named <app>__<tool> belong to the apps of the cloud; each app decides what its tools return for the signed-in person. '
  + 'A tool whose readOnlyHint is false writes: before calling it, show the person exactly what will change and ask them to approve; then pass confirmed_by with the email of the person who approved. '
  + 'The gateway checks that person in the company directory and records every write, with who asked and who approved, in its audit log.';

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

export function gatewayConfigFromEnv(env = process.env) {
  const baseDomain = env.BASE_DOMAIN || 'cloud.localhost';
  const scheme = /(^|\.)localhost$/.test(baseDomain) ? 'http' : 'https';
  const authentikUrl = trimSlash(env.AUTHENTIK_URL) || `${scheme}://auth.${baseDomain}`;
  const authentikInternal = trimSlash(env.AUTHENTIK_INTERNAL_URL) || authentikUrl;
  const clientId = env.MCP_OIDC_CLIENT_ID || 'ihc-mcp';
  return {
    publicUrl: trimSlash(env.MCP_PUBLIC_URL) || `${scheme}://mcp.${baseDomain}`,
    authentikUrl,
    clientId,
    issuer: env.MCP_OIDC_ISSUER || `${authentikUrl}/application/o/${clientId}/`,
    jwksUrl: env.MCP_OIDC_JWKS_URL || `${authentikInternal}/application/o/${clientId}/jwks/`,
    userinfoUrl: env.MCP_OIDC_USERINFO_URL || `${authentikInternal}/application/o/userinfo/`,
    userGroup: env.USER_GROUP || 'ihc-users',
    adminGroup: env.ADMIN_GROUP || 'ihc-admins',
    keyPath: env.MCP_ACTOR_KEY_PATH || '/ihc/mcp-keys/actor-key.pem',
    actorTtlSeconds: Number(env.MCP_ACTOR_TTL_SECONDS) || 300,
    listTimeoutMs: Number(env.MCP_TOOLS_LIST_TIMEOUT_MS) || 10_000,
    callTimeoutMs: Number(env.MCP_TOOL_CALL_TIMEOUT_MS) || 30_000,
    fallbackSeconds: env.MCP_CATALOG_FALLBACK_SECONDS === undefined ? 86_400 : Number(env.MCP_CATALOG_FALLBACK_SECONDS) || 0,
    auditDatabaseUrl: auditUrlFrom(env.MCP_AUDIT_DATABASE_URL),
  };
}

// Sem senha (o .env de antes do papel do audit) e o mesmo que sem URL: escritas
// desligadas, com a mensagem certa, em vez de uma conexao que falha a cada chamada.
function auditUrlFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    return new URL(text).password ? text : '';
  } catch {
    return '';
  }
}

// RFC 9728. `resource` e a URL que o cliente usa (…/mcp).
export function protectedResourceMetadata(config) {
  return {
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: [config.issuer],
    scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'InHouseCloud MCP gateway',
  };
}

// Para clientes que procuram o metadata do servidor de autorizacao na origem do proprio
// servidor MCP (versao 2025-03-26 da especificacao): os endpoints do provider ihc-mcp.
export function authorizationServerMetadata(config) {
  const base = `${config.authentikUrl}/application/o`;
  return {
    issuer: config.issuer,
    authorization_endpoint: `${base}/authorize/`,
    token_endpoint: `${base}/token/`,
    userinfo_endpoint: `${base}/userinfo/`,
    revocation_endpoint: `${base}/revoke/`,
    jwks_uri: `${base}/${config.clientId}/jwks/`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
  };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function toolResult(value, { isError = false } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const result = { content: [{ type: 'text', text }], isError };
  if (!isError && value && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

export function createGatewayApp({
  config = gatewayConfigFromEnv(),
  signer = null,
  verifier = null,
  providerGateway = null,
  platformTools = null,
  directory = null,
  audit = null,
  confirmers = null,
  listAppsFn = () => {
    const inventory = readInventory();
    return inventory.example ? [] : inventory.apps;
  },
  log = (line) => console.log(line),
} = {}) {
  const actor = signer ?? createActorSigner({ ...loadOrCreateSigningKey(config.keyPath), issuer: config.publicUrl, ttlSeconds: config.actorTtlSeconds });
  const tokens = verifier ?? createAccessTokenVerifier({
    issuer: config.issuer,
    audience: config.clientId,
    jwksUrl: config.jwksUrl,
    userinfoUrl: config.userinfoUrl,
    userGroup: config.userGroup,
    adminGroup: config.adminGroup,
  });
  const providers = providerGateway ?? createProviderGateway({
    signer: actor,
    listTimeoutMs: config.listTimeoutMs,
    callTimeoutMs: config.callTimeoutMs,
    fallbackMs: config.fallbackSeconds * 1000,
    log,
  });
  const people = directory ?? createAuthentikDirectory();
  const auditLog = audit ?? createAuditLog({ databaseUrl: config.auditDatabaseUrl, log });
  const confirmer = confirmers ?? createConfirmerResolver({ directory: people, userGroup: config.userGroup });
  const platform = platformTools ?? createPlatformTools({ directory: people, audit: auditLog });
  const resourceMetadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const currentProviders = () => providersFromApps(listAppsFn(), { userGroup: config.userGroup });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Descoberta publica para o cliente ler antes da primeira chamada MCP.
  app.get('/llms.txt', (_req, res) => {
    res.type('text/plain').sendFile(fileURLToPath(new URL('../mcp-llms.txt', import.meta.url)));
  });
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'inhousecloud-mcp-gateway',
      commit_hash: String(process.env.COMMIT_SHA || process.env.GIT_SHA || 'unknown').trim() || 'unknown',
      actor_kid: actor.kid,
    });
  });
  app.get('/', (_req, res) => {
    res.type('text').send(`InHouseCloud MCP gateway. Connect an MCP client to ${config.publicUrl}/mcp (docs/mcp-gateway.md).\n`);
  });
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, (_req, res) => res.json(protectedResourceMetadata(config)));
  }
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(authorizationServerMetadata(config)));
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(actor.jwks());
  });

  function challenge(res, status, error, detail) {
    const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
    if (error) parts.push(`error="${error}"`);
    if (detail) parts.push(`error_description="${String(detail).replace(/["\\]/g, '')}"`);
    res.set('WWW-Authenticate', parts.join(', ')).status(status).json({ error: error || 'unauthorized', detail: detail || 'sign in through the company SSO' });
  }

  async function authenticate(req, res, next) {
    const match = String(req.get('authorization') ?? '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) {
      challenge(res, 401, null, null);
      return;
    }
    const outcome = await tokens.verify(match[1]);
    if (!outcome.ok) {
      if (outcome.status === 503) {
        res.status(503).json({ error: outcome.error, detail: outcome.detail });
        return;
      }
      log(`mcp auth refused: ${outcome.error} (${outcome.detail})`);
      challenge(res, outcome.status, outcome.error, outcome.detail);
      return;
    }
    req.user = outcome.user;
    next();
  }

  async function listTools(user, requestId) {
    const listed = await providers.listTools(user, currentProviders(), { requestId });
    return [...platformToolsFor(user), ...listed.tools];
  }

  async function callTool(user, params, requestId) {
    const name = typeof params?.name === 'string' ? params.name : '';
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    if (isPlatformTool(name)) {
      try {
        return toolResult(await platform.call(user, name, args));
      } catch (error) {
        if (error instanceof PlatformToolError) return toolResult(error.message, { isError: true });
        throw error;
      }
    }
    try {
      const plan = await providers.prepareCall(user, currentProviders(), name, { requestId });
      if (plan.access === 'write') return await callWriteTool(user, plan, args, requestId);
      const { result } = await providers.execute(user, plan, args, { requestId });
      log(`mcp tools/call ${name} by ${user.email}: ok`);
      return toolResult(result);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      log(`mcp tools/call ${name} by ${user.email}: ${error.code}`);
      if (error.code === 'tool_not_found' && !name.includes('__')) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
      return toolResult(error.message, { isError: true });
    }
  }

  // Uma escrita: confirmed_by conferido, `requested` gravado, o app chamado, `completed`
  // gravado. confirmed_by nao vai nos argumentos do app: vai no actor JWT (claim
  // confirmed_by) ja como o e-mail do diretorio.
  async function callWriteTool(user, plan, rawArgs, requestId) {
    const { confirmedBy: input, args } = splitConfirmedBy(rawArgs);
    const base = { requestId, actor: user, tool: plan.name, provider: plan.provider.slug, access: 'write', arguments: args, confirmedByInput: input };
    const refuse = async (code, message, extra = {}) => {
      log(`mcp tools/call ${plan.name} by ${user.email}: refused ${code}`);
      if (auditLog.configured) await auditLog.record({ ...base, ...extra, phase: 'refused', status: code, error: message });
      return toolResult(message, { isError: true });
    };
    if (!auditLog.configured) {
      return refuse('audit_unavailable', `${plan.name} writes, and writes are disabled on this cloud: the gateway's audit log is not configured (MCP_AUDIT_DATABASE_URL)`);
    }
    let approver;
    try {
      approver = await confirmer.resolve(input);
    } catch (error) {
      if (error instanceof ConfirmationError) return refuse(error.code, error.message);
      throw error;
    }
    const confirmedBy = approver.email;
    const requested = await auditLog.record({ ...base, confirmedBy, phase: 'requested', details: { confirmed_by_is_actor: confirmedBy === user.email } });
    if (!requested.ok) {
      log(`mcp tools/call ${plan.name} by ${user.email}: refused audit_unavailable (${requested.error})`);
      return toolResult(`${plan.name} was not called: the gateway could not write its audit log, and no write happens without it. Try again later or tell an admin.`, { isError: true });
    }
    let outcome;
    try {
      outcome = await providers.execute(user, plan, args, { requestId, confirmedBy });
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        await auditLog.record({ ...base, confirmedBy, phase: 'completed', status: 'gateway_error', error: 'the gateway failed while calling the app' });
        throw error;
      }
      const completed = await auditLog.record({ ...base, confirmedBy, phase: 'completed', status: error.code, error: error.message });
      if (!completed.ok) log(`mcp audit: ${requestId} (${plan.name}) has no completed row: ${completed.error}`);
      throw error;
    }
    const audit = outcome.audit ?? {};
    const completed = await auditLog.record({
      ...base,
      confirmedBy,
      phase: 'completed',
      status: 'ok',
      previousValue: 'previous' in audit ? audit.previous : undefined,
      newValue: 'new' in audit ? audit.new : undefined,
      target: typeof audit.target === 'string' ? audit.target : null,
    });
    if (!completed.ok) log(`mcp audit: ${requestId} (${plan.name}) has no completed row: ${completed.error}`);
    log(`mcp tools/call ${plan.name} by ${user.email} confirmed by ${confirmedBy}: ok`);
    return toolResult(outcome.result);
  }

  async function handle(message, user) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid Request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (isNotification) return null;
    const requestId = crypto.randomUUID();
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          };
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: await listTools(user, requestId) } };
        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await callTool(user, params, requestId) };
        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } };
        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } };
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      if (error.rpcCode) return rpcError(id, error.rpcCode, error.message);
      log(`mcp ${method} failed: ${error?.stack ?? error}`);
      return rpcError(id, -32603, 'Internal error');
    }
  }

  app.post('/mcp', authenticate, async (req, res) => {
    const body = req.body;
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (messages.length === 0) {
      res.status(400).json(rpcError(null, -32600, 'Invalid Request'));
      return;
    }
    const replies = (await Promise.all(messages.map((message) => handle(message, req.user)))).filter(Boolean);
    if (replies.length === 0) {
      res.status(202).end();
      return;
    }
    res.json(batch ? replies : replies[0]);
  });
  // Sem sessao e sem stream do servidor: GET e DELETE em /mcp nao existem aqui.
  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed', detail: 'this MCP server is stateless: POST JSON-RPC to /mcp' });
  });

  // JSON invalido no corpo: erro de parse do JSON-RPC.
  app.use((error, _req, res, next) => {
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json(rpcError(null, -32700, 'Parse error'));
      return;
    }
    next(error);
  });
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  app.locals.actor = actor;
  return app;
}

export function startGateway({ port = process.env.MCP_PORT || process.env.PORT || 8090, host = process.env.HOST || '127.0.0.1' } = {}) {
  const config = gatewayConfigFromEnv();
  const app = createGatewayApp({ config });
  return app.listen(Number(port), host, () => {
    console.log(`inhousecloud-mcp-gateway listening on ${host}:${port}; resource ${config.publicUrl}/mcp; issuer ${config.issuer}; actor kid ${app.locals.actor.kid}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway();
}
