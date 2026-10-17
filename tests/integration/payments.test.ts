import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  installDatabase,
  postCheckout,
  type PaymentBody,
  type TestContext,
} from './helpers.js';

describe('checkout and payment intents', () => {
  const ctx = {} as TestContext;
  installDatabase(ctx);

  it('serves health and the OpenAPI document', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok', stripe_mode: 'fake' });

    const spec = await ctx.app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(spec.statusCode, 200);
    const document = spec.json() as { paths: Record<string, unknown> };
    assert.ok(document.paths['/v1/checkout/sessions']);
    assert.ok(document.paths['/v1/payment-intents']);
    assert.ok(document.paths['/v1/webhooks/stripe']);
  });

  it('creates a Checkout session and replays the same idempotency key', async () => {
    const created = await postCheckout(ctx.app, 'checkout-key-001');
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers['idempotency-replayed'], 'false');
    const payment = created.json() as PaymentBody;
    assert.equal(payment.status, 'pending');
    assert.equal(payment.kind, 'checkout');
    assert.equal(payment.amount_cents, 2500);
    assert.ok(payment.checkout_url?.startsWith('https://checkout.stripe.com/'));
    assert.ok(payment.stripe_payment_intent_id);

    const replay = await postCheckout(ctx.app, 'checkout-key-001');
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.headers['idempotency-replayed'], 'true');
    assert.equal((replay.json() as PaymentBody).id, payment.id);
    assert.equal(ctx.fake.checkouts.size, 1);

    const conflict = await postCheckout(ctx.app, 'checkout-key-001', { amount_cents: 2600 });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { error: { code: string } }).error.code, 'idempotency_key_reused');

    const again = await postCheckout(ctx.app, 'checkout-key-001');
    assert.equal((again.json() as PaymentBody).id, payment.id);
  });

  it('requires an idempotency key and rejects an invalid body', async () => {
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { 'content-type': 'application/json' },
      payload: {
        amount_cents: 100,
        currency: 'usd',
        description: 'Missing key',
        success_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel',
      },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal((missing.json() as { error: { code: string } }).error.code, 'idempotency_key_required');

    const invalid = await postCheckout(ctx.app, 'checkout-key-bad', { currency: 'US' });
    assert.equal(invalid.statusCode, 400);
    assert.equal((invalid.json() as { error: { code: string } }).error.code, 'validation_error');
  });

  it('creates a PaymentIntent and lists it', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/payment-intents',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'pi-key-001',
      },
      payload: {
        amount_cents: 1800,
        currency: 'usd',
        description: 'Off-session invoice',
        customer_email: 'buyer@example.com',
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const payment = response.json() as PaymentBody;
    assert.equal(payment.kind, 'payment_intent');
    assert.ok(payment.client_secret?.endsWith('_secret_test'));
    assert.ok(payment.stripe_payment_intent_id);

    const listed = await ctx.app.inject({ method: 'GET', url: '/v1/payments' });
    assert.equal(listed.statusCode, 200);
    const body = listed.json() as { payments: PaymentBody[] };
    assert.equal(body.payments.length, 1);
    assert.equal(body.payments[0]?.id, payment.id);

    const fetched = await ctx.app.inject({ method: 'GET', url: `/v1/payments/${payment.id}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal((fetched.json() as PaymentBody).status, 'pending');
  });
});
