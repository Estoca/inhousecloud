import crypto from 'node:crypto';
import { appAccess, describeGrant, effectiveAccess, normalizeToolPolicies, toolGranted, withConfirmedBy } from './mcp-policy.js';

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
//
// Alem do escopo (src/mcp-policy.js): `mcp.tools` do manifesto restringe uma tool a
// grupos ou pessoas e diz se ela e leitura ou escrita, junto com o `access` que o app
// devolve na lista. Sem declaracao, a tool e escrita: o gateway pede confirmed_by e grava
// o audit (src/mcp-gateway.js). Uma tool sem grant para a pessoa nao aparece e a chamada
// e recusada aqui, sem chamar o app.

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
  const { policies, problems: toolProblems } = normalizeToolPolicies(mcp.tools);
  problems.push(...toolProblems);
  return {
    slug: app.slug,
    name: app.name || app.slug,
    baseUrl: `http://${app.slug}:${port}`,
    audience,
    toolsPath,
    executePath,
    scopes,
    tools: policies,
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
  accessTtlMs = 60_000,
  now = () => Date.now(),
  log = () => {},
}) {
  // Ultimo catalogo bom por (app, pessoa): o app pode filtrar as tools por quem pede.
  const lastGood = new Map();
  // O `access` que o app declarou por tool, da ultima lista lida ao vivo, por (app, pessoa):
  // a chamada usa enquanto tiver menos de accessTtlMs; depois, le a lista de novo.
  const declared = new Map();

  async function request(provider, user, scopes, method, path, { body, timeoutMs, requestId, clientId, confirmedBy = null }) {
    const token = signer.issue({ audience: provider.audience, scopes, user, requestId, clientId, confirmedBy });
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

  // A lista do app, ja com o que o gateway decide: so as tools que a pessoa tem grant,
  // leitura ou escrita (manifesto + app, na duvida escrita), e nas de escrita o
  // confirmed_by obrigatorio no schema. Guarda o `access` declarado para a chamada.
  async function fetchTools(provider, user, scopes, requestId) {
    const body = await request(provider, user, scopes, 'GET', provider.toolsPath, { timeoutMs: listTimeoutMs, requestId, clientId: user.clientId });
    if (!body || !Array.isArray(body.tools)) throw new ProviderError(`${provider.slug} answered a tool list without "tools"`, { code: 'invalid_provider_response' });
    const tools = [];
    const access = new Map();
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || !TOOL_NAME.test(String(tool.name ?? ''))) continue;
      access.set(tool.name, appAccess(tool.access));
      const policy = provider.tools.get(tool.name);
      if (!toolGranted(policy, user)) continue;
      const effective = effectiveAccess(policy?.access ?? null, appAccess(tool.access));
      const schema = tool.input_schema ?? tool.inputSchema;
      const inputSchema = schema && typeof schema === 'object' && schema.type === 'object' ? schema : { type: 'object', properties: {} };
      const description = typeof tool.description === 'string' ? tool.description : '';
      tools.push({
        name: `${provider.slug}${TOOL_SEPARATOR}${tool.name}`,
        title: typeof tool.title === 'string' ? tool.title : undefined,
        description: `[${provider.name}] ${description}${effective === 'write' ? ' (Writes: needs confirmed_by, the email of the person who approved this exact call.)' : ''}`.trim(),
        inputSchema: effective === 'write' ? withConfirmedBy(inputSchema) : inputSchema,
        annotations: { ...(tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : {}), readOnlyHint: effective === 'read' },
      });
    }
    declared.set(`${provider.slug}\n${user.email}`, { access, fetchedAt: now() });
    return tools;
  }

  // read | write de uma tool para esta pessoa. O manifesto dizendo write decide sem
  // perguntar ao app; senao vale o `access` da lista do app (a guardada, se recente, ou
  // lida de novo). App fora do ar ou tool fora da lista: nao declarado.
  async function accessOf(provider, user, scopes, tool, requestId) {
    const policy = provider.tools.get(tool);
    if (policy?.access === 'write') return 'write';
    const key = `${provider.slug}\n${user.email}`;
    let entry = declared.get(key);
    if (!entry || entry.fetchedAt + accessTtlMs <= now()) {
      try {
        await fetchTools(provider, user, scopes, requestId);
        entry = declared.get(key);
      } catch (error) {
        log(`mcp tools/call: ${provider.slug} tool list ${error.code ?? 'failed'}: ${tool} counts as a write`);
        entry = null;
      }
    }
    return effectiveAccess(policy?.access ?? null, entry?.access.get(tool) ?? null);
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

  // Antes de chamar: o provider do prefixo, o escopo, o grant da tool e se ela escreve.
  // -> { provider, tool, name, scopes, access }. Levanta ProviderError (tool_not_found,
  // provider_misconfigured, scope_not_granted, tool_not_granted).
  async function prepareCall(user, providers, name, { requestId = crypto.randomUUID() } = {}) {
    const parts = splitToolName(name);
    const provider = parts && providers.find((candidate) => candidate.slug === parts.slug);
    if (!provider || !TOOL_NAME.test(parts.tool)) throw new ProviderError(`no tool named ${name}`, { code: 'tool_not_found' });
    if (provider.problems.length > 0) throw new ProviderError(`${provider.slug}: its mcp section is invalid (${provider.problems.join('; ')})`, { code: 'provider_misconfigured' });
    const scopes = grantedScopes(provider, user.groups);
    if (scopes.length === 0) {
      const groups = [...new Set(provider.scopes.flatMap((scope) => scope.groups))];
      throw new ProviderError(`access denied: ${provider.slug} grants its MCP scopes to ${groups.join(', ') || 'no group'}, and ${user.email} is in none of them`, { code: 'scope_not_granted', status: 403 });
    }
    const policy = provider.tools.get(parts.tool);
    if (!toolGranted(policy, user)) {
      throw new ProviderError(`access denied: ${name} is granted to ${describeGrant(policy)}, and ${user.email} is not among them`, { code: 'tool_not_granted', status: 403 });
    }
    const access = await accessOf(provider, user, scopes, parts.tool, requestId);
    return { provider, tool: parts.tool, name, scopes, access };
  }

  // Chama o app de um plano de prepareCall. -> { provider, result, audit }, onde audit e o
  // `audit` que o app devolveu ao lado de `result` ({ previous, new, target }) ou null.
  async function execute(user, plan, args, { requestId = crypto.randomUUID(), confirmedBy = null } = {}) {
    const { provider } = plan;
    const path = provider.executePath.replace('{tool}', encodeURIComponent(plan.tool));
    const body = await request(provider, user, plan.scopes, 'POST', path, {
      body: { arguments: args && typeof args === 'object' ? args : {} },
      timeoutMs: callTimeoutMs,
      requestId,
      clientId: user.clientId,
      confirmedBy,
    });
    if (!body || !('result' in body)) throw new ProviderError(`${provider.slug} answered without "result"`, { code: 'invalid_provider_response' });
    const audit = body.audit && typeof body.audit === 'object' && !Array.isArray(body.audit) ? body.audit : null;
    return { provider: provider.slug, result: body.result, audit };
  }

  // prepareCall + execute. Uma escrita sem confirmedBy e recusada aqui tambem; quem
  // confere a pessoa e grava o audit e o gateway (src/mcp-gateway.js).
  async function callTool(user, providers, name, args, { requestId = crypto.randomUUID(), confirmedBy = null } = {}) {
    const plan = await prepareCall(user, providers, name, { requestId });
    if (plan.access === 'write' && !confirmedBy) throw new ProviderError(`${name} writes: it needs confirmed_by`, { code: 'confirmation_required' });
    const { provider, result } = await execute(user, plan, args, { requestId, confirmedBy });
    return { provider, result };
  }

  return { listTools, prepareCall, execute, callTool };
}
