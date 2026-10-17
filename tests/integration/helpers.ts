import assert from 'node:assert/strict';
import { after, before, beforeEach } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import Stripe from 'stripe';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool, migrate } from '../../src/db.js';
import { FakeStripeGateway, type ListedStripeEvent } from '../../src/stripe-gateway.js';

export const WEBHOOK_SECRET = 'whsec_dev_only_placeholder';
export const JOB_TOKEN = 'ci-job-token';

export type PaymentBody = {
  id: string;
  kind: string;
  status: string;
  amount_cents: number;
  currency: string;
  checkout_url: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  client_secret: string | null;
};

export type RefundBody = {
  id: string;
  payment_id: string;
  status: string;
  amount_cents: number;
  stripe_refund_id: string | null;
};

export type TestContext = {
  config: Config;
  pool: pg.Pool;
  app: FastifyInstance;
  fake: FakeStripeGateway;
};

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

type StripeEventFixture = {
  id: string;
  object: 'event';
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

export function installDatabase(ctx: TestContext): void {
  before(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required for integration tests');
    }
    ctx.config = loadConfig({
      DATABASE_URL: databaseUrl,
      STRIPE_MODE: 'fake',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      JOB_TOKEN,
      ENABLE_SCHEDULER: 'false',
      ENABLE_OUTBOX_POLLER: 'false',
      LOG: 'false',
    });
    ctx.pool = createPool(ctx.config.databaseUrl);
    await migrate(ctx.pool);
    ctx.fake = new FakeStripeGateway();
    ctx.app = await buildApp({
      config: ctx.config,
      pool: ctx.pool,
      stripe: ctx.fake,
      logger: false,
    });
  });

  beforeEach(async () => {
    await ctx.pool.query(`
      TRUNCATE TABLE
        published_events,
        outbox,
        journal_lines,
        journal_entries,
        refunds,
        payments,
        stripe_events,
        idempotency_keys,
        reconciliation_runs,
        ledger_accounts
      RESTART IDENTITY CASCADE
    `);
    ctx.fake.reset();
  });

  after(async () => {
    if (ctx.app) {
      await ctx.app.close();
    }
    if (ctx.pool) {
      await ctx.pool.end();
    }
  });
}

export function stripeEvent(type: string, object: Record<string, unknown>, id?: string): StripeEventFixture {
  return {
    id: id ?? `evt_${type.replaceAll('.', '_')}_${String(object.id ?? 'x')}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object },
  };
}

export async function deliver(
  app: FastifyInstance,
  fake: FakeStripeGateway,
  event: StripeEventFixture,
): Promise<InjectResponse> {
  const payload = JSON.stringify(event);
  const listed: ListedStripeEvent = {
    id: event.id,
    type: event.type,
    created: event.created,
    livemode: event.livemode,
    object: event.data.object,
  };
  fake.pushEvent(listed);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signature,
    },
    payload,
  });
}

export async function postCheckout(
  app: FastifyInstance,
  idempotencyKey: string,
  body: Record<string, unknown> = {},
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/checkout/sessions',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    payload: {
      amount_cents: 2500,
      currency: 'usd',
      description: 'Design invoice',
      success_url: 'https://example.com/success',
      cancel_url: 'https://example.com/cancel',
      ...body,
    },
  });
}

export async function captureCheckout(ctx: TestContext, payment: PaymentBody): Promise<void> {
  assert.ok(payment.stripe_checkout_session_id);
  assert.ok(payment.stripe_payment_intent_id);
  const response = await deliver(
    ctx.app,
    ctx.fake,
    stripeEvent('checkout.session.completed', {
      id: payment.stripe_checkout_session_id,
      object: 'checkout.session',
      payment_status: 'paid',
      amount_total: payment.amount_cents,
      currency: payment.currency,
      payment_intent: payment.stripe_payment_intent_id,
      client_reference_id: payment.id,
      metadata: { payment_id: payment.id },
    }),
  );
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { outcome: string };
  assert.equal(body.outcome, 'processed');
}
