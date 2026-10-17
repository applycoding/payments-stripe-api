import type pg from 'pg';
import {
  cashAccountCode,
  paymentStatusAfterRefund,
  revenueAccountCode,
  refundsAccountCode,
  type PaymentKind,
  type PaymentStatus,
  type RefundStatus,
} from './domain.js';
import { query, queryOne, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { hashRequest, runIdempotent, type IdempotentResult } from './idempotency.js';
import { journalForSources, postEntry, type JournalEntryView } from './ledger.js';
import { enqueueOutbox } from './outbox.js';
import type { StripeGateway } from './stripe-gateway.js';

export type PaymentRow = {
  id: string;
  idempotency_key: string;
  kind: PaymentKind;
  amount_cents: number;
  currency: string;
  status: PaymentStatus;
  description: string;
  customer_email: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  client_secret: string | null;
  checkout_url: string | null;
  created_at: Date;
  updated_at: Date;
};

export type RefundRow = {
  id: string;
  payment_id: string;
  idempotency_key: string;
  amount_cents: number;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  stripe_refund_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const PAYMENT_COLUMNS = `id, idempotency_key, kind, amount_cents, currency, status, description, customer_email,
  stripe_checkout_session_id, stripe_payment_intent_id, client_secret, checkout_url, created_at, updated_at`;

export function paymentJson(row: PaymentRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency,
    description: row.description,
    customer_email: row.customer_email,
    checkout_url: row.checkout_url,
    stripe_checkout_session_id: row.stripe_checkout_session_id,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    client_secret: row.client_secret,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function refundJson(row: RefundRow): Record<string, unknown> {
  return {
    id: row.id,
    payment_id: row.payment_id,
    status: row.status,
    amount_cents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    stripe_refund_id: row.stripe_refund_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function getPayment(db: pg.Pool | pg.PoolClient, id: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`, [id]);
}

export async function listPayments(db: pg.Pool | pg.PoolClient, limit: number): Promise<PaymentRow[]> {
  return query<PaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments ORDER BY created_at DESC LIMIT $1`, [limit]);
}

async function lockPayment(client: pg.PoolClient, id: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(client, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`, [id]);
}

export async function findPayment(db: pg.Pool | pg.PoolClient, refs: {
  paymentId: string | null;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
}): Promise<PaymentRow | null> {
  if (refs.paymentId) {
    const byId = await getPayment(db, refs.paymentId);
    if (byId) {
      return byId;
    }
  }
  if (refs.checkoutSessionId) {
    const bySession = await queryOne<PaymentRow>(
      db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE stripe_checkout_session_id = $1`,
      [refs.checkoutSessionId],
    );
    if (bySession) {
      return bySession;
    }
  }
  if (refs.paymentIntentId) {
    return queryOne<PaymentRow>(
      db,
      `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE stripe_payment_intent_id = $1`,
      [refs.paymentIntentId],
    );
  }
  return null;
}

async function insertPayment(
  pool: pg.Pool,
  input: {
    idempotencyKey: string;
    kind: PaymentKind;
    amountCents: number;
    currency: string;
    description: string;
    customerEmail: string | null;
  },
): Promise<PaymentRow> {
  const inserted = await queryOne<PaymentRow>(
    pool,
    `INSERT INTO payments (idempotency_key, kind, amount_cents, currency, status, description, customer_email)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${PAYMENT_COLUMNS}`,
    [input.idempotencyKey, input.kind, input.amountCents, input.currency, input.description, input.customerEmail],
  );
  if (inserted) {
    return inserted;
  }
  const existing = await queryOne<PaymentRow>(
    pool,
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (!existing) {
    throw new AppError(500, 'payment_missing', 'Payment idempotency conflict did not resolve to a row');
  }
  if (existing.amount_cents !== input.amountCents || existing.currency !== input.currency || existing.kind !== input.kind) {
    throw new AppError(409, 'idempotency_key_reused', 'Idempotency-Key was already used with a different payment');
  }
  return existing;
}

export async function createCheckoutSession(
  pool: pg.Pool,
  stripe: StripeGateway,
  input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    description: string;
    customerEmail: string | null;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ result: IdempotentResult; replayed: boolean }> {
  const requestHash = hashRequest('POST', '/v1/checkout/sessions', {
    amount_cents: input.amountCents,
    currency: input.currency,
    description: input.description,
    customer_email: input.customerEmail,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  return runIdempotent(pool, input.idempotencyKey, requestHash, async () => {
    const payment = await insertPayment(pool, {
      idempotencyKey: input.idempotencyKey,
      kind: 'checkout',
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description,
      customerEmail: input.customerEmail,
    });
    if (!payment.stripe_checkout_session_id) {
      const session = await stripe.createCheckoutSession(
        {
          paymentId: payment.id,
          amountCents: input.amountCents,
          currency: input.currency,
          description: input.description,
          customerEmail: input.customerEmail,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
        },
        input.idempotencyKey,
      );
      const updated = await queryOne<PaymentRow>(
        pool,
        `UPDATE payments
         SET stripe_checkout_session_id = $2,
             stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3),
             checkout_url = $4
         WHERE id = $1
         RETURNING ${PAYMENT_COLUMNS}`,
        [payment.id, session.id, session.paymentIntentId, session.url],
      );
      if (!updated) {
        throw new AppError(500, 'payment_missing', 'Payment disappeared before Checkout was saved');
      }
      return { statusCode: 201, body: paymentJson(updated) };
    }
    return { statusCode: 201, body: paymentJson(payment) };
  });
}

export async function createPaymentIntent(
  pool: pg.Pool,
  stripe: StripeGateway,
  input: {
    idempotencyKey: string;
    amountCents: number;
    currency: string;
    description: string;
    customerEmail: string | null;
  },
): Promise<{ result: IdempotentResult; replayed: boolean }> {
  const requestHash = hashRequest('POST', '/v1/payment-intents', {
    amount_cents: input.amountCents,
    currency: input.currency,
    description: input.description,
    customer_email: input.customerEmail,
  });
  return runIdempotent(pool, input.idempotencyKey, requestHash, async () => {
    const payment = await insertPayment(pool, {
      idempotencyKey: input.idempotencyKey,
      kind: 'payment_intent',
      amountCents: input.amountCents,
      currency: input.currency,
      description: input.description,
      customerEmail: input.customerEmail,
    });
    if (!payment.stripe_payment_intent_id) {
      const intent = await stripe.createPaymentIntent(
        {
          paymentId: payment.id,
          amountCents: input.amountCents,
          currency: input.currency,
          description: input.description,
          customerEmail: input.customerEmail,
        },
        input.idempotencyKey,
      );
      const updated = await queryOne<PaymentRow>(
        pool,
        `UPDATE payments
         SET stripe_payment_intent_id = $2, client_secret = $3
         WHERE id = $1
         RETURNING ${PAYMENT_COLUMNS}`,
        [payment.id, intent.id, intent.clientSecret],
      );
      if (!updated) {
        throw new AppError(500, 'payment_missing', 'Payment disappeared before the PaymentIntent was saved');
      }
      return { statusCode: 201, body: paymentJson(updated) };
    }
    return { statusCode: 201, body: paymentJson(payment) };
  });
}

export async function paymentJournal(pool: pg.Pool, paymentId: string): Promise<JournalEntryView[]> {
  const payment = await getPayment(pool, paymentId);
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'Payment not found');
  }
  const refunds = await query<{ id: string }>(pool, 'SELECT id FROM refunds WHERE payment_id = $1', [paymentId]);
  return journalForSources(pool, [
    { sourceType: 'payment', sourceId: paymentId },
    ...refunds.map((refund) => ({ sourceType: 'refund' as const, sourceId: refund.id })),
  ]);
}

export async function fulfillCapturedPayment(
  client: pg.PoolClient,
  input: {
    paymentId: string;
    amountCents: number;
    currency: string;
    checkoutSessionId: string | null;
    paymentIntentId: string | null;
  },
): Promise<'captured' | 'already_captured'> {
  const payment = await lockPayment(client, input.paymentId);
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'Payment not found');
  }
  if (payment.amount_cents !== input.amountCents || payment.currency !== input.currency) {
    throw new AppError(
      409,
      'amount_mismatch',
      'Stripe amount does not match the payment recorded locally',
    );
  }
  await client.query(
    `UPDATE payments
     SET stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, $2),
         stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $3)
     WHERE id = $1`,
    [payment.id, input.checkoutSessionId, input.paymentIntentId],
  );
  if (payment.status === 'succeeded' || payment.status === 'partially_refunded' || payment.status === 'refunded') {
    return 'already_captured';
  }
  await client.query(`UPDATE payments SET status = 'succeeded' WHERE id = $1`, [payment.id]);
  const posted = await postEntry(client, {
    idempotencyKey: `capture:${payment.id}`,
    description: `Capture payment ${payment.id}`,
    sourceType: 'payment',
    sourceId: payment.id,
    lines: [
      {
        accountCode: cashAccountCode(payment.currency),
        accountName: 'Cash at Stripe',
        accountType: 'asset',
        direction: 'debit',
        amountCents: payment.amount_cents,
        currency: payment.currency,
      },
      {
        accountCode: revenueAccountCode(payment.currency),
        accountName: 'Revenue',
        accountType: 'income',
        direction: 'credit',
        amountCents: payment.amount_cents,
        currency: payment.currency,
      },
    ],
  });
  if (posted.created) {
    await enqueueOutbox(client, {
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType: 'payment.captured',
      payload: {
        payment_id: payment.id,
        amount_cents: payment.amount_cents,
        currency: payment.currency,
        stripe_payment_intent_id: input.paymentIntentId,
      },
    });
  }
  return 'captured';
}

export async function markPaymentClosed(
  client: pg.PoolClient,
  paymentId: string,
  status: 'failed' | 'canceled',
): Promise<void> {
  const payment = await lockPayment(client, paymentId);
  if (!payment || payment.status !== 'pending') {
    return;
  }
  await client.query(`UPDATE payments SET status = $2 WHERE id = $1 AND status = 'pending'`, [paymentId, status]);
}

export async function getRefund(db: pg.Pool | pg.PoolClient, id: string): Promise<RefundRow | null> {
  return queryOne<RefundRow>(
    db,
    `SELECT id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at
     FROM refunds WHERE id = $1`,
    [id],
  );
}

export async function findRefundByStripeId(db: pg.Pool | pg.PoolClient, stripeRefundId: string): Promise<RefundRow | null> {
  return queryOne<RefundRow>(
    db,
    `SELECT id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at
     FROM refunds WHERE stripe_refund_id = $1`,
    [stripeRefundId],
  );
}

async function reservedRefundCents(client: pg.PoolClient, paymentId: string): Promise<number> {
  const row = await queryOne<{ reserved: number }>(
    client,
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS reserved
     FROM refunds
     WHERE payment_id = $1 AND status IN ('pending', 'succeeded')`,
    [paymentId],
  );
  return row?.reserved ?? 0;
}

export async function createRefund(
  pool: pg.Pool,
  stripe: StripeGateway,
  input: {
    paymentId: string;
    idempotencyKey: string;
    amountCents: number | null;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer' | null;
  },
): Promise<{ result: IdempotentResult; replayed: boolean }> {
  const requestHash = hashRequest('POST', `/v1/payments/${input.paymentId}/refunds`, {
    amount_cents: input.amountCents,
    reason: input.reason,
  });
  return runIdempotent(pool, input.idempotencyKey, requestHash, async () => {
    const reserved = await withTransaction(pool, async (client) => {
      const payment = await lockPayment(client, input.paymentId);
      if (!payment) {
        throw new AppError(404, 'payment_not_found', 'Payment not found');
      }
      if (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') {
        throw new AppError(409, 'payment_not_refundable', `Payment in status ${payment.status} cannot be refunded`);
      }
      if (!payment.stripe_payment_intent_id) {
        throw new AppError(409, 'payment_intent_missing', 'Payment has no Stripe PaymentIntent to refund');
      }
      const existing = await queryOne<RefundRow>(
        client,
        `SELECT id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at
         FROM refunds WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      if (existing) {
        return { payment, refund: existing };
      }
      const reservedCents = await reservedRefundCents(client, payment.id);
      const remaining = payment.amount_cents - reservedCents;
      const amount = input.amountCents ?? remaining;
      if (amount <= 0 || amount > remaining) {
        throw new AppError(409, 'refund_exceeds_balance', `Refund of ${amount} exceeds remaining ${remaining}`);
      }
      const refund = await queryOne<RefundRow>(
        client,
        `INSERT INTO refunds (payment_id, idempotency_key, amount_cents, currency, status, reason)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at`,
        [payment.id, input.idempotencyKey, amount, payment.currency, input.reason],
      );
      if (!refund) {
        throw new AppError(500, 'refund_missing', 'Refund insert did not return a row');
      }
      return { payment, refund };
    });

    if (reserved.refund.status === 'succeeded') {
      return { statusCode: 201, body: refundJson(reserved.refund) };
    }
    if (reserved.refund.status === 'failed') {
      throw new AppError(409, 'refund_failed', 'This refund already failed. Use a new Idempotency-Key to try again.');
    }
    if (!reserved.payment.stripe_payment_intent_id) {
      throw new AppError(409, 'payment_intent_missing', 'Payment has no Stripe PaymentIntent to refund');
    }

    try {
      const stripeRefund = await stripe.createRefund(
        {
          refundId: reserved.refund.id,
          paymentId: reserved.payment.id,
          paymentIntentId: reserved.payment.stripe_payment_intent_id,
          amountCents: reserved.refund.amount_cents,
          reason: input.reason,
        },
        input.idempotencyKey,
      );
      if (stripeRefund.status === 'succeeded') {
        const settled = await withTransaction(pool, (client) =>
          settleSucceededRefund(client, {
            refundId: reserved.refund.id,
            stripeRefundId: stripeRefund.id,
            amountCents: stripeRefund.amount,
            currency: stripeRefund.currency,
          }),
        );
        return { statusCode: 201, body: refundJson(settled) };
      }
      if (stripeRefund.status === 'failed' || stripeRefund.status === 'canceled') {
        await markRefundFailed(pool, reserved.refund.id, stripeRefund.id);
        throw new AppError(409, 'refund_failed', `Stripe refund status is ${stripeRefund.status}`);
      }
      const pending = await queryOne<RefundRow>(
        pool,
        `UPDATE refunds SET stripe_refund_id = $2 WHERE id = $1
         RETURNING id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at`,
        [reserved.refund.id, stripeRefund.id],
      );
      if (!pending) {
        throw new AppError(500, 'refund_missing', 'Refund disappeared while saving the Stripe id');
      }
      return { statusCode: 201, body: refundJson(pending) };
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      await markRefundFailed(pool, reserved.refund.id, null);
      throw err;
    }
  });
}

export async function settleSucceededRefund(
  client: pg.PoolClient,
  input: {
    refundId: string;
    stripeRefundId: string;
    amountCents: number;
    currency: string;
  },
): Promise<RefundRow> {
  const peek = await getRefund(client, input.refundId);
  if (!peek) {
    throw new AppError(404, 'refund_not_found', 'Refund not found');
  }
  const payment = await lockPayment(client, peek.payment_id);
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'Payment not found');
  }
  const refund = await queryOne<RefundRow>(
    client,
    `SELECT id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at
     FROM refunds WHERE id = $1 FOR UPDATE`,
    [input.refundId],
  );
  if (!refund) {
    throw new AppError(404, 'refund_not_found', 'Refund not found');
  }
  if (refund.amount_cents !== input.amountCents || refund.currency !== input.currency) {
    throw new AppError(409, 'amount_mismatch', 'Stripe refund amount does not match the local refund');
  }
  if (refund.status === 'succeeded') {
    return refund;
  }
  const posted = await postEntry(client, {
    idempotencyKey: `refund:${refund.id}`,
    description: `Refund ${refund.id} on payment ${payment.id}`,
    sourceType: 'refund',
    sourceId: refund.id,
    lines: [
      {
        accountCode: refundsAccountCode(refund.currency),
        accountName: 'Refunds',
        accountType: 'expense',
        direction: 'debit',
        amountCents: refund.amount_cents,
        currency: refund.currency,
      },
      {
        accountCode: cashAccountCode(refund.currency),
        accountName: 'Cash at Stripe',
        accountType: 'asset',
        direction: 'credit',
        amountCents: refund.amount_cents,
        currency: refund.currency,
      },
    ],
  });
  const updated = await queryOne<RefundRow>(
    client,
    `UPDATE refunds
     SET status = 'succeeded', stripe_refund_id = COALESCE(stripe_refund_id, $2)
     WHERE id = $1
     RETURNING id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at`,
    [refund.id, input.stripeRefundId],
  );
  if (!updated) {
    throw new AppError(500, 'refund_missing', 'Refund disappeared while settling');
  }
  const succeeded = await queryOne<{ refunded: number }>(
    client,
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS refunded
     FROM refunds WHERE payment_id = $1 AND status = 'succeeded'`,
    [payment.id],
  );
  const nextStatus = paymentStatusAfterRefund(succeeded?.refunded ?? 0, payment.amount_cents);
  await client.query(`UPDATE payments SET status = $2 WHERE id = $1`, [payment.id, nextStatus]);
  if (posted.created) {
    await enqueueOutbox(client, {
      aggregateType: 'refund',
      aggregateId: refund.id,
      eventType: 'refund.posted',
      payload: {
        refund_id: refund.id,
        payment_id: payment.id,
        amount_cents: refund.amount_cents,
        currency: refund.currency,
        stripe_refund_id: input.stripeRefundId,
      },
    });
  }
  return updated;
}

async function markRefundFailed(pool: pg.Pool, refundId: string, stripeRefundId: string | null): Promise<void> {
  await pool.query(
    `UPDATE refunds
     SET status = 'failed', stripe_refund_id = COALESCE(stripe_refund_id, $2)
     WHERE id = $1 AND status = 'pending'`,
    [refundId, stripeRefundId],
  );
}

export async function ensureExternalRefund(
  client: pg.PoolClient,
  input: {
    paymentId: string;
    stripeRefundId: string;
    amountCents: number;
    currency: string;
    reason: string | null;
  },
): Promise<RefundRow> {
  const existing = await findRefundByStripeId(client, input.stripeRefundId);
  if (existing) {
    return existing;
  }
  const payment = await lockPayment(client, input.paymentId);
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'Payment not found');
  }
  const created = await queryOne<RefundRow>(
    client,
    `INSERT INTO refunds (payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6)
     ON CONFLICT (stripe_refund_id) DO NOTHING
     RETURNING id, payment_id, idempotency_key, amount_cents, currency, status, reason, stripe_refund_id, created_at, updated_at`,
    [payment.id, `stripe:${input.stripeRefundId}`, input.amountCents, input.currency, input.reason, input.stripeRefundId],
  );
  if (created) {
    return created;
  }
  const raced = await findRefundByStripeId(client, input.stripeRefundId);
  if (!raced) {
    throw new AppError(500, 'refund_missing', 'External refund conflict did not resolve to a row');
  }
  return raced;
}
