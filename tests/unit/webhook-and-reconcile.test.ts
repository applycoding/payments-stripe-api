import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Stripe from 'stripe';
import { AppError } from '../../src/errors.js';
import { cashDiscrepancies, diffMovements, projectStripeMovements, type Movement } from '../../src/reconcile.js';
import type { ListedStripeEvent } from '../../src/stripe-gateway.js';
import { assertTestModeEvent, verifyStripeEvent } from '../../src/webhooks.js';

const SECRET = 'whsec_dev_only_placeholder';

function event(type: string, object: Record<string, unknown>, created: number, id: string): ListedStripeEvent {
  return { id, type, created, livemode: false, object };
}

describe('webhook signatures', () => {
  it('accepts a signature from the Stripe helper', () => {
    const payload = JSON.stringify({
      id: 'evt_unit_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_unit_1' } },
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    const verified = verifyStripeEvent(Buffer.from(payload), header, SECRET);
    assert.equal(verified.id, 'evt_unit_1');
  });

  it('rejects a tampered payload', () => {
    const payload = JSON.stringify({ id: 'evt_unit_2', livemode: false });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    assert.throws(
      () => verifyStripeEvent(Buffer.from(`${payload} `), header, SECRET),
      (err: unknown) => err instanceof AppError && err.code === 'invalid_signature',
    );
  });

  it('rejects live-mode events', () => {
    assert.throws(
      () => assertTestModeEvent({ livemode: true }),
      (err: unknown) => err instanceof AppError && err.code === 'live_mode_rejected',
    );
  });
});

describe('reconciliation diff', () => {
  it('ignores unpaid checkout and collapses a matching PaymentIntent', () => {
    const projected = projectStripeMovements([
      event('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'unpaid',
        amount_total: 2500,
        currency: 'usd',
        payment_intent: 'pi_1',
      }, 10, 'evt_1'),
      event('checkout.session.async_payment_succeeded', {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 2500,
        currency: 'usd',
        payment_intent: 'pi_1',
      }, 20, 'evt_2'),
      event('payment_intent.succeeded', {
        id: 'pi_1',
        amount_received: 2500,
        currency: 'usd',
      }, 30, 'evt_3'),
      event('refund.updated', {
        id: 're_1',
        status: 'succeeded',
        amount: 500,
        currency: 'usd',
      }, 40, 'evt_4'),
      event('refund.failed', {
        id: 're_1',
        status: 'failed',
        amount: 500,
        currency: 'usd',
      }, 50, 'evt_5'),
    ]);
    assert.deepEqual(projected.captures, [{ kind: 'capture', key: 'pi_1', amountCents: 2500, currency: 'usd' }]);
    assert.deepEqual(projected.refunds, []);
    assert.deepEqual(projected.conflicts, []);
  });

  it('reports missing ledger rows, amount mismatches, and cash drift', () => {
    const expected: Movement[] = [{ kind: 'capture', key: 'pi_1', amountCents: 2500, currency: 'usd' }];
    const actual: Movement[] = [{ kind: 'capture', key: 'pi_2', amountCents: 2500, currency: 'usd' }];
    const discrepancies = diffMovements(expected, actual);
    assert.deepEqual(
      discrepancies.map((item) => item.type),
      ['missing_in_ledger', 'missing_in_stripe'],
    );
    const mismatch = diffMovements(expected, [{ kind: 'capture', key: 'pi_1', amountCents: 2000, currency: 'usd' }]);
    assert.equal(mismatch[0]?.type, 'amount_mismatch');
    const cash = cashDiscrepancies(
      [{ kind: 'capture', key: 'pi_1', amountCents: 5000, currency: 'usd' }],
      [{ kind: 'refund', key: 're_1', amountCents: 2000, currency: 'usd' }],
      [{ currency: 'usd', balanceCents: 3000 }],
    );
    assert.deepEqual(cash, []);
    const drifted = cashDiscrepancies(
      [{ kind: 'capture', key: 'pi_1', amountCents: 5000, currency: 'usd' }],
      [],
      [{ currency: 'usd', balanceCents: 0 }],
    );
    assert.equal(drifted[0]?.type, 'cash_balance_mismatch');
  });
});
