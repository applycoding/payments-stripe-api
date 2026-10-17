import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalBalance, paymentStatusAfterRefund } from '../../src/domain.js';
import { AppError } from '../../src/errors.js';
import { hashRequest } from '../../src/idempotency.js';
import { assertBalanced, type JournalLineInput } from '../../src/ledger.js';
import { createIntegrationIdentifier } from '../../src/stripe-gateway.js';

function lines(amount: number): JournalLineInput[] {
  return [
    {
      accountCode: 'cash:stripe:usd',
      accountName: 'Cash at Stripe',
      accountType: 'asset',
      direction: 'debit',
      amountCents: amount,
      currency: 'usd',
    },
    {
      accountCode: 'revenue:usd',
      accountName: 'Revenue',
      accountType: 'income',
      direction: 'credit',
      amountCents: amount,
      currency: 'usd',
    },
  ];
}

describe('ledger planning', () => {
  it('accepts a balanced capture', () => {
    assert.doesNotThrow(() => assertBalanced(lines(2500)));
  });

  it('rejects an unbalanced entry', () => {
    const broken = lines(2500);
    const credit = broken[1];
    assert.ok(credit);
    credit.amountCents = 2400;
    assert.throws(
      () => assertBalanced(broken),
      (err: unknown) => err instanceof AppError && err.code === 'unbalanced_entry',
    );
  });

  it('uses the normal balance for each account type', () => {
    assert.equal(normalBalance('asset', 5000, 2000), 3000);
    assert.equal(normalBalance('expense', 2000, 0), 2000);
    assert.equal(normalBalance('income', 0, 5000), 5000);
    assert.equal(normalBalance('liability', 100, 400), 300);
    assert.equal(normalBalance('equity', 0, 50), 50);
  });

  it('derives refund status from the refunded total', () => {
    assert.equal(paymentStatusAfterRefund(0, 5000), 'succeeded');
    assert.equal(paymentStatusAfterRefund(2000, 5000), 'partially_refunded');
    assert.equal(paymentStatusAfterRefund(5000, 5000), 'refunded');
  });
});

describe('idempotency hash', () => {
  it('is stable when object keys arrive in a different order', () => {
    const left = hashRequest('POST', '/v1/checkout/sessions', { amount_cents: 100, currency: 'usd' });
    const right = hashRequest('POST', '/v1/checkout/sessions', { currency: 'usd', amount_cents: 100 });
    assert.equal(left, right);
  });

  it('changes when the path or body changes', () => {
    const base = hashRequest('POST', '/v1/checkout/sessions', { amount_cents: 100 });
    assert.notEqual(base, hashRequest('POST', '/v1/payment-intents', { amount_cents: 100 }));
    assert.notEqual(base, hashRequest('POST', '/v1/checkout/sessions', { amount_cents: 101 }));
  });
});

describe('integration identifier', () => {
  it('tags Checkout with an 8-letter suffix', () => {
    const identifier = createIntegrationIdentifier();
    assert.match(identifier, /^payments_api_[a-z]{8}$/);
  });
});
