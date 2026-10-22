import crypto from 'node:crypto';

// Providers MCP dos apps (camada 1, docs/app-contract.md "MCP"): todo app cujo
// company-app.yaml tem a secao `mcp` (o inventario guarda em apps.<slug>.mcp) expoe
//   GET  <tools_path>                       -> { tools: [{ name, description, input_schema }] }
//   POST <execute_path com {tool}>          <- { arguments }  -> { result }
// no proprio container, alcancado pelo alias do app na rede ihc (http://<slug>:<port>).
// O gateway manda a cada chamada um actor JWT com aud = mcp.audience e scope = os escopos
// do manifesto concedidos aos grupos de quem pede. Sem escopo concedido, o app nem e
// consultado: suas tools nao aparecem e a chamada e recusada aqui.
//
// No catalogo do gateway, a tool `ping` do app `notes` vira `notes__ping`: o slug nao tem
// `__`, entao o prefixo diz sempre a qual provider a chamada vai.

export const TOOL_SEPARATOR = '__';
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const DEFAULT_TOOLS_PATH = '/mcp/tools';
export const DEFAULT_EXECUTE_PATH = '/mcp/tools/{tool}/execute';

export class ProviderError extends Error {
  constructor(message, { code = 'provider_unavailable', transient = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.transient = transient;
    this.status = status;
  }
}

function cleanPath(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('..') || /\s|:\/\/|[?#]/.test(text)) return null;
  return text;
}

function groupList(value, fallback) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : null);
  if (!list) return fallback;
  return list.map((item) => String(item ?? '').trim()).filter(Boolean);
}

// `scopes` aceita tres formas, todas viram [{ name, groups }]:
//   { notes.read: [ihc-users], notes.admin: [ihc-admins] }    (a do template)
//   [{ name: notes.read, groups: [ihc-users] }]
//   [notes.read]                                              (concedido a USER_GROUP)
export function normalizeScopes(scopes, { userGroup = 'ihc-users' } = {}) {
  const out = [];
  if (Array.isArray(scopes)) {
    for (const item of scopes) {
      if (typeof item === 'string') out.push({ name: item.trim(), groups: [userGroup] });
      else if (item && typeof item === 'object') out.push({ name: String(item.name ?? '').trim(), groups: groupList(item.groups, [userGroup]) });
    }
  } else if (scopes && typeof scopes === 'object') {
    for (const [name, groups] of Object.entries(scopes)) out.push({ name: name.trim(), groups: groupList(groups, []) });
  }
  return out.filter((scope) => SCOPE_NAME.test(scope.name));
}

// Um app do inventario (forma do portal: src/inventory.js) -> provider, ou null.
export function providerFromApp(app, { userGroup = 'ihc-users' } = {}) {
  const mcp = app?.mcp;
  if (!mcp || typeof mcp !== 'object' || mcp.enabled === false) return null;
  if (app.kind === 'core' || !app.slug || app.slug.includes(TOOL_SEPARATOR)) return null;
  const port = Number(app.port) || 8080;
  const toolsPath = cleanPath(mcp.tools_path, DEFAULT_TOOLS_PATH);
  const executePath = cleanPath(mcp.execute_path, DEFAULT_EXECUTE_PATH);
  const problems = [];
  if (!toolsPath) problems.push('tools_path must be a path such as /mcp/tools');
  if (!executePath || !executePath.includes('{tool}')) problems.push('execute_path must be a path with {tool}');
  const audience = typeof mcp.audience === 'string' && mcp.audience.trim() ? mcp.audience.trim() : `${app.slug}.mcp`;
  const scopes = normalizeScopes(mcp.scopes, { userGroup });
  if (scopes.length === 0) problems.push('scopes must grant at least one scope to a group');
  return {
    slug: app.slug,
    name: app.name || app.slug,
    baseUrl: `http://${app.slug}:${port}`,
    audience,
    toolsPath,
    executePath,
    scopes,
    problems,
  };
}

export function providersFromApps(apps, options = {}) {
  return (Array.isArray(apps) ? apps : []).map((app) => providerFromApp(app, options)).filter(Boolean);
}

export function grantedScopes(provider, groups = []) {
  return provider.scopes.filter((scope) => scope.groups.some((group) => groups.includes(group))).map((scope) => scope.name);
}

export function splitToolName(name) {
  const text = String(name ?? '');
  const at = text.indexOf(TOOL_SEPARATOR);
  if (at <= 0) return null;
  return { slug: text.slice(0, at), tool: text.slice(at + TOOL_SEPARATOR.length) };
}

function errorBody(body) {
  const error = body && typeof body === 'object' ? (body.error ?? body.detail) : null;
  if (typeof error === 'string') return { code: error, message: typeof body.message === 'string' ? body.message : null };
  if (error && typeof error === 'object') return { code: typeof error.code === 'string' ? error.code : null, message: typeof error.message === 'string' ? error.message : null };
  return { code: null, message: null };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function raiseFor(response, body, provider) {
  const { code, message } = errorBody(body);
  const app = provider.slug;
  if (response.status === 403) throw new ProviderError(message || `${app} refused: no access to this tool`, { code: code || 'tool_access_denied', status: 403 });
  if (response.status === 401) throw new ProviderError(`${app} did not accept the gateway's actor token`, { code: 'provider_authentication_failed', status: 401 });
  if (response.status === 400 || response.status === 422) throw new ProviderError(message || `${app}: invalid arguments`, { code: code || 'invalid_arguments', status: response.status });
  if (response.status === 404) throw new ProviderError(message || `${app}: no such tool`, { code: code || 'tool_not_found', status: 404 });
  if (!response.ok) throw new ProviderError(`${app} is unavailable (HTTP ${response.status})`, { code: code || 'provider_unavailable', transient: true, status: response.status });
}

export function createProviderGateway({
  signer,
  fetchFn = globalThis.fetch,
  listTimeoutMs = 10_000,
  callTimeoutMs = 30_000,
  fallbackMs = 24 * 3600_000,
  now = () => Date.now(),
  log = () => {},
}) {
  // Ultimo catalogo bom por (app, pessoa): o app pode filtrar as tools por quem pede.
  const lastGood = new Map();

  async function request(provider, user, scopes, method, path, { body, timeoutMs, requestId, clientId }) {
    const token = signer.issue({ audience: provider.audience, scopes, user, requestId, clientId });
    let response;
    try {
      response = await fetchFn(`${provider.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'X-Request-ID': requestId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new ProviderError(`${provider.slug} ${timeout ? 'did not answer in time' : 'is unreachable'}`, { code: timeout ? 'provider_timeout' : 'provider_unavailable', transient: true });
    }
    const json = await readJson(response);
    raiseFor(response, json, provider);
    return json;
  }

  async function fetchTools(provider, user, scopes, requestId) {
    const body = await request(provider, user, scopes, 'GET', provider.toolsPath, { timeoutMs: listTimeoutMs, requestId, clientId: user.clientId });
    if (!body || !Array.isArray(body.tools)) throw new ProviderError(`${provider.slug} answered a tool list without "tools"`, { code: 'invalid_provider_response' });
    const tools = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || !TOOL_NAME.test(String(tool.name ?? ''))) continue;
      const schema = tool.input_schema ?? tool.inputSchema;
      tools.push({
        name: `${provider.slug}${TOOL_SEPARATOR}${tool.name}`,
        title: typeof tool.title === 'string' ? tool.title : undefined,
        description: `[${provider.name}] ${typeof tool.description === 'string' ? tool.description : ''}`.trim(),
        inputSchema: schema && typeof schema === 'object' && schema.type === 'object' ? schema : { type: 'object', properties: {} },
        annotations: { readOnlyHint: (tool.access ?? 'read') === 'read', ...(tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {}) },
      });
    }
    return tools;
  }

  // Uma linha por provider: { slug, tools, source: live|fallback|skipped, error }.
  async function listOne(provider, user, requestId) {
    const key = `${provider.slug}\n${user.email}`;
    if (provider.problems.length > 0) return { slug: provider.slug, tools: [], source: 'skipped', error: `manifest: ${provider.problems.join('; ')}` };
    const scopes = grantedScopes(provider, user.groups);
    if (scopes.length === 0) {
      lastGood.delete(key);
      return { slug: provider.slug, tools: [], source: 'skipped', error: 'scope_not_granted' };
    }
    try {
      const tools = await fetchTools(provider, user, scopes, requestId);
      if (fallbackMs > 0) lastGood.set(key, { tools, expiresAt: now() + fallbackMs });
      return { slug: provider.slug, tools, source: 'live', error: null };
    } catch (error) {
      const cached = lastGood.get(key);
      // So falha de disponibilidade usa o catalogo guardado; acesso negado (403) tira as
      // tools na hora.
      if (error.transient && cached && cached.expiresAt > now()) {
        log(`mcp tools/list: ${provider.slug} ${error.code}, serving the last good catalog`);
        return { slug: provider.slug, tools: cached.tools, source: 'fallback', error: error.code };
      }
      if (!error.transient) lastGood.delete(key);
      log(`mcp tools/list: ${provider.slug} ${error.code}`);
      return { slug: provider.slug, tools: [], source: 'failed', error: error.code };
    }
  }

  async function listTools(user, providers, { requestId = crypto.randomUUID() } = {}) {
    const outcomes = await Promise.all(providers.map((provider) => listOne(provider, user, requestId)));
    const tools = [];
    const seen = new Set();
    for (const outcome of outcomes) {
      for (const tool of outcome.tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return { tools, providers: outcomes };
  }

  // Roteia ao provider do prefixo. Levanta ProviderError (code tool_not_found,
  // scope_not_granted, tool_access_denied, ...).
  async function callTool(user, providers, name, args, { requestId = crypto.randomUUID() } = {}) {
    const parts = splitToolName(name);
    const provider = parts && providers.find((candidate) => candidate.slug === parts.slug);
    if (!provider || !TOOL_NAME.test(parts.tool)) throw new ProviderError(`no tool named ${name}`, { code: 'tool_not_found' });
    if (provider.problems.length > 0) throw new ProviderError(`${provider.slug}: its mcp section is invalid (${provider.problems.join('; ')})`, { code: 'provider_misconfigured' });
    const scopes = grantedScopes(provider, user.groups);
    if (scopes.length === 0) {
      const groups = [...new Set(provider.scopes.flatMap((scope) => scope.groups))];
      throw new ProviderError(`access denied: ${provider.slug} grants its MCP scopes to ${groups.join(', ') || 'no group'}, and ${user.email} is in none of them`, { code: 'scope_not_granted', status: 403 });
    }
    const path = provider.executePath.replace('{tool}', encodeURIComponent(parts.tool));
    const body = await request(provider, user, scopes, 'POST', path, {
      body: { arguments: args && typeof args === 'object' ? args : {} },
      timeoutMs: callTimeoutMs,
      requestId,
      clientId: user.clientId,
    });
    if (!body || !('result' in body)) throw new ProviderError(`${provider.slug} answered without "result"`, { code: 'invalid_provider_response' });
    return { provider: provider.slug, result: body.result };
  }

  return { listTools, callTool };
}
