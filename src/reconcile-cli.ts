import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { runReconciliation } from './reconcile.js';
import { createStripeGateway } from './stripe-gateway.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
await migrate(pool);
const stripe = createStripeGateway(config);
try {
  const report = await runReconciliation(pool, stripe);
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  process.exit(report.discrepancy_count > 0 ? 2 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
}
