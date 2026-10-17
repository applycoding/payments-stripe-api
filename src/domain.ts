import { AppError } from './errors.js';

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'canceled',
  'refunded',
  'partially_refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentKind = 'checkout' | 'payment_intent';

export const REFUND_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type Direction = 'debit' | 'credit';

export const MAX_AMOUNT_CENTS = 100_000_000;

export function assertMoney(amountCents: number, currency: string): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    throw new AppError(
      400,
      'invalid_amount',
      `amount_cents must be a positive integer up to ${MAX_AMOUNT_CENTS}`,
    );
  }
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new AppError(400, 'invalid_currency', 'currency must be a lowercase ISO 4217 code');
  }
}

export function normalBalance(accountType: AccountType, debitCents: number, creditCents: number): number {
  switch (accountType) {
    case 'asset':
    case 'expense':
      return debitCents - creditCents;
    case 'liability':
    case 'equity':
    case 'income':
      return creditCents - debitCents;
    default: {
      const unexpected: never = accountType;
      return unexpected;
    }
  }
}

export function paymentStatusAfterRefund(
  refundedCents: number,
  paymentAmountCents: number,
): 'succeeded' | 'partially_refunded' | 'refunded' {
  if (refundedCents <= 0) {
    return 'succeeded';
  }
  if (refundedCents >= paymentAmountCents) {
    return 'refunded';
  }
  return 'partially_refunded';
}

export function cashAccountCode(currency: string): string {
  return `cash:stripe:${currency}`;
}

export function revenueAccountCode(currency: string): string {
  return `revenue:${currency}`;
}

export function refundsAccountCode(currency: string): string {
  return `refunds:${currency}`;
}
