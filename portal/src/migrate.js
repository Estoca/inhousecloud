// Migracoes do banco do portal, aplicadas no boot do container (startServer) contra o
// banco e o papel que o instalador do cloud cria (ihc_platform, LOGIN NOSUPERUSER, dono
// do banco). Cada arquivo de db/migrations/ roda uma vez, em ordem, numa transacao, e fica
// registrado em deploy_platform.schema_migrations. Um banco migrado a mao ate o 009 antes
// desta tabela existir precisa das linhas 001 a 009 inseridas a mao (o 005 altera uma
// tabela que o 009 remove).
//
//   node src/migrate.js        aplica o que falta e imprime o resumo em JSON

import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fromRoot } from './paths.js';
import { getPool } from './db.js';

export function migrationFiles(dir = fromRoot('db', 'migrations')) {
  return readdirSync(dir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(`${dir}/${name}`, 'utf8') }));
}

// Os arquivos ja trazem BEGIN/COMMIT proprios em alguns casos; a transacao externa os
// tornaria aninhados. Tira os dois e roda o resto numa transacao so.
function body(sql) {
  return sql.replace(/^\s*BEGIN\s*;\s*$/gim, '').replace(/^\s*COMMIT\s*;\s*$/gim, '');
}

export async function runMigrations({ pool = getPool(), files = migrationFiles(), log = () => {} } = {}) {
  if (!pool) return { ok: false, error: 'missing_database_url', total: files.length, applied: 0, names: [] };
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS deploy_platform');
    await client.query(`CREATE TABLE IF NOT EXISTS deploy_platform.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    // Um portal por banco: duas instancias subindo juntas nao aplicam a mesma migracao.
    await client.query("SELECT pg_advisory_lock(hashtext('ihc-portal-migrations'))");
    const done = new Set((await client.query('SELECT name FROM deploy_platform.schema_migrations')).rows.map((row) => row.name));
    for (const file of files) {
      if (done.has(file.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(body(file.sql));
        await client.query('INSERT INTO deploy_platform.schema_migrations (name) VALUES ($1)', [file.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${file.name}: ${error.message}`);
      }
      applied.push(file.name);
      log(`migration ${file.name} applied`);
    }
    return { ok: true, total: files.length, applied: applied.length, names: applied };
  } catch (error) {
    return { ok: false, error: error.message, total: files.length, applied: applied.length, names: applied };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('ihc-portal-migrations'))").catch(() => {});
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMigrations({ log: (line) => console.error(line) });
  console.log(JSON.stringify(result));
  await getPool()?.end();
  process.exit(result.ok ? 0 : 1);
}
