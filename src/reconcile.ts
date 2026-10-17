import type pg from 'pg';
import { query, queryOne } from './db.js';
import type { ListedStripeEvent, StripeGateway } from './stripe-gateway.js';

export type MovementKind = 'capture' | 'refund';

export type Movement = {
  kind: MovementKind;
  key: string;
  amountCents: number;
  currency: string;
};

export type Discrepancy =
  | {
      type: 'missing_in_ledger';
      kind: MovementKind;
      key: string;
      currency: string;
      stripe_amount_cents: number;
    }
  | {
      type: 'missing_in_stripe';
      kind: MovementKind;
      key: string;
      currency: string;
      ledger_amount_cents: number;
    }
  | {
      type: 'amount_mismatch';
      kind: MovementKind;
      key: string;
      currency: string;
      stripe_amount_cents: number;
      ledger_amount_cents: number;
    }
  | {
      type: 'conflicting_stripe_events';
      kind: MovementKind;
      key: string;
      currency: string;
      stripe_amount_cents: number;
      other_amount_cents: number;
    }
  | {
      type: 'cash_balance_mismatch';
      currency: string;
      stripe_net_cents: number;
      ledger_balance_cents: number;
    };

const RECONCILE_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'payment_intent.succeeded',
  'refund.created',
  'refund.updated',
  'refund.failed',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function str(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function idOf(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'id' in value && typeof (value as { id: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function num(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function movementKey(movement: { kind: MovementKind; key: string }): string {
  return `${movement.kind}:${movement.key}`;
}

function remember(
  map: Map<string, Movement>,
  conflicts: Discrepancy[],
  movement: Movement,
): void {
  const existing = map.get(movement.key);
  if (!existing) {
    map.set(movement.key, movement);
    return;
  }
  if (existing.amountCents !== movement.amountCents || existing.currency !== movement.currency) {
    conflicts.push({
      type: 'conflicting_stripe_events',
      kind: movement.kind,
      key: movement.key,
      currency: movement.currency,
      stripe_amount_cents: existing.amountCents,
      other_amount_cents: movement.amountCents,
    });
  }
}

export function projectStripeMovements(events: ListedStripeEvent[]): {
  captures: Movement[];
  refunds: Movement[];
  conflicts: Discrepancy[];
} {
  const sorted = [...events].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id));
  const captures = new Map<string, Movement>();
  const refunds = new Map<string, Movement>();
  const conflicts: Discrepancy[] = [];

  for (const event of sorted) {
    const object = asRecord(event.object);
    if (!object) {
      continue;
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const paymentStatus = str(object, 'payment_status');
      if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
        continue;
      }
      const amount = num(object, 'amount_total');
      const currency = str(object, 'currency')?.toLowerCase() ?? null;
      const sessionId = str(object, 'id');
      if (amount === null || !currency || !sessionId) {
        continue;
      }
      const key = idOf(object, 'payment_intent') ?? `cs:${sessionId}`;
      remember(captures, conflicts, { kind: 'capture', key, amountCents: amount, currency });
      continue;
    }
    if (event.type === 'payment_intent.succeeded') {
      const amount = num(object, 'amount_received') ?? num(object, 'amount');
      const currency = str(object, 'currency')?.toLowerCase() ?? null;
      const key = str(object, 'id');
      if (amount === null || !currency || !key) {
        continue;
      }
      remember(captures, conflicts, { kind: 'capture', key, amountCents: amount, currency });
      continue;
    }
    if (event.type === 'refund.created' || event.type === 'refund.updated' || event.type === 'refund.failed') {
      const id = str(object, 'id');
      if (!id) {
        continue;
      }
      const status = event.type === 'refund.failed' ? 'failed' : str(object, 'status');
      if (status === 'failed' || status === 'canceled') {
        refunds.delete(id);
        continue;
      }
      if (status !== 'succeeded') {
        continue;
      }
      const amount = num(object, 'amount');
      const currency = str(object, 'currency')?.toLowerCase() ?? null;
      if (amount === null || !currency) {
        continue;
      }
      remember(refunds, conflicts, { kind: 'refund', key: id, amountCents: amount, currency });
    }
  }

  return { captures: [...captures.values()], refunds: [...refunds.values()], conflicts };
}

export function diffMovements(expected: Movement[], actual: Movement[]): Discrepancy[] {
  const actualByKey = new Map(actual.map((movement) => [movementKey(movement), movement]));
  const seen = new Set<string>();
  const discrepancies: Discrepancy[] = [];
  for (const item of expected) {
    const key = movementKey(item);
    seen.add(key);
    const got = actualByKey.get(key);
    if (!got) {
      discrepancies.push({
        type: 'missing_in_ledger',
        kind: item.kind,
        key: item.key,
        currency: item.currency,
        stripe_amount_cents: item.amountCents,
      });
      continue;
    }
    if (got.amountCents !== item.amountCents || got.currency !== item.currency) {
      discrepancies.push({
        type: 'amount_mismatch',
        kind: item.kind,
        key: item.key,
        currency: item.currency,
        stripe_amount_cents: item.amountCents,
        ledger_amount_cents: got.amountCents,
      });
    }
  }
  for (const item of actual) {
    if (seen.has(movementKey(item))) {
      continue;
    }
    discrepancies.push({
      type: 'missing_in_stripe',
      kind: item.kind,
      key: item.key,
      currency: item.currency,
      ledger_amount_cents: item.amountCents,
    });
  }
  return discrepancies;
}

export function cashDiscrepancies(
  captures: Movement[],
  refunds: Movement[],
  balances: Array<{ currency: string; balanceCents: number }>,
): Discrepancy[] {
  const expected = new Map<string, number>();
  for (const capture of captures) {
    expected.set(capture.currency, (expected.get(capture.currency) ?? 0) + capture.amountCents);
  }
  for (const refund of refunds) {
    expected.set(refund.currency, (expected.get(refund.currency) ?? 0) - refund.amountCents);
  }
  const actual = new Map(balances.map((balance) => [balance.currency, balance.balanceCents]));
  const currencies = new Set([...expected.keys(), ...actual.keys()]);
  const discrepancies: Discrepancy[] = [];
  for (const currency of currencies) {
    const stripeNet = expected.get(currency) ?? 0;
    const ledgerBalance = actual.get(currency) ?? 0;
    if (stripeNet !== ledgerBalance) {
      discrepancies.push({
        type: 'cash_balance_mismatch',
        currency,
        stripe_net_cents: stripeNet,
        ledger_balance_cents: ledgerBalance,
      });
    }
  }
  return discrepancies;
}

async function ledgerMovements(db: pg.Pool | pg.PoolClient): Promise<{ captures: Movement[]; refunds: Movement[] }> {
  const captures = await query<{ key: string; amount_cents: number; currency: string }>(
    db,
    `SELECT COALESCE(p.stripe_payment_intent_id, 'cs:' || p.stripe_checkout_session_id, 'payment:' || p.id::text) AS key,
            jl.amount_cents,
            jl.currency
     FROM journal_entries je
     JOIN payments p ON p.id = je.source_id AND je.source_type = 'payment'
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE la.code LIKE 'cash:stripe:%' AND jl.direction = 'debit'`,
  );
  const refunds = await query<{ key: string; amount_cents: number; currency: string }>(
    db,
    `SELECT COALESCE(r.stripe_refund_id, 'refund:' || r.id::text) AS key,
            jl.amount_cents,
            jl.currency
     FROM journal_entries je
     JOIN refunds r ON r.id = je.source_id AND je.source_type = 'refund'
     JOIN journal_lines jl ON jl.entry_id = je.id
     JOIN ledger_accounts la ON la.id = jl.account_id
     WHERE la.code LIKE 'cash:stripe:%' AND jl.direction = 'credit'`,
  );
  return {
    captures: captures.map((row) => ({
      kind: 'capture' as const,
      key: row.key,
      amountCents: row.amount_cents,
      currency: row.currency,
    })),
    refunds: refunds.map((row) => ({
      kind: 'refund' as const,
      key: row.key,
      amountCents: row.amount_cents,
      currency: row.currency,
    })),
  };
}

async function cashBalances(db: pg.Pool | pg.PoolClient): Promise<Array<{ currency: string; balanceCents: number }>> {
  const rows = await query<{ currency: string; balance_cents: number }>(
    db,
    `SELECT la.currency,
            COALESCE(SUM(CASE WHEN jl.direction = 'debit' THEN jl.amount_cents ELSE -jl.amount_cents END), 0)::int AS balance_cents
     FROM ledger_accounts la
     LEFT JOIN journal_lines jl ON jl.account_id = la.id
     WHERE la.code LIKE 'cash:stripe:%'
     GROUP BY la.currency`,
  );
  return rows.map((row) => ({ currency: row.currency, balanceCents: row.balance_cents }));
}

export type ReconciliationReport = {
  id: string;
  status: 'succeeded' | 'failed';
  discrepancy_count: number;
  discrepancies: Discrepancy[];
  stripe_capture_count: number;
  stripe_refund_count: number;
  ledger_capture_count: number;
  ledger_refund_count: number;
};

export async function runReconciliation(
  pool: pg.Pool,
  stripe: StripeGateway,
  options: { createdGte?: number } = {},
): Promise<ReconciliationReport> {
  const createdGte = options.createdGte ?? Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const run = await queryOne<{ id: string }>(
    pool,
    `INSERT INTO reconciliation_runs (status) VALUES ('running') RETURNING id`,
  );
  if (!run) {
    throw new Error('Failed to start reconciliation run');
  }
  try {
    const events = await stripe.listEvents({ createdGte, types: RECONCILE_TYPES });
    const projected = projectStripeMovements(events.filter((event) => !event.livemode));
    const ledger = await ledgerMovements(pool);
    const balances = await cashBalances(pool);
    const discrepancies = [
      ...projected.conflicts,
      ...diffMovements(projected.captures, ledger.captures),
      ...diffMovements(projected.refunds, ledger.refunds),
      ...cashDiscrepancies(projected.captures, projected.refunds, balances),
    ];
    const report: ReconciliationReport = {
      id: run.id,
      status: 'succeeded',
      discrepancy_count: discrepancies.length,
      discrepancies,
      stripe_capture_count: projected.captures.length,
      stripe_refund_count: projected.refunds.length,
      ledger_capture_count: ledger.captures.length,
      ledger_refund_count: ledger.refunds.length,
    };
    await pool.query(
      `UPDATE reconciliation_runs
       SET status = 'succeeded', finished_at = now(), discrepancy_count = $2, report = $3::jsonb
       WHERE id = $1`,
      [run.id, discrepancies.length, JSON.stringify(report)],
    );
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'reconciliation failed';
    await pool.query(
      `UPDATE reconciliation_runs
       SET status = 'failed', finished_at = now(), report = $2::jsonb
       WHERE id = $1`,
      [run.id, JSON.stringify({ error: message.slice(0, 500) })],
    );
    throw err;
  }
}

export async function listReconciliationRuns(pool: pg.Pool, limit: number): Promise<Array<Record<string, unknown>>> {
  const rows = await query<{
    id: string;
    status: string;
    discrepancy_count: number;
    started_at: Date;
    finished_at: Date | null;
  }>(
    pool,
    `SELECT id, status, discrepancy_count, started_at, finished_at
     FROM reconciliation_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    discrepancy_count: row.discrepancy_count,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  }));
}

export async function getReconciliationRun(pool: pg.Pool, id: string): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{
    id: string;
    status: string;
    discrepancy_count: number;
    started_at: Date;
    finished_at: Date | null;
    report: unknown;
  }>(
    pool,
    `SELECT id, status, discrepancy_count, started_at, finished_at, report
     FROM reconciliation_runs WHERE id = $1`,
    [id],
  );
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    discrepancy_count: row.discrepancy_count,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    report: row.report,
  };
}
