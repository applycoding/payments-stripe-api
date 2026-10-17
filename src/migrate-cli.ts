import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
await migrate(pool);
await pool.end();
console.log('migrations applied');
