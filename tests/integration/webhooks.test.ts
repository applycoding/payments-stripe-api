import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Stripe from 'stripe';
import {
  WEBHOOK_SECRET,
  captureCheckout,
  deliver,
  installDatabase,
  postCheckout,
  stripeEvent,
  type PaymentBody,
  type TestContext,
} from './helpers.js';

describe('stripe webhooks', () => {
  const ctx = {} as TestContext;
  installDatabase(ctx);

  it('rejects a bad signature and a live-mode event', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1,v1=deadbeef',
      },
      payload: JSON.stringify({ id: 'evt_bad', livemode: false }),
    });
    assert.equal(bad.statusCode, 400);
    assert.equal((bad.json() as { error: { code: string } }).error.code, 'invalid_signature');

    const live = stripeEvent('payment_intent.succeeded', {
      id: 'pi_live',
      object: 'payment_intent',
      amount: 100,
      amount_received: 100,
      currency: 'usd',
    });
    live.livemode = true;
    const payload = JSON.stringify(live);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    const rejected = await ctx.app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload,
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal((rejected.json() as { error: { code: string } }).error.code, 'live_mode_rejected');
  });

  it('posts a balanced capture once, including a duplicate delivery', async () => {
    const created = await postCheckout(ctx.app, 'checkout-capture-1', { amount_cents: 4200 });
    const payment = created.json() as PaymentBody;
    await captureCheckout(ctx, payment);

    const journal = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}/journal` });
    const entries = (journal.json() as { entries: Array<{ lines: Array<{ direction: string; amount_cents: number; account_code: string }> }> }).entries;
    assert.equal(entries.length, 1);
    const lines = entries[0]?.lines ?? [];
    const debit = lines.find((line) => line.direction === 'debit');
    const credit = lines.find((line) => line.direction === 'credit');
    assert.equal(debit?.account_code, 'cash:stripe:usd');
    assert.equal(debit?.amount_cents, 4200);
    assert.equal(credit?.account_code, 'revenue:usd');
    assert.equal(credit?.amount_cents, 4200);

    const trial = await ctx.app.inject({ method: 'GET', url: '/v1/ledger/trial-balance' });
    const balance = trial.json() as { balanced: boolean; total_debit_cents: number; total_credit_cents: number };
    assert.equal(balance.balanced, true);
    assert.equal(balance.total_debit_cents, 4200);
    assert.equal(balance.total_credit_cents, 4200);

    assert.ok(payment.stripe_checkout_session_id);
    assert.ok(payment.stripe_payment_intent_id);
    const duplicate = await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('checkout.session.completed', {
        id: payment.stripe_checkout_session_id,
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 4200,
        currency: 'usd',
        payment_intent: payment.stripe_payment_intent_id,
        metadata: { payment_id: payment.id },
      }),
    );
    assert.equal(duplicate.statusCode, 200);
    assert.equal((duplicate.json() as { duplicate: boolean }).duplicate, true);
    const count = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM journal_entries');
    assert.equal(count.rows[0]?.count, 1);
  });

  it('waits for async payment success before booking revenue', async () => {
    const created = await postCheckout(ctx.app, 'checkout-async-1');
    const payment = created.json() as PaymentBody;
    assert.ok(payment.stripe_checkout_session_id);
    assert.ok(payment.stripe_payment_intent_id);
    const session = {
      id: payment.stripe_checkout_session_id,
      object: 'checkout.session',
      amount_total: payment.amount_cents,
      currency: 'usd',
      payment_intent: payment.stripe_payment_intent_id,
      metadata: { payment_id: payment.id },
    };
    const pending = await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('checkout.session.completed', { ...session, payment_status: 'unpaid' }),
    );
    assert.equal((pending.json() as { outcome: string }).outcome, 'ignored');
    const stillPending = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal((stillPending.json() as PaymentBody).status, 'pending');

    const paid = await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' }),
    );
    assert.equal((paid.json() as { outcome: string }).outcome, 'processed');
    const succeeded = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal((succeeded.json() as PaymentBody).status, 'succeeded');
  });

  it('captures and fails PaymentIntents from webhooks', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'pi-capture-1' },
      payload: { amount_cents: 900, currency: 'usd', description: 'Usage charge' },
    });
    const payment = created.json() as PaymentBody;
    assert.ok(payment.stripe_payment_intent_id);
    const captured = await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('payment_intent.succeeded', {
        id: payment.stripe_payment_intent_id,
        object: 'payment_intent',
        amount: 900,
        amount_received: 900,
        currency: 'usd',
        metadata: { payment_id: payment.id },
      }),
    );
    assert.equal((captured.json() as { outcome: string }).outcome, 'processed');
    const fetched = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal((fetched.json() as PaymentBody).status, 'succeeded');

    const other = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'pi-fail-1' },
      payload: { amount_cents: 700, currency: 'usd', description: 'Declined charge' },
    });
    const failedPayment = other.json() as PaymentBody;
    assert.ok(failedPayment.stripe_payment_intent_id);
    await deliver(
      ctx.app,
      ctx.fake,
      stripeEvent('payment_intent.payment_failed', {
        id: failedPayment.stripe_payment_intent_id,
        object: 'payment_intent',
        amount: 700,
        currency: 'usd',
        metadata: { payment_id: failedPayment.id },
      }),
    );
    const failed = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${failedPayment.id}` });
    assert.equal((failed.json() as PaymentBody).status, 'failed');
  });
});
