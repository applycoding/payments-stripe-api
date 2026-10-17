import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { startScheduler } from './scheduler.js';
import { createStripeGateway } from './stripe-gateway.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
await migrate(pool);
const stripe = createStripeGateway(config);
const app = await buildApp({ config, pool, stripe, logger: config.log });
const scheduler = startScheduler({
  config,
  pool,
  stripe,
  log: {
    error: (obj, msg) => app.log.error(obj, msg),
    info: (obj, msg) => app.log.info(obj, msg),
  },
});

const shutdown = async () => {
  scheduler.stop();
  await app.close();
  await pool.end();
};

process.on('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ port: config.port, host: '0.0.0.0' });
if (config.stripeMode === 'test' && config.stripeApiKey.startsWith('sk_test_')) {
  app.log.warn('Using a Stripe secret key. Prefer a restricted key (rk_test_) with Checkout, PaymentIntent, Refund, and Event permissions.');
}
