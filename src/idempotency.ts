import { createHash } from 'node:crypto';
import type pg from 'pg';
import { queryOne } from './db.js';
import { AppError, isUniqueViolation } from './errors.js';

const STALE_LOCK_MS = 120_000;

export type IdempotentResult = {
  statusCode: number;
  body: unknown;
};

type IdempotencyRow = {
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown | null;
  created_at: Date;
  completed_at: Date | null;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stable(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = stable(record[key]);
    }
    return sorted;
  }
  return value;
}

export function hashRequest(method: string, requestPath: string, body: unknown): string {
  const canonical = JSON.stringify({ method, path: requestPath, body: stable(body) });
  return createHash('sha256').update(canonical).digest('hex');
}

async function readKey(db: pg.Pool | pg.PoolClient, key: string): Promise<IdempotencyRow | null> {
  return queryOne<IdempotencyRow>(db, 'SELECT key, request_hash, response_status, response_body, created_at, completed_at FROM idempotency_keys WHERE key = $1', [
    key,
  ]);
}

function replay(row: IdempotencyRow): IdempotentResult {
  return {
    statusCode: row.response_status ?? 500,
    body: row.response_body,
  };
}

export async function runIdempotent(
  pool: pg.Pool,
  key: string,
  requestHash: string,
  work: () => Promise<IdempotentResult>,
  attempt = 0,
): Promise<{ result: IdempotentResult; replayed: boolean }> {
  const existing = await readKey(pool, key);
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(409, 'idempotency_key_reused', 'Idempotency-Key was already used with a different request');
    }
    if (existing.completed_at && existing.response_status !== null) {
      return { result: replay(existing), replayed: true };
    }
    const ageMs = Date.now() - existing.created_at.getTime();
    if (ageMs < STALE_LOCK_MS) {
      throw new AppError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is already in progress');
    }
  } else {
    try {
      await pool.query('INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)', [key, requestHash]);
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 3) {
        return runIdempotent(pool, key, requestHash, work, attempt + 1);
      }
      throw err;
    }
  }

  try {
    const result = await work();
    await complete(pool, key, result);
    return { result, replayed: false };
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      const result: IdempotentResult = {
        statusCode: err.statusCode,
        body: { error: { code: err.code, message: err.message } },
      };
      await complete(pool, key, result);
      return { result, replayed: false };
    }
    await pool.query('DELETE FROM idempotency_keys WHERE key = $1 AND completed_at IS NULL', [key]);
    throw err;
  }
}

async function complete(pool: pg.Pool, key: string, result: IdempotentResult): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys
     SET response_status = $2, response_body = $3::jsonb, completed_at = now()
     WHERE key = $1`,
    [key, result.statusCode, JSON.stringify(result.body)],
  );
}
