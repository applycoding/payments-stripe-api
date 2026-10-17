import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export const STRIPE_API_VERSION = '2026-09-30.endive' as const;

const LIVE_KEY = /(?:sk|rk)_live_/;

export type StripeMode = 'fake' | 'test';

export type Config = {
  port: number;
  databaseUrl: string;
  stripeMode: StripeMode;
  stripeApiKey: string;
  stripeWebhookSecret: string;
  jobToken: string;
  enableScheduler: boolean;
  reconcileCron: string;
  enableOutboxPoller: boolean;
  outboxPollMs: number;
  log: boolean;
};

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return value === 'true' || value === '1';
}

function requirePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (env.STRIPE_MODE === 'live') {
    throw new Error('STRIPE_MODE=live is not supported. This demo is test mode only.');
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const stripeMode: StripeMode = env.STRIPE_MODE === 'test' ? 'test' : 'fake';
  const stripeApiKey = env.STRIPE_API_KEY ?? '';
  const stripeWebhookSecret =
    env.STRIPE_WEBHOOK_SECRET ?? (stripeMode === 'fake' ? 'whsec_dev_only_placeholder' : '');

  if (LIVE_KEY.test(stripeApiKey) || LIVE_KEY.test(stripeWebhookSecret)) {
    throw new Error('Refusing to start with a live Stripe key. This demo is test mode only.');
  }

  if (stripeMode === 'test') {
    if (!stripeApiKey.startsWith('rk_test_') && !stripeApiKey.startsWith('sk_test_')) {
      throw new Error('STRIPE_MODE=test requires a Stripe test key. Prefer a restricted key (rk_test_).');
    }
    if (!stripeWebhookSecret.startsWith('whsec_')) {
      throw new Error('STRIPE_MODE=test requires STRIPE_WEBHOOK_SECRET (whsec_...).');
    }
  }

  const jobToken = env.JOB_TOKEN ?? (stripeMode === 'fake' ? 'dev-job-token' : '');
  if (!jobToken) {
    throw new Error('JOB_TOKEN is required when STRIPE_MODE=test');
  }

  const outboxPollMs = Number(env.OUTBOX_POLL_MS ?? 2000);
  if (!Number.isInteger(outboxPollMs) || outboxPollMs < 100) {
    throw new Error('OUTBOX_POLL_MS must be an integer >= 100');
  }

  return {
    port: requirePort(env.PORT),
    databaseUrl,
    stripeMode,
    stripeApiKey,
    stripeWebhookSecret,
    jobToken,
    enableScheduler: flag(env.ENABLE_SCHEDULER, false),
    reconcileCron: env.RECONCILE_CRON ?? '0 2 * * *',
    enableOutboxPoller: flag(env.ENABLE_OUTBOX_POLLER, true),
    outboxPollMs,
    log: flag(env.LOG, true),
  };
}

export function assertJobToken(provided: string | undefined, expected: string): void {
  if (!provided || !tokensMatch(provided, expected)) {
    throw new AppError(401, 'unauthorized', 'Job token is missing or invalid');
  }
}

function tokensMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
