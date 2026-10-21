import pg from 'pg';

const { Pool } = pg;

let sharedPool;

export function getDatabaseUrl(env = process.env) {
  return env.DATABASE_URL;
}

export function getPool({ env = process.env } = {}) {
  const connectionString = getDatabaseUrl(env);
  if (!connectionString) {
    return null;
  }

  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString,
      max: Number(env.DATABASE_POOL_MAX || 5),
    });
  }

  return sharedPool;
}

export async function query(text, params = [], { pool = getPool() } = {}) {
  if (!pool) {
    return {
      available: false,
      error: 'missing_database_url',
      rows: [],
    };
  }

  try {
    const result = await pool.query(text, params);
    return {
      available: true,
      rows: result.rows,
      rowCount: result.rowCount,
    };
  } catch (error) {
    return {
      available: false,
      error: error.message,
      rows: [],
    };
  }
}

