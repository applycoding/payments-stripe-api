import Stripe from 'stripe';

export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
  jitterRatio?: number;
  random?: () => number;
};

export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const exponent = Math.max(0, attempt - 1);
  const uncapped = options.baseMs * 2 ** exponent;
  const delay = Math.min(options.maxMs, uncapped);
  const ratio = options.jitterRatio ?? 0;
  const random = options.random ?? Math.random;
  const delta = delay * ratio * (random() * 2 - 1);
  return Math.max(0, Math.round(delay + delta));
}

export function isRetryableStripeError(err: unknown): boolean {
  if (err instanceof RetryableError) {
    return true;
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return true;
  }
  if (err instanceof Stripe.errors.StripeAPIError) {
    return true;
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return true;
  }
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: BackoffOptions & {
    maxAttempts: number;
    sleep?: (ms: number) => Promise<void>;
    isRetryable?: (err: unknown) => boolean;
  },
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const retryable = options.isRetryable ?? isRetryableStripeError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const remaining = attempt < options.maxAttempts;
      if (!remaining || !retryable(err)) {
        throw err;
      }
      await sleep(backoffDelayMs(attempt, options));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('retry failed');
}
