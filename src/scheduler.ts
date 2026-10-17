import { schedule, validate, type ScheduledTask } from 'node-cron';
import type pg from 'pg';
import type { Config } from './config.js';
import { drainOutbox } from './outbox.js';
import { runReconciliation } from './reconcile.js';
import type { StripeGateway } from './stripe-gateway.js';

export function startScheduler(options: {
  config: Config;
  pool: pg.Pool;
  stripe: StripeGateway;
  log: { error: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}): { stop: () => void } {
  const timers: NodeJS.Timeout[] = [];
  let cronTask: ScheduledTask | null = null;

  if (options.config.enableOutboxPoller) {
    const timer = setInterval(() => {
      void drainOutbox(options.pool).catch((err: unknown) => {
        options.log.error({ err }, 'outbox poll failed');
      });
    }, options.config.outboxPollMs);
    timer.unref();
    timers.push(timer);
  }

  if (options.config.enableScheduler) {
    if (!validate(options.config.reconcileCron)) {
      throw new Error(`Invalid RECONCILE_CRON expression: ${options.config.reconcileCron}`);
    }
    cronTask = schedule(
      options.config.reconcileCron,
      () => {
        void runReconciliation(options.pool, options.stripe)
          .then((report) => {
            options.log.info(
              { id: report.id, discrepancy_count: report.discrepancy_count },
              'reconciliation finished',
            );
          })
          .catch((err: unknown) => {
            options.log.error({ err }, 'reconciliation failed');
          });
      },
      { timezone: 'Etc/UTC' },
    );
  }

  return {
    stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      cronTask?.stop();
    },
  };
}
