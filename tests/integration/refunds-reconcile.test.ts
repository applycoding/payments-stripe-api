import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RetryableError } from '../../src/retry.js';
import { drainOutbox } from '../../src/outbox.js';
import {
  JOB_TOKEN,
  captureCheckout,
  deliver,
  installDatabase,
  postCheckout,
  stripeEvent,
  type PaymentBody,
  type RefundBody,
  type TestContext,
} from './helpers.js';

describe('refunds, outbox, and reconciliation', () => {
  const ctx = {} as TestContext;
  installDatabase(ctx);

  async function capturedPayment(amountCents: number, key: string): Promise<PaymentBody> {
    const created = await postCheckout(ctx.app, key, { amount_cents: amountCents });
    assert.equal(created.statusCode, 201, created.body);
    const payment = created.json() as PaymentBody;
    await captureCheckout(ctx, payment);
    return payment;
  }

  it('refunds partially and then in full, and ignores a duplicate refund webhook', async () => {
    const payment = await capturedPayment(5000, 'checkout-refund-1');
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/refunds`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-partial-1' },
      payload: { amount_cents: 2000, reason: 'requested_by_customer' },
    });
    assert.equal(first.statusCode, 201, first.body);
    const partial = first.json() as RefundBody;
    assert.equal(partial.status, 'succeeded');
    assert.ok(partial.stripe_refund_id);

    const afterPartial = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal((afterPartial.json() as PaymentBody).status, 'partially_refunded');

    const webhook = await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('refund.updated', {
        id: partial.stripe_refund_id,
        object: 'refund',
        amount: 2000,
        currency: 'usd',
        status: 'succeeded',
        payment_intent: payment.stripe_payment_intent_id,
        metadata: { refund_id: partial.id, payment_id: payment.id },
      }),
    );
    assert.equal((webhook.json() as { outcome: string }).outcome, 'processed');

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/refunds`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-rest-1' },
      payload: { amount_cents: 3000 },
    });
    assert.equal(second.statusCode, 201, second.body);
    const closed = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal((closed.json() as PaymentBody).status, 'refunded');

    const extra = await ctx.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment.id}/refunds`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'refund-too-much' },
      payload: { amount_cents: 1 },
    });
    assert.equal(extra.statusCode, 409);
    assert.equal((extra.json() as { error: { code: string } }).error.code, 'refund_exceeds_balance');

    const trial = await ctx.app.inject({ method: 'GET', url: '/v1/ledger/trial-balance' });
    const balance = trial.json() as {
      balanced: boolean;
      total_debit_cents: number;
      total_credit_cents: number;
      accounts: Array<{ code: string; balance_cents: number }>;
    };
    assert.equal(balance.balanced, true);
    assert.equal(balance.total_debit_cents, balance.total_credit_cents);
    const cash = balance.accounts.find((account) => account.code === 'cash:stripe:usd');
    assert.equal(cash?.balance_cents, 0);
    const entries = await ctx.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM journal_entries WHERE source_type = 'refund'`,
    );
    assert.equal(entries.rows[0]?.count, 2);
  });

  it('publishes the outbox with backoff after a failed attempt', async () => {
    await capturedPayment(1500, 'checkout-outbox-1');
    const pending = await ctx.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM outbox WHERE published_at IS NULL',
    );
    assert.equal(pending.rows[0]?.count, 1);

    let calls = 0;
    const first = await drainOutbox(ctx.pool, {
      handler: async () => {
        calls += 1;
        throw new RetryableError('subscriber down');
      },
    });
    assert.equal(first.failed, 1);
    assert.equal(calls, 1);

    const skipped = await drainOutbox(ctx.pool, {
      handler: async () => {
        calls += 1;
      },
    });
    assert.equal(skipped.published, 0);
    assert.equal(calls, 1);

    await ctx.pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second'`);
    const drained = await ctx.app.inject({
      method: 'POST',
      url: '/v1/jobs/outbox/drain',
      headers: { 'x-job-token': JOB_TOKEN },
    });
    assert.equal(drained.statusCode, 200, drained.body);
    assert.equal((drained.json() as { published: number }).published, 1);
    const published = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM published_events');
    assert.equal(published.rows[0]?.count, 1);

    const unauthorized = await ctx.app.inject({ method: 'POST', url: '/v1/jobs/outbox/drain' });
    assert.equal(unauthorized.statusCode, 401);
  });

  it('reconciles the ledger against Stripe events and flags a missing capture', async () => {
    const payment = await capturedPayment(2500, 'checkout-recon-1');
    const clean = await ctx.app.inject({
      method: 'POST',
      url: '/v1/jobs/reconcile',
      headers: { 'x-job-token': JOB_TOKEN },
    });
    assert.equal(clean.statusCode, 200, clean.body);
    const cleanBody = clean.json() as { discrepancy_count: number; id: string; stripe_capture_count: number };
    assert.equal(cleanBody.discrepancy_count, 0);
    assert.equal(cleanBody.stripe_capture_count, 1);

    const stored = await ctx.app.inject({ method: 'GET', url: `/v1/reconciliations/${cleanBody.id}` });
    assert.equal(stored.statusCode, 200);

    ctx.fake.pushEvent({
      id: 'evt_orphan_capture',
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      object: {
        id: 'pi_test_orphan',
        object: 'payment_intent',
        amount: 800,
        amount_received: 800,
        currency: 'usd',
      },
    });
    const dirty = await ctx.app.inject({
      method: 'POST',
      url: '/v1/jobs/reconcile',
      headers: { 'x-job-token': JOB_TOKEN },
    });
    const dirtyBody = dirty.json() as { discrepancy_count: number; discrepancies: Array<{ type: string; key?: string }> };
    assert.ok(dirtyBody.discrepancy_count >= 1);
    assert.ok(dirtyBody.discrepancies.some((item) => item.type === 'missing_in_ledger' && item.key === 'pi_test_orphan'));
    assert.equal(payment.status, 'succeeded');
  });
});
