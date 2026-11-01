import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deployJournalDir, parseDeployJournal, readDeployJournal, undoTarget } from '../src/deploy-journal.js';
import { createApp } from '../src/server.js';
import { createAuth } from '../src/auth.js';

const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');
const begin = (tx, op, before, after, extra = {}) => ({
  tx, phase: 'begin', op, at: `2026-11-01T10:0${tx.slice(1)}:00Z`,
  before: { release: before, commit: before ? `c-${before}` : '' },
  after: { release: after, commit: `c-${after}` },
  ...extra,
});
const applied = (tx) => ({ tx, phase: 'step', step: 'applied' });
const end = (tx, result) => ({ tx, phase: 'end', result, at: '2026-11-01T11:00:00Z' });

const JOURNAL = lines(
  begin('t1', 'deploy', '', 'r1'), applied('t1'), end('t1', 'ok'),
  begin('t2', 'deploy', 'r1', 'r2'),
  { tx: 't2', phase: 'step', step: 'provision', env_keys_added: ['NEW_FLAG'], env_keys_removed: [], env_keys_changed: [] },
  applied('t2'), end('t2', 'unhealthy'),
  begin('t3', 'deploy', 'r2', 'r3'),
  'not json',
  begin('t4', 'rollback', 'r2', 'r1', { reverts: 't2' }), applied('t4'), end('t4', 'ok'),
);

test('the journal groups into transactions, an unfinished one is interrupted, bad lines are skipped', () => {
  const txs = parseDeployJournal(JOURNAL);
  assert.deepEqual(txs.map((tx) => [tx.tx, tx.op, tx.result, tx.applied]), [
    ['t1', 'deploy', 'ok', true],
    ['t2', 'deploy', 'unhealthy', true],
    ['t3', 'deploy', 'interrupted', false],
    ['t4', 'rollback', 'ok', true],
  ]);
  assert.deepEqual(txs[1].env, { env_keys_added: ['NEW_FLAG'], env_keys_removed: [], env_keys_changed: [] });
  assert.equal(txs[3].reverts, 't2');
});

test('the undo target follows reverse order and refuses the first deploy', () => {
  const txs = parseDeployJournal(JOURNAL);
  // t2 was rolled back by t4: next is t1, which replaced nothing the journal has.
  assert.deepEqual(undoTarget(txs), { available: false, reason: 'replaced_version_not_journaled', reverts: 't1' });
  assert.deepEqual(undoTarget(txs.slice(0, 2)), {
    available: true, reverts: 't2', from_release: 'r2', from_commit: 'c-r2', to_release: 'r1', to_commit: 'c-r1',
  });
  assert.deepEqual(undoTarget([]), { available: false, reason: 'no_deploys' });
});

test('readDeployJournal reads <dir>/<slug>.jsonl next to the inventory, newest first', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ihc-journal-'));
  try {
    mkdirSync(path.join(dir, 'deploys'));
    writeFileSync(path.join(dir, 'deploys', 'pedidos.jsonl'), JOURNAL);
    assert.equal(deployJournalDir({ INVENTORY_PATH: path.join(dir, 'inventory.json') }), path.join(dir, 'deploys'));
    assert.equal(deployJournalDir({ DEPLOY_JOURNAL_DIR: '/x/deploys', INVENTORY_PATH: '/y/inventory.json' }), '/x/deploys');
    const result = readDeployJournal('pedidos', { dir: path.join(dir, 'deploys'), limit: 2 });
    assert.equal(result.available, true);
    assert.equal(result.total, 4);
    assert.deepEqual(result.transactions.map((tx) => tx.tx), ['t4', 't3']);
    const missing = readDeployJournal('outro-app', { dir: path.join(dir, 'deploys') });
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.transactions, []);
    assert.equal(readDeployJournal('../etc', { dir }).error, 'invalid_slug');
    assert.equal(readDeployJournal('pedidos', { dir: null }).error, 'not_configured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('GET /api/apps/:slug/deploy-journal is for admins and read only', async () => {
  const seen = [];
  const app = createApp({
    auth: createAuth({ superAdminEmails: 'ana@example.com', portalUserDomains: 'example.com' }),
    readDeployJournalFn: (slug, options) => {
      seen.push([slug, options.limit]);
      if (slug === 'bad--') return { available: false, error: 'invalid_slug', transactions: [] };
      return { available: true, error: null, exists: true, total: 1, transactions: [{ tx: 't1', op: 'deploy', result: 'ok' }], undo: { available: false, reason: 'no_deploys' } };
    },
  });
  const { server, baseUrl } = await listen(app);
  try {
    const admin = { 'x-authentik-email': 'carla@example.org', 'x-authentik-groups': 'ihc-users|ihc-admins' };
    const viewer = { 'x-authentik-email': 'bia@example.org', 'x-authentik-groups': 'ihc-users' };
    const ok = await fetch(`${baseUrl}/api/apps/pedidos/deploy-journal?limit=5`, { headers: admin });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.count, 1);
    assert.equal(body.transactions[0].tx, 't1');
    assert.deepEqual(seen[0], ['pedidos', '5']);
    assert.equal((await fetch(`${baseUrl}/api/apps/pedidos/deploy-journal`, { headers: viewer })).status, 403);
    assert.equal((await fetch(`${baseUrl}/api/apps/bad--/deploy-journal`, { headers: admin })).status, 400);
    for (const method of ['POST', 'DELETE', 'PATCH']) {
      const write = await fetch(`${baseUrl}/api/apps/pedidos/deploy-journal`, { method, headers: { ...admin, 'content-type': 'application/json' }, body: '{}' });
      assert.notEqual(write.status, 200, `${method} answered 200`);
    }
  } finally {
    server.close();
  }
});
