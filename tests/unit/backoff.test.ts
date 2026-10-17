import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RetryableError, backoffDelayMs, withRetry } from '../../src/retry.js';

describe('backoff', () => {
  it('grows exponentially and caps', () => {
    const options = { baseMs: 100, maxMs: 350, jitterRatio: 0, random: () => 0.5 };
    assert.equal(backoffDelayMs(1, options), 100);
    assert.equal(backoffDelayMs(2, options), 200);
    assert.equal(backoffDelayMs(3, options), 350);
    assert.equal(backoffDelayMs(8, options), 350);
  });

  it('keeps jitter inside the requested ratio', () => {
    const low = backoffDelayMs(2, { baseMs: 100, maxMs: 10_000, jitterRatio: 0.2, random: () => 0 });
    const high = backoffDelayMs(2, { baseMs: 100, maxMs: 10_000, jitterRatio: 0.2, random: () => 1 });
    assert.equal(low, 160);
    assert.equal(high, 240);
  });

  it('retries retryable failures then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new RetryableError('downstream unavailable');
        }
        return 'ok';
      },
      {
        maxAttempts: 5,
        baseMs: 100,
        maxMs: 1_000,
        jitterRatio: 0,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    assert.equal(value, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('does not retry a permanent error', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error('invalid request');
          },
          {
            maxAttempts: 4,
            baseMs: 10,
            maxMs: 10,
            jitterRatio: 0,
            sleep: async () => undefined,
            isRetryable: () => false,
          },
        ),
      /invalid request/,
    );
    assert.equal(calls, 1);
  });
});
