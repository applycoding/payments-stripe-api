import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
}

export async function query<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be unusable; the original error is the one to surface.
    }
    throw err;
  } finally {
    client.release();
  }
}

function migrationsDir(): string {
  return path.join(process.cwd(), 'db', 'migrations');
}

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(migrationsDir())
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const applied = await queryOne<{ version: string }>(
      pool,
      'SELECT version FROM schema_migrations WHERE version = $1',
      [version],
    );
    if (applied) {
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir(), file), 'utf8');
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
  }
}
