import { randomInt } from 'node:crypto';
import Stripe from 'stripe';
import { STRIPE_API_VERSION, type Config } from './config.js';
import { RetryableError, withRetry } from './retry.js';

export type CheckoutSessionResult = {
  id: string;
  url: string;
  paymentIntentId: string | null;
  amountTotal: number;
  currency: string;
};

export type PaymentIntentResult = {
  id: string;
  clientSecret: string;
  status: string;
  amount: number;
  currency: string;
};

export type RefundResult = {
  id: string;
  status: 'succeeded' | 'pending' | 'failed' | 'canceled';
  amount: number;
  currency: string;
  paymentIntentId: string;
};

export type ListedStripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  object: Record<string, unknown>;
};

export type CreateCheckoutInput = {
  paymentId: string;
  amountCents: number;
  currency: string;
  description: string;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
};

export type CreatePaymentIntentInput = {
  paymentId: string;
  amountCents: number;
  currency: string;
  description: string;
  customerEmail: string | null;
};

export type CreateRefundInput = {
  refundId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  reason: 'duplicate' | 'fraudulent' | 'requested_by_customer' | null;
};

export interface StripeGateway {
  createCheckoutSession(input: CreateCheckoutInput, idempotencyKey: string): Promise<CheckoutSessionResult>;
  createPaymentIntent(input: CreatePaymentIntentInput, idempotencyKey: string): Promise<PaymentIntentResult>;
  createRefund(input: CreateRefundInput, idempotencyKey: string): Promise<RefundResult>;
  listEvents(input: { createdGte: number; types: string[] }): Promise<ListedStripeEvent[]>;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function createIntegrationIdentifier(): string {
  let suffix = '';
  for (let i = 0; i < 8; i += 1) {
    suffix += LETTERS.charAt(randomInt(LETTERS.length));
  }
  return `payments_api_${suffix}`;
}

const STRIPE_RETRY = { maxAttempts: 3, baseMs: 200, maxMs: 2_000, jitterRatio: 0.2 };

function idFrom(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'id' in value && typeof (value as { id: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

export class FakeStripeGateway implements StripeGateway {
  readonly checkouts = new Map<string, CheckoutSessionResult>();
  readonly paymentIntents = new Map<string, PaymentIntentResult>();
  readonly paymentIntentsByKey = new Map<string, PaymentIntentResult>();
  readonly refunds = new Map<string, RefundResult>();
  readonly events: ListedStripeEvent[] = [];
  failNext: Error | null = null;

  reset(): void {
    this.checkouts.clear();
    this.paymentIntents.clear();
    this.paymentIntentsByKey.clear();
    this.refunds.clear();
    this.events.length = 0;
    this.failNext = null;
  }

  pushEvent(event: ListedStripeEvent): void {
    this.events.push(event);
  }

  private consumeFailure(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async createCheckoutSession(input: CreateCheckoutInput, idempotencyKey: string): Promise<CheckoutSessionResult> {
    this.consumeFailure();
    const existing = this.checkouts.get(idempotencyKey);
    if (existing) {
      return existing;
    }
    const slug = idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'session';
    const paymentIntentId = `pi_test_${slug}`;
    const created: CheckoutSessionResult = {
      id: `cs_test_${slug}`,
      url: `https://checkout.stripe.com/c/pay/cs_test_${slug}`,
      paymentIntentId,
      amountTotal: input.amountCents,
      currency: input.currency,
    };
    this.checkouts.set(idempotencyKey, created);
    this.paymentIntents.set(paymentIntentId, {
      id: paymentIntentId,
      clientSecret: `${paymentIntentId}_secret_test`,
      status: 'requires_payment_method',
      amount: input.amountCents,
      currency: input.currency,
    });
    return created;
  }

  async createPaymentIntent(input: CreatePaymentIntentInput, idempotencyKey: string): Promise<PaymentIntentResult> {
    this.consumeFailure();
    const existing = this.paymentIntentsByKey.get(idempotencyKey);
    if (existing) {
      return existing;
    }
    const slug = idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'intent';
    const created: PaymentIntentResult = {
      id: `pi_test_${slug}`,
      clientSecret: `pi_test_${slug}_secret_test`,
      status: 'requires_payment_method',
      amount: input.amountCents,
      currency: input.currency,
    };
    this.paymentIntents.set(created.id, created);
    this.paymentIntentsByKey.set(idempotencyKey, created);
    return created;
  }

  async createRefund(input: CreateRefundInput, idempotencyKey: string): Promise<RefundResult> {
    this.consumeFailure();
    const existing = this.refunds.get(idempotencyKey);
    if (existing) {
      return existing;
    }
    const intent = this.paymentIntents.get(input.paymentIntentId);
    if (!intent) {
      throw new Error(`Unknown payment intent ${input.paymentIntentId}`);
    }
    const slug = idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'refund';
    const created: RefundResult = {
      id: `re_test_${slug}`,
      status: 'succeeded',
      amount: input.amountCents,
      currency: intent.currency,
      paymentIntentId: input.paymentIntentId,
    };
    this.refunds.set(idempotencyKey, created);
    return created;
  }

  async listEvents(input: { createdGte: number; types: string[] }): Promise<ListedStripeEvent[]> {
    const allowed = new Set(input.types);
    return this.events.filter((event) => event.created >= input.createdGte && allowed.has(event.type));
  }
}

export class StripeTestGateway implements StripeGateway {
  private readonly client: Stripe;

  constructor(apiKey: string) {
    this.client = new Stripe(apiKey, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      maxNetworkRetries: 0,
      appInfo: {
        name: 'payments-stripe-api',
        url: 'https://github.com/applycoding/payments-stripe-api',
      },
    });
  }

  async createCheckoutSession(input: CreateCheckoutInput, idempotencyKey: string): Promise<CheckoutSessionResult> {
    const session = await withRetry(
      () =>
        this.client.checkout.sessions.create(
          {
            mode: 'payment',
            client_reference_id: input.paymentId,
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            metadata: { payment_id: input.paymentId },
            integration_identifier: createIntegrationIdentifier(),
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: input.currency,
                  unit_amount: input.amountCents,
                  product_data: { name: input.description },
                },
              },
            ],
            ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
          },
          { idempotencyKey },
        ),
      STRIPE_RETRY,
    );
    if (!session.url) {
      throw new Error('Stripe Checkout did not return a URL');
    }
    return {
      id: session.id,
      url: session.url,
      paymentIntentId: idFrom(session.payment_intent),
      amountTotal: session.amount_total ?? input.amountCents,
      currency: session.currency ?? input.currency,
    };
  }

  async createPaymentIntent(input: CreatePaymentIntentInput, idempotencyKey: string): Promise<PaymentIntentResult> {
    const intent = await withRetry(
      () =>
        this.client.paymentIntents.create(
          {
            amount: input.amountCents,
            currency: input.currency,
            description: input.description,
            metadata: { payment_id: input.paymentId },
            ...(input.customerEmail ? { receipt_email: input.customerEmail } : {}),
          },
          { idempotencyKey },
        ),
      STRIPE_RETRY,
    );
    if (!intent.client_secret) {
      throw new Error('Stripe PaymentIntent did not return a client secret');
    }
    return {
      id: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
    };
  }

  async createRefund(input: CreateRefundInput, idempotencyKey: string): Promise<RefundResult> {
    const refund = await withRetry(
      () =>
        this.client.refunds.create(
          {
            payment_intent: input.paymentIntentId,
            amount: input.amountCents,
            metadata: { refund_id: input.refundId, payment_id: input.paymentId },
            ...(input.reason ? { reason: input.reason } : {}),
          },
          { idempotencyKey },
        ),
      STRIPE_RETRY,
    );
    const paymentIntentId = idFrom(refund.payment_intent);
    if (!paymentIntentId) {
      throw new Error('Stripe Refund did not reference a payment intent');
    }
    const status = refund.status ?? 'pending';
    return {
      id: refund.id,
      status: status === 'succeeded' || status === 'failed' || status === 'canceled' ? status : 'pending',
      amount: refund.amount,
      currency: refund.currency,
      paymentIntentId,
    };
  }

  async listEvents(input: { createdGte: number; types: string[] }): Promise<ListedStripeEvent[]> {
    const events = await withRetry(
      () =>
        this.client.events
          .list({
            created: { gte: input.createdGte },
            types: input.types,
            limit: 100,
          })
          .autoPagingToArray({ limit: 1000 }),
      STRIPE_RETRY,
    );
    return events.map((event) => ({
      id: event.id,
      type: event.type,
      created: event.created,
      livemode: event.livemode,
      object: event.data.object as unknown as Record<string, unknown>,
    }));
  }
}

export function createStripeGateway(config: Config): StripeGateway {
  if (config.stripeMode === 'fake') {
    return new FakeStripeGateway();
  }
  return new StripeTestGateway(config.stripeApiKey);
}
