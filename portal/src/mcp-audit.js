import pg from 'pg';

// Audit log das escritas do gateway MCP (docs/security.md, "Writes need a human"):
// tabela deploy_platform.mcp_audit_log no banco do portal (migracao 010), append-only
// (um trigger recusa UPDATE, DELETE e TRUNCATE, ate do dono). Quem grava e o gateway,
// nunca o app: o app nao tem credencial deste banco nem alcanca a tabela.
//
// O gateway entra com um papel proprio, so INSERT e SELECT nesta tabela
// (MCP_AUDIT_DATABASE_URL, papel ihc_mcp_audit que o install.sh cria). Uma escrita
// gera duas linhas com o mesmo request_id:
//   requested   antes de chamar o app; sem ela gravada, o app nao e chamado
//   completed   depois, com o status, o erro e, se o app devolveu, o valor anterior e o novo
// e uma escrita recusada pelo gateway (sem confirmed_by, pessoa desconhecida) gera uma
// linha `refused`. Uma `requested` sem `completed` e uma escrita de resultado
// desconhecido (o gateway caiu no meio, ou a segunda linha falhou): aparece como unknown.

const { Pool } = pg;
const SECRET_KEYS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'cookie', 'credential', 'privatekey', 'sessionid', 'cvv', 'cardnumber'];
const SECRET_EXACT = new Set(['pin', 'otp', 'pwd', 'auth']);
const SECRET_VALUE = [/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/, /^Bearer\s+\S+/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /^(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}$/];
const MAX_STRING = 4096;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;
const MAX_JSON = 64 * 1024;
export const REDACTED = '[redacted]';

export function isSecretKey(key) {
  const flat = String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_EXACT.has(flat) || SECRET_KEYS.some((word) => flat.includes(word));
}

function redactValue(value, depth) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.some((pattern) => pattern.test(value))) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length - MAX_STRING} more characters]` : value;
  }
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`[${value.length - MAX_ITEMS} more items]`);
    return out;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1);
  return out;
}

// Argumentos e valores como vao para o audit: chave com cara de segredo (password,
// token, api_key, authorization, cookie, ...) e valor com cara de segredo (JWT, Bearer,
// chave privada PEM, tokens com prefixo conhecido) viram [redacted]; texto longo,
// listas longas e aninhamento fundo sao cortados; acima de 64 KiB fica so um resumo.
export function redact(value) {
  if (value === undefined) return null;
  const out = redactValue(value, 0);
  const text = JSON.stringify(out);
  if (text !== undefined && text.length > MAX_JSON) return { truncated: true, bytes: text.length, preview: text.slice(0, 2000) };
  return out;
}

function limitOf(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));

export function createAuditLog({ databaseUrl = '', pool = null, poolMax = 3, log = () => {} } = {}) {
  const url = String(databaseUrl ?? '').trim();
  const db = pool ?? (url ? new Pool({ connectionString: url, max: poolMax, connectionTimeoutMillis: 5000 }) : null);
  if (db && typeof db.on === 'function') db.on('error', (error) => log(`mcp audit: idle connection error: ${error.message}`));

  // -> { ok: true, id } | { ok: false, error }. Nunca levanta.
  async function record(entry) {
    if (!db) return { ok: false, error: 'not_configured' };
    try {
      const result = await db.query(`
        INSERT INTO deploy_platform.mcp_audit_log (
          request_id, phase, actor_email, actor_groups, client_id, confirmed_by, confirmed_by_input,
          tool, provider, access, arguments, status, error, previous_value, new_value, target, details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15::jsonb, $16, $17::jsonb)
        RETURNING id, created_at
      `, [
        entry.requestId,
        entry.phase,
        entry.actor?.email ?? 'unknown',
        Array.isArray(entry.actor?.groups) ? entry.actor.groups : [],
        entry.actor?.clientId ?? null,
        entry.confirmedBy ?? null,
        entry.confirmedByInput ? String(entry.confirmedByInput).slice(0, 320) : null,
        entry.tool,
        entry.provider ?? null,
        entry.access ?? 'write',
        json(redact(entry.arguments ?? {})) ?? '{}',
        entry.status ?? null,
        entry.error ? String(entry.error).slice(0, 2000) : null,
        entry.previousValue === undefined ? null : json(redact(entry.previousValue)),
        entry.newValue === undefined ? null : json(redact(entry.newValue)),
        entry.target ? String(entry.target).slice(0, 500) : null,
        json(entry.details ?? {}) ?? '{}',
      ]);
      return { ok: true, id: result.rows[0]?.id ?? null };
    } catch (error) {
      log(`mcp audit: insert failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  // Uma entrada por escrita (ou recusa), a mais recente primeiro. Filtros: app (provider),
  // tool, actor, confirmed_by, since (ISO). -> { available, entries } | { available: false, error }.
  async function list({ limit = 50, app = null, tool = null, actor = null, confirmedBy = null, since = null } = {}) {
    if (!db) return { available: false, error: 'not_configured', entries: [] };
    const where = ["r.phase IN ('requested', 'refused')"];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (app) add('r.provider = ?', String(app));
    if (tool) add('r.tool = ?', String(tool));
    if (actor) add('r.actor_email = ?', String(actor).toLowerCase());
    if (confirmedBy) add('r.confirmed_by = ?', String(confirmedBy).toLowerCase());
    if (since) {
      const at = new Date(since);
      if (Number.isNaN(at.getTime())) return { available: false, error: 'since must be an ISO date or time', entries: [] };
      add('r.created_at >= ?', at.toISOString());
    }
    params.push(limitOf(limit));
    try {
      const result = await db.query(`
        SELECT r.request_id, r.created_at, r.phase, r.actor_email, r.actor_groups, r.client_id, r.confirmed_by,
               r.confirmed_by_input, r.tool, r.provider, r.access, r.arguments, r.status AS refused_code, r.error AS refused_error,
               c.created_at AS completed_at, c.status, c.error, c.previous_value, c.new_value, c.target
        FROM deploy_platform.mcp_audit_log r
        LEFT JOIN LATERAL (
          SELECT * FROM deploy_platform.mcp_audit_log x
          WHERE x.request_id = r.request_id AND x.phase = 'completed'
          ORDER BY x.created_at
          LIMIT 1
        ) c ON true
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT $${params.length}
      `, params);
      return { available: true, entries: result.rows.map(entryOf) };
    } catch (error) {
      log(`mcp audit: read failed: ${error.message}`);
      return { available: false, error: error.message, entries: [] };
    }
  }

  return { configured: Boolean(db), record, list, close: async () => { if (!pool && db) await db.end(); } };
}

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function entryOf(row) {
  const refused = row.phase === 'refused';
  return {
    request_id: row.request_id,
    at: iso(row.created_at),
    actor: row.actor_email,
    actor_groups: row.actor_groups ?? [],
    client_id: row.client_id ?? null,
    confirmed_by: row.confirmed_by ?? null,
    confirmed_by_input: row.confirmed_by_input ?? null,
    tool: row.tool,
    app: row.provider ?? null,
    access: row.access,
    arguments: row.arguments ?? {},
    status: refused ? 'refused' : (row.status ?? 'unknown'),
    code: refused ? row.refused_code ?? null : null,
    error: refused ? row.refused_error ?? null : row.error ?? null,
    previous_value: refused ? null : row.previous_value ?? null,
    new_value: refused ? null : row.new_value ?? null,
    target: refused ? null : row.target ?? null,
    completed_at: refused ? null : iso(row.completed_at),
  };
}
