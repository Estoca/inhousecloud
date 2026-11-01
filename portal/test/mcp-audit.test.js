import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { REDACTED, createAuditLog, isSecretKey, redact } from '../src/mcp-audit.js';
import { runMigrations } from '../src/migrate.js';

// O audit log das escritas do gateway MCP (src/mcp-audit.js, migracao 010).

describe('what the audit stores of arguments and values', () => {
  test('secret keys and secret-looking values become [redacted], at any depth', () => {
    const jwt = `eyJ${'a'.repeat(10)}.eyJ${'b'.repeat(10)}.${'c'.repeat(10)}`;
    const out = redact({
      sku: 'A1',
      password: 'hunter2',
      apiKey: 'x',
      'X-Api-Key': 'y',
      nested: { client_secret: 'z', list: [{ access_token: 't' }, 'Bearer abc.def', jwt] },
      note: '-----BEGIN RSA PRIVATE KEY-----\nMII...',
      pin: '1234',
      shipping: 'kept',
      count: 3,
    });
    assert.deepEqual(out, {
      sku: 'A1',
      password: REDACTED,
      apiKey: REDACTED,
      'X-Api-Key': REDACTED,
      nested: { client_secret: REDACTED, list: [{ access_token: REDACTED }, REDACTED, REDACTED] },
      note: REDACTED,
      pin: REDACTED,
      shipping: 'kept',
      count: 3,
    });
    assert.equal(isSecretKey('Authorization'), true);
    assert.equal(isSecretKey('description'), false);
  });

  test('long text, long lists, deep nesting and huge payloads are cut', () => {
    assert.match(redact({ text: 'x'.repeat(5000) }).text, /…\[904 more characters\]$/);
    assert.equal(redact({ list: Array.from({ length: 250 }, (_, i) => i) }).list.length, 201);
    let deep = { v: 1 };
    for (let i = 0; i < 12; i += 1) deep = { deep };
    assert.match(JSON.stringify(redact(deep)), /nested too deep/);
    const huge = redact({ rows: Array.from({ length: 150 }, () => 'y'.repeat(1000)) });
    assert.equal(huge.truncated, true);
    assert.equal(redact(undefined), null);
  });
});

describe('the audit log over a pool', () => {
  function fakePool(rows = []) {
    const queries = [];
    return {
      queries,
      async query(text, params) {
        queries.push({ text, params });
        if (/^\s*INSERT/.test(text)) return { rows: [{ id: 'id-1', created_at: new Date() }] };
        return { rows };
      },
    };
  }

  test('without a URL or pool it is not configured and never throws', async () => {
    const audit = createAuditLog({});
    assert.equal(audit.configured, false);
    assert.deepEqual(await audit.record({ phase: 'requested' }), { ok: false, error: 'not_configured' });
    assert.equal((await audit.list()).available, false);
  });

  test('record inserts one row, redacted, with the person, the approver and the tool', async () => {
    const pool = fakePool();
    const audit = createAuditLog({ pool });
    const out = await audit.record({
      requestId: 'r1', phase: 'completed', actor: { email: 'ana@example.com', groups: ['ihc-users'], clientId: 'ihc-mcp' },
      confirmedBy: 'bia@example.com', confirmedByInput: 'bia', tool: 'notes__add', provider: 'notes',
      arguments: { text: 'x', token: 'secret' }, status: 'ok', previousValue: { v: 1 }, newValue: { v: 2, password: 'p' }, target: 'note 7',
    });
    assert.deepEqual(out, { ok: true, id: 'id-1' });
    const params = pool.queries[0].params;
    assert.match(pool.queries[0].text, /INSERT INTO deploy_platform\.mcp_audit_log/);
    assert.deepEqual(params.slice(0, 10), ['r1', 'completed', 'ana@example.com', ['ihc-users'], 'ihc-mcp', 'bia@example.com', 'bia', 'notes__add', 'notes', 'write']);
    assert.deepEqual(JSON.parse(params[10]), { text: 'x', token: REDACTED });
    assert.deepEqual(JSON.parse(params[13]), { v: 1 });
    assert.deepEqual(JSON.parse(params[14]), { v: 2, password: REDACTED });
    assert.equal(params[15], 'note 7');
  });

  test('a failing database is { ok: false }, not an exception', async () => {
    const audit = createAuditLog({ pool: { async query() { throw new Error('connection refused'); } } });
    assert.deepEqual(await audit.record({ requestId: 'r', phase: 'requested', tool: 't' }), { ok: false, error: 'connection refused' });
  });

  test('list joins the outcome to each write and filters by app, tool, actor, approver and date', async () => {
    const pool = fakePool([
      { request_id: 'r2', created_at: new Date('2026-11-01T10:00:00Z'), phase: 'refused', actor_email: 'ana@example.com', tool: 'notes__add', provider: 'notes', access: 'write', arguments: {}, refused_code: 'confirmation_required', refused_error: 'pass confirmed_by' },
      { request_id: 'r1', created_at: new Date('2026-11-01T09:00:00Z'), phase: 'requested', actor_email: 'ana@example.com', confirmed_by: 'bia@example.com', tool: 'notes__add', provider: 'notes', access: 'write', arguments: { text: 'x' }, completed_at: new Date('2026-11-01T09:00:01Z'), status: 'ok', previous_value: { v: 1 }, new_value: { v: 2 } },
      { request_id: 'r0', created_at: new Date('2026-11-01T08:00:00Z'), phase: 'requested', actor_email: 'ana@example.com', tool: 'notes__add', provider: 'notes', access: 'write', arguments: {} },
    ]);
    const audit = createAuditLog({ pool });
    const out = await audit.list({ limit: 999, app: 'notes', tool: 'notes__add', actor: 'Ana@Example.com', confirmedBy: 'bia@example.com', since: '2026-11-01' });
    assert.equal(out.available, true);
    assert.deepEqual(out.entries.map((entry) => [entry.request_id, entry.status]), [['r2', 'refused'], ['r1', 'ok'], ['r0', 'unknown']]);
    assert.equal(out.entries[0].code, 'confirmation_required');
    assert.deepEqual(out.entries[1].previous_value, { v: 1 });
    assert.equal(out.entries[1].completed_at, '2026-11-01T09:00:01.000Z');
    const { text, params } = pool.queries[0];
    assert.match(text, /r\.provider = \$1 AND r\.tool = \$2|r\.provider = \$1/);
    assert.deepEqual(params, ['notes', 'notes__add', 'ana@example.com', 'bia@example.com', '2026-11-01T00:00:00.000Z', 200]);
    assert.equal((await audit.list({ since: 'yesterday' })).available, false);
  });
});

// Contra um Postgres de verdade, so quando IHC_TEST_DATABASE_URL aponta um banco
// descartavel (o papel dono, como ihc_platform). Prova a migracao 010 e o append-only.
const databaseUrl = process.env.IHC_TEST_DATABASE_URL;
describe('the audit log on a real Postgres', { skip: !databaseUrl && 'set IHC_TEST_DATABASE_URL to a scratch database to run' }, () => {
  let pool;
  before(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const migrated = await runMigrations({ pool });
    assert.equal(migrated.ok, true, migrated.error);
  });
  after(async () => { await pool?.end(); });

  test('two rows per write, read back as one entry; UPDATE, DELETE and TRUNCATE are refused, even to the owner', async () => {
    const audit = createAuditLog({ pool });
    const requestId = crypto.randomUUID();
    const base = { requestId, actor: { email: 'ana@example.com', groups: ['ihc-users'] }, tool: 'notes__add', provider: 'notes', confirmedBy: 'bia@example.com', arguments: { text: 'x', password: 'p' } };
    assert.equal((await audit.record({ ...base, phase: 'requested' })).ok, true);
    assert.equal((await audit.record({ ...base, phase: 'completed', status: 'ok', previousValue: null, newValue: { v: 2 } })).ok, true);
    const { entries } = await audit.list({ tool: 'notes__add', actor: 'ana@example.com' });
    const entry = entries.find((item) => item.request_id === requestId);
    assert.equal(entry.status, 'ok');
    assert.deepEqual(entry.arguments, { text: 'x', password: REDACTED });
    assert.deepEqual(entry.new_value, { v: 2 });
    await assert.rejects(pool.query("UPDATE deploy_platform.mcp_audit_log SET status = 'forged' WHERE request_id = $1", [requestId]), /append-only/);
    await assert.rejects(pool.query('DELETE FROM deploy_platform.mcp_audit_log WHERE request_id = $1', [requestId]), /append-only/);
    await assert.rejects(pool.query('TRUNCATE deploy_platform.mcp_audit_log'), /append-only/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM deploy_platform.mcp_audit_log WHERE request_id = $1', [requestId])).rows[0].n, 2);
  });
});
