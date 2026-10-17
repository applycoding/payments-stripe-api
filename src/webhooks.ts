import Stripe from 'stripe';
import type pg from 'pg';
import { AppError } from './errors.js';
import { queryOne, withTransaction } from './db.js';
import {
  ensureExternalRefund,
  findPayment,
  findRefundByStripeId,
  fulfillCapturedPayment,
  getRefund,
  markPaymentClosed,
  settleSucceededRefund,
} from './payments.js';

export type IngestResult = {
  duplicate: boolean;
  outcome: 'processed' | 'ignored' | 'failed';
};

type EventRow = {
  status: 'received' | 'processed' | 'ignored' | 'failed';
};

type ApplyResult = {
  status: 'processed' | 'ignored' | 'failed';
  error: string | null;
};

export function verifyStripeEvent(payload: Buffer, signature: string, secret: string): Stripe.Event {
  try {
    return Stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
    }
    throw err;
  }
}

export function assertTestModeEvent(event: { livemode: boolean }): void {
  if (event.livemode) {
    throw new AppError(400, 'live_mode_rejected', 'Live-mode Stripe events are rejected. This service is test mode only.');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new AppError(400, 'invalid_event', 'Stripe event data is not an object');
}

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function idField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'id' in value && typeof (value as { id: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

function numberField(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function metadataId(object: Record<string, unknown>, key: string): string | null {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const HANDLED = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'refund.created',
  'refund.updated',
  'refund.failed',
] as const;

type HandledType = (typeof HANDLED)[number];

function isHandled(type: string): type is HandledType {
  return (HANDLED as readonly string[]).includes(type);
}

function paidSession(status: string | null): boolean {
  return status === 'paid' || status === 'no_payment_required';
}

export async function ingestStripeEvent(pool: pg.Pool, event: Stripe.Event): Promise<IngestResult> {
  assertTestModeEvent(event);
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [event.id]);
    await client.query(
      `INSERT INTO stripe_events (stripe_event_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'received')
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [event.id, event.type, JSON.stringify(event)],
    );
    const row = await queryOne<EventRow>(
      client,
      'SELECT status FROM stripe_events WHERE stripe_event_id = $1 FOR UPDATE',
      [event.id],
    );
    if (!row) {
      throw new AppError(500, 'event_missing', 'Stripe event was not stored');
    }
    if (row.status === 'processed' || row.status === 'ignored') {
      return { duplicate: true, outcome: row.status };
    }
    const applied = await applyEvent(client, event);
    await client.query(
      `UPDATE stripe_events
       SET status = $2, error = $3, processed_at = now()
       WHERE stripe_event_id = $1`,
      [event.id, applied.status, applied.error],
    );
    return { duplicate: false, outcome: applied.status };
  });
}

async function applyEvent(client: pg.PoolClient, event: Stripe.Event): Promise<ApplyResult> {
  if (!isHandled(event.type)) {
    return { status: 'ignored', error: null };
  }
  const object = asRecord(event.data.object);
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return applyCheckoutPaid(client, object);
    case 'checkout.session.async_payment_failed':
      return applyCheckoutClosed(client, object, 'failed');
    case 'checkout.session.expired':
      return applyCheckoutClosed(client, object, 'canceled');
    case 'payment_intent.succeeded':
      return applyPaymentIntentSucceeded(client, object);
    case 'payment_intent.payment_failed':
      return applyPaymentIntentClosed(client, object, 'failed');
    case 'payment_intent.canceled':
      return applyPaymentIntentClosed(client, object, 'canceled');
    case 'refund.created':
    case 'refund.updated':
      return applyRefund(client, object);
    case 'refund.failed':
      return applyRefundFailed(client, object);
    default: {
      const unexpected: never = event.type;
      return unexpected;
    }
  }
}

async function applyCheckoutPaid(client: pg.PoolClient, object: Record<string, unknown>): Promise<ApplyResult> {
  const paymentStatus = stringField(object, 'payment_status');
  if (!paidSession(paymentStatus)) {
    return { status: 'ignored', error: null };
  }
  const amount = numberField(object, 'amount_total');
  const currency = stringField(object, 'currency')?.toLowerCase() ?? null;
  if (amount === null || !currency) {
    return { status: 'failed', error: 'Checkout session is missing amount_total or currency' };
  }
  const payment = await findPayment(client, {
    paymentId: metadataId(object, 'payment_id') ?? stringField(object, 'client_reference_id'),
    checkoutSessionId: stringField(object, 'id'),
    paymentIntentId: idField(object, 'payment_intent'),
  });
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'Checkout session does not match a local payment');
  }
  try {
    await fulfillCapturedPayment(client, {
      paymentId: payment.id,
      amountCents: amount,
      currency,
      checkoutSessionId: stringField(object, 'id'),
      paymentIntentId: idField(object, 'payment_intent'),
    });
    return { status: 'processed', error: null };
  } catch (err) {
    if (err instanceof AppError && err.code === 'amount_mismatch') {
      return { status: 'failed', error: err.message };
    }
    throw err;
  }
}

async function applyCheckoutClosed(
  client: pg.PoolClient,
  object: Record<string, unknown>,
  status: 'failed' | 'canceled',
): Promise<ApplyResult> {
  const payment = await findPayment(client, {
    paymentId: metadataId(object, 'payment_id') ?? stringField(object, 'client_reference_id'),
    checkoutSessionId: stringField(object, 'id'),
    paymentIntentId: idField(object, 'payment_intent'),
  });
  if (!payment) {
    return { status: 'ignored', error: null };
  }
  await markPaymentClosed(client, payment.id, status);
  return { status: 'processed', error: null };
}

async function applyPaymentIntentSucceeded(client: pg.PoolClient, object: Record<string, unknown>): Promise<ApplyResult> {
  const amount = numberField(object, 'amount_received') ?? numberField(object, 'amount');
  const currency = stringField(object, 'currency')?.toLowerCase() ?? null;
  if (amount === null || !currency) {
    return { status: 'failed', error: 'PaymentIntent is missing an amount or currency' };
  }
  const payment = await findPayment(client, {
    paymentId: metadataId(object, 'payment_id'),
    checkoutSessionId: null,
    paymentIntentId: stringField(object, 'id'),
  });
  if (!payment) {
    throw new AppError(404, 'payment_not_found', 'PaymentIntent does not match a local payment');
  }
  try {
    await fulfillCapturedPayment(client, {
      paymentId: payment.id,
      amountCents: amount,
      currency,
      checkoutSessionId: null,
      paymentIntentId: stringField(object, 'id'),
    });
    return { status: 'processed', error: null };
  } catch (err) {
    if (err instanceof AppError && err.code === 'amount_mismatch') {
      return { status: 'failed', error: err.message };
    }
    throw err;
  }
}

async function applyPaymentIntentClosed(
  client: pg.PoolClient,
  object: Record<string, unknown>,
  status: 'failed' | 'canceled',
): Promise<ApplyResult> {
  const payment = await findPayment(client, {
    paymentId: metadataId(object, 'payment_id'),
    checkoutSessionId: null,
    paymentIntentId: stringField(object, 'id'),
  });
  if (!payment) {
    return { status: 'ignored', error: null };
  }
  await markPaymentClosed(client, payment.id, status);
  return { status: 'processed', error: null };
}

async function applyRefund(client: pg.PoolClient, object: Record<string, unknown>): Promise<ApplyResult> {
  const status = stringField(object, 'status');
  if (status !== 'succeeded') {
    return { status: 'ignored', error: null };
  }
  const stripeRefundId = stringField(object, 'id');
  const amount = numberField(object, 'amount');
  const currency = stringField(object, 'currency')?.toLowerCase() ?? null;
  const paymentIntentId = idField(object, 'payment_intent');
  if (!stripeRefundId || amount === null || !currency) {
    return { status: 'failed', error: 'Refund event is missing id, amount, or currency' };
  }
  const localId = metadataId(object, 'refund_id');
  let refund = localId ? await getRefund(client, localId) : await findRefundByStripeId(client, stripeRefundId);
  if (!refund) {
    const payment = await findPayment(client, {
      paymentId: metadataId(object, 'payment_id'),
      checkoutSessionId: null,
      paymentIntentId,
    });
    if (!payment) {
      throw new AppError(404, 'payment_not_found', 'Refund does not match a local payment');
    }
    refund = await ensureExternalRefund(client, {
      paymentId: payment.id,
      stripeRefundId,
      amountCents: amount,
      currency,
      reason: stringField(object, 'reason'),
    });
  }
  try {
    await settleSucceededRefund(client, {
      refundId: refund.id,
      stripeRefundId,
      amountCents: amount,
      currency,
    });
    return { status: 'processed', error: null };
  } catch (err) {
    if (err instanceof AppError && err.code === 'amount_mismatch') {
      return { status: 'failed', error: err.message };
    }
    throw err;
  }
}

async function applyRefundFailed(client: pg.PoolClient, object: Record<string, unknown>): Promise<ApplyResult> {
  const stripeRefundId = stringField(object, 'id');
  const localId = metadataId(object, 'refund_id');
  if (localId) {
    await client.query(
      `UPDATE refunds SET status = 'failed', stripe_refund_id = COALESCE(stripe_refund_id, $2)
       WHERE id = $1 AND status = 'pending'`,
      [localId, stripeRefundId],
    );
  } else if (stripeRefundId) {
    await client.query(
      `UPDATE refunds SET status = 'failed' WHERE stripe_refund_id = $1 AND status = 'pending'`,
      [stripeRefundId],
    );
  }
  return { status: 'processed', error: null };
}
