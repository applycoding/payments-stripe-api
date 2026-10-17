import type pg from 'pg';
import { query, withTransaction } from './db.js';
import { backoffDelayMs } from './retry.js';

export type OutboxEvent = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
};

type OutboxRow = OutboxEvent & {
  next_attempt_at: Date;
  published_at: Date | null;
};

export async function enqueueOutbox(
  client: pg.PoolClient,
  event: {
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (aggregate_type, aggregate_id, event_type) DO NOTHING`,
    [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
  );
}

export type DrainResult = {
  published: number;
  failed: number;
  dead: number;
};

const DEFAULT_MAX_ATTEMPTS = 8;

export async function drainOutbox(
  pool: pg.Pool,
  options: {
    limit?: number;
    maxAttempts?: number;
    handler?: (event: OutboxEvent) => Promise<void>;
  } = {},
): Promise<DrainResult> {
  const limit = options.limit ?? 50;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const handler = options.handler ?? (async () => undefined);
  const pending = await query<{ id: string }>(
    pool,
    `SELECT id FROM outbox
     WHERE published_at IS NULL AND attempts < $1 AND next_attempt_at <= now()
     ORDER BY created_at
     LIMIT $2`,
    [maxAttempts, limit],
  );

  const result: DrainResult = { published: 0, failed: 0, dead: 0 };
  for (const item of pending) {
    const outcome = await withTransaction(pool, async (client) => {
      const locked = await query<OutboxRow>(
        client,
        `SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts, next_attempt_at, published_at
         FROM outbox
         WHERE id = $1
         FOR UPDATE`,
        [item.id],
      );
      const row = locked[0];
      if (!row || row.published_at || row.attempts >= maxAttempts || row.next_attempt_at.getTime() > Date.now()) {
        return 'skip' as const;
      }
      try {
        await handler(row);
        await client.query(
          `UPDATE outbox SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
          [row.id],
        );
        await client.query(
          `INSERT INTO published_events (outbox_id, event_type, payload)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (outbox_id) DO NOTHING`,
          [row.id, row.event_type, JSON.stringify(row.payload)],
        );
        return 'published' as const;
      } catch (err) {
        const attempts = row.attempts + 1;
        const delay = backoffDelayMs(attempts, { baseMs: 500, maxMs: 60_000, jitterRatio: 0.2 });
        const message = err instanceof Error ? err.message : 'publish failed';
        await client.query(
          `UPDATE outbox
           SET attempts = $2,
               published_at = NULL,
               next_attempt_at = now() + ($3::int * interval '1 millisecond'),
               last_error = $4
           WHERE id = $1`,
          [row.id, attempts, delay, message.slice(0, 500)],
        );
        return attempts >= maxAttempts ? ('dead' as const) : ('failed' as const);
      }
    });
    if (outcome === 'published') {
      result.published += 1;
    } else if (outcome === 'failed') {
      result.failed += 1;
    } else if (outcome === 'dead') {
      result.dead += 1;
    }
  }
  return result;
}
