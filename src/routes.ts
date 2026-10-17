import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { assertJobToken, type Config } from './config.js';
import { AppError } from './errors.js';
import { trialBalance } from './ledger.js';
import { drainOutbox } from './outbox.js';
import {
  createCheckoutSession,
  createPaymentIntent,
  createRefund,
  getPayment,
  listPayments,
  paymentJournal,
  paymentJson,
} from './payments.js';
import { getReconciliationRun, listReconciliationRuns, runReconciliation } from './reconcile.js';
import type { StripeGateway } from './stripe-gateway.js';
import { ingestStripeEvent, verifyStripeEvent } from './webhooks.js';

const currencySchema = z.string().regex(/^[a-z]{3}$/);
const amountSchema = z.number().int().positive().max(100_000_000);
const urlSchema = z.string().url();
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,255}$/);

const checkoutBody = z.object({
  amount_cents: amountSchema,
  currency: currencySchema,
  description: z.string().min(1).max(200),
  customer_email: z.string().email().optional(),
  success_url: urlSchema,
  cancel_url: urlSchema,
});

const paymentIntentBody = z.object({
  amount_cents: amountSchema,
  currency: currencySchema,
  description: z.string().min(1).max(200),
  customer_email: z.string().email().optional(),
});

const refundBody = z.object({
  amount_cents: amountSchema.optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new AppError(400, 'validation_error', message);
  }
  return parsed.data;
}

function requireIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header is required');
  }
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      400,
      'invalid_idempotency_key',
      'Idempotency-Key must be 8-255 characters of letters, numbers, underscore, or hyphen',
    );
  }
  return parsed.data;
}

function parseLimit(value: unknown): number {
  const parsed = z.coerce.number().int().min(1).max(100).default(20).safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', 'limit must be an integer from 1 to 100');
  }
  return parsed.data;
}

function requireUuid(value: string, name: string): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'validation_error', `${name} must be a UUID`);
  }
  return parsed.data;
}

function openApiFile(): string {
  return path.join(process.cwd(), 'openapi', 'openapi.yaml');
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { config: Config; pool: pg.Pool; stripe: StripeGateway },
): void {
  app.get('/health', async () => {
    await deps.pool.query('SELECT 1');
    return { status: 'ok', stripe_mode: deps.config.stripeMode };
  });

  app.get('/openapi.yaml', async (_request, reply) => {
    const body = readFileSync(openApiFile(), 'utf8');
    return reply.type('application/yaml').send(body);
  });

  app.get('/openapi.json', async () => {
    const body = readFileSync(openApiFile(), 'utf8');
    return parseYaml(body) as unknown;
  });

  app.post('/v1/checkout/sessions', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parseBody(checkoutBody, request.body);
    const outcome = await createCheckoutSession(deps.pool, deps.stripe, {
      idempotencyKey,
      amountCents: body.amount_cents,
      currency: body.currency,
      description: body.description,
      customerEmail: body.customer_email ?? null,
      successUrl: body.success_url,
      cancelUrl: body.cancel_url,
    });
    return reply
      .header('Idempotency-Replayed', outcome.replayed ? 'true' : 'false')
      .status(outcome.result.statusCode)
      .send(outcome.result.body);
  });

  app.post('/v1/payment-intents', async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parseBody(paymentIntentBody, request.body);
    const outcome = await createPaymentIntent(deps.pool, deps.stripe, {
      idempotencyKey,
      amountCents: body.amount_cents,
      currency: body.currency,
      description: body.description,
      customerEmail: body.customer_email ?? null,
    });
    return reply
      .header('Idempotency-Replayed', outcome.replayed ? 'true' : 'false')
      .status(outcome.result.statusCode)
      .send(outcome.result.body);
  });

  app.get('/v1/payments', async (request) => {
    const limit = parseLimit((request.query as { limit?: string }).limit);
    const payments = await listPayments(deps.pool, limit);
    return { payments: payments.map(paymentJson) };
  });

  app.get('/v1/payments/:id', async (request) => {
    const id = requireUuid((request.params as { id: string }).id, 'id');
    const payment = await getPayment(deps.pool, id);
    if (!payment) {
      throw new AppError(404, 'payment_not_found', 'Payment not found');
    }
    return paymentJson(payment);
  });

  app.get('/v1/payments/:id/journal', async (request) => {
    const id = requireUuid((request.params as { id: string }).id, 'id');
    const entries = await paymentJournal(deps.pool, id);
    return { entries };
  });

  app.post('/v1/payments/:id/refunds', async (request, reply) => {
    const id = requireUuid((request.params as { id: string }).id, 'id');
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const body = parseBody(refundBody, request.body ?? {});
    const outcome = await createRefund(deps.pool, deps.stripe, {
      paymentId: id,
      idempotencyKey,
      amountCents: body.amount_cents ?? null,
      reason: body.reason ?? null,
    });
    return reply
      .header('Idempotency-Replayed', outcome.replayed ? 'true' : 'false')
      .status(outcome.result.statusCode)
      .send(outcome.result.body);
  });

  app.get('/v1/ledger/trial-balance', async () => trialBalance(deps.pool));

  app.post('/v1/webhooks/stripe', async (request, reply) => {
    const raw = (request as { rawBody?: Buffer }).rawBody;
    const signatureHeader = request.headers['stripe-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!raw || !signature) {
      throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
    }
    const event = verifyStripeEvent(raw, signature, deps.config.stripeWebhookSecret);
    const result = await ingestStripeEvent(deps.pool, event);
    return reply.status(200).send({ received: true, duplicate: result.duplicate, outcome: result.outcome });
  });

  app.post('/v1/jobs/reconcile', async (request) => {
    assertJobToken(request.headers['x-job-token'] as string | undefined, deps.config.jobToken);
    return runReconciliation(deps.pool, deps.stripe);
  });

  app.get('/v1/reconciliations', async (request) => {
    const limit = parseLimit((request.query as { limit?: string }).limit);
    return { reconciliations: await listReconciliationRuns(deps.pool, limit) };
  });

  app.get('/v1/reconciliations/:id', async (request) => {
    const id = requireUuid((request.params as { id: string }).id, 'id');
    const run = await getReconciliationRun(deps.pool, id);
    if (!run) {
      throw new AppError(404, 'reconciliation_not_found', 'Reconciliation run not found');
    }
    return run;
  });

  app.post('/v1/jobs/outbox/drain', async (request) => {
    assertJobToken(request.headers['x-job-token'] as string | undefined, deps.config.jobToken);
    return drainOutbox(deps.pool);
  });
}
