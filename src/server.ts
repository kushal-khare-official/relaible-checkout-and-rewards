import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/database.js';
import { migrateToLatest } from './db/migrations.js';
import { seedProducts } from './db/seed.js';

const config = loadConfig();
const db = createDb({ connectionString: config.databaseUrl, max: config.dbPoolMax });

await migrateToLatest(db);
if (config.seedOnStart) {
  await seedProducts(db);
}

const app = await buildApp({ config, db, logger: { level: config.logLevel } });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
