import { parseGroups } from './roles.js';

// Regras do gateway MCP para as tools dos apps alem do escopo do provider
// (docs/app-contract.md "MCP", docs/security.md "Writes need a human"):
//
//   leitura ou escrita   `mcp.tools[].access` no company-app.yaml e `access` de cada tool na
//                        lista que o app devolve. E leitura so quando um dos dois diz
//                        `read` e nenhum diz outra coisa; sem declaracao, e escrita.
//   grant por tool       `mcp.tools[].groups` e `mcp.tools[].people`: quem pode ver e
//                        chamar a tool, alem do escopo. Sem entrada, vale so o escopo
//                        (o comportamento de antes).
//   confirmed_by         toda escrita leva o e-mail (ou username) de quem aprovou; o
//                        gateway confere no diretorio do Authentik: pessoa ativa e em
//                        USER_GROUP. Texto livre nunca vale sozinho.

export const CONFIRMED_BY = 'confirmed_by';
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function stringList(value) {
  if (value === undefined || value === null) return { list: null, ok: true };
  const raw = typeof value === 'string' ? parseGroups(value) : value;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string' && item.trim())) return { list: null, ok: false };
  return { list: raw.map((item) => item.trim()), ok: true };
}

// `mcp.tools` do manifesto, em duas formas, as duas viram Map nome -> politica:
//   [{ name: create_note, access: write, groups: [editors], people: [ana@x.com] }]
//   { create_note: { access: write, groups: [editors] } }
// Entrada invalida vira problema do provider (o provider inteiro fica de fora): uma
// regra de acesso mal escrita nunca concede mais do que devia.
export function normalizeToolPolicies(tools) {
  const policies = new Map();
  const problems = [];
  if (tools === undefined || tools === null) return { policies, problems };
  let entries;
  if (Array.isArray(tools)) entries = tools.map((item) => [item?.name, item]);
  else if (typeof tools === 'object') entries = Object.entries(tools).map(([name, item]) => [name, item ?? {}]);
  else return { policies, problems: ['tools must be a list of { name, access, groups, people }'] };
  for (const [name, item] of entries) {
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      problems.push(`tools: ${JSON.stringify(name ?? null)} is not a tool name`);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`tools.${name} must be a mapping (access, groups, people)`);
      continue;
    }
    const access = item.access === undefined || item.access === null ? null : item.access;
    if (access !== null && access !== 'read' && access !== 'write') problems.push(`tools.${name}.access must be read or write`);
    const groups = stringList(item.groups);
    if (!groups.ok) problems.push(`tools.${name}.groups must be a list of groups`);
    const people = stringList(item.people);
    if (!people.ok || (people.list && !people.list.every((email) => EMAIL.test(email)))) problems.push(`tools.${name}.people must be a list of emails`);
    policies.set(name, {
      access: access === 'read' || access === 'write' ? access : null,
      groups: groups.list,
      people: people.list ? people.list.map((email) => email.toLowerCase()) : null,
    });
  }
  return { policies, problems };
}

// O `access` que o app declarou na lista de tools: read, write, ou null (nao disse).
// Qualquer outro valor (admin, destructive, ...) conta como escrita.
export function appAccess(value) {
  if (value === undefined || value === null || value === '') return null;
  return value === 'read' ? 'read' : 'write';
}

// Leitura so quando alguem disse read e ninguem disse write. Na duvida, escrita.
export function effectiveAccess(manifestAccess, declaredAccess) {
  if (manifestAccess === 'write' || declaredAccess === 'write') return 'write';
  if (manifestAccess === 'read' || declaredAccess === 'read') return 'read';
  return 'write';
}

// Grant por tool: sem groups nem people, so o escopo decide (true).
export function toolGranted(policy, user) {
  if (!policy || (!policy.groups && !policy.people)) return true;
  const groups = Array.isArray(user?.groups) ? user.groups : parseGroups(user?.groups);
  if (policy.groups && policy.groups.some((group) => groups.includes(group))) return true;
  const email = String(user?.email ?? '').toLowerCase();
  return Boolean(policy.people && email && policy.people.includes(email));
}

export function describeGrant(policy) {
  const parts = [];
  if (policy?.groups?.length) parts.push(`groups ${policy.groups.join(', ')}`);
  if (policy?.people?.length) parts.push(`${policy.people.length} named ${policy.people.length === 1 ? 'person' : 'people'}`);
  return parts.join(' and ') || 'nobody';
}

// O schema que o cliente ve para uma tool de escrita: o do app, mais confirmed_by
// obrigatorio. Nunca altera o objeto do app.
export function withConfirmedBy(inputSchema) {
  const schema = inputSchema && typeof inputSchema === 'object' && inputSchema.type === 'object' ? inputSchema : { type: 'object', properties: {} };
  const properties = { ...(schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) };
  properties[CONFIRMED_BY] = {
    type: 'string',
    description: 'Email (or company username) of the person who approved this exact write. Ask them first; the gateway checks they exist in the company directory and records them in its audit log.',
  };
  const required = [...new Set([...(Array.isArray(schema.required) ? schema.required : []), CONFIRMED_BY])];
  return { ...schema, properties, required };
}

// Separa confirmed_by dos argumentos que vao ao app.
export function splitConfirmedBy(args) {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const { [CONFIRMED_BY]: confirmedBy, ...rest } = source;
  return { confirmedBy: typeof confirmedBy === 'string' ? confirmedBy.trim() : (confirmedBy ?? null), args: rest };
}

export class ConfirmationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ConfirmationError';
    this.code = code;
  }
}

// Quem aprovou, conferido no diretorio do Authentik (a conta de servico so leitura do
// portal). Casa por e-mail ou username, sem diferenca de caixa; a pessoa precisa estar
// ativa e em USER_GROUP. A lista fica em memoria por ttlMs; um nome que nao casa faz
// reler uma vez (alguem que acabou de entrar), no maximo a cada 10 s.
export function createConfirmerResolver({ directory, userGroup = 'ihc-users', ttlMs = 60_000, now = () => Date.now() }) {
  let cache = null; // { users, fetchedAt }

  async function users({ force = false } = {}) {
    const age = cache ? now() - cache.fetchedAt : Infinity;
    if (cache && age < ttlMs && !(force && age > 10_000)) return cache.users;
    const list = await directory.listUsers();
    cache = { users: Array.isArray(list) ? list : [], fetchedAt: now() };
    return cache.users;
  }

  const find = (list, key) => list.find((person) => String(person.email ?? '').toLowerCase() === key || String(person.username ?? '').toLowerCase() === key);

  // -> { email, username, name }; levanta ConfirmationError.
  async function resolve(text) {
    const key = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!key) throw new ConfirmationError(`this tool writes: pass ${CONFIRMED_BY} with the email of the person who approved this call (ask them first)`, 'confirmation_required');
    if (!directory?.configured) throw new ConfirmationError(`writes are refused: the gateway cannot check ${CONFIRMED_BY} without the directory (AUTHENTIK_PORTAL_TOKEN)`, 'directory_unavailable');
    let person;
    try {
      person = find(await users(), key) ?? find(await users({ force: true }), key);
    } catch {
      throw new ConfirmationError(`writes are refused: the company directory did not answer, so ${CONFIRMED_BY} cannot be checked`, 'directory_unavailable');
    }
    if (!person) throw new ConfirmationError(`${CONFIRMED_BY} "${String(text).trim().slice(0, 120)}" is nobody in the company directory: use the approver's company email`, 'confirmed_by_unknown');
    if (person.is_active === false) throw new ConfirmationError(`${CONFIRMED_BY} ${person.email ?? person.username} is deactivated in the company directory`, 'confirmed_by_inactive');
    if (userGroup && !(person.groups ?? []).includes(userGroup)) throw new ConfirmationError(`${CONFIRMED_BY} ${person.email ?? person.username} is not in ${userGroup}`, 'confirmed_by_not_member');
    if (!person.email) throw new ConfirmationError(`${CONFIRMED_BY} ${person.username} has no email in the company directory`, 'confirmed_by_unknown');
    return { email: String(person.email).toLowerCase(), username: person.username ?? null, name: person.name ?? null };
  }

  return { resolve };
}
