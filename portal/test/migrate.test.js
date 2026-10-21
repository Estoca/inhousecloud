import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationFiles, runMigrations } from '../src/migrate.js';

function fakePool({ done = [], failOn = null } = {}) {
  const log = [];
  const applied = new Set(done);
  const client = {
    async query(sql, params) {
      log.push(sql.trim().split('\n')[0]);
      if (sql.startsWith('SELECT name FROM deploy_platform.schema_migrations')) return { rows: [...applied].map((name) => ({ name })) };
      if (sql.startsWith('INSERT INTO deploy_platform.schema_migrations')) applied.add(params[0]);
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { rows: [] };
    },
    release() { log.push('release'); },
  };
  return { log, applied, pool: { connect: async () => client } };
}

test('the repository migrations are found in order', () => {
  const names = migrationFiles().map((file) => file.name);
  assert.equal(names[0], '001_deploy_platform_schema.sql');
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('009_drop_write_surface.sql'));
});

test('runMigrations applies only what is missing, each in a transaction, and records it', async () => {
  const files = [
    { name: '001_a.sql', sql: 'CREATE TABLE a();' },
    { name: '002_b.sql', sql: 'BEGIN;\nCREATE TABLE b();\nCOMMIT;' },
    { name: '003_c.sql', sql: 'CREATE TABLE c();' },
  ];
  const { pool, log, applied } = fakePool({ done: ['001_a.sql'] });
  const result = await runMigrations({ pool, files });
  assert.deepEqual(result, { ok: true, total: 3, applied: 2, names: ['002_b.sql', '003_c.sql'] });
  assert.deepEqual([...applied].sort(), ['001_a.sql', '002_b.sql', '003_c.sql']);
  assert.equal(log.filter((line) => line === 'BEGIN;').length, 0, 'the file BEGIN/COMMIT are stripped');
  assert.equal(log.filter((line) => line === 'BEGIN').length, 2);
  assert.equal(log.at(-1), 'release');

  const again = await runMigrations({ pool, files });
  assert.equal(again.applied, 0);
});

test('a failing migration is rolled back, named, and stops the rest', async () => {
  const files = [{ name: '001_a.sql', sql: 'CREATE TABLE a();' }, { name: '002_bad.sql', sql: 'CREATE TABLE bad();' }, { name: '003_c.sql', sql: 'x' }];
  const { pool, log, applied } = fakePool({ failOn: 'bad()' });
  const result = await runMigrations({ pool, files });
  assert.equal(result.ok, false);
  assert.match(result.error, /^002_bad\.sql: boom/);
  assert.equal(result.applied, 1);
  assert.ok(log.includes('ROLLBACK'));
  assert.equal(applied.has('003_c.sql'), false);
});

test('without DATABASE_URL nothing runs', async () => {
  const result = await runMigrations({ pool: null, files: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_database_url');
});
